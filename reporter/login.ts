import { spawn } from 'child_process'
import { readFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import pc from 'picocolors'
import { readClaudeAccount } from './claudeAccount'

// `bun login`: sign in to the leaderboard from the machine that reports for
// you. The reporter is the only thing that can prove who you are — it runs
// with the shared secret, on your Mac, beside your Claude account — so it
// asks the server for a one-time code and opens the browser on it. No
// password, no OAuth app, nothing to register.

interface Config {
  name: string
  email: string
  deviceId: string
  serverUrl: string
  secret: string
  claudeAccountId?: string
  /** Per-device credential issued by the server on first report. */
  linkToken?: string
}

const CONFIG_PATH = path.join(os.homedir(), '.leaderboard-reporter.json')
const FETCH_TIMEOUT_MS = 10_000

interface LinkResponse {
  code: string
  url: string | null
  expiresAt: number
}

async function loadConfig(): Promise<Config> {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8')
    return JSON.parse(raw) as Config
  } catch {
    console.error(pc.red('✖') + ` No config found at ${CONFIG_PATH}. Run "bun setup.ts" first.`)
    process.exit(1)
  }
}

function openInBrowser(url: string): void {
  // macOS only, like the rest of the reporter. Failure is not fatal: the
  // code is printed either way.
  const child = spawn('/usr/bin/open', [url], { stdio: 'ignore', detached: true })
  child.on('error', (err) => {
    console.warn(pc.yellow('⚠') + ' Could not open the browser: ' + err.message)
  })
  child.unref()
}

export async function requestLoginCode(config: Config): Promise<LinkResponse> {
  // Use the per-device linkToken when available — it proves device identity
  // without relying on the shared team secret. Fall back to the shared secret
  // only for devices that haven't completed their first /report yet.
  const credential = config.linkToken
    ? { linkToken: config.linkToken }
    : { secret: config.secret }
  const res = await fetch(`${config.serverUrl}/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...credential,
      email: config.email,
      deviceId: config.deviceId,
      name: config.name,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `Server returned ${res.status}`)
  }
  return (await res.json()) as LinkResponse
}

export async function login({ open = true }: { open?: boolean } = {}): Promise<void> {
  const config = await loadConfig()
  const link = await requestLoginCode(config)
  const pretty = `${link.code.slice(0, 4)}-${link.code.slice(4)}`
  const minutes = Math.max(1, Math.round((link.expiresAt - Date.now()) / 60_000))

  process.stdout.write('\n')
  process.stdout.write(pc.yellow('◇') + '  ' + pc.bold('Sign in to the leaderboard') + '\n')
  process.stdout.write(pc.dim('│') + `  Your code: ${pc.bold(pc.cyan(pretty))}` + pc.dim(`  (valid ${minutes} min, one use)`) + '\n')
  if (link.url) {
    process.stdout.write(pc.dim('│') + `  Or open:   ${pc.underline(pc.cyan(link.url))}` + '\n')
    if (open) openInBrowser(link.url)
  }
  process.stdout.write(pc.dim('│') + '  On the wall screen, choose Account and type the code.\n')
  process.stdout.write(pc.dim('└') + '\n\n')
}

if (import.meta.main) {
  void login().catch((err) => {
    console.error(pc.red('✖') + ' ' + (err instanceof Error ? err.message : String(err)))
    process.exit(1)
  })
}
