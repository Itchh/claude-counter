'use client'

import { useState, useMemo } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../convex/_generated/api'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { fmtTokensShort } from '@/lib/formatters'

const RANGES = [
  { label: '1H', ms: 60 * 60_000 },
  { label: '8H', ms: 8 * 60 * 60_000 },
  { label: '24H', ms: 24 * 60 * 60_000 },
  { label: '7D', ms: 7 * 24 * 60 * 60_000 },
  { label: '30D', ms: 30 * 24 * 60 * 60_000 },
] as const

const DEFAULT_COLORS = [
  '#ff2d95',
  '#00f0ff',
  '#a855f7',
  '#22d3ee',
  '#f97316',
  '#84cc16',
  '#ec4899',
  '#06b6d4',
]

function formatTimeLabel(timestamp: number, rangeMs: number): string {
  const d = new Date(timestamp)
  if (rangeMs <= 24 * 60 * 60_000) {
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

interface TooltipPayloadEntry {
  dataKey: string
  value: number
  color: string
  name: string
}

interface CustomTooltipProps {
  active?: boolean
  payload?: ReadonlyArray<TooltipPayloadEntry>
  label?: number
  rangeMs: number
}

function CustomTooltip({ active, payload, label, rangeMs }: CustomTooltipProps): React.ReactElement | null {
  if (!active || !payload?.length || !label) return null
  return (
    <div
      style={{
        background: '#12122a',
        border: '1px solid #2a2a4a',
        padding: '8px 12px',
        fontFamily: "ui-monospace, 'Cascadia Code', monospace",
        fontSize: '11px',
      }}
    >
      <div style={{ color: '#5e5e7e', marginBottom: 4 }}>
        {formatTimeLabel(label, rangeMs)}
      </div>
      {payload.map((entry) => (
        <div key={entry.dataKey} style={{ color: entry.color, marginBottom: 2 }}>
          {entry.name}: {fmtTokensShort(entry.value)}
        </div>
      ))}
    </div>
  )
}

export function Timeline(): React.ReactElement {
  const [rangeIdx, setRangeIdx] = useState(0)
  const range = RANGES[rangeIdx]
  const timeline = useQuery(api.leaderboard.getTimeline, { rangeMs: range.ms })

  // Build unified time-series: merge all user points onto shared timestamps
  const chartData = useMemo(() => {
    if (!timeline) return []
    const allTimestamps = new Set<number>()
    for (const user of timeline) {
      for (const p of user.points) {
        allTimestamps.add(p.t)
      }
    }
    const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b)

    return sortedTimestamps.map((t) => {
      const row: Record<string, number> = { timestamp: t }
      for (const user of timeline) {
        // Find closest point at or before this timestamp
        let val = 0
        for (const p of user.points) {
          if (p.t <= t) val = p.v
          else break
        }
        row[user.key] = val
      }
      return row
    })
  }, [timeline])

  if (!timeline || timeline.length === 0) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#3a3a5a',
          fontSize: 'clamp(10px, 1.2vw, 13px)',
          fontFamily: "ui-monospace, 'Cascadia Code', monospace",
        }}
      >
        COLLECTING TIMELINE DATA...
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Range toggle */}
      <div
        style={{
          display: 'flex',
          gap: '4px',
          padding: '0 8px 6px',
          justifyContent: 'flex-end',
        }}
      >
        {RANGES.map((r, i) => (
          <button
            key={r.label}
            onClick={() => setRangeIdx(i)}
            style={{
              background: i === rangeIdx ? '#2a2a4a' : 'transparent',
              border: `1px solid ${i === rangeIdx ? '#5e5e7e' : '#1a1a3a'}`,
              color: i === rangeIdx ? '#00f0ff' : '#3a3a5a',
              padding: '2px 8px',
              fontSize: 'clamp(9px, 0.9vw, 11px)',
              fontFamily: "ui-monospace, 'Cascadia Code', monospace",
              cursor: 'pointer',
              letterSpacing: '0.05em',
            }}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* Chart */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 4, right: 12, bottom: 4, left: 12 }}>
            <XAxis
              dataKey="timestamp"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(v: number) => formatTimeLabel(v, range.ms)}
              tick={{ fill: '#3a3a5a', fontSize: 10, fontFamily: "ui-monospace, 'Cascadia Code', monospace" }}
              axisLine={{ stroke: '#1a1a3a' }}
              tickLine={false}
              minTickGap={40}
            />
            <YAxis
              tickFormatter={(v: number) => fmtTokensShort(v)}
              tick={{ fill: '#3a3a5a', fontSize: 10, fontFamily: "ui-monospace, 'Cascadia Code', monospace" }}
              axisLine={{ stroke: '#1a1a3a' }}
              tickLine={false}
              width={50}
            />
            <Tooltip
              content={<CustomTooltip rangeMs={range.ms} />}
              cursor={{ stroke: '#2a2a4a', strokeWidth: 1 }}
            />
            {timeline.map((user, i) => (
              <Line
                key={user.key}
                dataKey={user.key}
                name={user.name}
                type="stepAfter"
                stroke={user.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
                strokeWidth={2}
                dot={false}
                activeDot={{
                  r: 3,
                  fill: user.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length],
                  stroke: '#08080f',
                  strokeWidth: 1,
                }}
                style={{
                  filter: `drop-shadow(0 0 4px ${user.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]}66)`,
                }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
