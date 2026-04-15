import { NextResponse } from 'next/server'
import { getStore } from '@/lib/kv'
import type { LeaderboardEntry } from '@/types'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  const store = await getStore()

  const sorted: ReadonlyArray<LeaderboardEntry> = Object.values(store.entries)
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .map((entry, i) => ({
      ...entry,
      rank: i + 1,
      isOnline: Date.now() - new Date(entry.lastSeen).getTime() < 90_000,
    }))

  const totalTokens = sorted.reduce((s, e) => s + e.totalTokens, 0)

  return NextResponse.json({
    leaderboard: sorted,
    totalTokens,
    updatedAt: store.updatedAt,
  })
}
