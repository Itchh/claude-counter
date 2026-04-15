import { kv } from '@vercel/kv'
import type { LeaderboardStore, DevEntry } from '@/types'

const ENTRIES_KEY = 'leaderboard:entries'
const UPDATED_KEY = 'leaderboard:updatedAt'

export async function getStore(): Promise<LeaderboardStore> {
  const [entries, updatedAt] = await Promise.all([
    kv.hgetall<Record<string, DevEntry>>(ENTRIES_KEY),
    kv.get<string>(UPDATED_KEY),
  ])
  return {
    entries: entries ?? {},
    updatedAt: updatedAt ?? new Date().toISOString(),
  }
}

export async function upsertEntry(entry: DevEntry): Promise<void> {
  await Promise.all([
    kv.hset(ENTRIES_KEY, { [entry.name.toLowerCase()]: entry }),
    kv.set(UPDATED_KEY, new Date().toISOString()),
  ])
}
