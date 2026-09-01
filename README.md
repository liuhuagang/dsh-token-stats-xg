# dsh-token-stats-xg — 跨会话模型 Token 用量监听与统计

**简体中文** · [English](README_EN.md)

> [!NOTE] 维护状态
> 本插件为 XG 系列内部工具，**仅供学习参考，不承诺维护**（issue 不保证响应）。
> 最新开发版维护于内网 GitLab XGDSHPlugins；本仓库为源码快照。

监听 DSH 所有会话日志中 provider 上报的 usage，跨会话累计并按日 / 按模型 /
按会话聚合，提供终端监控行、`token_stats` 查询工具、Web GUI 看板页签与
**费用估算**（DeepSeek 按官网空闲时段价、本地按电费）。

## 数据源与去重语义

usage 来自会话日志的 provider 上报（durable log，source of truth）：

| 事件 | 字段 | 角色 |
|------|------|------|
| `assistant/chunk` | `data.chunk = { type:'usage', usage }` | 流式样本（请求失败也能保留） |
| `assistant/message` | `data.usage` | 该步骤最终样本（替换同步骤 chunk 样本） |

去重语义与 DSH 内置 token-meter 的 `tokenUsage` 投影对齐：单 last 槽位，
同一 `(turn, step)` 的重复样本**替换**而非累加（减旧加新），新步骤的样本
才计一次请求。在此基础上增加按日（本地日期键）与按模型
（`provider/model`，message 用 `message.source`，chunk 用最近一次
`request/context` / `request/header` 记录的路由）归属。

用量桶：`inputTokens`（未缓存输入）、`outputTokens`（含推理）、
`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens`（已含在输出内，
单列为分析口径）。`totalTokens = inputTokens + cacheReadTokens +
cacheWriteTokens + outputTokens`（推理不重复计）。

## 监听与历史回溯

插件在全局 ctx 注册（收到所有会话，含子代理会话）：

- `session/created`：会话公告时把整段内存日志**批量折叠**——恢复会话携带
  全部历史，因此插件安装前发生的用量也会被计入。折叠结果整体替换状态中
  该会话的条目（日志是 source of truth，重放幂等）。
- `session/event`：实时增量折叠；每个步骤的首条 usage 样本输出一条终端
  监控行（`logCalls` 控制，默认开）。

## 持久化

状态文件 `<dir>/token-stats.json`（默认 `~/.dsh/token-stats/`）：按会话存储
累计值（requests / totals / lastActivity / byDay），防抖写盘（默认 2000ms）
+ 卸载兜底写，tmp+rename 原子替换。进程重启后恢复累计值；会话再次激活时
由批量折叠刷新其条目。内存态（last 槽位、路由、最近调用环形缓冲）不落盘。

## 查询工具 `token_stats`

| 参数 | 说明 |
|------|------|
| `days` | 只统计最近 N 个自然日（含今天）；省略 = 全部历史 |
| `sessionId` | 只统计指定会话（id 精确或前缀匹配） |
| `limit` | bySession 行数上限，默认 10，最大 100 |

返回：窗口内总量、按会话 TOP、按日（升序）、按模型（降序）、最近调用
（倒序，内存环形缓冲，默认上限 200 条）。总量与各聚合行均带**估算费用**
（元）：`total.cost` 细分为 DeepSeek / 本地电费，`byRoute` 行带 `cost`，
`byDay` / `bySession` 行带 `costYuan`。

实现注记：`tools` / `webServer` 服务声明为 inject 硬依赖
（`export const inject = ['tools', 'webServer']`）——composition 树并行激活所有
条目，不等待的话 `apply` 执行时服务可能尚未就绪，注册会静默丢失。DSH
composition 保证提供这两个服务，等待在毫秒级完成。

## 费用估算

用量统计之上叠加费用估算，按路由（`provider/model`）归属计价：

- **DeepSeek 官方**（默认 provider `deepseek-official`）：按官网"模型 & 价格"
  页**空闲时段**价（2026-08 版，元/百万 tokens）估算——低谷价 = 高峰价一半，
  "以低估时期"口径（实际高峰调用成本最高可达估算 2 倍）。严格区分缓存
  命中/未命中：`cacheReadTokens` 用命中价，`inputTokens` 与 `cacheWriteTokens`
  （缓存写官网不单独计费，归入未命中口径）用未命中价，输出用输出价。
  内置价目表：deepseek-v4-flash / -vision-exp 输入 1.5（命中 0.05）/ 输出 4.5；
  deepseek-v4-pro 输入 4.5（命中 0.15）/ 输出 13.5。
- **本地模型**（默认 provider `llama-local`）：按 **GPU 负载折算电费** ——
  只对真正消耗算力的 token 折算时间：`输出 ÷ decode吞吐 + 未命中输入 ÷
  prefill吞吐`，乘功耗与电价；**缓存读/写不计**（KV 缓存拉取能耗可忽略）。
  默认参数：整机功耗 600W、电价 0.6 元/kWh、decode 50 tok/s、prefill 1000
  tok/s。**物理上限兜底**：有限窗口下本地电费不超过"窗口天数 × 24h × 功耗
  × 电价"（即 600W 满载约 8.6 元/天），超出部分按比例分摊到各路由/日/会话，
  任何参数偏差都不会算出物理上不可能的数值。
- **未匹配的 route**（provider 不在配置列表、模型不在价目表）费用为 0，
  报告中该行费用显示 ¥0.00。

估算费用对 DeepSeek 是 token 数的线性函数、对本地按折算时长线性，直接对
聚合桶计算即可；窗口过滤后费用与用量严格同步。

## Web 看板（conversation.view 页签）

Web GUI 会话视图区的 "Token 统计" 页签（`conversation.view` 列表槽，
`id: token-stats`，order 20，排在 chat / trajectory 之后）。布局参考
DeepSeek 开放平台用量面板：

- 标题行 + 时间维度切换（今日 / 3 日 / 7 日 / 全部）
- 统计卡片行：合计 / 输入（含缓存）/ 输出 / 缓存读 / 估算费用（DeepSeek
  与本地电费拆分，页面底部有估算口径脚注）
- 主柱状图：今日窗口按小时（24 桶），其余窗口按日（超过 14 天显示最近 14 天）
- 按模型 / 按会话双列表（含费用列）+ 最近调用明细（内存环形缓冲前 10 条）

数据流：客户端每 5s 轮询宿主 REST API（页签切走即卸载停止轮询）：

```
GET /token-stats/api/report?days=1|3|7[&limit=N]
→ { report: StatsReport, byHour: HourBucketRow[] | null }   // byHour 仅 days=1 非 null
```

颜色全部使用 DSH 主题 token（`--dsw-alias-*`），浅色/深色主题自适应。

客户端半是单文件 bundle（`lib/client.js`，tsdown 打包，
`window.__ModuleLoader__.load` 装载，react 走平台模块表不打包），
由 boot 从 `package.json` 的 `dsh.client`（`platform: 'web'`）与
`exports['./client']` 自动发现，无需额外 composition 配置。

## 配置（cordis.patch.yml）

```yaml
- insert:
    - id: token-stats
      name: 'dsh-token-stats-xg'
      config:
        logCalls: true   # 每次模型调用输出一条终端监控行（默认 true）
        # enabled: true  # 总开关（默认 true）
        # dir: ...       # 状态目录（默认 ~/.dsh/token-stats）
        # flushMs: 2000  # 写盘防抖（默认 2000）
        # recentLimit: 200
        # ---- 费用估算（默认值即下方注释值）----
        # deepseekProvider: 'deepseek-official'       # DeepSeek 官方 provider 名
        # localProviders: ['llama-local']            # 按电费估算的本地 provider 列表
        # deepseekPrices: {}                         # 价目表覆盖（元/百万 tokens，空闲价）
        #                                              # 例：{ 'deepseek-v4-flash': { inputMiss: 1.5, inputHit: 0.05, output: 4.5 } }
        # localPricePerKwh: 0.6                      # 本地电价（元/千瓦时）
        # localPowerWatts: 600                       # 本地整机功耗（瓦）
        # localDecodeTps: 50                         # 本地输出吞吐（tokens/秒）
        # localPrefillTps: 1000                      # 本地未命中输入吞吐（tokens/秒）
```

## 构建与部署

```
# 构建（插件目录内，一步完成：junction 补齐 → tsdown 客户端 bundle →
# tsc 宿主编译 → 客户端类型检查 → 产物验证 → 单元测试）
node scripts/build.mjs
# 可选：DSH_CHECKOUT 环境变量指定 DSH checkout 路径（默认 D:/deepseek-harness）
# 部署（先删后拷，避免旧文件残留）
复制 lib/ 与 package.json 到 ~/.dsh/profiles/web/node_modules/dsh-token-stats-xg/
# 重启 DSH 生效（Ctrl+C → pnpm dsh web）
```

构建顺序约束：tsdown 的 clean 会清空整个 `lib/`，必须先于宿主 tsc 运行
（`scripts/build.mjs` 已按此排序）。

生效标志：DSH 终端出现 `[token-stats] started: dir=... ... api=/token-stats/api/report`
启动行；会话激活时出现 `session <id> ready: history folded, model calls=N`
折叠行；每次模型调用出现 `[token-stats] call session=... model=... in=... out=...`
监控行；Web GUI 会话视图区出现 "Token 统计" 页签且数据 5s 刷新。

## 已知边界

- 用量依赖 provider 上报：不回报 usage 的模型（部分免费/本地端点）统计不到
- `reasoningTokens` 已含在 `outputTokens` 内，合计口径不重复计
- 同步骤样本在合法日志中必然相邻，单槽位替换无损；异常日志（乱序）下
  以"最后到达的样本"为准
- 费用估算为近似值：DeepSeek 按空闲时段价低估（高峰调用实际更高）；本地
  电费按 GPU 负载折算（缓存读不计）+ 满载上限兜底，参数（功耗/吞吐/电价）
  按实际硬件调整后更准；价目表与官网变动不同步时需更新配置（或等插件内置
  价目表随官网刷新）
