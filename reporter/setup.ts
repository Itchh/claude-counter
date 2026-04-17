import { spawn } from 'child_process'
import { chmod, mkdir, writeFile, access, readFile } from 'fs/promises'
import { existsSync, openSync } from 'fs'
import tty from 'tty'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import * as p from '@clack/prompts'
import pc from 'picocolors'

// When run via `curl | bash`, process.stdin is the pipe — not a real TTY.
// Reopen /dev/tty so clack can render prompts and receive keystrokes.
if (!process.stdin.isTTY) {
  const fd = openSync('/dev/tty', 'r+')
  process.stdin = new tty.ReadStream(fd) as NodeJS.ReadStream & { fd: number }
  process.stdout = new tty.WriteStream(fd) as NodeJS.WriteStream & { fd: number }
}

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
    p.cancel('This setup script is macOS-only (uses launchd).')
    process.exit(1)
  }
}

function assertUid(): number {
  if (typeof UID !== 'number') {
    p.cancel('Cannot read UID.')
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

interface SetupResult {
  config: Config
  leaderboardUrl: string | null
}

async function promptConfig(): Promise<SetupResult> {
  console.log(BANNER)

  const repoConfig = await loadRepoConfig()

  if (repoConfig) {
    p.intro(pc.dim('Config loaded — just need your name'))

    const name = await p.text({
      message: "What's your display name?",
      placeholder: 'e.g. Archie',
      validate(value) {
        if (!value.trim()) return 'Name is required'
        if (value.trim().length > 20) return 'Keep it under 20 characters'
        return undefined
      },
    })

    if (p.isCancel(name)) {
      p.cancel('Setup cancelled.')
      process.exit(0)
    }

    p.log.info(`${pc.dim('Server:')} ${repoConfig.serverUrl}`)
    p.log.info(`${pc.dim('Secret:')} ${'*'.repeat(repoConfig.secret.length)}`)

    return {
      config: {
        name: name.trim(),
        serverUrl: repoConfig.serverUrl.replace(/\/$/, ''),
        secret: repoConfig.secret,
      },
      leaderboardUrl: repoConfig.leaderboardUrl ?? null,
    }
  }

  p.intro(pc.dim("Let's get you on the leaderboard"))

  const answers = await p.group(
    {
      name: () =>
        p.text({
          message: "What's your display name?",
          placeholder: 'e.g. Archie',
          validate(value) {
            if (!value.trim()) return 'Name is required'
            if (value.trim().length > 20) return 'Keep it under 20 characters'
            return undefined
          },
        }),
      serverUrl: () =>
        p.text({
          message: 'Convex site URL',
          placeholder: 'https://your-deployment.convex.site',
          validate(value) {
            if (!value.trim()) return 'URL is required'
            try {
              const url = new URL(value.trim())
              if (url.protocol !== 'https:' && url.protocol !== 'http:') {
                return 'Must be a valid http(s) URL'
              }
            } catch {
              return 'Must be a valid http(s) URL'
            }
            return undefined
          },
        }),
      secret: () =>
        p.password({
          message: 'Shared secret',
          validate(value) {
            if (!value.trim()) return 'Secret is required'
            return undefined
          },
        }),
    },
    {
      onCancel() {
        p.cancel('Setup cancelled.')
        process.exit(0)
      },
    },
  )

  return {
    config: {
      name: (answers.name as string).trim(),
      serverUrl: (answers.serverUrl as string).trim().replace(/\/$/, ''),
      secret: (answers.secret as string).trim(),
    },
    leaderboardUrl: null,
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

async function installAgent(uid: number): Promise<void> {
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
    p.log.warn(`launchctl kickstart warning: ${kick.stderr.trim()}`)
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
  const { config, leaderboardUrl } = await promptConfig()

  const s = p.spinner()

  s.start('Writing config')
  await writeConfig(config)
  s.stop(pc.dim(`Config saved to ${CONFIG_PATH}`))

  s.start('Installing launch agent')
  await writePlist(bunPath)
  await installAgent(uid)
  s.stop(pc.dim('Launch agent installed and running'))

  p.note(
    [
      `${pc.dim('Config:')}   ${CONFIG_PATH}`,
      `${pc.dim('Plist:')}    ${PLIST_PATH}`,
      `${pc.dim('Logs:')}     ${LOG_PATH}`,
      `${pc.dim('Bun:')}      ${bunPath}`,
      '',
      `${pc.dim('Check status:')}  launchctl print gui/${uid}/${LABEL}`,
      `${pc.dim('Tail logs:')}     tail -f ${LOG_PATH}`,
      `${pc.dim('Uninstall:')}     bun uninstall.ts`,
    ].join('\n'),
    'Details',
  )

  const outroLines = [`${amber("You're on the board!")} The reporter is running in the background.`]
  if (leaderboardUrl) {
    outroLines.push(`\n  ${amber('→')} View the leaderboard: ${pc.underline(pc.cyan(leaderboardUrl))}`)
  }
  p.outro(outroLines.join(''))
}

void main().catch((err) => {
  p.cancel(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
