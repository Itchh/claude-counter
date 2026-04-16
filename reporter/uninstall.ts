import { spawn } from 'child_process'
import { rm } from 'fs/promises'
import os from 'os'
import path from 'path'

const HOME = os.homedir()
const LABEL = 'com.leaderboard.reporter'
const PLIST_PATH = path.join(HOME, 'Library/LaunchAgents', `${LABEL}.plist`)
const CACHE_PATH = path.join(HOME, '.leaderboard-reporter.cache.json')
const ERROR_FLAG_PATH = path.join(HOME, '.leaderboard-reporter.error')

function run(cmd: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: 'ignore' })
    proc.on('close', (code) => resolve(code ?? 0))
    proc.on('error', () => resolve(1))
  })
}

async function tryRemove(filePath: string): Promise<boolean> {
  try {
    await rm(filePath, { force: true })
    return true
  } catch (err) {
    console.warn(`Failed to remove ${filePath}:`, err)
    return false
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.error('Uninstall is macOS-only.')
    process.exit(1)
  }
  const uid = process.getuid?.()
  if (typeof uid !== 'number') {
    console.error('Cannot read UID.')
    process.exit(1)
  }

  // Boot out the launchd agent. Ignore exit code — it may already be gone.
  await run('/bin/launchctl', ['bootout', `gui/${uid}/${LABEL}`])
  await tryRemove(PLIST_PATH)
  await tryRemove(CACHE_PATH)
  await tryRemove(ERROR_FLAG_PATH)

  console.log(`
Uninstalled.

  Removed: ${PLIST_PATH}
  Removed: ${CACHE_PATH}
  Removed: ${ERROR_FLAG_PATH}

Your config (name, URL, secret) was left at ~/.leaderboard-reporter.json
so re-running bun setup.ts won't re-prompt. Delete it manually if you want a
full wipe.
`)
}

void main().catch((err) => {
  console.error('Uninstall failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
