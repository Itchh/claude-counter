import fs from 'fs'
import path from 'path'
import readline from 'readline'
import chokidar from 'chokidar'

interface Config {
  name: string
  serverUrl: string
  secret: string
}

interface ParseResult {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  firstTimestamp: string | null
}

interface Aggregate {
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  tokensToday: number
  sessionCount: number
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

const CONFIG_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.leaderboard-reporter.json'
)

function getClaudeDataDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const candidates = [
    path.join(home, '.config/claude/projects'),
    path.join(home, '.claude/projects'),
  ]
  return candidates.filter((d) => fs.existsSync(d))
}

function walkJSONL(dir: string): string[] {
  const results: string[] = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...walkJSONL(full))
    } else if (entry.name.endsWith('.jsonl')) {
      results.push(full)
    }
  }
  return results
}

function isToday(isoString: string): boolean {
  const d = new Date(isoString)
  const now = new Date()
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  )
}

function parseJSONLFile(filePath: string): ParseResult {
  let totalTokens = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheTokens = 0
  let firstTimestamp: string | null = null

  try {
    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const parsed: JSONLLine = JSON.parse(line)
        if (parsed.type === 'assistant' && parsed.message?.usage) {
          const u = parsed.message.usage
          const input = u.input_tokens ?? 0
          const output = u.output_tokens ?? 0
          const cacheRead = u.cache_read_input_tokens ?? 0
          const cacheCreate = u.cache_creation_input_tokens ?? 0

          inputTokens += input
          outputTokens += output
          cacheTokens += cacheRead + cacheCreate
          totalTokens += input + output + cacheRead + cacheCreate
        }
        if (parsed.timestamp && !firstTimestamp) {
          firstTimestamp = parsed.timestamp
        }
      } catch (err) {
        console.warn(`Skipping malformed line in ${filePath}:`, err)
      }
    }
  } catch (err) {
    console.warn(`Skipping unreadable file ${filePath}:`, err)
  }

  return { totalTokens, inputTokens, outputTokens, cacheTokens, firstTimestamp }
}

function aggregateAll(): Aggregate {
  const dirs = getClaudeDataDirs()
  let totalTokens = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheTokens = 0
  let tokensToday = 0
  let sessionCount = 0

  for (const dir of dirs) {
    const files = walkJSONL(dir)
    for (const filePath of files) {
      const result = parseJSONLFile(filePath)
      totalTokens += result.totalTokens
      inputTokens += result.inputTokens
      outputTokens += result.outputTokens
      cacheTokens += result.cacheTokens
      sessionCount++

      try {
        const stat = fs.statSync(filePath)
        if (
          isToday(stat.mtime.toISOString()) ||
          (result.firstTimestamp && isToday(result.firstTimestamp))
        ) {
          tokensToday += result.totalTokens
        }
      } catch (err) {
        console.warn(`Skipping stat for ${filePath}:`, err)
      }
    }
  }

  return { totalTokens, inputTokens, outputTokens, cacheTokens, tokensToday, sessionCount }
}

async function postToServer(config: Config, aggregate: Aggregate): Promise<void> {
  try {
    const res = await fetch(`${config.serverUrl}/api/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: config.name,
        secret: config.secret,
        ...aggregate,
      }),
    })
    if (res.status === 401) {
      console.error('Wrong secret')
      process.exit(1)
    }
    if (res.ok) {
      console.log(
        `[${new Date().toLocaleTimeString()}] ${config.name}: ${aggregate.totalTokens.toLocaleString()} tokens`
      )
    }
  } catch {
    console.log('Server unreachable, will retry.')
  }
}

function askQuestion(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()))
  })
}

async function setupConfig(): Promise<Config> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  console.log('\n🏆 Claude Leaderboard Reporter — First-time setup\n')
  const name = await askQuestion(rl, 'Your display name: ')
  const serverUrl = await askQuestion(
    rl,
    'Leaderboard URL (e.g. https://leaderboard-seasonone.vercel.app): '
  )
  const secret = await askQuestion(rl, 'Shared secret: ')

  rl.close()

  const config: Config = {
    name,
    serverUrl: serverUrl.replace(/\/$/, ''),
    secret,
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
  console.log(`\nConfig saved to ${CONFIG_PATH}. Starting reporter...\n`)
  return config
}

async function main(): Promise<void> {
  let config: Config

  if (fs.existsSync(CONFIG_PATH)) {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Config
    console.log(`\nReporter starting for ${config.name} → ${config.serverUrl}\n`)
  } else {
    config = await setupConfig()
  }

  const report = async (): Promise<void> => {
    const aggregate = aggregateAll()
    await postToServer(config, aggregate)
  }

  await report()
  setInterval(report, 30_000)

  const dirs = getClaudeDataDirs()
  if (dirs.length > 0) {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null
    chokidar
      .watch(dirs, { ignoreInitial: true })
      .on('change', () => {
        clearTimeout(debounceTimer ?? undefined)
        debounceTimer = setTimeout(report, 2000)
      })
      .on('add', () => {
        clearTimeout(debounceTimer ?? undefined)
        debounceTimer = setTimeout(report, 2000)
      })

    console.log('Watching for Claude Code activity...')
  }
}

main()
