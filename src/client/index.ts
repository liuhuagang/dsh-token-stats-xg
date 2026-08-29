/**
 * dsh-token-stats-xg 客户端入口：安装看板样式，并在 conversation.view 列表槽注册
 * "Token 统计"页签（id 'token-stats'，order 20，排在 chat/trajectory 之后）。
 *
 * 数据来自宿主 REST API（/token-stats/api/report），组件挂载期间 5s 轮询，
 * 页签切走即卸载（列表槽 only: 单显渲染），轮询随之停止。
 *
 * 布局参考 DeepSeek 开放平台用量面板；颜色全部走 DSH 主题 token，
 * 浅色/深色主题自适应，不硬编码品牌色。
 */

import { TokenStatsView } from './TokenStatsView.tsx'

/** 结构性 slots 服务面（与运行时 SlotRegistry 一致；仅取本插件用到的方法） */
type SlotsService = {
  inject(key: string, callback: () => void | (() => void)): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** 结构性客户端根上下文面（仅取本插件用到的字段） */
type ClientContext = {
  slots: SlotsService
  effect(dispose: () => void, label?: string): void
}

const STYLES = `
.tts-root { display: flex; flex-direction: column; gap: 14px; height: 100%; overflow-y: auto; padding: 16px 20px; box-sizing: border-box; }
.tts-root * { box-sizing: border-box; }
.tts-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.tts-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, #ffffff); }
.tts-sub { font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.55)); margin-top: 2px; }
.tts-window { display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.06)); }
.tts-window button { border: 0; background: transparent; color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.55)); font-size: 12px; padding: 4px 12px; border-radius: 6px; cursor: pointer; line-height: 1.4; }
.tts-window button:hover { color: var(--dsw-alias-label-primary, #ffffff); }
.tts-window button.active { background: var(--dsw-alias-brand-primary, #ff7a1a); color: #ffffff; }
.tts-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.tts-card { background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.04)); border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1)); border-radius: 10px; padding: 12px 14px; min-width: 0; }
.tts-card-label { font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.55)); }
.tts-card-value { font-size: 22px; font-weight: 600; margin-top: 4px; color: var(--dsw-alias-label-primary, #ffffff); font-variant-numeric: tabular-nums; }
.tts-card-sub { font-size: 11px; color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.45)); margin-top: 4px; }
.tts-panel { background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.04)); border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1)); border-radius: 10px; padding: 14px 16px; min-width: 0; }
.tts-panel-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #ffffff); margin-bottom: 10px; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.tts-chart { display: flex; align-items: stretch; gap: 3px; height: 150px; }
.tts-bar-col { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.tts-bar-wrap { flex: 1; display: flex; align-items: flex-end; min-height: 0; }
.tts-bar { width: 100%; background: var(--dsw-alias-brand-primary, #ff7a1a); border-radius: 2px 2px 0 0; opacity: 0.9; }
.tts-bar:hover { opacity: 1; }
.tts-bar-label { height: 14px; font-size: 10px; line-height: 14px; color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.45)); text-align: center; white-space: nowrap; overflow: hidden; }
.tts-cols { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 10px; }
.tts-table { width: 100%; border-collapse: collapse; font-size: 12px; color: var(--dsw-alias-label-primary, #ffffff); }
.tts-table th { text-align: left; color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.55)); font-weight: 400; padding: 4px 6px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1)); white-space: nowrap; }
.tts-table td { padding: 5px 6px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.06)); font-variant-numeric: tabular-nums; }
.tts-table tr:last-child td { border-bottom: 0; }
.tts-ellipsis { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tts-recent { display: flex; flex-direction: column; }
.tts-recent-row { display: flex; gap: 10px; align-items: baseline; font-size: 12px; padding: 5px 0; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.06)); color: var(--dsw-alias-label-primary, #ffffff); }
.tts-recent-row:last-child { border-bottom: 0; }
.tts-recent-row .tts-ellipsis:nth-of-type(1) { max-width: 180px; }
.tts-recent-row .tts-ellipsis:nth-of-type(2) { flex: 1; max-width: none; }
.tts-recent-nums { color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.55)); white-space: nowrap; font-variant-numeric: tabular-nums; }
.tts-muted { color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.55)); font-variant-numeric: tabular-nums; }
.tts-empty { font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.55)); padding: 18px 0; text-align: center; }
.tts-error { font-size: 12px; color: var(--dsw-alias-state-error-primary, #ff5c5c); }
.tts-footnote { font-size: 11px; color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.45)); line-height: 1.5; }
@media (max-width: 900px) {
  .tts-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .tts-cols { grid-template-columns: 1fr; }
}
`

function installStyles(): void {
  const tagId = 'token-stats'
  if (document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-token-stats-xg'
    tag.dataset.pluginCss = tagId
    tag.textContent = STYLES
    document.head.appendChild(tag)
  }
}

/** 硬依赖：slots 服务就绪后 fiber 才执行 apply（shell 核心保证提供） */
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'token-stats:styles')
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'token-stats',
    order: 20,
    label: 'Token 统计',
  }, TokenStatsView))
}
