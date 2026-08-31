/**
 * dsh-token-stats-xg：跨会话模型 Token 用量监听与统计插件。
 *
 * 数据源：会话日志（durable log）中的 provider 上报 usage ——
 *   - assistant/chunk(usage)：流式 usage 样本（请求失败也能保留）
 *   - assistant/message(usage)：该步骤最终 usage（替换同步骤 chunk 样本）
 *
 * 监听面（全局 ctx 注册，收到所有会话）：
 *   - session/created：会话公告时把整段内存日志批量折叠（含恢复会话的
 *     全部历史 —— 插件安装前发生的用量也在其中），折叠结果整体替换
 *     状态中该会话的条目（日志是 source of truth）
 *   - session/event：实时增量折叠，每个步骤首条 usage 样本输出一条
 *     终端监控行（模型路由 + 输入/输出/缓存桶）
 *
 * 去重语义与 DSH 内置 token-meter 的 tokenUsage 投影一致（同 turn/step
 * 重复样本替换而非累加），另加按日 / 按模型（provider/model）归属。
 *
 * 持久化：<dir>/token-stats.json（默认 ~/.dsh/token-stats/），防抖写盘，
 * 进程重启后恢复累计值；会话再次激活时由批量折叠刷新其条目。
 *
 * 查询面：
 *   - 模型工具 token_stats（总览 / 按会话 / 按日 / 按模型 / 最近调用）
 *   - REST API /token-stats/api/report（Web 看板数据源，?days= 窗口过滤，
 *     days=1 时附带 byHour 小时直方图）
 * tools / webServer 服务声明为 inject 硬依赖：composition 树并行激活所有
 * 条目，不等待的话 apply 执行时服务可能尚未就绪（注册静默丢失）。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: 引入 webServer 服务的模块增强（ctx.webServer 类型）。
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  buildReport,
  createSessionFold,
  defaultCostPlan,
  foldToStored,
  foldUsageSample,
  hourlyHistogram,
  loadState,
  pushRecent,
  renderReport,
  routeFromEvent,
  routeLabel,
  sampleFromEvent,
  saveState,
  stateFilePath,
  totalTokens,
  type CostPlan,
  type DeepseekModelPrice,
  type HourBucketRow,
  type RecentCommit,
  type SessionFold,
  type StatsReport,
  type TokenStatsState,
  type UsageSample,
  titleFromEvent,
} from './logic.js'

export const name = 'dsh-token-stats-xg'

/** 硬依赖：tools / webServer 服务就绪后 fiber 才执行 apply（DSH composition 保证提供） */
export const inject = ['tools', 'webServer']

const API_PREFIX = '/token-stats/api'

// ---------- token_stats 工具输出 schema（与 logic.StatsReport 形状一致） ----------
// 注意：schema 以 as const 字面量类型传入 defineTool —— 泛型推导依赖精确形状，
// 不能先标注为 ValueSchemaSpec 联合类型（会把对象分支推导成 Record<string, never>）。

const usageSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    inputTokens: { type: 'integer' },
    outputTokens: { type: 'integer' },
    cacheReadTokens: { type: 'integer' },
    cacheWriteTokens: { type: 'integer' },
    reasoningTokens: { type: 'integer' },
  },
} as const

const costEstimateSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    deepseekYuan: { type: 'number' },
    localYuan: { type: 'number' },
    totalYuan: { type: 'number' },
  },
} as const

const usageWithRequestsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    requests: { type: 'integer' },
    usage: usageSchema,
    totalTokens: { type: 'integer' },
    cost: costEstimateSchema,
  },
} as const

const routeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string' },
    model: { type: 'string' },
  },
} as const

const statsOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    generatedAt: { type: 'integer' },
    windowDays: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    windowFrom: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    total: usageWithRequestsSchema,
    sessionCount: { type: 'integer' },
    trackedSessionCount: { type: 'integer' },
    bySession: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string' },
          title: { type: 'string' },
          cwd: { type: 'string' },
          agentPreset: { type: 'string' },
          requests: { type: 'integer' },
          usage: usageSchema,
          totalTokens: { type: 'integer' },
          costYuan: { type: 'number' },
          lastActivity: { type: 'integer' },
          routes: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    byDay: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          day: { type: 'string' },
          requests: { type: 'integer' },
          usage: usageSchema,
          totalTokens: { type: 'integer' },
          costYuan: { type: 'number' },
        },
      },
    },
    byRoute: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          route: { type: 'string' },
          requests: { type: 'integer' },
          usage: usageSchema,
          totalTokens: { type: 'integer' },
          cost: costEstimateSchema,
        },
      },
    },
    recent: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          time: { type: 'integer' },
          sessionId: { type: 'string' },
          title: { type: 'string' },
          route: { oneOf: [routeSchema, { type: 'null' }] },
          source: { type: 'string', enum: ['message', 'chunk'] },
          usage: usageSchema,
          routeLabel: { type: 'string' },
          totalTokens: { type: 'integer' },
        },
      },
    },
  },
} as const

/** 插件配置（cordis.patch.yml 中 config 字段） */
export interface Config {
  /** 总开关；false 时不监听、不注册工具，默认 true */
  enabled?: boolean
  /** 状态目录，默认 ~/.dsh/token-stats（状态文件 token-stats.json） */
  dir?: string
  /** 每次模型调用输出一条终端监控行，默认 true */
  logCalls?: boolean
  /** 状态写盘防抖（毫秒），默认 2000 */
  flushMs?: number
  /** 内存"最近调用"环形缓冲上限，默认 200 */
  recentLimit?: number
  /** DeepSeek 官方 provider 名（费用估算归属），默认 deepseek-official */
  deepseekProvider?: string
  /** 按电费估算的本地 provider 名列表，默认 ['llama-local'] */
  localProviders?: string[]
  /** DeepSeek 单价覆盖（元/百万 tokens，官网空闲时段价）；合并进内置价目表 */
  deepseekPrices?: Record<string, DeepseekModelPrice>
  /** 本地电价（元/千瓦时），默认 0.6 */
  localPricePerKwh?: number
  /** 本地整机功耗（瓦），默认 600 */
  localPowerWatts?: number
  /** 本地输出（decode）吞吐（tokens/秒），默认 50 */
  localDecodeTps?: number
  /** 本地未命中输入（prefill）吞吐（tokens/秒），默认 1000 */
  localPrefillTps?: number
}

export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return

  const dir = config.dir ?? join(homedir(), '.dsh', 'token-stats')
  const stateFile = stateFilePath(dir)
  const flushMs = config.flushMs ?? 2000
  const logCalls = config.logCalls !== false
  const recentLimit = config.recentLimit ?? 200
  const defaults = defaultCostPlan()
  const costPlan: CostPlan = {
    deepseekProvider: config.deepseekProvider ?? defaults.deepseekProvider,
    localProviders: config.localProviders ?? defaults.localProviders,
    deepseekPrices: { ...defaults.deepseekPrices, ...config.deepseekPrices },
    localPricePerKwh: config.localPricePerKwh ?? defaults.localPricePerKwh,
    localPowerWatts: config.localPowerWatts ?? defaults.localPowerWatts,
    localDecodeTps: config.localDecodeTps ?? defaults.localDecodeTps,
    localPrefillTps: config.localPrefillTps ?? defaults.localPrefillTps,
  }

  const state: TokenStatsState = loadState(stateFile)
  const folds = new Map<string, SessionFold>()
  /** 已观察到实时事件的会话（session/created 前若已出现实时事件则跳过历史折叠） */
  const liveSeen = new Set<string>()
  const recent: RecentCommit[] = []

  // ---------- 状态写盘（防抖 + 卸载兜底） ----------

  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let dirty = false
  function flushNow(): void {
    if (!dirty) return
    dirty = false
    try {
      saveState(stateFile, state)
    } catch (error) {
      dirty = true // 写失败保持脏标记，交给下一轮防抖重试
      console.warn(`[token-stats] state save failed: ${String(error)}`)
    }
  }
  function scheduleFlush(): void {
    dirty = true
    if (flushTimer !== undefined) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      flushNow()
    }, flushMs)
    ;(flushTimer as { unref?: () => void }).unref?.()
  }

  ctx.effect(() => {
    return () => {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer)
        flushTimer = undefined
      }
      flushNow()
    }
  }, 'token-stats:state')

  // ---------- 会话标题回填（可选依赖 session-query；缺省时仅用折叠所得标题） ----------

  /** session-query 服务的结构化子集（readTitleSnapshots 折叠持久化日志中的 session/title 事件） */
  interface TitleBackfillService {
    readTitleSnapshots(
      sessionIds: readonly string[],
      signal?: AbortSignal,
    ): Promise<ReadonlyArray<
      | { status: 'fulfilled'; value: { title?: { title: string } } }
      | { status: 'rejected'; reason: unknown }
    >>
  }

  const sessionQuery = ctx.get('sessionQuery') as TitleBackfillService | undefined
  /** 已解析的会话标题缓存（回填过的 id 不再重复读日志） */
  const titleCache = new Map<string, string>()

  /**
   * 为缺少标题的跟踪会话回填标题：折叠持久化/内存日志中的 session/title
   * 事件（session-query 优先用内存日志，缺失时读持久化日志）。解析结果写入
   * 状态（随下一次 flush 落盘）。可选依赖：sessionQuery 缺失时静默跳过。
   */
  async function backfillTitles(): Promise<void> {
    if (sessionQuery === undefined) return
    const need = Object.keys(state.sessions).filter(id =>
      state.sessions[id]!.title === undefined && !titleCache.has(id))
    if (need.length === 0) return
    let results: Awaited<ReturnType<TitleBackfillService['readTitleSnapshots']>>
    try {
      results = await sessionQuery.readTitleSnapshots(need)
    } catch (error) {
      console.warn(`[token-stats] title backfill failed: ${String(error)}`)
      return
    }
    let changed = false
    results.forEach((result, i) => {
      const id = need[i]
      if (id === undefined || result.status !== 'fulfilled') return
      const title = result.value?.title?.title
      if (typeof title !== 'string' || title.length === 0) return
      titleCache.set(id, title)
      const session = state.sessions[id]
      if (session !== undefined && session.title === undefined) {
        session.title = title
        changed = true
      }
    })
    if (changed) scheduleFlush()
  }

  // ---------- Web 看板 API（webServer 为 inject 硬依赖，apply 时必然就绪） ----------

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      connection: 'close',
    })
    res.end(JSON.stringify(body))
  }

  /** 正整数查询参数；缺失/非法返回 undefined，超出 [min,max] 截断到边界 */
  function intParam(value: string | null, min: number, max: number): number | undefined {
    if (value === null) return undefined
    const n = Number(value)
    if (!Number.isInteger(n)) return undefined
    return Math.max(min, Math.min(max, n))
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== `${API_PREFIX}/report`) {
          json(res, 404, { error: 'not found' })
          return
        }
        await backfillTitles()
        const days = intParam(url.searchParams.get('days'), 1, 3650)
        const limit = intParam(url.searchParams.get('limit'), 1, 100)
        const report = buildReport(state, {
          days,
          limit,
          now: Date.now(),
          recent,
          costPlan,
        })
        // 小时直方图只在"今日"窗口有意义（数据边界：环形缓冲覆盖范围）
        const byHour: HourBucketRow[] | null = days === 1
          ? hourlyHistogram(recent, Date.now(), 24)
          : null
        json(res, 200, { report, byHour })
      } catch (error) {
        json(res, 500, { error: String(error) })
      }
    },
  }), 'token-stats:api')

  // ---------- 折叠管线 ----------

  const metaOf = (session: Session) => ({
    cwd: session.header.cwd,
    agentPreset: session.header.agentPreset,
    createdAt: session.header.createdAt,
  })

  function foldFor(id: string, session: Session): SessionFold {
    let fold = folds.get(id)
    if (fold === undefined) {
      fold = createSessionFold(metaOf(session))
      folds.set(id, fold)
    }
    return fold
  }

  /**
   * 应用一条 usage 样本：折叠 → 镜像到状态 → 最近调用缓冲 → 监控行。
   * 监控行只在"步骤首样本"输出（每次模型调用一行；同步骤替换样本不重复输出）。
   */
  function applySample(id: string, session: Session, sample: UsageSample): void {
    const fold = foldFor(id, session)
    const firstOfStep = fold.last === null || fold.last.turn !== sample.turn || fold.last.step !== sample.step
    foldUsageSample(fold, sample)
    state.sessions[id] = foldToStored(fold)
    if (firstOfStep) {
      pushRecent(recent, recentLimit, {
        time: sample.time,
        sessionId: id,
        route: sample.route,
        source: sample.source,
        usage: sample.usage,
      })
      if (logCalls) {
        const u = sample.usage
        console.log(
          `[token-stats] call session=${id} model=${routeLabel(sample.route)}`
          + ` in=${u.inputTokens} cacheR=${u.cacheReadTokens} cacheW=${u.cacheWriteTokens} out=${u.outputTokens}`
          + ` (total=${totalTokens(u)}) [${sample.source}]`,
        )
      }
    }
    scheduleFlush()
  }

  // ---------- 监听器 ----------

  /**
   * 会话公告：批量折叠整段内存日志（恢复会话携带全部历史），折叠结果整体
   * 替换状态条目。监听器异常不得 veto 发布，整体兜底。
   */
  ctx.on('session/created', (session: Session) => {
    try {
      const id = String(session.id)
      if (liveSeen.has(id)) {
        console.warn(`[token-stats] session ${id}: live events observed before session/created; history fold skipped`)
        return
      }
      const fold = createSessionFold(metaOf(session))
      folds.set(id, fold)
      for (const event of session.events) {
        const title = titleFromEvent(event)
        if (title !== undefined) fold.title = title
        const route = routeFromEvent(event)
        if (route !== null) fold.route = route
        const sample = sampleFromEvent(event, fold.route)
        if (sample === null) continue
        foldUsageSample(fold, sample)
      }
      state.sessions[id] = foldToStored(fold)
      const t = fold.totals
      console.log(
        `[token-stats] session ${id} ready: history folded, model calls=${fold.requests}`
        + (fold.requests > 0 ? ` in=${t.inputTokens} cacheR=${t.cacheReadTokens} cacheW=${t.cacheWriteTokens} out=${t.outputTokens}` : ''),
      )
      if (fold.requests > 0) scheduleFlush()
    } catch (error) {
      console.warn(`[token-stats] session/created fold failed: ${String(error)}`)
    }
  })

  /** 实时事件流：增量折叠所有会话的日志追加。 */
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    try {
      const id = String(session.id)
      liveSeen.add(id)
      const fold = foldFor(id, session)
      // 会话标题增量更新（session/title 事件；最新胜出）
      const title = titleFromEvent(event)
      if (title !== undefined) {
        fold.title = title
        state.sessions[id] = foldToStored(fold)
        scheduleFlush()
        return
      }
      const route = routeFromEvent(event)
      if (route !== null) fold.route = route
      const sample = sampleFromEvent(event, fold.route)
      if (sample === null) return
      applySample(id, session, sample)
    } catch (error) {
      console.warn(`[token-stats] session/event listener failed: ${String(error)}`)
    }
  })

  // ---------- 查询工具（tools 为 inject 硬依赖，apply 时必然就绪） ----------

  ctx.tools.register(defineTool({
    name: 'token_stats',
    description: '查询跨会话模型 Token 用量统计（输入/输出/缓存读写，按会话、按日、按模型汇总，含最近调用明细）。当用户询问 token 用量、消耗、成本分布时使用。',
    parameters: {
      days: { type: 'integer', description: '只统计最近 N 个自然日（含今天）；省略 = 全部历史' },
      sessionId: { type: 'string', description: '只统计指定会话（id 精确或前缀匹配）' },
      limit: { type: 'integer', description: 'bySession 返回行数上限，默认 10，最大 100' },
    },
    output: {
      schema: statsOutputSchema,
      render: (_args, value) => [{ type: 'text' as const, text: renderReport(value as unknown as StatsReport) }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      await backfillTitles()
      const report = buildReport(state, {
        days: args.days,
        sessionId: args.sessionId,
        limit: args.limit,
        now: Date.now(),
        recent,
        costPlan,
      })
      return report
    },
    presentCall: args => ({ card: 'generic', title: '查询 Token 用量统计', kind: 'other', rawInput: args }),
  }))

  // 启动后延迟回填一次历史标题（不阻塞启动；查询路径仍有兜底回填）
  ctx.effect(() => {
    const warmup = setTimeout(() => { void backfillTitles() }, 3_000)
    warmup.unref?.()
    return () => clearTimeout(warmup)
  }, 'token-stats:title-warmup')

  console.log(
    `[token-stats] started: dir=${dir} trackedSessions=${Object.keys(state.sessions).length} logCalls=${logCalls} flushMs=${flushMs} api=${API_PREFIX}/report`
    + ` cost(deepseek=${costPlan.deepseekProvider}, local=[${costPlan.localProviders.join(',')}], kwh=${costPlan.localPricePerKwh}, w=${costPlan.localPowerWatts}, decodeTps=${costPlan.localDecodeTps}, prefillTps=${costPlan.localPrefillTps})`,
  )
}
