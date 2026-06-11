'use client'

import { useEffect, useRef, useState } from 'react'
import type { LeaderboardEntry } from '@/types'

// Burn rate is derived client-side: each reactive update from Convex carries
// fresh totals, so we sample them over a sliding window and compute tokens/min.
const SAMPLE_WINDOW_MS = 10 * 60_000
// Need at least this much elapsed time between first and last sample before a
// rate is meaningful — avoids wild numbers from two near-simultaneous updates.
const MIN_SPAN_MS = 15_000

interface Sample {
  t: number
  total: number
}

export function useBurnRates(
  entries: ReadonlyArray<LeaderboardEntry> | undefined,
  updatedAt: string | undefined,
): ReadonlyMap<string, number> {
  const samplesRef = useRef<Map<string, Sample[]>>(new Map())
  const [rates, setRates] = useState<ReadonlyMap<string, number>>(new Map())

  useEffect(() => {
    if (!entries || !updatedAt) return

    const now = Date.now()
    const nextRates = new Map<string, number>()

    for (const entry of entries) {
      const key = entry.name.toLowerCase()
      const existing = samplesRef.current.get(key) ?? []
      const last = existing[existing.length - 1]

      const withNew =
        !last || last.total !== entry.totalTokens
          ? [...existing, { t: now, total: entry.totalTokens }]
          : existing

      const windowed = withNew.filter((s) => now - s.t <= SAMPLE_WINDOW_MS)
      samplesRef.current.set(key, windowed)

      const first = windowed[0]
      const latest = windowed[windowed.length - 1]
      if (first && latest && latest.t - first.t >= MIN_SPAN_MS) {
        const tokensPerMin =
          ((latest.total - first.total) / (latest.t - first.t)) * 60_000
        nextRates.set(key, Math.max(0, tokensPerMin))
      }
    }

    setRates(nextRates)
  }, [entries, updatedAt])

  return rates
}
