import { spawn } from 'child_process'
import { chmod, mkdir, writeFile, access, readFile } from 'fs/promises'
import { existsSync, createReadStream } from 'fs'
import readline from 'readline'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import pc from 'picocolors'

interface Config {
  name: string
  serverUrl: string
  secret: string
}

interface RepoConfig {
  serverUrl: string
  secret: string
  leaderboardUrl?: string
}

const HOME = os.homedir()
const UID = process.getuid?.()
const LABEL = 'com.leaderboard.reporter'
const CONFIG_PATH = path.join(HOME, '.leaderboard-reporter.json')
const PLIST_DIR = path.join(HOME, 'Library/LaunchAgents')
const PLIST_PATH = path.join(PLIST_DIR, `${LABEL}.plist`)
const LOG_DIR = path.join(HOME, 'Library/Logs')
const LOG_PATH = path.join(LOG_DIR, 'leaderboard-reporter.log')
const REPORTER_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPORTER_SCRIPT = path.join(REPORTER_DIR, 'index.ts')
const REPO_CONFIG_PATH = path.join(REPORTER_DIR, '..', 'leaderboard.config.json')

const amber = (text: string): string => pc.yellow(text)

const BANNER = `
  ${pc.bold(amber('  _____ _                 _'))}
  ${pc.bold(amber(' / ____| |               | |'))}
  ${pc.bold(amber('| |    | | __ _ _   _  __| | ___'))}
  ${pc.bold(amber("| |    | |/ _` | | | |/ _` |/ _ \\"))}
  ${pc.bold(amber('| |____| | (_| | |_| | (_| |  __/'))}
  ${pc.bold(amber(' \\_____|_|\\__,_|\\__,_|\\__,_|\\___|'))}

  ${pc.bold(amber('L E A D E R B O A R D'))}
  ${pc.dim('Season One — Reporter Setup')}
`

function assertMacOS(): void {
  if (process.platform !== 'darwin') {
    console.error(pc.red('✖') + ' This setup script is macOS-only (uses launchd).')
    process.exit(1)
  }
}

function assertUid(): number {
  if (typeof UID !== 'number') {
    console.error(pc.red('✖') + ' Cannot read UID.')
    process.exit(1)
  }
  return UID
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function run(cmd: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
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

async function locateBun(): Promise<string> {
  const envBun = process.env.BUN_INSTALL
    ? path.join(process.env.BUN_INSTALL, 'bin/bun')
    : null
  const candidates = [
    envBun,
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
    path.join(HOME, '.bun/bin/bun'),
  ].filter((candidate): candidate is string => candidate !== null)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  const result = await run('/usr/bin/which', ['bun'])
  if (result.code === 0 && result.stdout.trim()) {
    return result.stdout.trim()
  }
  throw new Error(
    'Could not locate bun. Install it from https://bun.sh then re-run this setup.'
  )
}

async function loadRepoConfig(): Promise<RepoConfig | null> {
  try {
    const raw = await readFile(REPO_CONFIG_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed.serverUrl === 'string' && typeof parsed.secret === 'string') {
      return {
        serverUrl: parsed.serverUrl,
        secret: parsed.secret,
        ...(typeof parsed.leaderboardUrl === 'string' && { leaderboardUrl: parsed.leaderboardUrl }),
      }
    }
    return null
  } catch {
    return null
  }
}

// Prompt helpers using readline with explicit /dev/tty for input and
// process.stdout for output — so all output goes through one stream
// and avoids interleaving when run via `curl | bash`.

function openRl(): readline.Interface {
  const rl = readline.createInterface({
    input: createReadStream('/dev/tty'),
    output: process.stdout,
    terminal: true,
  })
  rl.on('SIGINT', () => {
    process.stdout.write('\n' + pc.red('✖') + ' Setup cancelled.\n')
    process.exit(0)
  })
  return rl
}

function ask(
  rl: readline.Interface,
  label: string,
  validate?: (v: string) => string | undefined,
): Promise<string> {
  return new Promise((resolve) => {
    const prompt = (): void => {
      process.stdout.write(pc.cyan('◆') + '  ' + pc.bold(label) + '\n' + pc.dim('│') + '  ')
      rl.question('', (raw) => {
        const value = raw.trim()
        const error = validate?.(value)
        if (error) {
          process.stdout.write(pc.red('│  ✖ ' + error) + '\n')
          prompt()
        } else {
          resolve(value)
        }
      })
    }
    prompt()
  })
}

interface SetupResult {
  config: Config
  leaderboardUrl: string | null
}

async function promptConfig(): Promise<SetupResult> {
  process.stdout.write(BANNER)

  const repoConfig = await loadRepoConfig()
  const rl = openRl()

  let serverUrl: string
  let secret: string

  if (repoConfig) {
    process.stdout.write(pc.dim('┌  Config loaded — just need your name\n'))
    process.stdout.write(pc.dim(`│  Server: ${repoConfig.serverUrl}\n`))
    process.stdout.write(pc.dim(`│  Secret: ${'*'.repeat(repoConfig.secret.length)}\n`))
    serverUrl = repoConfig.serverUrl
    secret = repoConfig.secret
  } else {
    process.stdout.write(pc.dim('┌  Let\'s get you on the leaderboard\n'))
    serverUrl = await ask(rl, 'Convex site URL', (v) => {
      if (!v) return 'URL is required'
      try {
        const u = new URL(v)
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Must be http(s)'
      } catch {
        return 'Must be a valid URL'
      }
      return undefined
    })
    secret = await ask(rl, 'Shared secret')
  }

  const name = await ask(rl, "What's your display name?", (v) => {
    if (!v) return 'Name is required'
    if (v.length > 20) return 'Keep it under 20 characters'
    return undefined
  })

  rl.close()

  return {
    config: { name, serverUrl: serverUrl.replace(/\/$/, ''), secret },
    leaderboardUrl: repoConfig?.leaderboardUrl ?? null,
  }
}

async function writeConfig(config: Config): Promise<void> {
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
  await chmod(CONFIG_PATH, 0o600)
}

function buildPlist(bunPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>${REPORTER_SCRIPT}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${REPORTER_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Nice</key>
  <integer>10</integer>
  <key>LowPriorityIO</key>
  <true/>
  <key>LowPriorityBackgroundIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
  <key>HardResourceLimits</key>
  <dict>
    <key>ResidentSetSize</key>
    <integer>419430400</integer>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
</dict>
</plist>
`
}

async function writePlist(bunPath: string): Promise<void> {
  await mkdir(PLIST_DIR, { recursive: true })
  await mkdir(LOG_DIR, { recursive: true })
  await writeFile(PLIST_PATH, buildPlist(bunPath), 'utf-8')
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function installAgent(uid: number): Promise<void> {
  await run('/bin/launchctl', ['bootout', `gui/${uid}/${LABEL}`])
  await sleep(500) // give launchd time to fully unload before re-bootstrapping
  const bootstrap = await run('/bin/launchctl', [
    'bootstrap',
    `gui/${uid}`,
    PLIST_PATH,
  ])
  if (bootstrap.code !== 0) {
    throw new Error(
      `launchctl bootstrap failed (${bootstrap.code}): ${bootstrap.stderr.trim()}`
    )
  }
  await run('/bin/launchctl', ['enable', `gui/${uid}/${LABEL}`])
  const kick = await run('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/${LABEL}`])
  if (kick.code !== 0) {
    console.warn(pc.yellow('⚠') + ' launchctl kickstart warning: ' + kick.stderr.trim())
  }
}

async function verifyReporterScript(): Promise<void> {
  try {
    await access(REPORTER_SCRIPT)
  } catch {
    throw new Error(
      `Reporter script not found at ${REPORTER_SCRIPT}. Are you running setup from reporter/?`
    )
  }
}

function log(msg: string): void {
  process.stdout.write(msg + '\n')
}

async function main(): Promise<void> {
  assertMacOS()
  const uid = assertUid()
  await verifyReporterScript()

  const bunPath = await locateBun()
  const { config, leaderboardUrl } = await promptConfig()

  log('')
  log(pc.dim('◇') + '  Writing config...')
  await writeConfig(config)
  log(pc.green('◇') + '  ' + pc.dim(`Config saved → ${CONFIG_PATH}`))

  log(pc.dim('◇') + '  Installing launch agent...')
  await writePlist(bunPath)
  await installAgent(uid)
  log(pc.green('◇') + '  ' + pc.dim('Launch agent installed and running'))

  log('')
  log(pc.dim('┌  Details'))
  log(pc.dim(`│  Config:  ${CONFIG_PATH}`))
  log(pc.dim(`│  Plist:   ${PLIST_PATH}`))
  log(pc.dim(`│  Logs:    ${LOG_PATH}`))
  log(pc.dim(`│  Bun:     ${bunPath}`))
  log(pc.dim('│'))
  log(pc.dim(`│  Check:   launchctl print gui/${uid}/${LABEL}`))
  log(pc.dim(`│  Logs:    tail -f ${LOG_PATH}`))
  log(pc.dim(`│  Remove:  bun uninstall.ts`))
  log(pc.dim('└'))
  log('')
  log(amber('◇') + '  ' + pc.bold(amber("You're on the board!")) + ' The reporter is running in the background.')
  if (leaderboardUrl) {
    log(amber('  →') + ' View the leaderboard: ' + pc.underline(pc.cyan(leaderboardUrl)))
  }
  log('')
}

void main().catch((err) => {
  console.error(pc.red('✖') + ' ' + (err instanceof Error ? err.message : String(err)))
  process.exit(1)
})
