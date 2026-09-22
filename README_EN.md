# dsh-token-stats-xg — Cross-Session Model Token Usage Monitoring & Statistics

[简体中文](README.md) · **English**

> [!NOTE] Maintenance Status
> This plugin is an internal XG-series tool, **provided for learning/reference only, with no maintenance commitment** (issues are not guaranteed a response).
> The latest development version is maintained in the internal GitLab XGDSHPlugins; this repository is a source-code snapshot.

Monitors the usage reported by providers in all DSH session logs, accumulates across sessions, and aggregates by day / by model / by session. Provides a terminal monitoring line, a `token_stats` query tool, a Web GUI dashboard tab, and **cost estimation** (DeepSeek at official off-peak prices, local at electricity cost), plus a hypothetical "if everything ran remotely" equivalent cost and **estimated savings**.

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

- `session/created`: when a session is announced, the in-memory log of events the session **produced itself** is **bulk-folded** — a resumed session carries all of its own history, so usage that occurred before the plugin was installed is also counted. The fold replaces that session's entry in the state atomically (the log is the source of truth; replay is idempotent). A forked subagent session (`subagent_fork`) carries the parent's completed-turn prefix as a seed (`inheritedEventCount` events); that usage belongs to the parent's entry, so only `session.ownEvents()` is folded and the parent's history is not double-counted into this session or into the total / byDay / byRoute / cost aggregates.
- `session/event`: real-time incremental folding; the first usage sample of each step prints one terminal monitoring line (controlled by `logCalls`, on by default).

## Persistence & Layered Storage

**Hot layer + archive layer** (`<dir>`, default `~/.dsh/token-stats/`):

- `token-stats.json` (**hot layer**): holds only the sessions **announced/active during the current process run** (the few sessions currently producing events). Each call debounces disk writes (default 2000ms, atomic tmp+rename replacement) and **only the hot layer is written** — write volume and hot-layer size are independent of total history.
- `archive.jsonl` (**archive layer**): **append-only**, one line per session (`{v, id, entry, archivedAt}`). Sessions are **finalized** into it one by one when the process stops (`finalizeOnStop`, default true) and removed from the hot layer; sessions announced again later are rebuilt wholesale from their durable log (idempotent replay — nothing lost, nothing double-counted). Duplicate lines for the same id are compacted proportionally at startup (last-wins).

Query paths (`token_stats` tool / REST `/token-stats/api/report` / Web dashboard) **merge the hot layer with the archive into a full session view** (hot wins, avoiding double counting), so history is **fully traceable** — including usage before plugin installation and old sessions never announced in this process (established by the backfill below).

## Full History Traceability (on-demand materialization + out-of-process worker)

The plugin **never bulk-scans inside the host process** — reading/parsing whole durable logs would hog the host's single event loop and stall the GUI and sessions. History is completed through two non-interfering paths:

1. **Real-time / on-demand materialization (in host, zero background cost)**: when a session is announced (opening a historical session → `session/created` full fold, i.e. "opened is complete") or when `token_stats` / REST **explicitly queries an untracked session id**, the session is folded into the archive **one at a time** in the background — but only if its compressed log does not exceed `materializeMaxSizeBytes` (default 8MB; 0 disables). Larger logs are skipped with a terminal hint to use the worker. Small-log reads are quick and cause no perceptible stutter.
2. **Out-of-process worker (`scripts/backfill.mjs`, full/incremental baseline)**: a standalone process sharing the same read and fold implementation as the host — it opens the store through `@deepseek-ai/dsh-session-persistence-jsonl` (reusing DSH's own format migration / validation / torn-tail handling — no self-written parsing) and folds with the pure `lib/logic.js` functions, appending into the same `archive.jsonl`. **It can run in parallel with a live DSH**: store reads are concurrency-safe, archive writes are whole-line appends that never overwrite the host's own appends (stop finalization / on-demand materialization), and the worker's end-of-run whole-file compaction detects foreign writes and skips itself, leaving duplicate lines for the host's next startup compaction. Use `--parallel 2` alongside a live DSH; `--parallel 4` (default) when DSH is down:

   ```powershell
   # After deployment (with DSH running or stopped; idempotent, resumable anytime)
   node ~/.dsh/profiles/web/node_modules/dsh-token-stats-xg/scripts/backfill.mjs
   # Useful options: --dry-run to preview pending; --limit N to sample;
   # --reconcile to re-fold archived sessions and compare entries (exit code 1 on mismatch)
   ```

   It only folds sessions that are **untracked** (absent from both hot and archive); prints progress, isolates per-session errors, and guards concurrent workers with `backfill.lock`. For full traceability: run it once; re-run it anytime to incrementally add new sessions (idempotent).

   **v0 legacy tolerant fallback**: some August-era session logs are format-v0 artifacts the current DSH catalog refuses to read (e.g. `subagent/descriptor` version 2 events — the DSH reader fails closed, and GUI resume fails for them too). For these artifacts the worker automatically falls back to a tolerant raw read: it decompresses the file frame by frame and feeds only schema-recognizable rows (usage / route / title events) into the same pure fold, dropping unknown rows. There is no reconciliation baseline for artifacts the current DSH cannot read, so this is a best-effort tolerant parse (worker-only; the host never reads log files directly).

## Query Tool `token_stats`

| Parameter | Description |
|------|------|
| `days` | Only count the most recent N calendar days (including today); omitted = entire history |
| `sessionId` | Only count the specified session (exact id or prefix match) |
| `limit` | Row limit for bySession, default 10, max 100 |

Returns: the total within the window, TOP by session, by day (ascending), by model (descending), and recent calls (descending, in-memory ring buffer, default cap 200 entries). The total and each aggregate row carry an **estimated cost** (CNY): `total.cost` breaks down into DeepSeek / local electricity and also carries `remoteYuan` (equivalent remote cost) and `savedYuan` (estimated savings); `byRoute` rows carry `cost`; `byDay` / `bySession` rows carry `costYuan`.

Implementation note: the `tools` / `webServer` services are declared as inject hard dependencies (`export const inject = ['tools', 'webServer']`) — the composition tree activates all entries in parallel, so without waiting the services may not be ready when `apply` runs, and registration would be silently lost. DSH composition guarantees these two services are provided, and the wait completes in milliseconds.

## Cost Estimation

On top of usage statistics, cost estimation is applied and priced by route (`provider/model`):

- **DeepSeek official** (default provider `deepseek-official`): estimated at the official "Models & Pricing" page **off-peak** prices (2026-08 version, CNY per million tokens) — the low-peak price is half the peak price, an "underestimates at low-peak" convention (actual peak-hour calls can cost up to 2x the estimate). Strictly distinguishes cache hit/miss: `cacheReadTokens` uses the hit price, `inputTokens` and `cacheWriteTokens` (cache writes are not separately billed by the official page, so they fall into the miss convention) use the miss price, and output uses the output price. Built-in price table: deepseek-v4-flash / -vision-exp input 1.5 (hit 0.05) / output 4.5; deepseek-v4-pro input 4.5 (hit 0.15) / output 13.5.
- **Local models** (default provider list `['llama-local', 'sglang-local', 'vllm-local', 'ollama']`): priced by **GPU-load-derived electricity cost** — only the tokens that actually consume compute are converted to time: `output ÷ decode throughput + uncached input ÷ prefill throughput`, multiplied by power draw and electricity price; **cache read/write is not counted** (the energy of fetching an KV cache is negligible). Default parameters: full-machine power 600W, electricity price 0.6 CNY/kWh, decode 50 tok/s, prefill 1000 tok/s. **Physical upper-bound fallback**: within a limited window, local electricity cost does not exceed "window days × 24h × power × electricity price" (i.e. ~8.6 CNY/day at 600W full load); any excess is apportioned across each route/day/session, so no parameter deviation can produce a physically impossible number.
- **Unmatched routes** (provider not in the config list, model not in the price table) have a cost of 0, and that row shows ¥0.00 in the report.
- **Equivalent remote cost & estimated savings**: for local routes, an additional hypothetical "if run remotely" cost is estimated by looking up the price table through the `localToRemoteModel` mapping (local model name → remote price-table model name). Mapping keys match by **prefix** (exact hit first, then the longest prefix), so a single `'Qwen3.8-27B': 'deepseek-v4-flash'` covers quantized variants like `Qwen3.8-27B-UD-IQ4_XS-…`; on a mapping miss the lookup falls back to **same-name** (local `llama-local/deepseek-v4-flash` is priced directly at the official `deepseek-v4-flash` price); if that also misses (quantized names are not in the table), `localFallbackRemoteModel` applies (default `deepseek-v4-flash` price, configurable or disabled with null). `remoteYuan` = actual DeepSeek cost + local equivalent remote cost (i.e. the total "if everything ran remotely"); `savedYuan` = estimated savings = `remoteYuan - totalYuan`, contributed only by local routes. **Convention note**: savings are an **opportunity cost** (local compute is a sunk cost; electricity is only the marginal cost), not cash savings; with the fallback disabled and a local model absent from the price table (and unmapped), the equivalent remote cost is 0 and savings show as negative — a signal that local deployment is more expensive than remote.

For DeepSeek, estimated cost is a linear function of token count; for local it is linear in converted time, so it can be computed directly on the aggregate buckets; after window filtering, cost and usage remain strictly in sync.

## Web Dashboard (conversation.view Tab)

The "Token Statistics" tab in the DSH Web client's session view area (`conversation.view` list slot, `id: token-stats`, order 20, after chat / trajectory). Layout follows the DeepSeek Open Platform usage panel:

- Title row + time-dimension switch (Today / 3 days / 7 days / All)
- Statistics card row: Total / Input (incl. cache) / Output / Cache read / Estimated cost (broken down into DeepSeek and local electricity) / Estimated savings (with "if everything ran remotely ≈ ¥X", and an estimation-convention footnote at the bottom of the page)
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
        # finalizeOnStop: true     # finalize hot sessions into archive.jsonl on stop (default true)
        # materializeMaxSizeBytes: 8388608  # on-demand log size cap (default 8MB, 0 disables)
        # ---- Cost estimation (defaults are the commented values below) ----
        # deepseekProvider: 'deepseek-official'       # DeepSeek official provider name
        # localProviders: ['llama-local', 'sglang-local', 'vllm-local', 'ollama']
        #                                              # local providers priced at electricity cost
        # deepseekPrices: {}                         # price-table override (CNY per million tokens, off-peak)
        #                                              # e.g. { 'deepseek-v4-flash': { inputMiss: 1.5, inputHit: 0.05, output: 4.5 } }
        # localToRemoteModel: {}                     # local model name → remote price-table model name (keys match by prefix)
        #                                              # e.g. { 'Qwen3.8-27B': 'deepseek-v4-flash' } covers all quantized variants
        # localFallbackRemoteModel: 'deepseek-v4-flash'
        #                                              # fallback remote model for unmapped local models; null disables it
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

Activation markers: a DSH terminal startup line of `[token-stats] started: dir=... trackedSessions=N archived=M ... api=/token-stats/api/report` (`archived` = sessions already in the archive layer); a fold line of `session <id> ready: history folded, model calls=N` when a session becomes active; a monitoring line of `[token-stats] call session=... model=... in=... out=...` on each model call; on on-demand materialization of an untracked session, `materialized stored session <id> (archive now M)`; a "Token Statistics" tab in the DSH client session view area with data refreshing every 5s. The worker's progress prints to its own terminal (see "Full History Traceability").

## Known Limitations

- Usage depends on provider reports: models that do not report usage (some free/local endpoints) are not counted
- In-process subagents are counted as sessions: children of `subagent` / `subagent_fork` / `workflow` / `ralph` etc. are real sessions in the host process and are counted (one row per child, titled with its task/persona first line); if an **out-of-process** backend (codex / claude-code / ACP family) is used instead, the usage happens in another process and this plugin cannot observe its session logs
- Forked subagent entries created before v1.4.1 may have the parent's historical usage double-counted in their entries (inflated totals / byDay); after upgrading, the entry is re-folded and corrected the next time that session becomes active (`session/created`)
- Layered storage (v1.5.0): queries use a "hot ∪ archive" merged view; on a **downgrade** below 1.5.0 the old version only reads `token-stats.json` (hot layer), so history would temporarily disappear from the tool/dashboard — merge each `entry` from `archive.jsonl` back into that file's `sessions` to restore the old all-in-one behavior. The archive is append-only and never rewritten; the read-only archive map is kept in memory (~0.5–1 KB per session; history rows contain no per-call details) — per-session lazy loading can be added later if memory needs to shrink further
- No **bulk history scan inside the host** (an earlier in-process auto-backfill was removed — reading/parsing whole logs hogs the host's single event loop and causes stutter); the full baseline is handled by the out-of-process worker (`scripts/backfill.mjs`, idempotent/resumable) while DSH is stopped. On-demand materialization only folds logs at or below `materializeMaxSizeBytes` (default 8MB); for very large logs use the worker or open the session in the GUI (DSH loads it on announce and the plugin folds along)
- The worker must run from the deployed `scripts/` folder (it resolves `@deepseek-ai/*` through the deployment tree); running it inside the repo fails with ERR_MODULE_NOT_FOUND because that tree is not present (dry-run with `--limit N` at the deployed location to try it)
- `reasoningTokens` is already included in `outputTokens`; the total convention does not double-count it
- Samples of the same step are necessarily adjacent in a valid log, so single-slot replacement is lossless; for abnormal out-of-order logs, the "last-arrived sample" wins
- Cost estimates are approximations: DeepSeek underestimates at off-peak prices (peak-hour calls are actually higher); local electricity is derived from GPU load (cache reads not counted) with a full-load upper-bound fallback — adjust the parameters (power/throughput/price) to the actual hardware for better accuracy; if the price table drifts from the official site, the config must be updated (or wait for the plugin's built-in price table to refresh with the site)
- Estimated savings are an **opportunity-cost convention** (not cash savings): local compute is a sunk cost; the equivalent remote cost approximates by same-name/prefix-mapped models, with an unmapped fallback to the flash price (configurable, can be disabled) — a misconfigured mapping or fallback will skew the comparison
