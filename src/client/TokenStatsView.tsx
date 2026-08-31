/**
 * dsh-token-stats-xg 看板视图（conversation.view 的 "Token 统计" 页签）。
 *
 * 布局参考 DeepSeek 开放平台用量面板：标题行 + 时间维度切换、统计卡片行、
 * 主柱状图（今日按小时 / 其余按日）、按模型与按会话双列表、最近调用明细。
 * 颜色全部走 DSH 主题 token（见 index.ts 的 STYLES），不硬编码品牌色。
 *
 * 数据：挂载期间每 5s 轮询宿主 REST API；页签切走即卸载停止轮询。
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import {
  fetchReport,
  WINDOWS,
  type DayRow,
  type HourRow,
  type Report,
  type ReportResponse,
  type WindowChoice,
} from './api.ts'

const POLL_MS = 5_000

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

function fmtYuan(y: number): string {
  return `¥${y.toFixed(2)}`
}

function fmtClock(t: number): string {
  const d = new Date(t)
  const p = (x: number) => `${x}`.padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtDay(day: string): string {
  // YYYY-MM-DD → MM-DD
  return day.length === 10 ? day.slice(5) : day
}

function shortSession(id: string): string {
  return id.length > 15 ? `${id.slice(0, 15)}…` : id
}

/** 会话标签：有标题显示 "标题 · 短id"，否则仅短 id */
function sessionCell(title: string | undefined, sessionId: string): ReactElement {
  if (title === undefined || title.length === 0) return <>{shortSession(sessionId)}</>
  return (
    <>
      {title}
      <span className="tts-muted"> · {shortSession(sessionId)}</span>
    </>
  )
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }): ReactElement {
  return (
    <div className="tts-card">
      <div className="tts-card-label">{label}</div>
      <div className="tts-card-value">{value}</div>
      {sub !== undefined ? <div className="tts-card-sub">{sub}</div> : null}
    </div>
  )
}

interface BarDatum {
  label: string
  value: number
  detail: string
}

function Chart({ bars, emptyHint }: { bars: BarDatum[]; emptyHint: string }): ReactElement {
  const max = bars.reduce((m, b) => Math.max(m, b.value), 0)
  if (max === 0) return <div className="tts-empty">{emptyHint}</div>
  return (
    <div className="tts-chart">
      {bars.map((b, i) => (
        <div
          key={`${b.label}-${i}`}
          className="tts-bar-col"
          title={`${b.label}\n${b.detail}`}
        >
          <div className="tts-bar-wrap">
            <div className="tts-bar" style={{ height: `${Math.max(1, (b.value / max) * 100)}%` }} />
          </div>
          <div className="tts-bar-label">{b.label}</div>
        </div>
      ))}
    </div>
  )
}

function buildChartBars(report: Report, byHour: HourRow[] | null, windowDays: WindowChoice): { bars: BarDatum[]; suffix: string } {
  if (byHour !== null) {
    // 今日窗口：按小时（每 4 格标一个刻度）
    return {
      bars: byHour.map((h, i) => ({
        label: i % 4 === 0 ? h.hour : '',
        value: h.totalTokens,
        detail: `${h.hour}:00  调用 ${h.requests}  输入 ${fmtTokens(h.usage.inputTokens + h.usage.cacheReadTokens + h.usage.cacheWriteTokens)}  输出 ${fmtTokens(h.usage.outputTokens)}`,
      })),
      suffix: '（按小时）',
    }
  }
  const days = report.byDay as DayRow[]
  const shown = days.length > 14 ? days.slice(-14) : days
  return {
    bars: shown.map(d => ({
      label: fmtDay(d.day),
      value: d.totalTokens,
      detail: `${d.day}  调用 ${d.requests}  输入 ${fmtTokens(d.usage.inputTokens + d.usage.cacheReadTokens + d.usage.cacheWriteTokens)}  输出 ${fmtTokens(d.usage.outputTokens)}`,
    })),
    suffix: days.length > 14 ? '（最近 14 天）' : '（按日）',
  }
}

export function TokenStatsView(): ReactElement {
  const [windowDays, setWindowDays] = useState<WindowChoice>(1)
  const [data, setData] = useState<ReportResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    const load = async () => {
      try {
        const body = await fetchReport(windowDays)
        if (!disposed) {
          setData(body)
          setError(null)
        }
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void load()
    const timer = setInterval(() => { void load() }, POLL_MS)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [windowDays])

  const report = data?.report
  const byHour = data?.byHour ?? null
  const chart = report !== undefined ? buildChartBars(report, byHour, windowDays) : null

  return (
    <div className="tts-root">
      <div className="tts-header">
        <div>
          <div className="tts-title">用量信息</div>
          <div className="tts-sub">
            {report !== undefined
              ? `更新于 ${fmtClock(report.generatedAt)}  ·  跟踪 ${report.trackedSessionCount} 个会话`
              : '跨会话模型 Token 用量（输入 / 输出 / 缓存）'}
          </div>
        </div>
        <div className="tts-window">
          {WINDOWS.map(w => (
            <button
              key={String(w.value)}
              type="button"
              className={w.value === windowDays ? 'active' : ''}
              onClick={() => setWindowDays(w.value)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {error !== null ? <div className="tts-error">数据加载失败：{error}（5 秒后重试）</div> : null}

      {report === undefined ? (
        <div className="tts-empty">加载中…</div>
      ) : (
        <>
          <div className="tts-cards">
            <Card
              label="合计 Tokens"
              value={fmtTokens(report.total.totalTokens)}
              sub={`${fmtTokens(report.total.requests)} 次调用 · ${report.sessionCount} 个会话`}
            />
            <Card
              label="输入"
              value={fmtTokens(report.total.usage.inputTokens + report.total.usage.cacheReadTokens + report.total.usage.cacheWriteTokens)}
              sub={`其中缓存读 ${fmtTokens(report.total.usage.cacheReadTokens)}`}
            />
            <Card
              label="输出"
              value={fmtTokens(report.total.usage.outputTokens)}
              sub={`推理 ${fmtTokens(report.total.usage.reasoningTokens)}`}
            />
            <Card
              label="缓存读"
              value={fmtTokens(report.total.usage.cacheReadTokens)}
              sub={`缓存写 ${fmtTokens(report.total.usage.cacheWriteTokens)}`}
            />
            <Card
              label="估算费用"
              value={fmtYuan(report.total.cost.totalYuan)}
              sub={`DeepSeek ${fmtYuan(report.total.cost.deepseekYuan)} · 本地电费 ${fmtYuan(report.total.cost.localYuan)}`}
            />
          </div>

          <section className="tts-panel">
            <div className="tts-panel-title">
              <span>{`Token 用量${chart?.suffix ?? ''}`}</span>
            </div>
            {chart !== null
              ? (
                <Chart
                  bars={chart.bars}
                  emptyHint={windowDays === 1 ? '今日暂无用量数据' : '窗口内暂无用量数据'}
                />
              )
              : null}
          </section>

          <div className="tts-cols">
            <section className="tts-panel">
              <div className="tts-panel-title"><span>按模型</span></div>
              {report.byRoute.length === 0 ? (
                <div className="tts-empty">暂无数据</div>
              ) : (
                <table className="tts-table">
                  <thead>
                    <tr><th>模型</th><th>调用</th><th>输入</th><th>输出</th><th>合计</th><th>费用</th></tr>
                  </thead>
                  <tbody>
                    {report.byRoute.map(row => (
                      <tr key={row.route}>
                        <td className="tts-ellipsis" title={row.route}>{row.route}</td>
                        <td>{row.requests}</td>
                        <td>{fmtTokens(row.usage.inputTokens + row.usage.cacheReadTokens + row.usage.cacheWriteTokens)}</td>
                        <td>{fmtTokens(row.usage.outputTokens)}</td>
                        <td>{fmtTokens(row.totalTokens)}</td>
                        <td title={`DeepSeek ${fmtYuan(row.cost.deepseekYuan)} · 本地电费 ${fmtYuan(row.cost.localYuan)}`}>{fmtYuan(row.cost.totalYuan)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="tts-panel">
              <div className="tts-panel-title"><span>按会话</span></div>
              {report.bySession.length === 0 ? (
                <div className="tts-empty">暂无数据</div>
              ) : (
                <table className="tts-table">
                  <thead>
                    <tr><th>会话</th><th>调用</th><th>合计</th><th>费用</th><th>最近</th></tr>
                  </thead>
                  <tbody>
                    {report.bySession.map(row => (
                      <tr key={row.sessionId}>
                        <td className="tts-ellipsis" title={row.title !== undefined ? `${row.title}（${row.sessionId}）` : (row.cwd ?? row.sessionId)}>
                          {sessionCell(row.title, row.sessionId)}
                        </td>
                        <td>{row.requests}</td>
                        <td>{fmtTokens(row.totalTokens)}</td>
                        <td>{fmtYuan(row.costYuan)}</td>
                        <td>{fmtClock(row.lastActivity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>

          <section className="tts-panel">
            <div className="tts-panel-title">
              <span>最近调用</span>
              <span className="tts-sub">内存环形缓冲（最多 200 条）</span>
            </div>
            {report.recent.length === 0 ? (
              <div className="tts-empty">暂无记录（本进程启动后产生的调用才会出现）</div>
            ) : (
              <div className="tts-recent">
                {report.recent.slice(0, 10).map((row, i) => (
                  <div key={`${row.time}-${i}`} className="tts-recent-row">
                    <span className="tts-muted">{fmtClock(row.time)}</span>
                    <span className="tts-ellipsis" title={row.title !== undefined ? `${row.title}（${row.sessionId}）` : row.sessionId}>
                      {sessionCell(row.title, row.sessionId)}
                    </span>
                    <span className="tts-ellipsis" title={row.routeLabel}>{row.routeLabel}</span>
                    <span className="tts-recent-nums">
                      入 {fmtTokens(row.usage.inputTokens + row.usage.cacheReadTokens + row.usage.cacheWriteTokens)}
                      {'  '}出 {fmtTokens(row.usage.outputTokens)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="tts-footnote">
            费用估算：DeepSeek 按官网空闲时段价（缓存命中 / 未命中分档，未计费模型除外）；本地按电费——输出与未命中输入折算 GPU 时间 × 功耗 × 电价，缓存读不计，不超过窗口内满载电费上限（参数可在插件配置中调整）
          </div>
        </>
      )}
    </div>
  )
}
