import { NextRequest, NextResponse } from 'next/server'
import { upsertEntry } from '@/lib/kv'
import type { ReportBody } from '@/types'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body: ReportBody = await req.json()

  if (body.secret !== process.env.LEADERBOARD_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!body.name?.trim()) {
    return NextResponse.json({ error: 'Name required' }, { status: 400 })
  }

  await upsertEntry({
    name: body.name.trim(),
    totalTokens: body.totalTokens ?? 0,
    inputTokens: body.inputTokens ?? 0,
    outputTokens: body.outputTokens ?? 0,
    cacheTokens: body.cacheTokens ?? 0,
    tokensToday: body.tokensToday ?? 0,
    sessionCount: body.sessionCount ?? 0,
    lastSeen: new Date().toISOString(),
  })

  return NextResponse.json({ ok: true })
}
