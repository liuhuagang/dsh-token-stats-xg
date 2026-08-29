/**
 * dsh-token-stats-xg 纯逻辑层单元测试（Node 内置 test runner）。
 * 运行：node --test tests/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addCost,
  addUsage,
  buildReport,
  createSessionFold,
  dayKey,
  defaultCostPlan,
  emptyState,
  emptyUsage,
  estimateRouteCost,
  foldToStored,
  foldUsageSample,
  hourlyHistogram,
  loadState,
  normalizeUsage,
  pushRecent,
  renderReport,
  routeFromEvent,
  routeLabel,
  sampleFromEvent,
  saveState,
  stateFilePath,
  totalTokens,
  usageEqual,
  zeroCost,
} from '../lib/logic.js'

const ts = (s) => new Date(s).getTime()
const DAY_A = ts('2026-08-20T10:00:00') // 本地 08-20
const DAY_B = ts('2026-08-21T09:30:00') // 本地 08-21
const NOW = ts('2026-08-21T12:00:00')
const PLAN = defaultCostPlan()

const ev = (type, time, data) => ({ type, time, data })

/** 与插件入口一致的折叠驱动（路由跟踪 + 样本提取 + 折叠） */
function foldLog(events, meta = { createdAt: 0 }) {
  const fold = createSessionFold(meta)
  for (const event of events) {
    const route = routeFromEvent(event)
    if (route !== null) fold.route = route
    const sample = sampleFromEvent(event, fold.route)
    if (sample === null) continue
    foldUsageSample(fold, sample)
  }
  return fold
}

const U = (inputTokens, outputTokens, extra = {}) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: extra.cacheReadTokens ?? 0,
  cacheWriteTokens: extra.cacheWriteTokens ?? 0,
  reasoningTokens: extra.reasoningTokens ?? 0,
})

// ---------- normalizeUsage / 基础 ----------

test('normalizeUsage：合法记录归一化（缺省可选桶补 0）', () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 10, outputTokens: 5 }), U(10, 5))
  assert.deepEqual(
    normalizeUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 7 }),
    U(1, 2, { cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 7 }),
  )
})

test('normalizeUsage：非法记录返回 null', () => {
  assert.equal(normalizeUsage(null), null)
  assert.equal(normalizeUsage(42), null)
  assert.equal(normalizeUsage({ outputTokens: 1 }), null) // 缺 inputTokens
  assert.equal(normalizeUsage({ inputTokens: 1 }), null) // 缺 outputTokens
  assert.equal(normalizeUsage({ inputTokens: -1, outputTokens: 1 }), null)
  assert.equal(normalizeUsage({ inputTokens: '10', outputTokens: 1 }), null)
})

test('totalTokens：输入三桶 + 输出，推理不重复计', () => {
  assert.equal(totalTokens(U(100, 50, { cacheReadTokens: 30, cacheWriteTokens: 5, reasoningTokens: 20 })), 185)
  assert.equal(totalTokens(emptyUsage()), 0)
})

test('dayKey：本地日期键', () => {
  assert.equal(dayKey(DAY_A), '2026-08-20')
  assert.equal(dayKey(DAY_B), '2026-08-21')
})

test('routeLabel：null → unknown', () => {
  assert.equal(routeLabel(null), 'unknown')
  assert.equal(routeLabel({ provider: 'p', model: 'm' }), 'p/m')
})

// ---------- 折叠（去重累加） ----------

test('fold：chunk 样本被同步骤 message 最终样本替换，不重复计数', () => {
  const fold = foldLog([
    ev('assistant/chunk', DAY_A, { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } } }),
    ev('assistant/message', DAY_A, {
      turn: 0, step: 0,
      usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 7 },
      message: { source: { provider: 'p1', model: 'm1' } },
    }),
  ])
  assert.equal(fold.requests, 1)
  assert.deepEqual(fold.totals, U(100, 50, { reasoningTokens: 7 }))
  assert.equal(fold.last.step, 0)
})

test('fold：新步骤样本才计入请求数（跨日按日归属）', () => {
  const fold = foldLog([
    ev('request/header', DAY_A, { header: { config: { provider: 'p1', model: 'm1' } }, reason: 'initial' }),
    ev('assistant/message', DAY_A, {
      turn: 0, step: 0,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 5 },
      message: { source: { provider: 'p1', model: 'm1' } },
    }),
    ev('assistant/chunk', DAY_B, { turn: 0, step: 1, chunk: { type: 'usage', usage: { inputTokens: 200, outputTokens: 20, cacheWriteTokens: 3 } } }),
    ev('assistant/message', DAY_B, {
      turn: 0, step: 1,
      usage: { inputTokens: 200, outputTokens: 80, cacheWriteTokens: 3 },
      message: { source: { provider: 'p2', model: 'm2' } },
    }),
  ])
  assert.equal(fold.requests, 2)
  assert.deepEqual(fold.totals, U(300, 130, { cacheReadTokens: 5, cacheWriteTokens: 3 }))
  const dayA = fold.byDay['2026-08-20']
  const dayB = fold.byDay['2026-08-21']
  assert.deepEqual(dayA.usage, U(100, 50, { cacheReadTokens: 5 }))
  assert.equal(dayA.requests, 1)
  assert.deepEqual(dayB.usage, U(200, 80, { cacheWriteTokens: 3 }))
  // 步骤1 的 chunk 样本归属路由为 p1/m1（最近路由），message 最终样本归属 p2/m2：
  // 替换后 p2/m2 持有该步骤用量，p1/m1 只保留步骤0
  assert.deepEqual(fold.byDay['2026-08-21'].byRoute['p2/m2'].usage, U(200, 80, { cacheWriteTokens: 3 }))
  assert.equal(fold.byDay['2026-08-21'].byRoute['p1/m1'], undefined)
  assert.deepEqual(fold.byDay['2026-08-20'].byRoute['p1/m1'].usage, U(100, 50, { cacheReadTokens: 5 }))
})

test('fold：无 message 的失败请求保留 chunk 样本（请求级兜底）', () => {
  const fold = foldLog([
    ev('request/context', DAY_A, { provider: 'p1', model: 'm1' }),
    ev('assistant/chunk', DAY_A, { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 77, outputTokens: 0 } } }),
    // 请求失败：没有 assistant/message，也没有下一个步骤
  ])
  assert.equal(fold.requests, 1)
  assert.deepEqual(fold.totals, U(77, 0))
  assert.deepEqual(fold.byDay['2026-08-20'].byRoute['p1/m1'].usage, U(77, 0))
})

test('fold：同步骤等值样本重复到达不产生变化', () => {
  const fold = foldLog([
    ev('assistant/chunk', DAY_A, { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } } }),
    ev('assistant/message', DAY_A, {
      turn: 0, step: 0,
      usage: { inputTokens: 10, outputTokens: 1 },
      message: { source: { provider: 'p1', model: 'm1' } },
    }),
  ])
  assert.equal(fold.requests, 1)
  assert.deepEqual(fold.totals, U(10, 1))
})

test('fold：跨日替换样本在旧日桶中做减法', () => {
  const fold = createSessionFold({ createdAt: 0 })
  foldUsageSample(fold, { turn: 0, step: 0, time: DAY_A, route: null, source: 'chunk', usage: U(100, 10) })
  // 同一 (turn, step) 的最终样本时间落在次日（跨午夜长步骤），路由也变了
  foldUsageSample(fold, { turn: 0, step: 0, time: DAY_B, route: { provider: 'p', model: 'm' }, source: 'message', usage: U(100, 50) })
  assert.equal(fold.requests, 1)
  assert.deepEqual(fold.totals, U(100, 50))
  // 旧日桶用量被减回 0；请求数归属保持在首样本所在日；路由条目被清理
  const dayA = fold.byDay[dayKey(DAY_A)]
  assert.ok(dayA !== undefined)
  assert.equal(dayA.requests, 1)
  assert.ok(usageEqual(dayA.usage, emptyUsage()))
  assert.equal(dayA.byRoute['unknown'], undefined)
  assert.deepEqual(fold.byDay[dayKey(DAY_B)].usage, U(100, 50))
  assert.deepEqual(fold.byDay[dayKey(DAY_B)].byRoute['p/m'].usage, U(100, 50))
  assert.equal(fold.byDay[dayKey(DAY_B)].byRoute['p/m'].requests, 1)
})

test('foldToStored：丢弃内存态 last/route，保留聚合值', () => {
  const fold = foldLog([
    ev('assistant/message', DAY_A, {
      turn: 0, step: 0,
      usage: { inputTokens: 1, outputTokens: 2 },
      message: { source: { provider: 'p', model: 'm' } },
    }),
  ])
  const stored = foldToStored(fold)
  assert.ok('last' in stored === false)
  assert.ok('route' in stored === false)
  assert.equal(stored.requests, 1)
  assert.deepEqual(stored.totals, U(1, 2))
  assert.equal(stored.lastActivity, DAY_A)
})

// ---------- 事件提取 ----------

test('sampleFromEvent：只提取 usage 样本', () => {
  assert.equal(sampleFromEvent(ev('assistant/chunk', DAY_A, { turn: 0, step: 0, chunk: { type: 'text', text: 'hi' } }), null), null)
  assert.equal(sampleFromEvent(ev('assistant/chunk', DAY_A, { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 'x', outputTokens: 1 } } }), null), null)
  assert.equal(sampleFromEvent(ev('tool/call', DAY_A, { callId: 'c1' }), null), null)
  assert.equal(sampleFromEvent(ev('assistant/message', DAY_A, { turn: 0, step: 0, message: {} }), null), null) // 无 usage

  const sample = sampleFromEvent(
    ev('assistant/message', DAY_A, {
      turn: 1, step: 2,
      usage: { inputTokens: 3, outputTokens: 4 },
      message: { source: { provider: 'p9', model: 'm9' } },
    }),
    null,
  )
  assert.equal(sample.turn, 1)
  assert.equal(sample.step, 2)
  assert.equal(sample.source, 'message')
  assert.deepEqual(sample.route, { provider: 'p9', model: 'm9' })
  assert.deepEqual(sample.usage, U(3, 4))
})

test('sampleFromEvent：chunk 样本归属调用方传入的最近路由', () => {
  const sample = sampleFromEvent(
    ev('assistant/chunk', DAY_A, { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } } }),
    { provider: 'pc', model: 'mc' },
  )
  assert.deepEqual(sample.route, { provider: 'pc', model: 'mc' })
  assert.equal(sample.source, 'chunk')
})

test('routeFromEvent：request/context 与 request/header 提取路由', () => {
  assert.deepEqual(routeFromEvent(ev('request/context', DAY_A, { provider: 'p', model: 'm' })), { provider: 'p', model: 'm' })
  assert.deepEqual(routeFromEvent(ev('request/header', DAY_A, { header: { config: { provider: 'p', model: 'm' } } })), { provider: 'p', model: 'm' })
  assert.equal(routeFromEvent(ev('request/header', DAY_A, { header: { config: { provider: 'p', model: '' } } })), null)
  assert.equal(routeFromEvent(ev('step/start', DAY_A, { turn: 0, step: 0 })), null)
  assert.equal(routeFromEvent(ev('request/context', DAY_A, { provider: 'p' })), null) // 缺 model
})

// ---------- 状态持久化 ----------

test('saveState/loadState：往返一致；文件缺失/损坏回退空状态', () => {
  const dir = mkdtempSync(join(tmpdir(), 'token-stats-'))
  try {
    const file = stateFilePath(dir)
    assert.deepEqual(loadState(file), emptyState()) // 不存在

    const state = {
      version: 1,
      sessions: {
        'session-1': {
          cwd: 'D:\\work',
          createdAt: DAY_A,
          requests: 3,
          totals: U(10, 20, { cacheReadTokens: 2 }),
          lastActivity: DAY_B,
          byDay: {
            '2026-08-20': { requests: 2, usage: U(4, 8), byRoute: { 'p/m': { requests: 2, usage: U(4, 8) } } },
            '2026-08-21': { requests: 1, usage: U(6, 12, { cacheReadTokens: 2 }), byRoute: {} },
          },
        },
      },
    }
    saveState(file, state)
    const reloaded = loadState(file)
    assert.deepEqual(reloaded, state)

    writeFileSync(file, '{ not json', 'utf8')
    assert.deepEqual(loadState(file), emptyState()) // 损坏
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 报告 ----------

function twoSessionState() {
  const state = emptyState()
  state.sessions['session-aaa'] = {
    cwd: 'D:\\proj-a',
    agentPreset: 'cordis',
    createdAt: DAY_A - 1000,
    requests: 3,
    totals: U(100, 50, { cacheReadTokens: 10 }),
    lastActivity: DAY_B,
    byDay: {
      '2026-08-20': { requests: 2, usage: U(40, 20, { cacheReadTokens: 10 }), byRoute: { 'p1/m1': { requests: 2, usage: U(40, 20, { cacheReadTokens: 10 }) } } },
      '2026-08-21': { requests: 1, usage: U(60, 30), byRoute: { 'p1/m1': { requests: 1, usage: U(60, 30) } } },
    },
  }
  state.sessions['session-bbb'] = {
    createdAt: DAY_A,
    requests: 1,
    totals: U(10, 5),
    lastActivity: DAY_A,
    byDay: {
      '2026-08-20': { requests: 1, usage: U(10, 5), byRoute: { 'p2/m2': { requests: 1, usage: U(10, 5) } } },
    },
  }
  return state
}

test('buildReport：全部历史窗口（总量/按会话/按日/按模型）', () => {
  const report = buildReport(twoSessionState(), { now: NOW, recent: [], costPlan: PLAN })
  assert.equal(report.windowDays, null)
  assert.equal(report.total.requests, 4)
  assert.deepEqual(report.total.usage, U(110, 55, { cacheReadTokens: 10 }))
  assert.equal(report.total.totalTokens, 175)
  assert.equal(report.sessionCount, 2)
  assert.equal(report.trackedSessionCount, 2)
  // bySession 按 totalTokens 降序
  assert.equal(report.bySession[0].sessionId, 'session-aaa')
  assert.equal(report.bySession[1].sessionId, 'session-bbb')
  assert.equal(report.bySession[0].cwd, 'D:\\proj-a')
  assert.deepEqual(report.bySession[0].routes, ['p1/m1'])
  // byDay 升序
  assert.deepEqual(report.byDay.map(d => d.day), ['2026-08-20', '2026-08-21'])
  assert.equal(report.byDay[0].requests, 3)
  // byRoute 降序：p1/m1 = (40+20+10) + (60+30) = 160
  assert.equal(report.byRoute[0].route, 'p1/m1')
  assert.equal(report.byRoute[0].totalTokens, 160)
  assert.equal(report.byRoute[0].requests, 3)
})

test('buildReport：days 窗口只计窗口内用量（byRoute 同步过滤）', () => {
  const report = buildReport(twoSessionState(), { now: NOW, days: 1, recent: [], costPlan: PLAN })
  assert.equal(report.windowFrom, '2026-08-21')
  assert.equal(report.total.requests, 1)
  assert.deepEqual(report.total.usage, U(60, 30))
  assert.equal(report.sessionCount, 1)
  assert.equal(report.bySession[0].sessionId, 'session-aaa')
  assert.equal(report.byRoute.length, 1)
  assert.equal(report.byRoute[0].route, 'p1/m1')
  assert.deepEqual(report.byDay.map(d => d.day), ['2026-08-21'])
})

test('buildReport：sessionId 前缀过滤', () => {
  const report = buildReport(twoSessionState(), { now: NOW, sessionId: 'session-b', recent: [], costPlan: PLAN })
  assert.equal(report.sessionCount, 1)
  assert.equal(report.bySession[0].sessionId, 'session-bbb')
  assert.equal(report.total.requests, 1)
  assert.equal(report.trackedSessionCount, 2)
})

test('buildReport：limit 限制 bySession 行数（total 不受影响）', () => {
  const report = buildReport(twoSessionState(), { now: NOW, limit: 1, recent: [], costPlan: PLAN })
  assert.equal(report.bySession.length, 1)
  assert.equal(report.bySession[0].sessionId, 'session-aaa')
  assert.equal(report.total.requests, 4) // 总量仍含两个会话
})

test('buildReport：recent 按窗口过滤且倒序', () => {
  const recent = [
    { time: DAY_A, sessionId: 'session-aaa', route: { provider: 'p1', model: 'm1' }, source: 'message', usage: U(40, 20) },
    { time: DAY_B, sessionId: 'session-bbb', route: null, source: 'chunk', usage: U(1, 2) },
    { time: NOW, sessionId: 'session-aaa', route: { provider: 'p1', model: 'm1' }, source: 'message', usage: U(60, 30) },
  ]
  const full = buildReport(twoSessionState(), { now: NOW, recent, costPlan: PLAN })
  // 倒序：[NOW(p1/m1), DAY_B(route null), DAY_A(p1/m1)]
  assert.equal(full.recent.length, 3)
  assert.equal(full.recent[0].time, NOW)
  assert.equal(full.recent[1].routeLabel, 'unknown')
  assert.equal(full.recent[2].routeLabel, 'p1/m1')
  const windowed = buildReport(twoSessionState(), { now: NOW, days: 1, recent, costPlan: PLAN })
  assert.deepEqual(windowed.recent.map(c => c.time), [NOW, DAY_B])
})

// ---------- 渲染 ----------

test('renderReport：关键段落齐全', () => {
  const report = buildReport(twoSessionState(), {
    now: NOW,
    recent: [{ time: NOW, sessionId: 'session-aaa', route: { provider: 'p1', model: 'm1' }, source: 'message', usage: U(60, 30) }],
    costPlan: PLAN,
  })
  const text = renderReport(report)
  assert.ok(text.includes('【Token 用量统计】'))
  assert.ok(text.includes('全部历史'))
  assert.ok(text.includes('按模型'))
  assert.ok(text.includes('p1/m1'))
  assert.ok(text.includes('按日'))
  assert.ok(text.includes('按会话'))
  assert.ok(text.includes('最近调用'))
  assert.ok(text.includes('合计'))
})

// ---------- 环形缓冲 ----------

test('pushRecent：超限丢弃最旧条目', () => {
  const buffer = []
  for (let i = 0; i < 5; i += 1) {
    pushRecent(buffer, 3, { time: i, sessionId: 's', route: null, source: 'message', usage: U(i, 0) })
  }
  assert.equal(buffer.length, 3)
  assert.deepEqual(buffer.map(c => c.time), [2, 3, 4])
})

test('addUsage：逐桶累加', () => {
  assert.deepEqual(addUsage(U(1, 2, { cacheReadTokens: 3 }), U(4, 5, { cacheWriteTokens: 6, reasoningTokens: 7 })), U(5, 7, { cacheReadTokens: 3, cacheWriteTokens: 6, reasoningTokens: 7 }))
})

// ---------- 小时直方图 ----------

test('hourlyHistogram：固定轴（含零桶）与桶归属', () => {
  const now = ts('2026-08-21T12:30:00')
  const commits = [
    { time: ts('2026-08-21T11:59:00'), sessionId: 's', route: null, source: 'message', usage: U(10, 1) },
    { time: ts('2026-08-21T12:01:00'), sessionId: 's', route: null, source: 'message', usage: U(20, 2) },
    { time: ts('2026-08-21T09:59:00'), sessionId: 's', route: null, source: 'message', usage: U(5, 5) },
    { time: ts('2026-08-20T12:59:00'), sessionId: 's', route: null, source: 'message', usage: U(99, 9) }, // 窗口外（cutoff 08-20 13:00）
    { time: ts('2026-08-21T13:30:00'), sessionId: 's', route: null, source: 'message', usage: U(88, 8) }, // 未来时钟漂移，丢弃
  ]
  const rows = hourlyHistogram(commits, now, 24)
  assert.equal(rows.length, 24)
  assert.equal(rows[0].hour, '13') // 前一日 13:00
  assert.equal(rows[23].hour, '12') // 当前小时
  const byHour = new Map(rows.map(r => [r.hour, r]))
  assert.equal(byHour.get('11').requests, 1)
  assert.equal(byHour.get('11').usage.inputTokens, 10)
  assert.equal(byHour.get('12').usage.inputTokens, 20)
  assert.equal(byHour.get('09').usage.inputTokens, 5)
  assert.equal(byHour.get('13').requests, 0)
  assert.equal(rows.reduce((sum, r) => sum + r.requests, 0), 3)
  assert.equal(rows.reduce((sum, r) => sum + r.totalTokens, 0), totalTokens(U(35, 8)))
})

test('hourlyHistogram：空缓冲返回全零轴；hours=1 只覆盖当前小时', () => {
  const now = ts('2026-08-21T12:30:00')
  const rows = hourlyHistogram([], now, 24)
  assert.equal(rows.length, 24)
  assert.ok(rows.every(r => r.requests === 0 && r.totalTokens === 0))
  const single = hourlyHistogram([
    { time: ts('2026-08-21T12:10:00'), sessionId: 's', route: null, source: 'message', usage: U(3, 3) },
    { time: ts('2026-08-21T11:59:00'), sessionId: 's', route: null, source: 'message', usage: U(4, 4) },
  ], now, 1)
  assert.equal(single.length, 1)
  assert.equal(single[0].hour, '12')
  assert.equal(single[0].requests, 1)
  assert.equal(single[0].usage.inputTokens, 3)
})

// ---------- 费用估算 ----------

test('estimateRouteCost：DeepSeek 命中/未命中/输出分档，缓存写归未命中', () => {
  // deepseek-v4-flash 空闲价：miss 1.5 / hit 0.05 / out 4.5（元/百万）
  // miss = (1,000,000 + 100,000)/1e6 × 1.5 = 1.65；hit = 2,000,000/1e6 × 0.05 = 0.10
  // out = 500,000/1e6 × 4.5 = 2.25 → deepseek 合计 4.00
  const cost = estimateRouteCost(
    'deepseek-official/deepseek-v4-flash',
    U(1_000_000, 500_000, { cacheReadTokens: 2_000_000, cacheWriteTokens: 100_000 }),
    PLAN,
  )
  assert.deepEqual(cost, { deepseekYuan: 4.0, localYuan: 0, totalYuan: 4.0 })
})

test('estimateRouteCost：DeepSeek 模型不在价目表内不计费', () => {
  assert.deepEqual(estimateRouteCost('deepseek-official/other-model', U(1, 1), PLAN), zeroCost())
})

test('estimateRouteCost：本地按 GPU 负载折算电费（输出/未命中输入，缓存读不计）', () => {
  // 默认：decode 50 tok/s、prefill 1000 tok/s、600W、0.6 元/kWh
  // 输出 1M → 20000s；未命中输入 1M → 1000s；共 21000s = 3.5 kWh = 2.1 元
  const cost = estimateRouteCost('llama-local/Qwen-x', U(1_000_000, 1_000_000), PLAN)
  assert.ok(Math.abs(cost.localYuan - 2.1) < 1e-9)
  assert.deepEqual(cost, { deepseekYuan: 0, localYuan: 2.1, totalYuan: 2.1 })
  // 缓存读不折算 GPU 时间：大量缓存读不产生电费
  assert.deepEqual(estimateRouteCost('llama-local/Qwen-x', U(0, 0, { cacheReadTokens: 100_000_000 }), PLAN), zeroCost())
  // 纯输出 1M → 20000s = 3.3333 kWh = 2.0 元
  const outOnly = estimateRouteCost('llama-local/Qwen-x', U(0, 1_000_000), PLAN)
  assert.ok(Math.abs(outOnly.localYuan - 2.0) < 1e-9)
})

test('estimateRouteCost：未知/未配置计费的 route 为零费用', () => {
  assert.deepEqual(estimateRouteCost('unknown', U(1, 1), PLAN), zeroCost())
  assert.deepEqual(estimateRouteCost('other-provider/m', U(1, 1), PLAN), zeroCost())
  assert.deepEqual(estimateRouteCost('no-slash', U(1, 1), PLAN), zeroCost())
})

test('addCost：逐项累加，totalYuan = deepseek + local', () => {
  const a = addCost({ deepseekYuan: 1.5, localYuan: 2.5, totalYuan: 4 }, { deepseekYuan: 0.5, localYuan: 0.5, totalYuan: 1 })
  assert.deepEqual(a, { deepseekYuan: 2, localYuan: 3, totalYuan: 5 })
})

test('buildReport：费用按路由聚合（total 细分 / byRoute / byDay / bySession）', () => {
  const state = emptyState()
  state.sessions['session-ds'] = {
    createdAt: DAY_B,
    requests: 1,
    totals: U(1_000_000, 500_000, { cacheReadTokens: 2_000_000, cacheWriteTokens: 100_000 }),
    lastActivity: DAY_B,
    byDay: {
      '2026-08-21': {
        requests: 1,
        usage: U(1_000_000, 500_000, { cacheReadTokens: 2_000_000, cacheWriteTokens: 100_000 }),
        byRoute: {
          'deepseek-official/deepseek-v4-flash': {
            requests: 1,
            usage: U(1_000_000, 500_000, { cacheReadTokens: 2_000_000, cacheWriteTokens: 100_000 }),
          },
        },
      },
    },
  }
  state.sessions['session-local'] = {
    createdAt: DAY_A,
    requests: 1,
    totals: U(0, 1_000_000),
    lastActivity: DAY_A,
    byDay: {
      '2026-08-20': {
        requests: 1,
        usage: U(0, 1_000_000),
        byRoute: { 'llama-local/Qwen-x': { requests: 1, usage: U(0, 1_000_000) } },
      },
    },
  }
  const report = buildReport(state, { now: NOW, recent: [], costPlan: PLAN })
  // total：deepseek 4.0 + local 2.0（输出 1M ÷ 50 tok/s × 600W × 0.6 元）
  assert.ok(Math.abs(report.total.cost.deepseekYuan - 4.0) < 1e-9)
  assert.ok(Math.abs(report.total.cost.localYuan - 2.0) < 1e-9)
  assert.ok(Math.abs(report.total.cost.totalYuan - 6.0) < 1e-9)
  // byRoute：两行各带 cost 细分
  const ds = report.byRoute.find(r => r.route === 'deepseek-official/deepseek-v4-flash')
  assert.ok(Math.abs(ds.cost.deepseekYuan - 4.0) < 1e-9)
  assert.equal(ds.cost.localYuan, 0)
  const local = report.byRoute.find(r => r.route === 'llama-local/Qwen-x')
  assert.ok(Math.abs(local.cost.localYuan - 2.0) < 1e-9)
  // byDay / bySession 行费用
  assert.ok(Math.abs(report.byDay.find(d => d.day === '2026-08-21').costYuan - 4.0) < 1e-9)
  assert.ok(Math.abs(report.byDay.find(d => d.day === '2026-08-20').costYuan - 2.0) < 1e-9)
  assert.ok(Math.abs(report.bySession.find(s => s.sessionId === 'session-ds').costYuan - 4.0) < 1e-9)
  assert.ok(Math.abs(report.bySession.find(s => s.sessionId === 'session-local').costYuan - 2.0) < 1e-9)
  // days 窗口：只含今日 → 费用只剩 deepseek
  const windowed = buildReport(state, { now: NOW, days: 1, recent: [], costPlan: PLAN })
  assert.ok(Math.abs(windowed.total.cost.totalYuan - 4.0) < 1e-9)
  assert.equal(windowed.byRoute.length, 1)
})

test('buildReport：本地电费不超过窗口满载上限（按比例分摊）', () => {
  const state = emptyState()
  // 本地输出 1 亿 tokens → 折算 200 元；1 天窗口满载上限 = 24h × 600W × 0.6 元 = 8.64 元
  state.sessions['session-heavy'] = {
    createdAt: DAY_B,
    requests: 1,
    totals: U(0, 100_000_000),
    lastActivity: DAY_B,
    byDay: {
      '2026-08-21': {
        requests: 1,
        usage: U(0, 100_000_000),
        byRoute: { 'llama-local/Qwen-x': { requests: 1, usage: U(0, 100_000_000) } },
      },
    },
  }
  state.sessions['session-light'] = {
    createdAt: DAY_B,
    requests: 1,
    totals: U(0, 10_000_000),
    lastActivity: DAY_B,
    byDay: {
      '2026-08-21': {
        requests: 1,
        usage: U(0, 10_000_000),
        byRoute: { 'llama-local/Qwen-y': { requests: 1, usage: U(0, 10_000_000) } },
      },
    },
  }
  const report = buildReport(state, { now: NOW, days: 1, recent: [], costPlan: PLAN })
  // 折算合计 220 元 → clamp 到 8.64 元
  assert.ok(Math.abs(report.total.cost.localYuan - 8.64) < 1e-9)
  assert.equal(report.total.cost.deepseekYuan, 0)
  // 按比例分摊：heavy 占 200/220，light 占 20/220
  const heavy = report.byRoute.find(r => r.route === 'llama-local/Qwen-x')
  const light = report.byRoute.find(r => r.route === 'llama-local/Qwen-y')
  assert.ok(Math.abs(heavy.cost.localYuan - 8.64 * 200 / 220) < 1e-9)
  assert.ok(Math.abs(light.cost.localYuan - 8.64 * 20 / 220) < 1e-9)
  // 行级（byDay/bySession）与总量一致
  assert.ok(Math.abs(report.byDay[0].costYuan - 8.64) < 1e-9)
  assert.ok(Math.abs(report.bySession[0].costYuan + report.bySession[1].costYuan - 8.64) < 1e-9)
  // 全部历史窗口不设上限（无窗口天数）
  const full = buildReport(state, { now: NOW, recent: [], costPlan: PLAN })
  assert.ok(Math.abs(full.total.cost.localYuan - 220) < 1e-9)
})

test('renderReport：含估算费用行', () => {
  const report = buildReport(twoSessionState(), { now: NOW, recent: [], costPlan: PLAN })
  const text = renderReport(report)
  assert.ok(text.includes('估算费用'))
  assert.ok(text.includes('DeepSeek API'))
  assert.ok(text.includes('本地电费'))
})
