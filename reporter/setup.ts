import { spawn } from 'child_process'
import { chmod, mkdir, writeFile, access } from 'fs/promises'
import { existsSync, createReadStream, createWriteStream } from 'fs'
import os from 'os'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'

interface Config {
  name: string
  serverUrl: string
  secret: string
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

function assertMacOS(): void {
  if (process.platform !== 'darwin') {
    console.error('This setup script is macOS-only (uses launchd). Aborting.')
    process.exit(1)
  }
}

function assertUid(): number {
  if (typeof UID !== 'number') {
    console.error('Cannot read UID. Aborting.')
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
  // Fall back to `which bun`
  const result = await run('/usr/bin/which', ['bun'])
  if (result.code === 0 && result.stdout.trim()) {
    return result.stdout.trim()
  }
  throw new Error(
    'Could not locate bun. Install it from https://bun.sh then re-run this setup.'
  )
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()))
  })
}

async function promptConfig(): Promise<Config> {
  // Open /dev/tty directly so prompts work even when stdin is a pipe (e.g. curl | bash).
  const rl = readline.createInterface({
    input: createReadStream('/dev/tty'),
    output: createWriteStream('/dev/tty'),
    terminal: true,
  })
  console.log('\nClaude Leaderboard Reporter — Setup\n')
  const name = await ask(rl, 'Your display name: ')
  const serverUrl = await ask(
    rl,
    'Convex site URL (e.g. https://your-deployment.convex.site): '
  )
  const secret = await ask(rl, 'Shared secret: ')
  rl.close()

  if (!name || !serverUrl || !secret) {
    throw new Error('Name, URL, and secret are all required.')
  }
  return { name, serverUrl: serverUrl.replace(/\/$/, ''), secret }
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

async function installAgent(uid: number): Promise<void> {
  // Boot out any existing instance; ignore errors (it may not be loaded).
  await run('/bin/launchctl', ['bootout', `gui/${uid}/${LABEL}`])
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
  const kick = await run('/bin/launchctl', [
    'kickstart',
    '-k',
    `gui/${uid}/${LABEL}`,
  ])
  if (kick.code !== 0) {
    console.warn(`launchctl kickstart warning: ${kick.stderr.trim()}`)
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

async function main(): Promise<void> {
  assertMacOS()
  const uid = assertUid()
  await verifyReporterScript()

  const bunPath = await locateBun()
  const config = await promptConfig()
  await writeConfig(config)
  await writePlist(bunPath)
  await installAgent(uid)

  console.log(`
Setup complete.

  Config:  ${CONFIG_PATH}
  Plist:   ${PLIST_PATH}
  Logs:    ${LOG_PATH}
  Bun:     ${bunPath}

The reporter is now running in the background and will start automatically
on every login. To check status:

  launchctl print gui/${uid}/${LABEL}

To tail the log:

  tail -f ${LOG_PATH}

To uninstall:

  bun uninstall.ts
`)
}

void main().catch((err) => {
  console.error('Setup failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
