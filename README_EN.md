# dsh-token-stats-xg — Cross-Session Model Token Usage Monitoring & Statistics

<div align="center">
  <sub><a href="README.md">简体中文</a> | <b>English</b></sub>
</div>

> [!NOTE] Maintenance Status
> This plugin is an internal XG-series tool, **provided for learning/reference only, with no maintenance commitment** (issues are not guaranteed a response).
> The latest development version is maintained in the internal GitLab XGDSHPlugins; this repository is a source-code snapshot.

Monitors the usage reported by providers in all DSH session logs, accumulates across sessions, and aggregates by day / by model / by session. Provides a terminal monitoring line, a `token_stats` query tool, a Web GUI dashboard tab, and **cost estimation** (DeepSeek at official off-peak prices, local at electricity cost).

## Data Sources & Deduplication Semantics

usage comes from provider reports in session logs (durable log, source of truth):

| Event | Field | Role |
|------|------|------|
| `assistant/chunk` | `data.chunk = { type:'usage', usage }` | Streaming sample (retained even if the request fails) |
| `assistant/message` | `data.usage` | Final sample for that step (replaces the chunk sample of the same step) |

Deduplication semantics align with the `tokenUsage` projection of DSH's built-in token-meter: a single last slot; duplicate samples for the same `(turn, step)` are **replaced** rather than accumulated (subtract old, add new); a sample for a new step counts as one request. On top of this it attributes by day (local date key) and by model (`provider/model`; message uses `message.source`, chunk uses the route recorded by the most recent `request/context` / `request/header` log).

Usage buckets: `inputTokens` (uncached input), `outputTokens` (includes reasoning), `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens` (already contained within output; listed separately for analysis purposes). `totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens` (reasoning is not double-counted).

## Monitoring & History Fold-back

The plugin registers on the global ctx (receives all sessions, including subagent sessions):

- `session/created`: when a session is announced, the entire in-memory log is **bulk-folded** — a resumed session carries all its history, so usage that occurred before the plugin was installed is also counted. The fold replaces that session's entry in the state atomically (the log is the source of truth; replay is idempotent).
- `session/event`: real-time incremental folding; the first usage sample of each step prints one terminal monitoring line (controlled by `logCalls`, on by default).

## Persistence

State file `<dir>/token-stats.json` (default `~/.dsh/token-stats/`): stores per-session accumulated values (requests / totals / lastActivity / byDay), with debounced disk writes (default 2000ms) + an unload fallback write, and atomic replacement via tmp+rename. Accumulated values are restored after a process restart; when a session becomes active again its entry is refreshed by bulk folding. In-memory state (last slot, routes, recent-call ring buffer) is not persisted.

## Query Tool `token_stats`

| Parameter | Description |
|------|------|
| `days` | Only count the most recent N calendar days (including today); omitted = entire history |
| `sessionId` | Only count the specified session (exact id or prefix match) |
| `limit` | Row limit for bySession, default 10, max 100 |

Returns: the total within the window, TOP by session, by day (ascending), by model (descending), and recent calls (descending, in-memory ring buffer, default cap 200 entries). The total and each aggregate row carry an **estimated cost** (CNY): `total.cost` breaks down into DeepSeek / local electricity; `byRoute` rows carry `cost`; `byDay` / `bySession` rows carry `costYuan`.

Implementation note: the `tools` / `webServer` services are declared as inject hard dependencies (`export const inject = ['tools', 'webServer']`) — the composition tree activates all entries in parallel, so without waiting the services may not be ready when `apply` runs, and registration would be silently lost. DSH composition guarantees these two services are provided, and the wait completes in milliseconds.

## Cost Estimation

On top of usage statistics, cost estimation is applied and priced by route (`provider/model`):

- **DeepSeek official** (default provider `deepseek-official`): estimated at the official "Models & Pricing" page **off-peak** prices (2026-08 version, CNY per million tokens) — the low-peak price is half the peak price, an "underestimates at low-peak" convention (actual peak-hour calls can cost up to 2x the estimate). Strictly distinguishes cache hit/miss: `cacheReadTokens` uses the hit price, `inputTokens` and `cacheWriteTokens` (cache writes are not separately billed by the official page, so they fall into the miss convention) use the miss price, and output uses the output price. Built-in price table: deepseek-v4-flash / -vision-exp input 1.5 (hit 0.05) / output 4.5; deepseek-v4-pro input 4.5 (hit 0.15) / output 13.5.
- **Local models** (default provider `llama-local`): priced by **GPU-load-derived electricity cost** — only the tokens that actually consume compute are converted to time: `output ÷ decode throughput + uncached input ÷ prefill throughput`, multiplied by power draw and electricity price; **cache read/write is not counted** (the energy of fetching an KV cache is negligible). Default parameters: full-machine power 600W, electricity price 0.6 CNY/kWh, decode 50 tok/s, prefill 1000 tok/s. **Physical upper-bound fallback**: within a limited window, local electricity cost does not exceed "window days × 24h × power × electricity price" (i.e. ~8.6 CNY/day at 600W full load); any excess is apportioned across each route/day/session, so no parameter deviation can produce a physically impossible number.
- **Unmatched routes** (provider not in the config list, model not in the price table) have a cost of 0, and that row shows ¥0.00 in the report.

For DeepSeek, estimated cost is a linear function of token count; for local it is linear in converted time, so it can be computed directly on the aggregate buckets; after window filtering, cost and usage remain strictly in sync.

## Web Dashboard (conversation.view Tab)

The "Token Statistics" tab in the DSH Web client's session view area (`conversation.view` list slot, `id: token-stats`, order 20, after chat / trajectory). Layout follows the DeepSeek Open Platform usage panel:

- Title row + time-dimension switch (Today / 3 days / 7 days / All)
- Statistics card row: Total / Input (incl. cache) / Output / Cache read / Estimated cost (broken down into DeepSeek and local electricity, with an estimation-convention footnote at the bottom of the page)
- Main bar chart: by hour (24 buckets) for the Today window, by day for the other windows (last 14 days shown when exceeding 14 days)
- Dual lists by model / by session (with cost column) + recent-call details (first 10 entries of the in-memory ring buffer)

Data flow: the client polls the host REST API every 5s (polling stops when the tab is switched away / unloaded):

```
GET /token-stats/api/report?days=1|3|7[&limit=N]
→ { report: StatsReport, byHour: HourBucketRow[] | null }   // byHour is non-null only for days=1
```

All colors use DSH theme tokens (`--dsw-alias-*`), adapting to light/dark themes.

The client half is a single-file bundle (`lib/client.js`, bundled by tsdown, loaded via `window.__ModuleLoader__.load`, with react going through the platform module table rather than being bundled), auto-discovered by boot from `package.json`'s `dsh.client` (`platform: 'web'`) and `exports['./client']`, requiring no extra composition config.

## Configuration (cordis.patch.yml)

```yaml
- insert:
    - id: token-stats
      name: 'dsh-token-stats-xg'
      config:
        logCalls: true   # print one terminal monitoring line per model call (default true)
        # enabled: true  # master switch (default true)
        # dir: ...       # state directory (default ~/.dsh/token-stats)
        # flushMs: 2000  # disk-write debounce (default 2000)
        # recentLimit: 200
        # ---- Cost estimation (defaults are the commented values below) ----
        # deepseekProvider: 'deepseek-official'       # DeepSeek official provider name
        # localProviders: ['llama-local']            # local providers priced at electricity cost
        # deepseekPrices: {}                         # price-table override (CNY per million tokens, off-peak)
        #                                              # e.g. { 'deepseek-v4-flash': { inputMiss: 1.5, inputHit: 0.05, output: 4.5 } }
        # localPricePerKwh: 0.6                      # local electricity price (CNY/kWh)
        # localPowerWatts: 600                       # local full-machine power draw (watts)
        # localDecodeTps: 50                         # local output throughput (tokens/sec)
        # localPrefillTps: 1000                      # local uncached-input throughput (tokens/sec)
```

## Build & Deployment

```
# Build (inside the plugin directory, one step: junction fix-up → tsdown client bundle →
# tsc host compile → client type check → artifact verification → unit tests)
node scripts/build.mjs
# Optional: DSH_CHECKOUT env var to specify the DSH checkout path (default D:/deepseek-harness)
# Deployment (delete first, then copy, to avoid stale files)
Copy lib/ and package.json to ~/.dsh/profiles/web/node_modules/dsh-token-stats-xg/
# Restart DSH to apply (Ctrl+C → pnpm dsh web)
```

Build-order constraint: tsdown's clean clears the entire `lib/`, so it must run before the host tsc (`scripts/build.mjs` is already ordered this way).

Activation markers: a DSH terminal startup line of `[token-stats] started: dir=... ... api=/token-stats/api/report`; a fold line of `session <id> ready: history folded, model calls=N` when a session becomes active; a monitoring line of `[token-stats] call session=... model=... in=... out=...` on each model call; a "Token Statistics" tab in the DSH client session view area with data refreshing every 5s.

## Known Limitations

- Usage depends on provider reports: models that do not report usage (some free/local endpoints) are not counted
- `reasoningTokens` is already included in `outputTokens`; the total convention does not double-count it
- Samples of the same step are necessarily adjacent in a valid log, so single-slot replacement is lossless; for abnormal out-of-order logs, the "last-arrived sample" wins
- Cost estimates are approximations: DeepSeek underestimates at off-peak prices (peak-hour calls are actually higher); local electricity is derived from GPU load (cache reads not counted) with a full-load upper-bound fallback — adjust the parameters (power/throughput/price) to the actual hardware for better accuracy; if the price table drifts from the official site, the config must be updated (or wait for the plugin's built-in price table to refresh with the site)
