'use client'

import { useState, useMemo } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../convex/_generated/api'
import { motion, AnimatePresence } from 'motion/react'
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
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
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
          {entry.name}: {fmtTokensShort(entry.value)}/hr
        </div>
      ))}
    </motion.div>
  )
}

export function Timeline(): React.ReactElement {
  const [rangeIdx, setRangeIdx] = useState(0)
  const range = RANGES[rangeIdx]
  const data = useQuery(api.leaderboard.getTimeline, { rangeMs: range.ms })
  const users = data?.users ?? []

  // Build time-series showing token consumption rate (tokens/hr)
  const chartData = useMemo(() => {
    if (!data || users.length === 0) return []

    const MS_PER_HOUR = 3_600_000

    // Compute rate between consecutive snapshots for each user
    const userRates = new Map<string, Array<{ t: number; rate: number }>>()
    for (const user of users) {
      const rates: Array<{ t: number; rate: number }> = []
      for (let i = 0; i < user.points.length - 1; i++) {
        const dt = user.points[i + 1].t - user.points[i].t
        const dv = user.points[i + 1].v - user.points[i].v
        if (dt > 0) {
          rates.push({ t: user.points[i].t, rate: Math.max(0, (dv / dt) * MS_PER_HOUR) })
        }
      }
      // Add a final point at the last timestamp with rate 0 (no data after this)
      if (user.points.length > 0) {
        rates.push({ t: user.points[user.points.length - 1].t, rate: 0 })
      }
      userRates.set(user.key, rates)
    }

    // Collect all timestamps
    const allTimestamps = new Set<number>()
    for (const rates of userRates.values()) {
      for (const r of rates) {
        allTimestamps.add(r.t)
      }
    }
    const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b)

    return sortedTimestamps.map((t) => {
      const row: Record<string, number | undefined> = { timestamp: t }
      for (const user of users) {
        const rates = userRates.get(user.key)
        if (!rates || rates.length === 0) {
          row[user.key] = undefined
          continue
        }
        // Find the rate active at time t (last rate where rate.t <= t)
        let rate: number | undefined
        for (const r of rates) {
          if (r.t <= t) rate = r.rate
          else break
        }
        row[user.key] = rate
      }
      return row
    })
  }, [data, users])

  if (!data || users.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4 }}
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
      </motion.div>
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
          <motion.button
            key={r.label}
            onClick={() => setRangeIdx(i)}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.95 }}
            animate={{
              background: i === rangeIdx ? '#2a2a4a' : 'rgba(0,0,0,0)',
              borderColor: i === rangeIdx ? '#5e5e7e' : '#1a1a3a',
              color: i === rangeIdx ? '#00f0ff' : '#3a3a5a',
            }}
            transition={{ duration: 0.2 }}
            style={{
              border: '1px solid',
              padding: '2px 8px',
              fontSize: 'clamp(9px, 0.9vw, 11px)',
              fontFamily: "ui-monospace, 'Cascadia Code', monospace",
              cursor: 'pointer',
              letterSpacing: '0.05em',
            }}
          >
            {r.label}
          </motion.button>
        ))}
      </div>

      {/* Chart */}
      <AnimatePresence mode="wait">
        <motion.div
          key={rangeIdx}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          style={{ flex: 1, minHeight: 0 }}
        >
          <ResponsiveContainer width="100%" height={130}>
            <LineChart data={chartData} margin={{ top: 4, right: 12, bottom: 4, left: 12 }}>
              <XAxis
                dataKey="timestamp"
                type="number"
                domain={[data?.since ?? 'dataMin', data?.now ?? 'dataMax']}
                tickFormatter={(v: number) => formatTimeLabel(v, range.ms)}
                tick={{ fill: '#3a3a5a', fontSize: 10, fontFamily: "ui-monospace, 'Cascadia Code', monospace" }}
                axisLine={{ stroke: '#1a1a3a' }}
                tickLine={false}
                minTickGap={40}
              />
              <YAxis
                tickFormatter={(v: number) => `${fmtTokensShort(v)}/h`}
                tick={{ fill: '#3a3a5a', fontSize: 10, fontFamily: "ui-monospace, 'Cascadia Code', monospace" }}
                axisLine={{ stroke: '#1a1a3a' }}
                tickLine={false}
                width={50}
                domain={[0, 'dataMax']}
              />
              <Tooltip
                content={<CustomTooltip rangeMs={range.ms} />}
                cursor={{ stroke: '#2a2a4a', strokeWidth: 1 }}
              />
              {users.map((user, i) => (
                <Line
                  key={user.key}
                  dataKey={user.key}
                  name={user.name}
                  type="stepAfter"
                  stroke={user.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 3, stroke: '#08080f', strokeWidth: 1 }}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
