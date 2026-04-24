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
}

interface FileTotals {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  tokensTodayByDate: Record<string, number>
  linesTotal: number
  linesJsonValid: number
  linesWithUsage: number
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
  tokensToday: number
  sessionCount: number
  schemaHealthy: boolean
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
  message?: { usage?: JSONLUsage }
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

const CACHE_VERSION = 2
const REPORT_INTERVAL_MS = 30_000
const CHOKIDAR_DEBOUNCE_MS = 2_000
const CACHE_PERSIST_INTERVAL_MS = 5 * 60_000
const MEMORY_CHECK_INTERVAL_MS = 60_000
const UPDATE_CHECK_INTERVAL_MS = 60 * 60_000
const MEMORY_CEILING_BYTES = 400 * 1024 * 1024
const AUTH_FAILURE_BACKOFF_MS = 60_000
const FETCH_TIMEOUT_MS = 30_000
const DRIFT_MIN_SAMPLE = 100
const DRIFT_YIELD_THRESHOLD = 0.01

const fileCache = new Map<string, FileCacheEntry>()
let cacheDirty = false
let scanning = false

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

async function parseJSONLStreaming(filePath: string): Promise<FileTotals | null> {
  const totals: FileTotals = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheTokens: 0,
    tokensTodayByDate: {},
    linesTotal: 0,
    linesJsonValid: 0,
    linesWithUsage: 0,
  }

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

      if (parsed.timestamp) {
        const dateKey = dateKeyFromIso(parsed.timestamp)
        if (dateKey) {
          totals.tokensTodayByDate[dateKey] = (totals.tokensTodayByDate[dateKey] ?? 0) + sum
        }
      }
    })

    rl.on('close', () => resolve(totals))
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
  let linesWithUsage = 0
  const today = todayKey()
  const seenPaths = new Set<string>()

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
      tokensToday += totals.tokensTodayByDate[today] ?? 0
      sessionCount++
      linesJsonValid += totals.linesJsonValid
      linesWithUsage += totals.linesWithUsage
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

  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cacheTokens,
    tokensToday,
    sessionCount,
    schemaHealthy,
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
        ...aggregate,
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

async function runScan(config: Config): Promise<void> {
  if (scanning) return
  scanning = true
  try {
    const aggregate = await aggregateAll()
    await postToServer(config, aggregate)
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

async function main(): Promise<void> {
  const config = await loadConfig()
  console.log(`Reporter starting for ${config.name} → ${config.serverUrl}`)

  // Pull any published updates before we do anything else. If the code changed
  // we exit here and launchd will respawn us running the new version.
  await checkForUpdates()

  await loadCache()
  await runScan(config)

  setInterval(() => {
    void runScan(config)
  }, REPORT_INTERVAL_MS)

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
