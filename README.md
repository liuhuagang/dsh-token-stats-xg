# dsh-token-stats-xg — 跨会话模型 Token 用量监听与统计

**简体中文** · [English](README_EN.md)

> [!NOTE] 维护状态
> 本插件为 XG 系列内部工具，**仅供学习参考，不承诺维护**（issue 不保证响应）。
> 最新开发版维护于内网 GitLab XGDSHPlugins；本仓库为源码快照。

监听 DSH 所有会话日志中 provider 上报的 usage，跨会话累计并按日 / 按模型 /
按会话聚合，提供终端监控行、`token_stats` 查询工具、Web GUI 看板页签与
**费用估算**（DeepSeek 按官网空闲时段价、本地按电费），并估算"若全部走远端"
的等价费用与**折算节约**。

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

- `session/created`：会话公告时把该会话**自身产生的**内存日志**批量折叠**——
  恢复会话携带全部自身历史，因此插件安装前发生的用量也会被计入。折叠结果
  整体替换状态中该会话的条目（日志是 source of truth，重放幂等）。
  fork 子会话（`subagent_fork`）的日志前缀是父会话已完成 turn 的种子
  （`inheritedEventCount` 个事件），其 usage 归属父会话条目，故只折叠
  `session.ownEvents()`，父会话历史不会被重复计入本会话与
  total / byDay / byRoute / 费用等聚合行。
- `session/event`：实时增量折叠；每个步骤的首条 usage 样本输出一条终端
  监控行（`logCalls` 控制，默认开）。

## 持久化与分层存储

**热层 + 归档层**（`<dir>` 默认 `~/.dsh/token-stats/`）：

- `token-stats.json`（**热层**）：只保存**本次进程内公告/活跃的会话**（当前
  正在产生事件的少数会话）。每次调用防抖写盘（默认 2000ms，tmp+rename
  原子替换），**只写热层**——写盘与热层体积与历史总量无关。
- `archive.jsonl`（**归档层**）：**只追加**、每会话一行
  （`{v, id, entry, archivedAt}`）。会话在进程停止（`finalizeOnStop`，
  默认 true）时逐条**终态化**追加进归档并从热层移除；之后再次公告的会话
  从 durable 日志整体重建回热层（重放幂等，不丢不重）。同 id 重复行在
  启动时按比例自动压实（last-wins）。

查询路径（`token_stats` 工具 / REST `/token-stats/api/report` / Web 看板）
把热层与归档**合并为全量会话视图**（热层优先，避免重复计数），因此历史可
**完整追溯**——含插件安装前发生、以及从未在本进程公告过的旧会话（后者由
回填建立基线，见下）。

## 历史可追溯（按需物化 + 进程外 worker）

插件**不在宿主进程内做批量扫描**——批量读取/解析整段 durable 日志会抢占
宿主单事件循环，卡住 GUI 与会话。历史基线由两条互不干扰的路径补齐：

1. **实时/按需物化（宿主内，零后台成本）**：会话被公告（打开历史会话 →
   `session/created` 全量折叠，本就覆盖"打开即补全"）或 `token_stats` /
   REST **显式按 sessionId 查询**未跟踪会话时，若其日志压缩体积不超过
   `materializeMaxSizeBytes`（默认 8MB，0=关闭）则在后台**单会话**折叠进
   归档（队列串行、逐个让出事件循环）；超过体积门槛的会话跳过并在终端
   提示改用 worker。小日志读取耗时极短，不会造成可感知卡顿。
2. **进程外 worker（scripts/backfill.mjs，全量/增量基线）**：独立进程运行，
   与宿主共享同一套读取与折叠实现——经
   `@deepseek-ai/dsh-session-persistence-jsonl` 打开存储（复用 DSH 自己的
   格式迁移/校验/残缺尾帧处理，不自研解析），折叠用 `lib/logic.js` 纯函数，
   结果追加进同一个 `archive.jsonl`。**可与运行中的 DSH 并行执行**（存储
   读取并发安全；归档只做整行追加，与宿主仅有的追加动作互不覆盖；worker
   收尾的整文件压实会自动检测他方改写并跳过——重复行留给宿主下次启动
   压实）。与 DSH 并行时建议 `--parallel 2`；停机时跑可默认 `--parallel 4`：

   ```powershell
   # 部署后（DSH 运行中或停机时均可；幂等，可随时重跑/续跑）
   node ~/.dsh/profiles/web/node_modules/dsh-token-stats-xg/scripts/backfill.mjs
   # 常用选项：--dry-run 预览待处理量；--limit N 抽样试跑；
   # --reconcile 对账（重折叠已归档会话与现有条目比对，不一致退出码 1）
   ```

   处理原则：只折叠**未跟踪**（热层/归档均无）会话；进度逐条输出、逐会话
   错误隔离、`backfill.lock` 互斥第二个 worker。
   恢复"完整可追溯"的方式：跑一次全量即可，之后随时重跑即增量补齐（幂等）。

   **v0 旧格式宽容回退**：8 月遗留的部分会话日志是当前 DSH 目录无法识别的
   format-v0 产物（如 `subagent/descriptor` version 2 事件，DSH 读取器
   fail-closed 拒读、GUI 恢复也会失败）。worker 对这类产物自动走宽容回退：
   逐帧解压原始文件、把 schema 可识别的行（usage/路由/标题事件）喂给同一
   纯折叠，未知行丢弃——无法被现 DSH 读取的旧产物没有对账基准，属尽力而为
   的宽容解析（仅 worker 使用，宿主永不直读日志文件）。

## 查询工具 `token_stats`

| 参数 | 说明 |
|------|------|
| `days` | 只统计最近 N 个自然日（含今天）；省略 = 全部历史 |
| `sessionId` | 只统计指定会话（id 精确或前缀匹配） |
| `limit` | bySession 行数上限，默认 10，最大 100 |

返回：窗口内总量、按会话 TOP、按日（升序）、按模型（降序）、最近调用
（倒序，内存环形缓冲，默认上限 200 条）。总量与各聚合行均带**估算费用**
（元）：`total.cost` 细分为 DeepSeek / 本地电费，并含 `remoteYuan`（等价
远端费用）与 `savedYuan`（折算节约）；`byRoute` 行带 `cost`，`byDay` /
`bySession` 行带 `costYuan`。

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
- **本地模型**（默认 provider 列表 `['llama-local', 'sglang-local',
  'vllm-local', 'ollama']`）：按 **GPU 负载折算电费** —— 只对真正消耗算力的
  token 折算时间：`输出 ÷ decode吞吐 + 未命中输入 ÷ prefill吞吐`，乘功耗与
  电价；**缓存读/写不计**（KV 缓存拉取能耗可忽略）。默认参数：整机功耗
  600W、电价 0.6 元/kWh、decode 50 tok/s、prefill 1000 tok/s。**物理上限
  兜底**：有限窗口下本地电费不超过"窗口天数 × 24h × 功耗 × 电价"（即 600W
  满载约 8.6 元/天），超出部分按比例分摊到各路由/日/会话，任何参数偏差
  都不会算出物理上不可能的数值。
- **未匹配的 route**（provider 不在配置列表、模型不在价目表）费用为 0，
  报告中该行费用显示 ¥0.00。
- **等价远端费用与折算节约**：对本地路由额外估算"若走远端"的假设费用——
  按 `localToRemoteModel` 映射（本地模型名 → 远端价目表模型名）查价目表。
  映射键按**前缀匹配**（精确命中优先，其次最长前缀），一条
  `'Qwen3.8-27B': 'deepseek-v4-flash'` 即可覆盖 `Qwen3.8-27B-UD-IQ4_XS-…`
  等量化变体；未命中映射时按**同名**查找（本地 `llama-local/deepseek-v4-flash`
  直接按 `deepseek-v4-flash` 官网价计）；仍查不到（量化模型名不在价目表）
  时按 `localFallbackRemoteModel` **兜底**（默认 `deepseek-v4-flash` 价，
  可配置覆盖或设 null 关闭）。`remoteYuan` = DeepSeek 实际费用 + 本地等价
  远端费用（即"若全部走远端"的总费用），`savedYuan` = 折算节约 =
  `remoteYuan - totalYuan`，仅本地路由贡献。**口径说明**：折算节约是
  **机会成本**（本地算力是沉没成本，电费只是边际成本），非现金节约；关闭
  兜底且本地模型不在价目表（未配置映射）时等价远端费用为 0，节约显示为负
  ——本地部署比远端更贵的信号。

估算费用对 DeepSeek 是 token 数的线性函数、对本地按折算时长线性，直接对
聚合桶计算即可；窗口过滤后费用与用量严格同步。

## Web 看板（conversation.view 页签）

Web GUI 会话视图区的 "Token 统计" 页签（`conversation.view` 列表槽，
`id: token-stats`，order 20，排在 chat / trajectory 之后）。布局参考
DeepSeek 开放平台用量面板：

- 标题行 + 时间维度切换（今日 / 3 日 / 7 日 / 全部）
- 统计卡片行：合计 / 输入（含缓存）/ 输出 / 缓存读 / 估算费用（DeepSeek
  与本地电费拆分）/ 折算节约（附"若全部走远端约 ¥X"，页面底部有估算口径脚注）
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
        # finalizeOnStop: true     # 停时把热层会话终态追加进 archive.jsonl（默认 true）
        # materializeMaxSizeBytes: 8388608  # 按需物化日志体积上限（默认 8MB，0=关闭）
        # ---- 费用估算（默认值即下方注释值）----
        # deepseekProvider: 'deepseek-official'       # DeepSeek 官方 provider 名
        # localProviders: ['llama-local', 'sglang-local', 'vllm-local', 'ollama']
        #                                              # 按电费估算的本地 provider 列表
        # deepseekPrices: {}                         # 价目表覆盖（元/百万 tokens，空闲价）
        #                                              # 例：{ 'deepseek-v4-flash': { inputMiss: 1.5, inputHit: 0.05, output: 4.5 } }
        # localToRemoteModel: {}                     # 本地模型名 → 远端价目表模型名（键按前缀匹配）
        #                                              # 例：{ 'Qwen3.8-27B': 'deepseek-v4-flash' } 覆盖所有量化变体
        # localFallbackRemoteModel: 'deepseek-v4-flash'
        #                                              # 未映射本地模型的兜底远端计费模型；null 关闭兜底
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

生效标志：DSH 终端出现
`[token-stats] started: dir=... trackedSessions=N archived=M ... api=/token-stats/api/report`
启动行（`archived` = 归档层已有会话数）；会话激活时出现
`session <id> ready: history folded, model calls=N` 折叠行；每次模型调用出现
`[token-stats] call session=... model=... in=... out=...` 监控行；按需物化
未跟踪会话时出现 `materialized stored session <id> (archive now M)`；Web GUI
会话视图区出现 "Token 统计" 页签且数据 5s 刷新。worker 运行见
"历史可追溯" 一节（进度逐条输出于其终端）。

## 已知边界

- 用量依赖 provider 上报：不回报 usage 的模型（部分免费/本地端点）统计不到
- 子代理按**进程内**会话统计：`subagent` / `subagent_fork` / `workflow` /
  `ralph` 等的子代理都是宿主进程内的真实会话，计入统计（每子代理一行，
  标题为其任务/角色首行）；若改用**进程外**后端（codex / claude-code /
  ACP 类），用量发生在别的进程，本插件观测不到其会话日志
- 1.4.1 之前创建的 fork 子会话条目可能把父会话历史用量重复计入（总量 /
  按日偏高）；升级后该会话再次激活（`session/created` 重新折叠）时其条目
  自动刷新修正
- 分层存储（1.5.0）：查询为"热层 ∪ 归档"合并视图；若**降级**到 <1.5.0，
  旧版本只读 `token-stats.json`（热层）——把 `archive.jsonl` 每行的
  `entry` 合并回该文件的 `sessions` 即可恢复旧全量行为。归档只追加不
  改写；内存中保留归档只读映射（每会话约 0.5–1 KB，历史行不含调用明细），
  如需进一步压内存可后续改每会话懒加载
- 宿主内**不做批量历史扫描**（曾引入的进程内自动回填已移除——整段日志
  读取/解析会抢占宿主单事件循环造成卡顿）；全量基线由停机时的进程外
  worker 承担（`scripts/backfill.mjs`，幂等续跑）。按需物化仅处理
  `materializeMaxSizeBytes`（默认 8MB）以内的小日志；超大日志请走 worker
  或在 GUI 打开该会话（公告时由 DSH 自己加载，插件顺带折叠）
- worker 在部署位的 `scripts/` 下运行（经部署树解析
  `@deepseek-ai/*`）；仓库内直接运行会因缺少该依赖树而报
  ERR_MODULE_NOT_FOUND（可用 `--dry-run --limit N` 在部署位试跑）
- `reasoningTokens` 已含在 `outputTokens` 内，合计口径不重复计
- 同步骤样本在合法日志中必然相邻，单槽位替换无损；异常日志（乱序）下
  以"最后到达的样本"为准
- 费用估算为近似值：DeepSeek 按空闲时段价低估（高峰调用实际更高）；本地
  电费按 GPU 负载折算（缓存读不计）+ 满载上限兜底，参数（功耗/吞吐/电价）
  按实际硬件调整后更准；价目表与官网变动不同步时需更新配置（或等插件内置
  价目表随官网刷新）
- 折算节约为**机会成本口径**（非现金节约）：本地算力是沉没成本；等价远端
  费用按同名/前缀映射模型近似，未映射时按兜底 flash 价（可配置关闭），
  映射与兜底配置不当会偏离真实对比
