import { readFile } from 'fs/promises'
import os from 'os'
import path from 'path'

// Claude Code keeps the signed-in account in ~/.claude.json. Reading it is
// how the reporter knows which Claude account this machine belongs to
// without asking anyone anything.

const CLAUDE_STATE_PATH = path.join(os.homedir(), '.claude.json')
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface ClaudeAccount {
  readonly email: string
  readonly accountId: string | null
  readonly displayName: string | null
}

export async function readClaudeAccount(): Promise<ClaudeAccount | null> {
  let raw: string
  try {
    raw = await readFile(CLAUDE_STATE_PATH, 'utf-8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { oauthAccount?: Record<string, unknown> }
    const account = parsed.oauthAccount
    if (!account) return null
    const email = typeof account.emailAddress === 'string' ? account.emailAddress.trim() : ''
    if (!EMAIL_REGEX.test(email)) return null
    return {
      email: email.toLowerCase(),
      accountId: typeof account.accountUuid === 'string' ? account.accountUuid : null,
      displayName: typeof account.displayName === 'string' && account.displayName.trim()
        ? account.displayName.trim()
        : null,
    }
  } catch (err) {
    console.warn('Could not parse ~/.claude.json:', err instanceof Error ? err.message : err)
    return null
  }
}
