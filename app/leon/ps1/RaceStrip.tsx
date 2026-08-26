'use client'

import { motion } from 'motion/react'
import type { LeaderboardEntry } from '@/types'
import { fmtTokensShort } from '@/lib/formatters'
import { PS1 } from './theme'

// A race nobody plays. Every kart's position on the track is today's token
// count as a share of the day's leader, so the game state is entirely a
// rendering of real work — there is no simulation and nothing to input.
//
// Layout here is inline-styled on purpose: this project's Tailwind build does
// not currently emit utilities for these files, so anything structural has to
// be a real style declaration to survive.

const MAX_LANES = 8
const FINISH_MARGIN_PERCENT = 12

interface RacerRow {
  readonly key: string
  readonly name: string
  readonly color: string
  readonly progress: number
  readonly tokensToday: number
  readonly burnRate: number
}

function laneColor(index: number, color: string | null): string {
  if (color !== null) return color
  return index === 0 ? PS1.hot : PS1.cyan
}

interface RaceStripProps {
  readonly entries: ReadonlyArray<LeaderboardEntry> | undefined
  readonly burnRates: ReadonlyMap<string, number>
}

export function RaceStrip({ entries, burnRates }: RaceStripProps): React.ReactElement {
  const contenders = (entries ?? []).slice(0, MAX_LANES)
  const dayLeader = Math.max(1, ...contenders.map((entry) => entry.tokensToday))

  const racers: ReadonlyArray<RacerRow> = contenders
    .map((entry, index) => {
      const key = entry.name.toLowerCase()
      return {
        key,
        name: entry.name,
        color: laneColor(index, entry.color),
        progress: entry.tokensToday / dayLeader,
        tokensToday: entry.tokensToday,
        burnRate: entry.isOnline ? (burnRates.get(key) ?? 0) : 0,
      }
    })
    .sort((left, right) => right.progress - left.progress)

  return (
    <div
      className="ps1-panel ps1-dither"
      style={{
        position: 'relative',
        height: '100%',
        padding: '8px 12px',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px' }}>
        <span
          className="ps1-plate ps1-warp"
          style={{ color: PS1.gold, fontSize: 'clamp(8px, 0.95vw, 11px)' }}
        >
          Stage 01 — Token Grand Prix
        </span>
        <span
          className="ps1-plate"
          style={{ color: PS1.textFaint, fontSize: 'clamp(7px, 0.8vw, 9px)' }}
        >
          Auto-play / lap = tokens today
        </span>
      </div>

      <div
        className="ps1-panel-inset"
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          padding: '6px 8px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-around',
          overflow: 'hidden',
        }}
      >
        {racers.length === 0 ? (
          <div
            className="ps1-plate"
            style={{ color: PS1.textFaint, fontSize: 'clamp(8px, 0.9vw, 11px)', textAlign: 'center' }}
          >
            Grid empty — waiting for entrants
          </div>
        ) : (
          racers.map((racer, index) => (
            <div
              key={racer.key}
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                minHeight: 0,
                flex: 1,
              }}
            >
              <span
                className="ps1-plate"
                style={{
                  width: '2.5ch',
                  flex: '0 0 auto',
                  fontSize: 'clamp(7px, 0.8vw, 10px)',
                  fontVariantNumeric: 'tabular-nums',
                  color: index === 0 ? PS1.gold : PS1.textFaint,
                }}
              >
                P{index + 1}
              </span>

              <div style={{ position: 'relative', flex: 1, height: '100%', minWidth: 0 }}>
                {/* Road surface only under the karts, so the lanes read as a
                    track rather than as a chart. */}
                {/* Finish line sits inside the lane so it never rides over
                    the name and token columns. */}
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: `${100 - FINISH_MARGIN_PERCENT / 2}%`,
                    width: '6px',
                    opacity: 0.7,
                    backgroundImage:
                      'repeating-conic-gradient(#d6d6f2 0% 25%, #07070d 0% 50%)',
                    backgroundSize: '4px 4px',
                  }}
                />
                <div
                  className="ps1-road"
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: '50%',
                    height: '2px',
                    transform: 'translateY(-50%)',
                    opacity: 0.35,
                  }}
                />

                <motion.div
                  style={{ position: 'absolute', top: '50%', transform: 'translateY(-50%)' }}
                  animate={{ left: `${racer.progress * (100 - FINISH_MARGIN_PERCENT)}%` }}
                  transition={{ type: 'spring', stiffness: 40, damping: 18 }}
                >
                  <Kart color={racer.color} moving={racer.burnRate > 0} />
                </motion.div>
              </div>

              <span
                className="ps1-plate"
                style={{
                  flex: '0 0 auto',
                  width: '7ch',
                  textAlign: 'right',
                  fontSize: 'clamp(7px, 0.8vw, 10px)',
                  fontVariantNumeric: 'tabular-nums',
                  color: racer.burnRate > 0 ? PS1.green : PS1.textFaint,
                }}
              >
                {fmtTokensShort(racer.tokensToday)}
              </span>
              <span
                className="ps1-plate"
                style={{
                  flex: '0 0 auto',
                  width: '9ch',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: 'clamp(7px, 0.8vw, 10px)',
                  color: racer.color,
                }}
                title={racer.name}
              >
                {racer.name}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/** Body, canopy, exhaust trail. Enough to read at 14px. */
function Kart({ color, moving }: { color: string; moving: boolean }): React.ReactElement {
  return (
    <span
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        animation: moving ? 'ps1KartBounce 0.35s steps(2) infinite' : 'none',
      }}
    >
      {moving && (
        <span
          style={{
            position: 'absolute',
            right: '100%',
            marginRight: '2px',
            height: '2px',
            width: '10px',
            background: `linear-gradient(to left, ${color}, transparent)`,
          }}
        />
      )}
      <span
        style={{
          display: 'block',
          height: '8px',
          width: '14px',
          background: color,
          boxShadow: `inset -2px -2px 0 0 rgba(7,7,13,0.55), 0 0 6px ${color}70`,
        }}
      />
      <span
        style={{
          position: 'absolute',
          left: '4px',
          top: '-3px',
          display: 'block',
          height: '4px',
          width: '6px',
          background: PS1.text,
        }}
      />
    </span>
  )
}
