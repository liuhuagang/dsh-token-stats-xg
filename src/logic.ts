/**
 * dsh-token-stats-xg 纯逻辑层：会话事件折叠（token 用量去重累加）、跨会话聚合、
 * 状态持久化与报告构建。
 *
 * 本文件只依赖 Node 内置模块，不依赖 cordis/dsh 包，所有函数可独立单元测试。
 *
 * 去重语义与 DSH 内置 token-meter 的 tokenUsage 投影对齐（单 last 槽位、
 * 同 turn/step 重复样本替换而非累加、新步骤到来才计入总数），并在此基础上
 * 增加按日 / 按模型（provider/model）归属与请求计数：
 *   - assistant/chunk(usage) 提供流式早期样本（请求失败也能保留）
 *   - assistant/message(usage) 提供该步骤最终样本（替换同步骤的 chunk 样本）
 *   - 样本携带 event.time（按日归属）与 route（message 用 message.source，
 *     chunk 用最近一次 request/context 或 request/header 记录的路由）
 *
 * 同一 (turn, step) 的 usage 样本在合法日志中必然相邻，因此单槽位替换是
 * 无损的；折叠函数对"批量重放整段日志"与"实时单条事件"两种用法完全一致。
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Token 用量桶（五个字段恒在；缺失字段归一化为 0） */
export interface UsageBuckets {
  /** 未缓存输入 tokens */
  inputTokens: number
  /** 输出 tokens（含 reasoningTokens，推理不重复计） */
  outputTokens: number
  /** 缓存命中读入 tokens */
  cacheReadTokens: number
  /** 缓存写入 tokens */
  cacheWriteTokens: number
  /** 推理 tokens（已含在 outputTokens 内，单列为分析口径） */
  reasoningTokens: number
}

/** 一个模型路由（provider/model） */
export interface RouteKey {
  provider: string
  model: string
}

/** 路由聚合：请求数 + 用量 */
export interface RouteAgg {
  requests: number
  usage: UsageBuckets
}

/** 单日聚合：请求数 + 用量 + 按路由细分 */
export interface DayAgg {
  requests: number
  usage: UsageBuckets
  byRoute: Record<string, RouteAgg>
}

/** 持久化的单会话统计（日志折叠结果；日志本身是 source of truth） */
export interface StoredSession {
  cwd?: string
  agentPreset?: string
  /** 会话标题（session/title 事件折叠所得；无标题事件时为 undefined） */
  title?: string
  createdAt: number
  /** 有 usage 样本的步骤数（= 报告过 token 的模型请求数） */
  requests: number
  totals: UsageBuckets
  /** 最近一次 usage 样本时间（ms）；无样本为 0 */
  lastActivity: number
  byDay: Record<string, DayAgg>
}

/** 全量状态（state.json 内容） */
export interface TokenStatsState {
  version: 1
  sessions: Record<string, StoredSession>
}

/** 折叠过程中的单会话可变状态（last 槽位与 route 只在内存，不落盘） */
export interface SessionFold {
  meta: { cwd?: string; agentPreset?: string; createdAt: number }
  /** 会话标题（session/title 事件折叠所得；无标题事件时为 undefined） */
  title?: string
  requests: number
  totals: UsageBuckets
  lastActivity: number
  byDay: Record<string, DayAgg>
  /** 最近一次路由记录（request/context 或 request/header）；chunk 样本的归属路由 */
  route: RouteKey | null
  /** 最近一次 usage 样本（同步骤新样本替换；新步骤到来时已计入 totals） */
  last: {
    turn: number
    step: number
    time: number
    route: RouteKey | null
    buckets: UsageBuckets
  } | null
}

/** 一条 usage 样本（fold 的输入） */
export interface UsageSample {
  turn: number
  step: number
  time: number
  route: RouteKey | null
  source: 'message' | 'chunk'
  usage: UsageBuckets
}

/** 可折叠事件的结构性形状（真实 SessionEvent 满足此形状；逻辑层不 import 类型包） */
export interface FoldableEvent {
  type: string
  time: number
  data: unknown
}

/** 最近调用环形缓冲条目（内存态，供报告"最近调用"段） */
export interface RecentCommit {
  time: number
  sessionId: string
  route: RouteKey | null
  source: 'message' | 'chunk'
  usage: UsageBuckets
}

// ---------- 基础工具 ----------

export function emptyUsage(): UsageBuckets {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
}

export function addUsage(a: UsageBuckets, b: UsageBuckets): UsageBuckets {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  }
}

export function subUsage(a: UsageBuckets, b: UsageBuckets): UsageBuckets {
  return {
    inputTokens: a.inputTokens - b.inputTokens,
    outputTokens: a.outputTokens - b.outputTokens,
    cacheReadTokens: a.cacheReadTokens - b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens - b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens - b.reasoningTokens,
  }
}

export function usageEqual(a: UsageBuckets, b: UsageBuckets): boolean {
  return a.inputTokens === b.inputTokens
    && a.outputTokens === b.outputTokens
    && a.cacheReadTokens === b.cacheReadTokens
    && a.cacheWriteTokens === b.cacheWriteTokens
    && a.reasoningTokens === b.reasoningTokens
}

/** 计费/分析口径的总量：输入三桶（未缓存+缓存读+缓存写）+ 输出；推理已含在输出内 */
export function totalTokens(u: UsageBuckets): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.outputTokens
}

// ---------- 费用估算 ----------

/**
 * DeepSeek 单价（元/百万 tokens）。
 *
 * 口径：官网"模型 & 价格"页（2026-08 版）的**空闲时段**价格（= 高峰时段
 * 一半；高峰为北京时间周一至五 9:00-12:00、14:00-18:00）——"以低估时期"
 * 估算，即假设全部调用落在空闲时段，实际高峰调用成本最高可达估算的 2 倍。
 * 缓存写（cacheWriteTokens）官网不单独计费（落盘由未命中价涵盖），归入
 * 未命中输入口径。
 */
export interface DeepseekModelPrice {
  /** 输入缓存未命中（元/百万 tokens） */
  inputMiss: number
  /** 输入缓存命中（元/百万 tokens） */
  inputHit: number
  /** 输出（元/百万 tokens） */
  output: number
}

/** 内置 DeepSeek 价目表（官网空闲时段价，2026-08 版；可通过配置覆盖/扩充） */
export const DEFAULT_DEEPSEEK_PRICES: Record<string, DeepseekModelPrice> = {
  'deepseek-v4-flash': { inputMiss: 1.5, inputHit: 0.05, output: 4.5 },
  'deepseek-v4-pro': { inputMiss: 4.5, inputHit: 0.15, output: 13.5 },
  'deepseek-v4-flash-vision-exp': { inputMiss: 1.5, inputHit: 0.05, output: 4.5 },
}

/** 计费计划：路由归属（DeepSeek / 本地）+ 单价 + 本地电费参数 */
export interface CostPlan {
  /** DeepSeek 官方 provider 名（费用按价目表估算） */
  deepseekProvider: string
  /** 按电费估算的本地 provider 名列表 */
  localProviders: string[]
  /** DeepSeek 价目表（模型名 → 单价；内置默认 + 配置覆盖） */
  deepseekPrices: Record<string, DeepseekModelPrice>
  /**
   * 本地模型名 → 远端价目表模型名映射。键按**前缀匹配**（精确命中优先，
   * 其次最长前缀），一条 `'Qwen3.8-27B': 'deepseek-v4-flash'` 即可覆盖
   * `Qwen3.8-27B-UD-IQ4_XS-176K-Text-MTP` 等量化变体；未命中映射时按
   * 同名（模型名本身）查价目表。
   */
  localToRemoteModel: Record<string, string>
  /**
   * 未映射（映射与同名都查不到价目表）本地模型的兜底远端计费模型名；
   * null = 不兜底（等价远端费用 0）。
   */
  localFallbackRemoteModel: string | null
  /** 本地电价（元/千瓦时） */
  localPricePerKwh: number
  /** 本地整机功耗（瓦） */
  localPowerWatts: number
  /** 本地输出（decode）吞吐（tokens/秒） */
  localDecodeTps: number
  /** 本地未命中输入（prefill）吞吐（tokens/秒） */
  localPrefillTps: number
}

/**
 * 默认计费计划（与配置缺省一致）。
 *
 * 本地电费口径：只对真正消耗 GPU 算力的 token 折算时间——输出（decode）
 * 与未命中输入（prefill）按各自吞吐折算，缓存读/写近似不计（从 KV 缓存
 * 拉取，能耗可忽略）；总电费不超过"窗口天数 × 24h 满载"的物理上限。
 *
 * 等价远端兜底：本地量化模型名（如 Qwen3.8-27B-UD-IQ4_XS-…）查不到价目表
 * 时默认按 deepseek-v4-flash 官网价估算（可配置覆盖或关闭）——"本地跑 vs
 * 远端 API"对比的保守参考。
 */
export function defaultCostPlan(): CostPlan {
  return {
    deepseekProvider: 'deepseek-official',
    localProviders: ['llama-local', 'sglang-local', 'vllm-local', 'ollama'],
    deepseekPrices: { ...DEFAULT_DEEPSEEK_PRICES },
    localToRemoteModel: {},
    localFallbackRemoteModel: 'deepseek-v4-flash',
    localPricePerKwh: 0.6,
    localPowerWatts: 600,
    localDecodeTps: 50,
    localPrefillTps: 1000,
  }
}

/**
 * 费用估算结果（元）。
 *
 * 语义：`totalYuan` = 实际费用（DeepSeek API + 本地电费）；`remoteYuan` =
 * "若全部走远端"的反事实费用（DeepSeek 路由即其本身费用，本地路由按同名/
 * 映射模型官网价估算）；`savedYuan` = 折算节约 = `remoteYuan - totalYuan`
 * （仅本地路由贡献，可为负——本地部署比远端更贵的信号）。
 */
export interface CostEstimate {
  /** DeepSeek 官方 API 估算费用 */
  deepseekYuan: number
  /** 本地模型电费估算 */
  localYuan: number
  /** 等价远端费用：本地 token 若走 DeepSeek API 的假设费用（含 DeepSeek 路由本身） */
  remoteYuan: number
  /** 折算节约：remoteYuan - totalYuan（机会成本口径，非现金节约） */
  savedYuan: number
  /** 合计（实际费用） */
  totalYuan: number
}

/** 零费用 */
export function zeroCost(): CostEstimate {
  return { deepseekYuan: 0, localYuan: 0, remoteYuan: 0, savedYuan: 0, totalYuan: 0 }
}

/** 费用累加（与 addUsage 对称）；totalYuan 恒 = deepseek + local，不重复累加 */
export function addCost(a: CostEstimate, b: CostEstimate): CostEstimate {
  const deepseekYuan = a.deepseekYuan + b.deepseekYuan
  const localYuan = a.localYuan + b.localYuan
  return {
    deepseekYuan,
    localYuan,
    remoteYuan: a.remoteYuan + b.remoteYuan,
    savedYuan: a.savedYuan + b.savedYuan,
    totalYuan: deepseekYuan + localYuan,
  }
}

/** 按价目表计 DeepSeek 费用（命中/未命中分档，缓存写归未命中） */
function remoteFee(usage: UsageBuckets, price: DeepseekModelPrice): number {
  const miss = (usage.inputTokens + usage.cacheWriteTokens) / 1e6 * price.inputMiss
  const hit = usage.cacheReadTokens / 1e6 * price.inputHit
  const out = usage.outputTokens / 1e6 * price.output
  return miss + hit + out
}

/**
 * 解析本地模型名的远端计费模型：先查 localToRemoteModel（精确命中优先，
 * 其次最长前缀匹配），未命中则回退同名（模型名本身）。返回值仅用于查
 * 价目表，价目表查不到时由调用方决定兜底。
 */
export function remoteModelOf(plan: CostPlan, model: string): string {
  const exact = plan.localToRemoteModel[model]
  if (exact !== undefined) return exact
  let bestKey: string | null = null
  for (const key of Object.keys(plan.localToRemoteModel)) {
    if (key.length === 0) continue
    if (model.startsWith(key) && (bestKey === null || key.length > bestKey.length)) {
      bestKey = key
    }
  }
  return bestKey === null ? model : plan.localToRemoteModel[bestKey]!
}

/**
 * 单路由费用估算（对聚合 usage 直接计算——费用是 token 数的线性函数，
 * 与逐样本累加等价；物理上限兜底由 buildReport 统一施加）。
 *
 * 归属规则：provider 匹配 deepseekProvider → 按价目表计费（模型不在价目表
 * 内不计费），该路由本身就是远端费用（remoteYuan = deepseekYuan，节约为 0）；
 * provider 在 localProviders → 电费 = (输出 ÷ decode 吞吐 + 未命中输入 ÷
 * prefill 吞吐) × 功耗 × 电价（缓存读/写不计），并额外估算"若走远端"的
 * 等价费用（按 localToRemoteModel 前缀映射或同名模型查价目表，仍查不到
 * 时按 localFallbackRemoteModel 兜底，再查不到为 0），折算节约 =
 * 等价远端费用 − 电费（可为负）；其余（未知/未配置计费）→ 零费用。
 */
export function estimateRouteCost(route: string, usage: UsageBuckets, plan: CostPlan): CostEstimate {
  const slash = route.indexOf('/')
  if (slash <= 0 || slash === route.length - 1) return zeroCost()
  const provider = route.slice(0, slash)
  const model = route.slice(slash + 1)
  if (provider === plan.deepseekProvider) {
    const price = plan.deepseekPrices[model]
    if (price === undefined) return zeroCost()
    const totalYuan = remoteFee(usage, price)
    return { deepseekYuan: totalYuan, localYuan: 0, remoteYuan: totalYuan, savedYuan: 0, totalYuan }
  }
  if (plan.localProviders.includes(provider)) {
    const seconds = usage.outputTokens / plan.localDecodeTps
      + (usage.inputTokens + usage.cacheWriteTokens) / plan.localPrefillTps
    const kwh = seconds / 3600 * plan.localPowerWatts / 1000
    const localYuan = kwh * plan.localPricePerKwh
    const remoteModel = remoteModelOf(plan, model)
    let price = plan.deepseekPrices[remoteModel]
    if (price === undefined && plan.localFallbackRemoteModel !== null) {
      price = plan.deepseekPrices[plan.localFallbackRemoteModel]
    }
    const remoteYuan = price === undefined ? 0 : remoteFee(usage, price)
    return {
      deepseekYuan: 0,
      localYuan,
      remoteYuan,
      savedYuan: remoteYuan - localYuan,
      totalYuan: localYuan,
    }
  }
  return zeroCost()
}

/** 本地时区日期键 YYYY-MM-DD */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 路由展示名 */
export function routeLabel(route: RouteKey | null): string {
  return route === null ? 'unknown' : `${route.provider}/${route.model}`
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** provider/model 对守卫（两字段均为非空字符串） */
export function isRoutePair(value: unknown): value is RouteKey {
  if (typeof value !== 'object' || value === null) return false
  const pair = value as Record<string, unknown>
  return typeof pair['provider'] === 'string' && pair['provider'].length > 0
    && typeof pair['model'] === 'string' && pair['model'].length > 0
}

/**
 * 归一化一条 TokenUsage 记录；非法（缺必填字段/负数/非数值）返回 null。
 * 可选桶缺失补 0 —— 聚合桶五字段恒在。
 */
export function normalizeUsage(raw: unknown): UsageBuckets | null {
  if (typeof raw !== 'object' || raw === null) return null
  const u = raw as Record<string, unknown>
  const inputTokens = u['inputTokens']
  const outputTokens = u['outputTokens']
  if (!isFiniteNumber(inputTokens) || inputTokens < 0) return null
  if (!isFiniteNumber(outputTokens) || outputTokens < 0) return null
  const optional = (v: unknown): number => (isFiniteNumber(v) && v >= 0 ? v : 0)
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: optional(u['cacheReadTokens']),
    cacheWriteTokens: optional(u['cacheWriteTokens']),
    reasoningTokens: optional(u['reasoningTokens']),
  }
}

// ---------- 折叠（去重累加） ----------

/** 新建一个会话折叠器 */
export function createSessionFold(meta: { cwd?: string; agentPreset?: string; createdAt: number }): SessionFold {
  return { meta, requests: 0, totals: emptyUsage(), lastActivity: 0, byDay: {}, route: null, last: null }
}

/**
 * 把一条 usage 样本折进会话状态（原地修改，批量重放与实时事件共用）。
 *
 * 语义：同一 (turn, step) 的重复样本替换旧值 —— 会话 totals、日桶用量、
 * 路由桶用量都做"减旧加新"，路由请求数从旧路由转到新路由（最终样本的
 * 路由持有该次调用的请求计数）；新步骤的样本才使会话/日桶 requests +1。
 */
export function foldUsageSample(fold: SessionFold, sample: UsageSample): void {
  const previous = fold.last !== null
    && fold.last.turn === sample.turn
    && fold.last.step === sample.step
    ? fold.last
    : null
  if (previous !== null && usageEqual(previous.buckets, sample.usage)) return

  if (previous !== null) {
    // 替换：先减去旧样本（会话总量 + 旧日桶/旧路由桶）
    fold.totals = subUsage(fold.totals, previous.buckets)
    removeSample(fold.byDay, previous.time, previous.route, previous.buckets)
    adjustRouteRequest(fold.byDay, previous.time, routeLabel(previous.route), -1)
  } else {
    fold.requests += 1
    adjustDayRequest(fold.byDay, sample.time, 1)
  }
  // 加新
  fold.totals = addUsage(fold.totals, sample.usage)
  addSample(fold.byDay, sample.time, sample.route, sample.usage)
  adjustRouteRequest(fold.byDay, sample.time, routeLabel(sample.route), 1)
  fold.lastActivity = Math.max(fold.lastActivity, sample.time)
  fold.last = { turn: sample.turn, step: sample.step, time: sample.time, route: sample.route, buckets: sample.usage }
}

/**
 * 批量折叠一段会话日志到会话状态（session/created 公告重放；原地修改 fold）。
 *
 * 逐事件推进 title / route / usage，顺序语义与实时事件流完全一致（重放幂等：
 * 同步骤样本替换、新步骤才计请求）。调用方负责传入**该会话自身产生的事件**：
 * fork 继承前缀的子会话（DSH `Session.inheritedEventCount` > 0）必须传
 * `session.ownEvents()`（继承前缀的 usage 属于父会话条目，整段折叠会把父
 * 会话历史重复计入本会话与全部聚合行）。普通/恢复会话前缀为 0，整段即自身。
 */
export function foldSessionEvents(fold: SessionFold, events: readonly FoldableEvent[]): void {
  for (const event of events) {
    const title = titleFromEvent(event)
    if (title !== undefined) fold.title = title
    const route = routeFromEvent(event)
    if (route !== null) fold.route = route
    const sample = sampleFromEvent(event, fold.route)
    if (sample === null) continue
    foldUsageSample(fold, sample)
  }
}

/** 从日桶中减去一个样本的用量（请求数由 adjustDayRequest/adjustRouteRequest 维护） */
function removeSample(byDay: Record<string, DayAgg>, time: number, route: RouteKey | null, usage: UsageBuckets): void {
  const day = dayKey(time)
  const bucket = byDay[day]
  if (bucket === undefined) return
  bucket.usage = subUsage(bucket.usage, usage)
  const key = routeLabel(route)
  const rb = bucket.byRoute[key]
  if (rb !== undefined) rb.usage = subUsage(rb.usage, usage)
  if (bucket.requests === 0 && Object.keys(bucket.byRoute).length === 0 && usageEqual(bucket.usage, emptyUsage())) {
    delete byDay[day]
  }
}

/** 向日桶中加一个样本的用量（请求数由 adjustDayRequest/adjustRouteRequest 维护） */
function addSample(byDay: Record<string, DayAgg>, time: number, route: RouteKey | null, usage: UsageBuckets): void {
  const day = dayKey(time)
  let bucket = byDay[day]
  if (bucket === undefined) {
    bucket = { requests: 0, usage: emptyUsage(), byRoute: {} }
    byDay[day] = bucket
  }
  bucket.usage = addUsage(bucket.usage, usage)
  const key = routeLabel(route)
  let rb = bucket.byRoute[key]
  if (rb === undefined) {
    rb = { requests: 0, usage: emptyUsage() }
    bucket.byRoute[key] = rb
  }
  rb.usage = addUsage(rb.usage, usage)
}

/** 日桶请求数增减（新步骤的首个样本归属其所在日） */
function adjustDayRequest(byDay: Record<string, DayAgg>, time: number, delta: number): void {
  const day = dayKey(time)
  let bucket = byDay[day]
  if (bucket === undefined) {
    if (delta > 0) {
      bucket = { requests: 0, usage: emptyUsage(), byRoute: {} }
      byDay[day] = bucket
    } else {
      return
    }
  }
  bucket.requests += delta
}

/** 路由桶请求数增减；减到 0 且用量清零的路由条目被清理 */
function adjustRouteRequest(byDay: Record<string, DayAgg>, time: number, routeKey: string, delta: number): void {
  const bucket = byDay[dayKey(time)]
  if (bucket === undefined) return
  const rb = bucket.byRoute[routeKey]
  if (rb === undefined) {
    if (delta > 0) bucket.byRoute[routeKey] = { requests: delta, usage: emptyUsage() }
    return
  }
  rb.requests += delta
  if (rb.requests <= 0 && usageEqual(rb.usage, emptyUsage())) delete bucket.byRoute[routeKey]
}

/** 一条样本进入日桶时是否"新步骤"（请求计数归属在 foldUsageSample 内完成） */
export function isStepBoundary(fold: SessionFold, turn: number, step: number): boolean {
  return fold.last === null || fold.last.turn !== turn || fold.last.step !== step
}

/** 折叠器 → 持久化会话统计（丢弃内存态 last 槽位） */
export function foldToStored(fold: SessionFold): StoredSession {
  return {
    ...fold.meta.cwd === undefined ? {} : { cwd: fold.meta.cwd },
    ...fold.meta.agentPreset === undefined ? {} : { agentPreset: fold.meta.agentPreset },
    ...fold.title === undefined ? {} : { title: fold.title },
    createdAt: fold.meta.createdAt,
    requests: fold.requests,
    totals: fold.totals,
    lastActivity: fold.lastActivity,
    byDay: fold.byDay,
  }
}

/**
 * 从一条会话事件提取 usage 样本（无样本返回 null）。
 *
 * 事件来源：批量重放（session.snapshotEvents() 全量）或实时（session/event）。
 * 路由归属：assistant/message 用 message.source（该消息的权威模型来源）；
 * chunk 样本用 `routeAt`（调用方维护的最近路由，来自 request/context 或
 * request/header）。
 */
export function sampleFromEvent(
  event: FoldableEvent,
  routeAt: RouteKey | null,
): UsageSample | null {
  const data = event.data
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (event.type === 'assistant/chunk') {
    const chunk = d['chunk']
    if (typeof chunk !== 'object' || chunk === null) return null
    const c = chunk as Record<string, unknown>
    if (c['type'] !== 'usage') return null
    const usage = normalizeUsage(c['usage'])
    if (usage === null) return null
    if (!isFiniteNumber(d['turn']) || !isFiniteNumber(d['step'])) return null
    return { turn: d['turn'], step: d['step'], time: event.time, route: routeAt, source: 'chunk', usage }
  }
  if (event.type === 'assistant/message') {
    const usage = normalizeUsage(d['usage'])
    if (usage === null) return null
    if (!isFiniteNumber(d['turn']) || !isFiniteNumber(d['step'])) return null
    const message = d['message']
    const source = typeof message === 'object' && message !== null ? (message as Record<string, unknown>)['source'] : null
    return {
      turn: d['turn'],
      step: d['step'],
      time: event.time,
      route: isRoutePair(source) ? { provider: source.provider, model: source.model } : null,
      source: 'message',
      usage,
    }
  }
  return null
}

/**
 * 从一条事件提取路由更新（request/context 或 request/header）；无更新返回 null。
 */
export function routeFromEvent(event: FoldableEvent): RouteKey | null {
  const data = event.data
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (event.type === 'request/context' && isRoutePair(d)) {
    return { provider: d.provider, model: d.model }
  }
  if (event.type === 'request/header') {
    const header = d['header']
    const config = typeof header === 'object' && header !== null ? (header as Record<string, unknown>)['config'] : null
    if (isRoutePair(config)) return { provider: config.provider, model: config.model }
  }
  return null
}

/**
 * 从一条 session/title 事件提取会话标题（去空白）；非标题事件返回 undefined。
 * 与 DSH 标题投影一致：最新事件胜出（调用方按日志顺序应用）。
 */
export function titleFromEvent(event: FoldableEvent): string | undefined {
  const data = event.data
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  if (event.type !== 'session/title') return undefined
  const title = d['title']
  return typeof title === 'string' && title.trim().length > 0 ? title.trim() : undefined
}

// ---------- 状态持久化 ----------

export const STATE_VERSION = 1

/** 状态文件路径：<dir>/token-stats.json */
export function stateFilePath(dir: string): string {
  return join(dir, 'token-stats.json')
}

/** 空状态 */
export function emptyState(): TokenStatsState {
  return { version: 1, sessions: {} }
}

/**
 * 读取状态文件；不存在/损坏返回空状态（损坏时由调用方决定是否告警）。
 * 只做宽松校验：顶层形状 + 每个会话的关键字段；字段缺失的会话按空统计处理。
 */
export function loadState(file: string): TokenStatsState {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return emptyState()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyState()
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyState()
  const root = parsed as Record<string, unknown>
  const sessionsRaw = root['sessions']
  if (typeof sessionsRaw !== 'object' || sessionsRaw === null) return emptyState()
  const sessions: Record<string, StoredSession> = {}
  for (const [id, value] of Object.entries(sessionsRaw as Record<string, unknown>)) {
    const stored = sanitizeStoredSession(value)
    if (stored !== null) sessions[id] = stored
  }
  return { version: 1, sessions }
}

/** 宽松校验单会话记录；非法返回 null */
export function sanitizeStoredSession(value: unknown): StoredSession | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const totals = normalizeUsage(v['totals'])
  if (totals === null) return null
  const byDay: Record<string, DayAgg> = {}
  const byDayRaw = v['byDay']
  if (typeof byDayRaw === 'object' && byDayRaw !== null) {
    for (const [day, dayValue] of Object.entries(byDayRaw as Record<string, unknown>)) {
      const dv = dayValue as Record<string, unknown>
      if (typeof dv !== 'object' || dv === null) continue
      const usage = normalizeUsage(dv['usage'])
      if (usage === null) continue
      const byRoute: Record<string, RouteAgg> = {}
      const byRouteRaw = dv['byRoute']
      if (typeof byRouteRaw === 'object' && byRouteRaw !== null) {
        for (const [route, rv] of Object.entries(byRouteRaw as Record<string, unknown>)) {
          const rr = rv as Record<string, unknown>
          const ru = normalizeUsage(rr?.['usage'])
          if (ru === null) continue
          byRoute[route] = {
            requests: isFiniteNumber(rr['requests']) && rr['requests'] >= 0 ? rr['requests'] : 0,
            usage: ru,
          }
        }
      }
      byDay[day] = {
        requests: isFiniteNumber(dv['requests']) && dv['requests'] >= 0 ? dv['requests'] : 0,
        usage,
        byRoute,
      }
    }
  }
  return {
    ...typeof v['cwd'] === 'string' ? { cwd: v['cwd'] } : {},
    ...typeof v['agentPreset'] === 'string' ? { agentPreset: v['agentPreset'] } : {},
    ...typeof v['title'] === 'string' && v['title'].length > 0 ? { title: v['title'] } : {},
    createdAt: isFiniteNumber(v['createdAt']) ? v['createdAt'] : 0,
    requests: isFiniteNumber(v['requests']) && v['requests'] >= 0 ? v['requests'] : 0,
    totals,
    lastActivity: isFiniteNumber(v['lastActivity']) && v['lastActivity'] >= 0 ? v['lastActivity'] : 0,
    byDay,
  }
}

/** 写状态文件（先写临时文件再原子改名，避免半截文件） */
export function saveState(file: string, state: TokenStatsState): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(state), 'utf8')
  renameSync(tmp, file)
}

// ---------- 报告 ----------

export interface RecentCommitRow extends RecentCommit {
  routeLabel: string
  totalTokens: number
  /** 会话标题（从状态解析；无标题事件时省略） */
  title?: string
}

export interface SessionReportRow {
  sessionId: string
  /** 会话标题（无标题事件时省略） */
  title?: string
  cwd?: string
  agentPreset?: string
  requests: number
  usage: UsageBuckets
  totalTokens: number
  /** 估算费用（元）：DeepSeek 官网空闲时段价 + 本地电费 */
  costYuan: number
  lastActivity: number
  routes: string[]
}

export interface DayReportRow {
  day: string
  requests: number
  usage: UsageBuckets
  totalTokens: number
  /** 估算费用（元） */
  costYuan: number
}

export interface RouteReportRow {
  route: string
  requests: number
  usage: UsageBuckets
  totalTokens: number
  /** 费用细分（DeepSeek / 本地电费） */
  cost: CostEstimate
}

export interface TotalReport {
  requests: number
  usage: UsageBuckets
  totalTokens: number
  /** 费用细分（DeepSeek / 本地电费） */
  cost: CostEstimate
}

export interface StatsReport {
  generatedAt: number
  /** 请求的窗口天数；null = 全部历史 */
  windowDays: number | null
  /** 窗口起始日（YYYY-MM-DD）；null = 全部历史 */
  windowFrom: string | null
  total: TotalReport
  /** 窗口内有用量的会话数 */
  sessionCount: number
  /** 状态中跟踪的全部会话数 */
  trackedSessionCount: number
  bySession: SessionReportRow[]
  byDay: DayReportRow[]
  byRoute: RouteReportRow[]
  recent: RecentCommitRow[]
}

export interface ReportOptions {
  /** 只统计最近 N 个自然日（含今天）；省略 = 全部历史。上限 3650。 */
  days?: number
  /** 只统计指定会话（id 精确或前缀匹配） */
  sessionId?: string
  /** bySession 行数上限，默认 10，最大 100 */
  limit?: number
  /** "现在"（用于窗口计算） */
  now: number
  /** 最近调用环形缓冲（内存态） */
  recent: RecentCommit[]
  /** recent 段行数上限，默认 10，最大 50 */
  recentLimit?: number
  /** 计费计划（费用估算）；必填 */
  costPlan: CostPlan
}

/**
 * 从状态构建报告。
 *
 * 窗口过滤按"会话 × 日"粒度：窗口内的请求数/用量从会话 byDay 求和，
 * 因此 byRoute 与窗口严格一致。无窗口时直接用会话 totals。
 */
export function buildReport(state: TokenStatsState, opts: ReportOptions): StatsReport {
  const days = opts.days !== undefined && opts.days >= 1 ? Math.min(opts.days, 3650) : null
  const windowFrom = days === null ? null : dayKey(opts.now - (days - 1) * 86_400_000)
  const windowStartMs = windowFrom === null ? -Infinity : new Date(`${windowFrom}T00:00:00`).getTime()
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 10)), 100)
  const recentLimit = Math.min(Math.max(1, Math.floor(opts.recentLimit ?? 10)), 50)
  const idFilter = opts.sessionId?.trim()
  const costPlan = opts.costPlan

  const matches = (id: string): boolean =>
    idFilter === undefined || id === idFilter || id.startsWith(idFilter)

  const byDayAcc: Record<string, DayAgg> = {}
  const dayCostAcc: Record<string, CostEstimate> = {}
  const byRouteAcc: Record<string, RouteAgg> = {}
  const sessionRows: SessionReportRow[] = []
  /** 与会话行对齐的费用细分（物理上限按比例分摊时使用） */
  const sessionCostAcc: CostEstimate[] = []
  let totalRequests = 0
  let totalUsage = emptyUsage()
  let sessionCount = 0

  const accRoute = (route: string, rb: RouteAgg): void => {
    let acc = byRouteAcc[route]
    if (acc === undefined) {
      acc = { requests: 0, usage: emptyUsage() }
      byRouteAcc[route] = acc
    }
    acc.requests += rb.requests
    acc.usage = addUsage(acc.usage, rb.usage)
  }

  for (const [id, session] of Object.entries(state.sessions)) {
    if (!matches(id)) continue
    // 窗口内（或全部历史）的会话级请求数/用量 + 按日/按路由聚合
    let requests = 0
    let usage: UsageBuckets = emptyUsage()
    let cost = zeroCost()
    const routes: string[] = []
    for (const [day, agg] of Object.entries(session.byDay)) {
      if (windowFrom !== null && day < windowFrom) continue
      requests += agg.requests
      usage = addUsage(usage, agg.usage)
      let dayAcc = byDayAcc[day]
      if (dayAcc === undefined) {
        dayAcc = { requests: 0, usage: emptyUsage(), byRoute: {} }
        byDayAcc[day] = dayAcc
      }
      dayAcc.requests += agg.requests
      dayAcc.usage = addUsage(dayAcc.usage, agg.usage)
      for (const [route, rb] of Object.entries(agg.byRoute)) {
        routes.push(route)
        accRoute(route, rb)
        const routeCost = estimateRouteCost(route, rb.usage, costPlan)
        cost = addCost(cost, routeCost)
        const dayCost = dayCostAcc[day] ?? zeroCost()
        dayCostAcc[day] = addCost(dayCost, routeCost)
      }
    }
    if (windowFrom === null) {
      // 全部历史窗口直接用会话累计值（byDay 求和与其一致，累计值更直接）
      requests = session.requests
      usage = session.totals
    }
    if (requests <= 0 && usageEqual(usage, emptyUsage())) continue
    sessionCount += 1
    totalRequests += requests
    totalUsage = addUsage(totalUsage, usage)
    sessionRows.push({
      sessionId: id,
      ...session.title === undefined ? {} : { title: session.title },
      ...session.cwd === undefined ? {} : { cwd: session.cwd },
      ...session.agentPreset === undefined ? {} : { agentPreset: session.agentPreset },
      requests,
      usage,
      totalTokens: totalTokens(usage),
      costYuan: cost.totalYuan,
      lastActivity: session.lastActivity,
      routes: Array.from(new Set(routes)),
    })
    sessionCostAcc.push(cost)
  }

  sessionRows.sort((a, b) => b.totalTokens - a.totalTokens || b.lastActivity - a.lastActivity)

  const byRoute: RouteReportRow[] = Object.entries(byRouteAcc)
    .map(([route, agg]) => ({
      route,
      requests: agg.requests,
      usage: agg.usage,
      totalTokens: totalTokens(agg.usage),
      cost: estimateRouteCost(route, agg.usage, costPlan),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens)

  // 总费用 = 窗口内各路由费用之和（按 route 归属天然区分 DeepSeek / 本地）
  let totalCost = zeroCost()
  for (const row of byRoute) totalCost = addCost(totalCost, row.cost)

  // 物理上限兜底：有限窗口下本地电费不超过"窗口天数 × 24h 满载"电费；
  // 超出时按比例分摊到各本地路由/日/会话（DeepSeek 费用不动；等价远端费用
  // 是 token 的线性函数，不受上限影响，按比例分摊后重算折算节约）。
  let localScale = 1
  if (days !== null && totalCost.localYuan > 0) {
    const cap = days * 24 * costPlan.localPowerWatts / 1000 * costPlan.localPricePerKwh
    if (totalCost.localYuan > cap) localScale = cap / totalCost.localYuan
  }
  if (localScale < 1) {
    const applyLocal = (c: CostEstimate): CostEstimate => {
      if (c.localYuan === 0) return c
      const localYuan = c.localYuan * localScale
      return {
        deepseekYuan: c.deepseekYuan,
        localYuan,
        remoteYuan: c.remoteYuan,
        savedYuan: c.remoteYuan - localYuan,
        totalYuan: c.deepseekYuan + localYuan,
      }
    }
    totalCost = applyLocal(totalCost)
    for (const row of byRoute) row.cost = applyLocal(row.cost)
    for (const [day, cost] of Object.entries(dayCostAcc)) dayCostAcc[day] = applyLocal(cost)
    for (let i = 0; i < sessionCostAcc.length; i += 1) sessionCostAcc[i] = applyLocal(sessionCostAcc[i]!)
  }
  for (let i = 0; i < sessionRows.length; i += 1) {
    sessionRows[i]!.costYuan = sessionCostAcc[i]!.totalYuan
  }
  const bySession = sessionRows.slice(0, limit)

  const byDay: DayReportRow[] = Object.entries(byDayAcc)
    .map(([day, agg]) => ({
      day,
      requests: agg.requests,
      usage: agg.usage,
      totalTokens: totalTokens(agg.usage),
      costYuan: (dayCostAcc[day] ?? zeroCost()).totalYuan,
    }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))

  const recent: RecentCommitRow[] = opts.recent
    .filter(c => c.time >= windowStartMs && matches(c.sessionId))
    .sort((a, b) => b.time - a.time)
    .slice(0, recentLimit)
    .map(c => {
      const title = state.sessions[c.sessionId]?.title
      return {
        ...c,
        routeLabel: routeLabel(c.route),
        totalTokens: totalTokens(c.usage),
        ...title === undefined ? {} : { title },
      }
    })

  return {
    generatedAt: opts.now,
    windowDays: days,
    windowFrom,
    total: { requests: totalRequests, usage: totalUsage, totalTokens: totalTokens(totalUsage), cost: totalCost },
    sessionCount,
    trackedSessionCount: Object.keys(state.sessions).length,
    bySession,
    byDay,
    byRoute,
    recent,
  }
}

// ---------- 渲染（模型可见文本） ----------

const fmtInt = (n: number): string => n.toLocaleString('en-US')

const fmtTime = (ts: number): string => {
  if (ts <= 0) return '-'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const fmtYuan = (y: number): string => `¥${y.toFixed(2)}`

const fmtDateTime = (ts: number): string => {
  if (ts <= 0) return '-'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 会话显示标签：有标题时 "标题（短id）"，否则仅短 id（提升可读性） */
export function sessionLabel(title: string | undefined, shortId: string): string {
  return title === undefined || title.length === 0 ? shortId : `${title}（${shortId}）`
}

/** 渲染报告为模型可见的中文摘要文本 */
export function renderReport(report: StatsReport): string {
  const lines: string[] = []
  const t = report.total
  const windowDesc = report.windowDays === null
    ? '全部历史'
    : `最近 ${report.windowDays} 天（自 ${report.windowFrom} 起）`
  lines.push(`【Token 用量统计】窗口：${windowDesc}`)
  lines.push(
    `会话 ${report.sessionCount}/${report.trackedSessionCount} 个（有用量/已跟踪），模型调用 ${fmtInt(t.requests)} 次`,
  )
  const u = t.usage
  lines.push(
    `输入 ${fmtInt(u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens)} tokens`
    + `（未缓存 ${fmtInt(u.inputTokens)} · 缓存读 ${fmtInt(u.cacheReadTokens)} · 缓存写 ${fmtInt(u.cacheWriteTokens)}）`,
  )
  lines.push(`输出 ${fmtInt(u.outputTokens)} tokens（含推理 ${fmtInt(u.reasoningTokens)}）`)
  lines.push(`合计 ${fmtInt(t.totalTokens)} tokens`)
  const c = t.cost
  lines.push(
    `估算费用 ${fmtYuan(c.totalYuan)}`
    + `（实际：DeepSeek API ${fmtYuan(c.deepseekYuan)} · 本地电费 ${fmtYuan(c.localYuan)}；`
    + `若全部走远端约 ${fmtYuan(c.remoteYuan)}，折算节约 ${fmtYuan(c.savedYuan)}。`
    + '低估口径：DeepSeek 官网空闲时段价、本地按 GPU 负载折算电费且不超过满载上限、'
    + '远端等价按同名/前缀映射模型（未映射兜底可配置）计）',
  )

  if (report.byRoute.length > 0) {
    lines.push('', '按模型：')
    for (const row of report.byRoute.slice(0, 10)) {
      lines.push(
        `  ${row.route}  调用 ${fmtInt(row.requests)}  输入 ${fmtInt(row.usage.inputTokens + row.usage.cacheReadTokens + row.usage.cacheWriteTokens)}`
        + `  输出 ${fmtInt(row.usage.outputTokens)}  合计 ${fmtInt(row.totalTokens)}  费用 ${fmtYuan(row.cost.totalYuan)}`,
      )
    }
  }

  if (report.byDay.length > 0) {
    const shown = report.byDay.slice(-7)
    lines.push('', `按日（最近 ${Math.min(7, report.byDay.length)} 天）：`)
    for (const row of shown) {
      lines.push(`  ${row.day}  调用 ${fmtInt(row.requests)}  合计 ${fmtInt(row.totalTokens)}  费用 ${fmtYuan(row.costYuan)}`)
    }
  }

  if (report.bySession.length > 0) {
    lines.push('', `按会话（TOP ${report.bySession.length}）：`)
    for (const row of report.bySession) {
      const shortId = row.sessionId.length > 19 ? `${row.sessionId.slice(0, 19)}…` : row.sessionId
      const label = sessionLabel(row.title, shortId)
      const cwd = row.cwd === undefined ? '' : `  ${row.cwd}`
      lines.push(
        `  ${label}${cwd}  调用 ${fmtInt(row.requests)}  输入 ${fmtInt(row.usage.inputTokens + row.usage.cacheReadTokens + row.usage.cacheWriteTokens)}`
        + `  输出 ${fmtInt(row.usage.outputTokens)}  合计 ${fmtInt(row.totalTokens)}  最近 ${fmtDateTime(row.lastActivity)}`,
      )
    }
  }

  if (report.recent.length > 0) {
    lines.push('', '最近调用：')
    for (const row of report.recent) {
      const u2 = row.usage
      lines.push(
        `  ${fmtTime(row.time)}  ${sessionLabel(row.title, row.sessionId.slice(0, 19))}  ${row.routeLabel}`
        + `  输入 ${fmtInt(u2.inputTokens + u2.cacheReadTokens + u2.cacheWriteTokens)}  输出 ${fmtInt(u2.outputTokens)}  [${row.source}]`,
      )
    }
  }

  return lines.join('\n')
}

// ---------- 最近调用环形缓冲 ----------

/** 追加一条最近调用；超出上限丢弃最旧条目（原地修改） */
export function pushRecent(buffer: RecentCommit[], limit: number, commit: RecentCommit): void {
  buffer.push(commit)
  if (buffer.length > limit) buffer.splice(0, buffer.length - limit)
}

// ---------- 小时直方图（看板按小时柱状图） ----------

export interface HourBucketRow {
  /** 桶起点（本地时区整点，epoch ms） */
  time: number
  /** 整点小时标签（HH，本地时区） */
  hour: string
  requests: number
  usage: UsageBuckets
  totalTokens: number
}

/**
 * 从最近调用环形缓冲构建固定轴的小时直方图（本地时区，含零桶）。
 *
 * 返回恰好 `hours` 个桶，从最旧到最新，最后一桶覆盖当前小时。
 * 缓冲覆盖早于窗口起点的小时恒为零——这是数据边界，由调用方按窗口选择呈现。
 * 超出轴范围的条目（时钟漂移产生的未来桶）被丢弃。
 */
export function hourlyHistogram(
  recent: readonly RecentCommit[],
  now: number,
  hours: number,
): HourBucketRow[] {
  const hourMs = 3_600_000
  const n = Math.max(1, Math.min(168, Math.trunc(hours)))
  const currentStart = Math.floor(now / hourMs) * hourMs
  const cutoff = currentStart - (n - 1) * hourMs
  const buckets: HourBucketRow[] = []
  for (let i = n - 1; i >= 0; i -= 1) {
    const time = currentStart - i * hourMs
    const hour = `${new Date(time).getHours()}`.padStart(2, '0')
    buckets.push({ time, hour, requests: 0, usage: emptyUsage(), totalTokens: 0 })
  }
  for (const commit of recent) {
    if (commit.time < cutoff) continue
    const idx = Math.floor((commit.time - currentStart) / hourMs) + n - 1
    if (idx < 0 || idx >= n) continue
    const bucket = buckets[idx]!
    bucket.requests += 1
    bucket.usage = addUsage(bucket.usage, commit.usage)
    bucket.totalTokens = totalTokens(bucket.usage)
  }
  return buckets
}

// ---------- 归档层（分层存储：热状态 + 只追加归档） ----------
//
// 性能模型：token-stats.json 只保存"本次进程内活跃/公告过的会话"（热层），
// 每次防抖落盘只写热层，体积与历史总量无关；会话在进程停止（finalizeOnStop）
// 时一次性追加进 archive.jsonl（每会话一行，之后不再改动）。查询路径把热层与
// 归档合并成"全量会话视图"，历史可完整追溯（durable 会话日志始终是最底层
// source of truth，归档只是派生缓存，会话再次公告时可整体重建，不会丢/重）。

export const ARCHIVE_VERSION = 1

/** 归档文件路径：<dir>/archive.jsonl（追加写；同 id 重复行以最后一行胜出） */
export function archiveFilePath(dir: string): string {
  return join(dir, 'archive.jsonl')
}

/** 归档行内容 */
export interface ArchiveLine {
  v: number
  id: string
  entry: StoredSession
  archivedAt: number
}

/** 序列化一行归档记录（单行 JSON，不换行） */
export function encodeArchiveLine(id: string, entry: StoredSession, archivedAt: number): string {
  return JSON.stringify({ v: ARCHIVE_VERSION, id, entry, archivedAt } as ArchiveLine)
}

/** 解析一行归档记录；空白/损坏/版本不符/条目非法返回 null */
export function parseArchiveLine(line: string): { id: string; entry: StoredSession; archivedAt: number } | null {
  const text = line.trim()
  if (text.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>
  if (p['v'] !== ARCHIVE_VERSION) return null
  const id = p['id']
  if (typeof id !== 'string' || id.length === 0) return null
  const entry = sanitizeStoredSession(p['entry'])
  if (entry === null) return null
  return { id, entry, archivedAt: isFiniteNumber(p['archivedAt']) ? p['archivedAt'] : 0 }
}

/** 统计归档文本：总行数（合法行）与重复 id 行数，用于压实判定 */
export function countArchiveDuplicates(text: string): { lines: number; duplicateLines: number } {
  const seen = new Set<string>()
  let lines = 0
  let duplicateLines = 0
  for (const line of text.split('\n')) {
    const parsed = parseArchiveLine(line)
    if (parsed === null) continue
    lines += 1
    if (seen.has(parsed.id)) {
      duplicateLines += 1
    } else {
      seen.add(parsed.id)
    }
  }
  return { lines, duplicateLines }
}

/** 归档文本 → 按会话去重的 Map（文件顺序，同 id 后写胜出） */
export function loadArchiveText(text: string): Map<string, StoredSession> {
  const map = new Map<string, StoredSession>()
  for (const line of text.split('\n')) {
    const parsed = parseArchiveLine(line)
    if (parsed === null) continue
    map.set(parsed.id, parsed.entry)
  }
  return map
}

/** Map → 归档文本（按 id 字典序，确定性输出；末尾换行） */
export function serializeArchive(map: Map<string, StoredSession>, archivedAt: number): string {
  const lines: string[] = []
  for (const id of [...map.keys()].sort()) {
    const entry = map.get(id)
    if (entry === undefined) continue
    lines.push(encodeArchiveLine(id, entry, archivedAt))
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

/** 读取归档文件并统计（不存在/损坏按空处理） */
export function readArchiveFile(file: string): { map: Map<string, StoredSession>; lines: number; duplicateLines: number } {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { map: new Map<string, StoredSession>(), lines: 0, duplicateLines: 0 }
  }
  const { lines, duplicateLines } = countArchiveDuplicates(raw)
  return { map: loadArchiveText(raw), lines, duplicateLines }
}

/** 全量重写归档（去重压实；先写临时文件再原子改名） */
export function rewriteArchive(file: string, map: Map<string, StoredSession>, archivedAt: number): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, serializeArchive(map, archivedAt), 'utf8')
  renameSync(tmp, file)
}

/** 追加一条会话归档记录（只追加不改写已有行） */
export function appendArchiveLine(file: string, id: string, entry: StoredSession, archivedAt: number): void {
  mkdirSync(join(file, '..'), { recursive: true })
  appendFileSync(file, `${encodeArchiveLine(id, entry, archivedAt)}\n`, 'utf8')
}

/**
 * 构建"全量会话视图"：热层优先，归档补齐缺失会话。
 *
 * 仅做引用级合并（不深拷贝条目），供 buildReport 等只读查询使用；
 * 视图与"插件持续运行"语义一致——热层条目（本次进程公告/活跃）覆盖归档
 * 中同 id 的上一次终态，避免重复计数。
 */
export function mergedSessions(
  hot: Record<string, StoredSession>,
  archived: Map<string, StoredSession>,
): Record<string, StoredSession> {
  const merged: Record<string, StoredSession> = { ...hot }
  for (const [id, entry] of archived) {
    if (!(id in merged)) merged[id] = entry
  }
  return merged
}
