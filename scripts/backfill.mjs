#!/usr/bin/env node
/**
 * dsh-token-stats-xg 进程外历史基线构建器（scripts/backfill.mjs）
 *
 * 用途：把持久化会话存储中"尚未跟踪"的会话（热层/归档均无记录）折叠进
 * archive.jsonl，建立/补齐跨会话历史基线。与宿主内插件同源：
 *   - 读取走 DSH 自己的 JSONL 持久化实现（@deepseek-ai/dsh-session-persistence-jsonl，
 *     含格式迁移/校验/残缺尾帧处理），不在本进程里自研解析；
 *   - 折叠走插件纯逻辑（../lib/logic.js 的 createSessionFold/foldSessionEvents/
 *     foldToStored），与宿主实时折叠逐位一致；
 *   - 归档写入与宿主同一条 append 路径（幂等：已跟踪会话跳过，可随时重跑）。
 *
 * ⚠ 并发：**可与运行中的 DSH 并行**——会话存储读取本身并发安全（宿主文档
 *   保证 read 不取所有权）；归档只做整行追加，与宿主仅有的追加动作（停时
 *   终态化/按需物化）互不覆盖。唯一例外是收尾的**整文件压实重写**：worker
 *   会在压实前检测归档是否被他方改写过（文件大小 != 启动大小 + 本进程追加
 *   字节），被改写则跳过压实，重复行留给宿主下次启动时自动压实。
 *   状态目录下用 backfill.lock 互斥第二个 worker。
 *
 * 用法：
 *   node scripts/backfill.mjs [选项]
 *   --dir <路径>     状态目录（默认 ~/.dsh/token-stats）
 *   --root <路径>    会话存储根目录（默认 ~/.dsh/sessions）
 *   --dry-run        只统计待处理会话，不写归档
 *   --limit N        最多处理 N 个待处理会话（试跑/抽样用）
 *   --parallel N     并行读取数（默认 4；与 DSH 并行时建议 2）
 *   --reconcile      对账：抽查已归档会话，重折叠日志与现有条目比对（默认 20 个，
 *                    --reconcile-limit N 调整），不一致会列出并退出码 1
 *   --reconcile-limit N
 *   --quiet          减少进度输出
 *   --help
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { openSync, closeSync, rmSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import {
  appendArchiveLine,
  archiveFilePath,
  createSessionFold,
  encodeArchiveLine,
  foldSessionEvents,
  foldToStored,
  readArchiveFile,
  rewriteArchive,
  usageEqual,
} from '../lib/logic.js'

const DEFAULTS = {
  dir: join(homedir(), '.dsh', 'token-stats'),
  root: join(homedir(), '.dsh', 'sessions'),
}

function usage() {
  console.log(String.raw`dsh-token-stats-xg backfill worker

用法:
  node scripts/backfill.mjs [--dir <dir>] [--root <root>] [--dry-run]
       [--limit N] [--parallel N] [--reconcile] [--reconcile-limit N] [--quiet] [--help]

说明: 可与运行中的 DSH 并行执行（读取并发安全、归档只整行追加；收尾压实
     会自动避让他方写入，重复行留给宿主下次启动压实）。
默认: --dir  ~/.dsh/token-stats
      --root ~/.dsh/sessions
`)
}

function parseArgs(argv) {
  const out = { ...DEFAULTS, dryRun: false, limit: Infinity, parallel: 4, reconcile: false, reconcileLimit: 20, quiet: false }
  const take = (i) => (i + 1 < argv.length ? argv[i + 1] : undefined)
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d }
    if (a === '--help' || a === '-h') { usage(); process.exit(0) }
    else if (a === '--dir') out.dir = take(i++)
    else if (a === '--root') out.root = take(i++)
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--limit') out.limit = num(take(i++), Infinity)
    else if (a === '--parallel') out.parallel = Math.max(1, num(take(i++), 4))
    else if (a === '--reconcile') out.reconcile = true
    else if (a === '--reconcile-limit') out.reconcileLimit = num(take(i++), 20)
    else if (a === '--quiet') out.quiet = true
    else { console.warn(`[backfill] 未知参数: ${a}`); usage(); process.exit(2) }
  }
  return out
}

/** 解析热层文件里的会话 id（宿主正常停机后为空；崩溃残留时视为已跟踪） */
function readHotIds(stateDir) {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, 'token-stats.json'), 'utf8'))
    return new Set(Object.keys(raw?.sessions ?? {}))
  } catch {
    return new Set()
  }
}

/** 逐字段比较两条折叠结果（token-stats 口径） */
function entriesEqual(a, b) {
  if (a.requests !== b.requests) return false
  if (a.lastActivity !== b.lastActivity) return false
  if (!usageEqual(a.totals, b.totals)) return false
  const da = Object.keys(a.byDay ?? {}).sort()
  const db = Object.keys(b.byDay ?? {}).sort()
  if (da.length !== db.length || da.some((d, i) => d !== db[i])) return false
  for (const day of da) {
    const x = a.byDay[day]
    const y = b.byDay[day]
    if (!x || !y) return false
    if (x.requests !== y.requests || !usageEqual(x.usage, y.usage)) return false
    const ra = Object.keys(x.byRoute ?? {}).sort()
    const rb = Object.keys(y.byRoute ?? {}).sort()
    if (ra.length !== rb.length || ra.some((r, i) => r !== rb[i])) return false
    for (const route of ra) {
      const xx = x.byRoute[route]
      const yy = y.byRoute[route]
      if (!xx || !yy) return false
      if (xx.requests !== yy.requests || !usageEqual(xx.usage, yy.usage)) return false
    }
  }
  return true
}

// ---------------------------------------------------------------------------
// v0 旧格式宽容回退（legacy raw reader）
//
// 部分 8 月遗留的会话日志为 format v0 artifact，内含当前 DSH 目录无法识别的
// 事件（如 subagent/descriptor version 2），DSH 持久化读取器对未知词汇
// fail-closed、整个文件拒读（宿主 GUI 恢复此类会话同样失败）。但文件本身是
// 可解的逐帧 zstd + JSONL，usage 相关事件（assistant/chunk|message、
// request/context|header、session/title）的 schema 与现格式一致。
//
// 回退策略（仅 worker 使用，宿主永不直读文件）：逐帧解压 → 逐行解析 →
// 只把"shape 可识别"的行喂给插件纯折叠函数（未知行被纯函数天然忽略），
// 得到该会话的用量基线。无法被现 DSH 读取的旧产物没有"对账基准"可依，
// 属尽力而为的宽容解析；行级失败不会中断其他会话。
// ---------------------------------------------------------------------------

const ZSTD_MAGIC = 0xFD2FB528

/**
 * 定位完整 zstd 帧区间（结构扫描，不解压）。移植自
 * @deepseek-ai/dsh-session-persistence-jsonl/src/zstd.ts（scanZstdFrames），
 * 与宿主读取同一容器格式：逐帧 zstd，尾部可能残留写入中断的半帧。
 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames }
    offset += 4
    if (offset === buffer.length) return { frames }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) return { frames }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) return { frames }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/** 逐帧解压完整帧（半帧忽略），返回拼接文本 */
function decodeRawLog(buffer) {
  const { frames } = scanZstdFrames(buffer)
  let text = ''
  for (const { start, end } of frames) {
    try {
      text += zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
    } catch {
      // 单帧损坏跳过；其余帧照常
    }
  }
  return text
}

/** 解析原始文本：可折叠行 {type,time,data} + 首条 session 行携带的头部元数据 */
function parseRawLog(text) {
  const rows = []
  let meta = {}
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    if (typeof obj !== 'object' || obj === null) continue
    if (obj.type === 'session' && typeof obj.id === 'string') {
      meta = {
        cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
        agentPreset: typeof obj.agentPreset === 'string' ? obj.agentPreset : undefined,
        createdAt: typeof obj.createdAt === 'number' && Number.isFinite(obj.createdAt) ? obj.createdAt : 0,
      }
    }
    if (typeof obj.type !== 'string' || obj.type.length === 0) continue
    if (!(typeof obj.time === 'number' && Number.isFinite(obj.time))) continue
    rows.push({ type: obj.type, time: obj.time, data: obj.data })
  }
  return { rows, meta }
}

/** 扫描存储根，建 id → 首个 *.jsonl.zstd 的索引（回退读取用） */
function buildRawIndex(root) {
  const index = new Map()
  let projects
  try { projects = readdirSync(root, { withFileTypes: true }) } catch { return index }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue
    const projPath = join(root, proj.name)
    let sessions
    try { sessions = readdirSync(projPath, { withFileTypes: true }) } catch { continue }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const dir = join(projPath, s.name)
      let names
      try { names = readdirSync(dir) } catch { continue }
      const logs = names.filter(n => n.endsWith('.jsonl.zstd'))
      if (logs.length === 0) continue
      // 优先不带版本号的旧文件名（session.jsonl.zstd），其次字典序
      logs.sort((x, y) => {
        const vx = /^session\.v\d+\.jsonl\.zstd$/.test(x) ? 1 : 0
        const vy = /^session\.v\d+\.jsonl\.zstd$/.test(y) ? 1 : 0
        return vx - vy || (x < y ? -1 : x > y ? 1 : 0)
      })
      index.set(s.name, join(dir, logs[0]))
    }
  }
  return index
}

async function main() {
  const opt = parseArgs(process.argv.slice(2))
  const stateFile = join(opt.dir, 'token-stats.json')
  const archiveFile = archiveFilePath(opt.dir)
  const hot = readHotIds(opt.dir)
  const { map: archived } = readArchiveFile(archiveFile)
  /** 启动时的归档文件大小（收尾压实前用于判断是否被其他方改写） */
  let archiveStartSize = 0
  try { archiveStartSize = statSync(archiveFile).size } catch { /* 归档尚不存在 */ }

  // 互斥锁：阻止第二个 worker 并发写归档
  const lockFile = join(opt.dir, 'backfill.lock')
  let lockFd = null
  try {
    lockFd = openSync(lockFile, 'wx')
  } catch {
    console.error('[backfill] 另一个 worker 正在运行（backfill.lock 已存在）；若确认无残留请删除后重试')
    process.exit(2)
  }
  const releaseLock = () => {
    try { if (lockFd !== null) closeSync(lockFd) } catch { /* ignore */ }
    try { rmSync(lockFile, { force: true }) } catch { /* ignore */ }
  }

  const ctx = new Context()
  let persistence
  try {
    persistence = new JsonlPersistence(ctx, { root: opt.root, compression: 'zstd' })
  } catch (error) {
    console.error(`[backfill] 无法打开会话存储根 ${opt.root}: ${String(error)}`)
    releaseLock()
    process.exit(2)
  }

  const log = (msg) => { if (!opt.quiet) console.log(msg) }
  const rawIndex = buildRawIndex(opt.root)

  /**
   * 折叠一个会话：优先 DSH 读取器；拒读的旧格式(v0)产物走宽容原始回退。
   * @returns {{entry: object, legacy: boolean}} legacy=true 表示走了 v0 回退
   */
  const foldAny = async (id) => {
    try {
      const handle = await persistence.open(id, 'read')
      try {
        const events = await handle.read(0)
        const meta = handle.header ?? {}
        const inherited = Number(handle.inheritedEventCount ?? 0)
        const own = Number.isFinite(inherited) && inherited > 0 ? events.slice(inherited) : events
        const fold = createSessionFold({
          cwd: typeof meta.cwd === 'string' ? meta.cwd : undefined,
          agentPreset: typeof meta.agentPreset === 'string' ? meta.agentPreset : undefined,
          createdAt: typeof meta.createdAt === 'number' && Number.isFinite(meta.createdAt) ? meta.createdAt : 0,
        })
        foldSessionEvents(fold, own)
        return { entry: foldToStored(fold), legacy: false }
      } finally {
        await handle.close()
      }
    } catch (error) {
      // v0 旧格式产物：当前 DSH 目录 fail-closed 拒读（含宿主 GUI 恢复）。
      // 尽力而为的宽容回退——逐帧解压原始文件，把可识别行喂给同一纯折叠。
      const file = rawIndex.get(id)
      if (file === undefined) throw error
      const { rows, meta } = parseRawLog(decodeRawLog(readFileSync(file)))
      if (rows.length === 0) throw error
      const fold = createSessionFold({
        cwd: meta.cwd,
        agentPreset: meta.agentPreset,
        createdAt: meta.createdAt,
      })
      foldSessionEvents(fold, rows)
      return { entry: foldToStored(fold), legacy: true }
    }
  }

  try {
    // ---- 对账（可选）：抽查已归档条目，重折叠日志比对 ----
    let mismatches = 0
    if (opt.reconcile) {
      const ids = [...archived.keys()].slice(0, opt.reconcileLimit)
      log(`[backfill] reconcile: 抽查 ${ids.length} 个已归档会话…`)
      for (const id of ids) {
        try {
          const { entry } = await foldAny(id)
          const existing = archived.get(id)
          if (existing && !entriesEqual(existing, entry)) {
            mismatches += 1
            console.warn(`[backfill] reconcile MISMATCH ${id}: stored requests=${existing.requests} vs log requests=${entry.requests}`)
          }
        } catch (error) {
          mismatches += 1
          console.warn(`[backfill] reconcile FAILED ${id}: ${String(error)}`)
        }
      }
      log(`[backfill] reconcile done: ${mismatches} mismatches/failures of ${ids.length}`)
      if (mismatches > 0) {
        releaseLock()
        process.exit(1)
      }
    }

    // ---- 枚举待处理 ----
    const list = await persistence.list()
    const pending = []
    let already = 0
    let zeroSize = 0
    for (const snap of list) {
      const meta = snap.header ?? {}
      const id = typeof meta.id === 'string' ? meta.id : ''
      if (!id) continue
      if (hot.has(id) || archived.has(id)) { already += 1; continue }
      if ((snap.sizeBytes ?? 0) === 0) { zeroSize += 1; continue }
      pending.push(id)
    }
    if (opt.limit !== Infinity) pending.length = Math.min(pending.length, opt.limit)
    log(`[backfill] stored=${list.length} already=${already} zeroSize=${zeroSize} pending=${pending.length}${opt.dryRun ? ' (dry-run)' : ''}`)
    if (pending.length === 0) {
      releaseLock()
      process.exit(0)
    }

    // ---- 折叠并写归档（串行队列 + parallel 并发读取）----
    const startedAt = Date.now()
    let archivedN = 0
    let legacyN = 0
    let failed = 0
    const failedIds = []
    const archivedMap = archived
    /** 本次进程追加进归档的字节数（压实前用它判断文件是否被其他方改写过） */
    let ownAppendedBytes = 0
    let cursor = 0
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

    const worker = async () => {
      while (cursor < pending.length) {
        const id = pending[cursor++]
        try {
          const { entry, legacy } = await foldAny(id)
          if (legacy) legacyN += 1
          if (!opt.dryRun) {
            const at = Date.now()
            appendArchiveLine(archiveFile, id, entry, at)
            ownAppendedBytes += Buffer.byteLength(encodeArchiveLine(id, entry, at), 'utf8') + 1
            archivedMap.set(id, entry)
          }
          archivedN += 1
        } catch (error) {
          failed += 1
          failedIds.push(id)
          console.warn(`[backfill] session ${id} failed: ${String(error)}`)
        }
        if ((archivedN + failed) % 10 === 0) {
          log(`[backfill] progress: ${archivedN + failed}/${pending.length} (ok=${archivedN} failed=${failed})`)
        }
        await sleep(5) // 让出事件循环，避免单 worker 长解析饿死调度
      }
    }
    await Promise.all(Array.from({ length: opt.parallel }, () => worker()))

    // 去重压实（追加期间可能产生同 id 重复行）。DSH 并行运行时，若归档文件
    // 除本进程追加外还被他方（宿主停时终态化/按需物化）改写过，则不重写
    // 整文件——重复行留给宿主下次启动时的自动压实，避免覆盖他人刚写入的行。
    if (!opt.dryRun && ownAppendedBytes > 0) {
      try {
        const endSize = statSync(archiveFile).size
        const touchedByOthers = endSize !== archiveStartSize + ownAppendedBytes
        if (touchedByOthers) {
          log('[backfill] archive 被其他方并行改写，跳过压实（重复行由宿主下次启动压实）')
        } else {
          const { map: afterMap, lines, duplicateLines } = readArchiveFile(archiveFile)
          if (duplicateLines > 0 && (duplicateLines >= 64 || duplicateLines > lines * 0.2)) {
            rewriteArchive(archiveFile, afterMap, Date.now())
            log(`[backfill] archive compacted: ${lines} lines -> ${afterMap.size} sessions`)
          }
        }
      } catch {
        // stat 失败不阻塞收尾
      }
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    log(`[backfill] done: ok=${archivedN} (legacy-v0=${legacyN}) failed=${failed} in ${seconds}s (archive now ${archivedMap.size})${opt.dryRun ? ' [dry-run, 未写盘]' : ''}`)
    if (failed > 0) {
      console.warn(`[backfill] failed ids (${failed}): ${failedIds.slice(0, 10).join(', ')}${failedIds.length > 10 ? ' …' : ''}`)
    }
    releaseLock()
    process.exit(failed > 0 ? 1 : 0)
  } catch (error) {
    console.error(`[backfill] aborted: ${String(error)}`)
    releaseLock()
    process.exit(1)
  }
}

main()
