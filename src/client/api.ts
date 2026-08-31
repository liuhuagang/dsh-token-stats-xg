/**
 * dsh-token-stats-xg 客户端 API 层：/token-stats/api/report 的类型与取数。
 * 形状与宿主端 logic.StatsReport / logic.HourBucketRow 保持一致（JSON 边界）。
 */

export interface UsageBuckets {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

export interface UsageRow {
  requests: number
  usage: UsageBuckets
  totalTokens: number
}

/** 费用估算（元）：DeepSeek 官网空闲时段价 + 本地电费 */
export interface CostEstimate {
  deepseekYuan: number
  localYuan: number
  totalYuan: number
}

/** 总量行：含费用细分 */
export interface TotalRow extends UsageRow {
  cost: CostEstimate
}

export interface SessionRow extends UsageRow {
  sessionId: string
  /** 会话标题（无标题事件时省略） */
  title?: string
  cwd?: string
  agentPreset?: string
  costYuan: number
  lastActivity: number
  routes: string[]
}

export interface DayRow extends UsageRow {
  day: string
  costYuan: number
}

export interface RouteRow extends UsageRow {
  route: string
  cost: CostEstimate
}

export interface RecentRow {
  time: number
  sessionId: string
  /** 会话标题（无标题事件时省略） */
  title?: string
  routeLabel: string
  source: 'message' | 'chunk'
  usage: UsageBuckets
  totalTokens: number
}

export interface Report {
  generatedAt: number
  windowDays: number | null
  windowFrom: string | null
  total: TotalRow
  sessionCount: number
  trackedSessionCount: number
  bySession: SessionRow[]
  byDay: DayRow[]
  byRoute: RouteRow[]
  recent: RecentRow[]
}

export interface HourRow {
  time: number
  hour: string
  requests: number
  usage: UsageBuckets
  totalTokens: number
}

/** /token-stats/api/report 响应 */
export interface ReportResponse {
  report: Report
  /** days=1 时非 null（24 个固定轴小时桶，含零桶） */
  byHour: HourRow[] | null
}

const API = '/token-stats/api/report'

/** 时间窗口选择：1=今日 3=3 日 7=7 日 0=全部历史 */
export type WindowChoice = 1 | 3 | 7 | 0

export const WINDOWS: ReadonlyArray<{ value: WindowChoice; label: string }> = [
  { value: 1, label: '今日' },
  { value: 3, label: '3 日' },
  { value: 7, label: '7 日' },
  { value: 0, label: '全部' },
]

export function fetchReport(windowDays: WindowChoice): Promise<ReportResponse> {
  const url = windowDays === 0 ? API : `${API}?days=${windowDays}`
  return fetch(url, { headers: { accept: 'application/json' } })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<ReportResponse>
    })
}
