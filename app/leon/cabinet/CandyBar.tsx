'use client'

import { motion } from 'motion/react'
import { ARCADE, FONTS } from '../ps1/theme'
import { toModelSegments } from '@/lib/models'

// One driver's spend, split by model family, as a single stacked rule.
//
// It is the only element on the board that says *what* the tokens went on
// rather than how many there were, which is why it survives every layout the
// board has had. A driver burning past the hot threshold gets flames off the
// end — emphasis, never the sole carrier: the same state is written in words
// beside it, so a colourblind viewer or a washed-out projector loses nothing.

/** Sustained rate past which a driver is, in the cabinet's language, on fire. */
export const ON_FIRE_TOKENS_PER_MIN = 30_000

/** Hard-edged tongues, no blur and no gradient — the kit has neither. */
const TONGUES: ReadonlyArray<{ readonly d: string; readonly fill: string; readonly delay: number }> = [
  { d: 'M6,26 L1,14 L5,16 L4,4 L10,13 L12,7 L14,17 L17,13 L15,26 Z', fill: '#ffb000', delay: 0 },
  { d: 'M7,26 L4,16 L8,17 L7,8 L11,15 L13,11 L13,26 Z', fill: '#ff6a1a', delay: 0.18 },
  { d: 'M8,26 L7,19 L10,20 L10,14 L12,20 L12,26 Z', fill: '#ffe14d', delay: 0.36 },
]

export function Flame({ height = 22 }: { readonly height?: number }): React.ReactElement {
  return (
    <span
      title="On fire"
      style={{ display: 'inline-block', width: `${height * 0.72}px`, height: `${height}px` }}
    >
      <svg viewBox="0 0 18 26" width="100%" height="100%" aria-hidden>
        {TONGUES.map((tongue) => (
          <motion.path
            key={tongue.d}
            d={tongue.d}
            fill={tongue.fill}
            style={{ originX: '50%', originY: '100%' }}
            animate={{ scaleY: [1, 1.22, 0.9, 1.1, 1], scaleX: [1, 0.92, 1.06, 0.96, 1] }}
            transition={{ duration: 0.62, repeat: Infinity, ease: 'linear', delay: tongue.delay }}
          />
        ))}
      </svg>
    </span>
  )
}

interface CandyBarProps {
  /** Raw per-model totals as the reporter sends them; collapsed to families here. */
  readonly tokensByModel: Readonly<Record<string, number>> | null | undefined
  /** The driver's own colour, used when nothing is attributed yet. */
  readonly fallbackColor: string
  readonly burnRate: number
  readonly height?: number
  /** Print the family and its share inside wide enough segments. */
  readonly showLabels?: boolean
}

export function CandyBar({
  tokensByModel,
  fallbackColor,
  burnRate,
  height = 14,
  showLabels = false,
}: CandyBarProps): React.ReactElement {
  const segments = toModelSegments(tokensByModel)
  const onFire = burnRate >= ON_FIRE_TOKENS_PER_MIN

  return (
    <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '1px' }}>
      <div
        style={{
          flex: 1,
          display: 'flex',
          height: `${height}px`,
          background: ARCADE.groundDeep,
          boxShadow: `inset 0 0 0 1px ${ARCADE.rule}`,
        }}
      >
        {/* Reporters older than v3 send no model split. Until theirs lands the
            bar stays a plain run in the driver's colour rather than claiming a
            breakdown nobody reported. */}
        {segments.length === 0 ? (
          <span style={{ width: '100%', background: fallbackColor, opacity: 0.5 }} />
        ) : (
          segments.map((segment) => (
            <span
              key={segment.family}
              title={`${segment.label} — ${Math.round(segment.share * 100)}%`}
              style={{
                width: `${segment.share * 100}%`,
                background: segment.color,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
              }}
            >
              {showLabels && segment.share > 0.18 && (
                <span
                  style={{
                    fontFamily: FONTS.hud,
                    fontSize: '10px',
                    color: '#000',
                    letterSpacing: '0.08em',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {segment.label} {Math.round(segment.share * 100)}
                </span>
              )}
            </span>
          ))
        )}
      </div>
      {onFire && <Flame height={height + 8} />}
    </div>
  )
}
