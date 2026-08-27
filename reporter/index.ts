import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { createReadStream } from 'fs'
import { chmod, readFile, readdir, stat, writeFile, rename, access } from 'fs/promises'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'
import chokidar from 'chokidar'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface Config {
  name: string
  email: string
  deviceId: string
  serverUrl: string
  secret: string
  color?: string
  /** Optional override for how often totals are POSTed. Floored at 5 minutes. */
  reportIntervalMinutes?: number
}

interface FileTotals {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  tokensByModel: Record<string, number>
  tokensTodayByDate: Record<string, number>
  /** Token sums keyed by 5-minute UTC bucket start (epoch ms, as a string). */
  bucketsByMinute: Record<string, number>
  /** Contiguous runs of assistant activity within this file. */
  sessions: SessionWindow[]
  linesTotal: number
  linesJsonValid: number
  linesWithUsage: number
}

interface SessionWindow {
  startedAt: number
  lastActivityAt: number
}

interface FileCacheEntry {
  mtime: number
  size: number
  totals: FileTotals
}

interface CacheSnapshot {
  version: number
  entries: Record<string, FileCacheEntry>
}

interface Aggregate {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  tokensByModel: Record<string, number>
  tokensToday: number
  sessionCount: number
  schemaHealthy: boolean
  /** Recent 5-minute token buckets, oldest first. */
  buckets: ReadonlyArray<{ bucketStart: number; tokens: number }>
  /** Most recent activity windows, newest first. */
  sessions: ReadonlyArray<SessionWindow>
}

interface JSONLUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface JSONLLine {
  type?: string
  timestamp?: string
  message?: { model?: string; usage?: JSONLUsage }
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? ''
const CONFIG_PATH = path.join(HOME, '.leaderboard-reporter.json')
const CACHE_PATH = path.join(HOME, '.leaderboard-reporter.cache.json')
const ERROR_FLAG_PATH = path.join(HOME, '.leaderboard-reporter.error')
const REPORTER_DIR = path.dirname(fileURLToPath(import.meta.url))

const CACHE_VERSION = 4
// How often we POST aggregated totals to the server. Local scanning/caching
// still happens on every file change (see the chokidar watcher), but network
// writes are throttled to this interval to keep Convex usage low.
const DEFAULT_REPORT_INTERVAL_MS = 60 * 60_000
const MIN_REPORT_INTERVAL_MS = 5 * 60_000
const CHOKIDAR_DEBOUNCE_MS = 2_000
const CACHE_PERSIST_INTERVAL_MS = 5 * 60_000
const MEMORY_CHECK_INTERVAL_MS = 60_000
const UPDATE_CHECK_INTERVAL_MS = 60 * 60_000
const MEMORY_CEILING_BYTES = 400 * 1024 * 1024
const AUTH_FAILURE_BACKOFF_MS = 60_000
const FETCH_TIMEOUT_MS = 30_000
const DRIFT_MIN_SAMPLE = 100
const DRIFT_YIELD_THRESHOLD = 0.01
// Claude Code writes this placeholder for locally-generated assistant lines
// that never hit the API; they always carry zero usage.
const SYNTHETIC_MODEL = '<synthetic>'

// Velocity resolution. Five minutes is fine enough that a kart visibly reacts
// within one report, coarse enough that a day of buckets stays small.
const BUCKET_MS = 5 * 60_000
// Only recent buckets are worth sending: the server derives *current* velocity
// and daily score, and anything older is already folded into lifetime totals.
const BUCKET_RETENTION_MS = 26 * 60 * 60_000
const MAX_BUCKETS_PER_REPORT = 400
// A gap longer than this ends a session. Claude Code's own window is 5h, but
// what we want here is "were they at the keyboard", which idles out far sooner.
const SESSION_IDLE_GAP_MS = 30 * 60_000
const MAX_SESSIONS_PER_REPORT = 3

const fileCache = new Map<string, FileCacheEntry>()
let cacheDirty = false
let scanning = false
let lastPostAt = 0
let reportIntervalMs = DEFAULT_REPORT_INTERVAL_MS

function todayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dateKeyFromIso(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return todayKey(d)
}

function run(cmd: string, args: readonly string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    proc.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }))
    proc.on('error', (err) => resolve({ code: 1, stdout: '', stderr: err.message }))
  })
}

async function getClaudeDataDirs(): Promise<string[]> {
  const candidates = [
    path.join(HOME, '.config/claude/projects'),
    path.join(HOME, '.claude/projects'),
  ]
  const existing: string[] = []
  for (const candidate of candidates) {
    try {
      await access(candidate)
      existing.push(candidate)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`Cannot access ${candidate}:`, err)
      }
    }
  }
  return existing
}

async function walkJSONL(dir: string): Promise<string[]> {
  const results: string[] = []
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const current = stack.pop() as string
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (err) {
      console.warn(`Cannot read dir ${current}:`, err)
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.name.endsWith('.jsonl')) {
        results.push(full)
      }
    }
  }
  return results
}

/**
 * Collapse a list of activity timestamps into contiguous windows, splitting
 * wherever the gap exceeds SESSION_IDLE_GAP_MS. Input need not be sorted.
 */
function toSessionWindows(times: ReadonlyArray<number>): SessionWindow[] {
  if (times.length === 0) return []
  const sorted = [...times].sort((a, b) => a - b)
  const windows: SessionWindow[] = []
  let start = sorted[0]
  let previous = sorted[0]

  for (let i = 1; i < sorted.length; i++) {
    const at = sorted[i]
    if (at - previous > SESSION_IDLE_GAP_MS) {
      windows.push({ startedAt: start, lastActivityAt: previous })
      start = at
    }
    previous = at
  }
  windows.push({ startedAt: start, lastActivityAt: previous })
  return windows
}

/**
 * Merge overlapping or near-touching windows from different transcripts. Two
 * projects open at once are one human session, not two.
 */
function mergeSessionWindows(windows: ReadonlyArray<SessionWindow>): SessionWindow[] {
  if (windows.length === 0) return []
  const sorted = [...windows].sort((a, b) => a.startedAt - b.startedAt)
  const merged: SessionWindow[] = [{ ...sorted[0] }]

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]
    const last = merged[merged.length - 1]
    if (current.startedAt - last.lastActivityAt <= SESSION_IDLE_GAP_MS) {
      last.lastActivityAt = Math.max(last.lastActivityAt, current.lastActivityAt)
    } else {
      merged.push({ ...current })
    }
  }
  return merged
}

async function parseJSONLStreaming(filePath: string): Promise<FileTotals | null> {
  const totals: FileTotals = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    tokensByModel: {},
    tokensTodayByDate: {},
    bucketsByMinute: {},
    sessions: [],
    linesTotal: 0,
    linesJsonValid: 0,
    linesWithUsage: 0,
  }

  // Lines within a transcript are chronological in practice, but a resumed or
  // forked session can emit them out of order. Collect and sort rather than
  // trusting file order, or one stray line splits a session in two.
  const activityTimes: number[] = []

  return await new Promise<FileTotals | null>((resolve) => {
    const stream = createReadStream(filePath, { encoding: 'utf-8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

    stream.on('error', (err) => {
      console.warn(`Read error on ${filePath}:`, err)
      rl.close()
      resolve(null)
    })

    rl.on('line', (line) => {
      if (!line.trim()) return
      totals.linesTotal++
      let parsed: JSONLLine
      try {
        parsed = JSON.parse(line) as JSONLLine
      } catch {
        return
      }
      totals.linesJsonValid++
      if (parsed.type !== 'assistant' || !parsed.message?.usage) return

      const u = parsed.message.usage
      const input = u.input_tokens ?? 0
      const output = u.output_tokens ?? 0
      const cacheRead = u.cache_read_input_tokens ?? 0
      const cacheCreate = u.cache_creation_input_tokens ?? 0
      const sum = input + output + cacheRead + cacheCreate

      totals.inputTokens += input
      totals.outputTokens += output
      totals.cacheTokens += cacheRead + cacheCreate
      totals.totalTokens += sum
      totals.linesWithUsage++

      // Raw model id is stored verbatim; the leaderboard normalises it to a
      // family label at render time so new dated ids never need a migration.
      const model = parsed.message.model
      if (model && model !== SYNTHETIC_MODEL && sum > 0) {
        totals.tokensByModel[model] = (totals.tokensByModel[model] ?? 0) + sum
      }

      if (parsed.timestamp) {
        const dateKey = dateKeyFromIso(parsed.timestamp)
        if (dateKey) {
          totals.tokensTodayByDate[dateKey] = (totals.tokensTodayByDate[dateKey] ?? 0) + sum
        }

        const at = new Date(parsed.timestamp).getTime()
        if (!Number.isNaN(at)) {
          activityTimes.push(at)
          const bucketStart = Math.floor(at / BUCKET_MS) * BUCKET_MS
          const bucketKey = String(bucketStart)
          totals.bucketsByMinute[bucketKey] = (totals.bucketsByMinute[bucketKey] ?? 0) + sum
        }
      }
    })

    rl.on('close', () => {
      totals.sessions = toSessionWindows(activityTimes)
      resolve(totals)
    })
  })
}

async function getFileTotals(filePath: string): Promise<FileTotals | null> {
  let st
  try {
    st = await stat(filePath)
  } catch (err) {
    console.warn(`Stat failed for ${filePath}:`, err)
    return null
  }

  const cached = fileCache.get(filePath)
  const mtime = st.mtimeMs
  const size = st.size
  if (cached && cached.mtime === mtime && cached.size === size) {
    return cached.totals
  }

  const totals = await parseJSONLStreaming(filePath)
  if (totals === null) return null
  fileCache.set(filePath, { mtime, size, totals })
  cacheDirty = true
  return totals
}

async function aggregateAll(): Promise<Aggregate> {
  const dirs = await getClaudeDataDirs()
  let totalTokens = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheTokens = 0
  let tokensToday = 0
  let sessionCount = 0
  let linesJsonValid = 0
  const tokensByModel: Record<string, number> = {}
  let linesWithUsage = 0
  const today = todayKey()
  const seenPaths = new Set<string>()
  const bucketTotals = new Map<number, number>()
  const allSessions: SessionWindow[] = []
  const bucketFloor = Date.now() - BUCKET_RETENTION_MS

  for (const dir of dirs) {
    const files = await walkJSONL(dir)
    for (const filePath of files) {
      seenPaths.add(filePath)
      const totals = await getFileTotals(filePath)
      if (!totals) continue
      totalTokens += totals.totalTokens
      inputTokens += totals.inputTokens
      outputTokens += totals.outputTokens
      cacheTokens += totals.cacheTokens
      for (const [model, count] of Object.entries(totals.tokensByModel ?? {})) {
        tokensByModel[model] = (tokensByModel[model] ?? 0) + count
      }
      tokensToday += totals.tokensTodayByDate[today] ?? 0
      sessionCount++
      linesJsonValid += totals.linesJsonValid
      linesWithUsage += totals.linesWithUsage

      // Buckets from v3 caches don't exist; the nullish guards keep an
      // un-refreshed cache entry from crashing the scan.
      for (const [bucketKey, count] of Object.entries(totals.bucketsByMinute ?? {})) {
        const bucketStart = Number(bucketKey)
        if (!Number.isFinite(bucketStart) || bucketStart < bucketFloor) continue
        bucketTotals.set(bucketStart, (bucketTotals.get(bucketStart) ?? 0) + count)
      }
      for (const session of totals.sessions ?? []) {
        if (session.lastActivityAt >= bucketFloor) allSessions.push(session)
      }
    }
  }

  // Prune cache entries for files that have been deleted.
  for (const cachedPath of fileCache.keys()) {
    if (!seenPaths.has(cachedPath)) {
      fileCache.delete(cachedPath)
      cacheDirty = true
    }
  }

  // Schema drift heuristic: if we have a reasonable sample of valid JSON lines
  // but almost none contain the expected assistant.usage shape, the Claude Code
  // JSONL format has likely changed out from under us.
  let schemaHealthy = true
  if (linesJsonValid >= DRIFT_MIN_SAMPLE) {
    const yieldRatio = linesWithUsage / linesJsonValid
    if (yieldRatio < DRIFT_YIELD_THRESHOLD) {
      schemaHealthy = false
      console.warn(
        `Schema drift suspected: only ${linesWithUsage}/${linesJsonValid} lines (${(
          yieldRatio * 100
        ).toFixed(2)}%) contained assistant usage data. Claude Code's JSONL schema may have changed.`
      )
    }
  }

  // Newest buckets are the ones that drive velocity, so if we have to truncate
  // we drop the oldest. Sent oldest-first so the server can apply in order.
  const buckets = Array.from(bucketTotals.entries())
    .map(([bucketStart, count]) => ({ bucketStart, tokens: count }))
    .sort((a, b) => b.bucketStart - a.bucketStart)
    .slice(0, MAX_BUCKETS_PER_REPORT)
    .reverse()

  const sessions = mergeSessionWindows(allSessions)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_SESSIONS_PER_REPORT)

  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cacheTokens,
    tokensByModel,
    tokensToday,
    sessionCount,
    schemaHealthy,
    buckets,
    sessions,
  }
}

async function loadCache(): Promise<void> {
  try {
    const raw = await readFile(CACHE_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<CacheSnapshot>
    if (parsed.version !== CACHE_VERSION || !parsed.entries) {
      console.log('Cache version mismatch, starting fresh.')
      return
    }
    for (const [filePath, entry] of Object.entries(parsed.entries)) {
      fileCache.set(filePath, entry)
    }
    console.log(`Loaded cache with ${fileCache.size} entries.`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Cache load failed, starting fresh:', err)
    }
  }
}

async function persistCache(): Promise<void> {
  if (!cacheDirty) return
  const snapshot: CacheSnapshot = { version: CACHE_VERSION, entries: {} }
  for (const [filePath, entry] of fileCache) {
    snapshot.entries[filePath] = entry
  }
  const tmp = `${CACHE_PATH}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(snapshot), 'utf-8')
    await rename(tmp, CACHE_PATH)
    cacheDirty = false
  } catch (err) {
    console.warn('Cache persist failed:', err)
  }
}

async function postToServer(config: Config, aggregate: Aggregate): Promise<void> {
  try {
    const res = await fetch(`${config.serverUrl}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: config.name,
        email: config.email,
        deviceId: config.deviceId,
        secret: config.secret,
        totalTokens: aggregate.totalTokens,
        inputTokens: aggregate.inputTokens,
        outputTokens: aggregate.outputTokens,
        cacheTokens: aggregate.cacheTokens,
        tokensByModel: aggregate.tokensByModel,
        tokensToday: aggregate.tokensToday,
        sessionCount: aggregate.sessionCount,
        schemaHealthy: aggregate.schemaHealthy,
        buckets: aggregate.buckets,
        sessions: aggregate.sessions,
        ...(config.color ? { color: config.color } : {}),
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (res.status === 401) {
      await writeFile(
        ERROR_FLAG_PATH,
        `[${new Date().toISOString()}] 401 Unauthorized — check secret in ${CONFIG_PATH}\n`,
        'utf-8'
      )
      console.error(`401 Unauthorized. Sleeping ${AUTH_FAILURE_BACKOFF_MS}ms before exit.`)
      await new Promise((resolve) => setTimeout(resolve, AUTH_FAILURE_BACKOFF_MS))
      process.exit(1)
    }
    if (res.ok) {
      const healthSuffix = aggregate.schemaHealthy ? '' : ' (schema drift!)'
      console.log(
        `[${new Date().toLocaleTimeString()}] ${config.name}: ${aggregate.totalTokens.toLocaleString()} tokens${healthSuffix}`
      )
    } else {
      console.warn(`Report returned ${res.status}`)
    }
  } catch (err) {
    console.log('Server unreachable, will retry.', err instanceof Error ? err.message : err)
  }
}

// `force` bypasses the post throttle (used by startup and the hourly timer so
// a report always lands on schedule). Watcher-triggered scans leave it false,
// so they refresh the local cache without hitting the server every few seconds.
async function runScan(config: Config, { force = false }: { force?: boolean } = {}): Promise<void> {
  if (scanning) return
  scanning = true
  try {
    const aggregate = await aggregateAll()
    const now = Date.now()
    if (force || now - lastPostAt >= reportIntervalMs) {
      await postToServer(config, aggregate)
      lastPostAt = now
    }
    await persistCache()
  } catch (err) {
    console.error('Scan failed:', err)
  } finally {
    scanning = false
  }
}

async function checkMemoryCeiling(): Promise<void> {
  const rss = process.memoryUsage().rss
  if (rss > MEMORY_CEILING_BYTES) {
    console.warn(
      `RSS ${(rss / 1024 / 1024).toFixed(0)}MB exceeds ceiling; persisting cache before restart.`
    )
    await persistCache()
    process.exit(0)
  }
}

async function isGitRepo(dir: string): Promise<boolean> {
  const result = await run('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], dir)
  return result.code === 0 && result.stdout.trim() === 'true'
}

async function getHeadHash(dir: string): Promise<string | null> {
  const result = await run('git', ['-C', dir, 'rev-parse', 'HEAD'], dir)
  if (result.code !== 0) return null
  return result.stdout.trim()
}

async function checkForUpdates(): Promise<void> {
  if (!(await isGitRepo(REPORTER_DIR))) return
  const before = await getHeadHash(REPORTER_DIR)
  if (!before) return
  const pull = await run('git', ['-C', REPORTER_DIR, 'pull', '--ff-only', '--quiet'], REPORTER_DIR)
  if (pull.code !== 0) {
    console.warn(`git pull failed (${pull.code}): ${pull.stderr.trim()}`)
    return
  }
  const after = await getHeadHash(REPORTER_DIR)
  if (after && after !== before) {
    console.log(`Reporter updated (${before.slice(0, 7)} → ${after.slice(0, 7)}). Restarting...`)
    await persistCache()
    process.exit(0)
  }
}

async function detectGitEmail(): Promise<string | undefined> {
  const result = await run('git', ['config', '--global', 'user.email'])
  if (result.code !== 0) return undefined
  const candidate = result.stdout.trim()
  return EMAIL_REGEX.test(candidate) ? candidate : undefined
}

async function loadConfig(): Promise<Config> {
  let raw: string
  try {
    raw = await readFile(CONFIG_PATH, 'utf-8')
  } catch (err) {
    console.error(
      `No config at ${CONFIG_PATH}. Run "bun setup.ts" before starting the reporter.`,
      err instanceof Error ? err.message : err,
    )
    process.exit(78) // EX_CONFIG
  }

  let parsed: Partial<Config>
  try {
    parsed = JSON.parse(raw) as Partial<Config>
  } catch (err) {
    console.error(
      `Config at ${CONFIG_PATH} is not valid JSON:`,
      err instanceof Error ? err.message : err,
    )
    process.exit(78)
  }

  const fatal: string[] = []
  if (!parsed.name) fatal.push('name')
  if (!parsed.serverUrl) fatal.push('serverUrl')
  if (!parsed.secret) fatal.push('secret')
  if (fatal.length > 0) {
    console.error(
      `Config at ${CONFIG_PATH} is missing required fields: ${fatal.join(', ')}. ` +
        `Run "bun setup.ts" to re-create it.`,
    )
    process.exit(78)
  }

  let dirty = false

  if (!parsed.deviceId) {
    parsed.deviceId = randomUUID()
    console.log(`Config missing deviceId; generated ${parsed.deviceId}`)
    dirty = true
  }

  if (!parsed.email) {
    const gitEmail = await detectGitEmail()
    if (!gitEmail) {
      console.error(
        `Config at ${CONFIG_PATH} is missing 'email' and git config --global user.email is not set to a valid email. ` +
          `Run "bun setup.ts" to re-create the config with an email address (required to merge your devices on the leaderboard).`,
      )
      process.exit(78)
    }
    parsed.email = gitEmail.toLowerCase()
    console.log(`Config missing email; auto-filled from git config: ${parsed.email}`)
    dirty = true
  }

  if (dirty) {
    try {
      await writeFile(CONFIG_PATH, JSON.stringify(parsed, null, 2), 'utf-8')
      await chmod(CONFIG_PATH, 0o600)
    } catch (err) {
      console.warn(
        `Failed to persist migrated config to ${CONFIG_PATH}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return parsed as Config
}

function resolveReportInterval(config: Config): number {
  const minutes = config.reportIntervalMinutes
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) {
    return DEFAULT_REPORT_INTERVAL_MS
  }
  const requested = minutes * 60_000
  if (requested < MIN_REPORT_INTERVAL_MS) {
    console.warn(
      `reportIntervalMinutes=${minutes} is below the ${
        MIN_REPORT_INTERVAL_MS / 60_000
      }-minute floor; using the floor instead.`
    )
    return MIN_REPORT_INTERVAL_MS
  }
  return requested
}

async function main(): Promise<void> {
  const config = await loadConfig()
  reportIntervalMs = resolveReportInterval(config)
  console.log(
    `Reporter starting for ${config.name} → ${config.serverUrl} ` +
      `(reporting every ${Math.round(reportIntervalMs / 60_000)}m)`
  )

  // Pull any published updates before we do anything else. If the code changed
  // we exit here and launchd will respawn us running the new version.
  await checkForUpdates()

  await loadCache()
  await runScan(config, { force: true })

  setInterval(() => {
    void runScan(config, { force: true })
  }, reportIntervalMs)

  setInterval(() => {
    void persistCache()
  }, CACHE_PERSIST_INTERVAL_MS)

  setInterval(() => {
    void checkMemoryCeiling()
  }, MEMORY_CHECK_INTERVAL_MS)

  setInterval(() => {
    void checkForUpdates()
  }, UPDATE_CHECK_INTERVAL_MS)

  const dirs = await getClaudeDataDirs()
  if (dirs.length > 0) {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleScan = (): void => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        void runScan(config)
      }, CHOKIDAR_DEBOUNCE_MS)
    }
    chokidar
      .watch(dirs, { ignoreInitial: true, awaitWriteFinish: false })
      .on('change', scheduleScan)
      .on('add', scheduleScan)
    console.log('Watching for Claude Code activity...')
  }

  const shutdown = async (): Promise<void> => {
    await persistCache()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

void main()
