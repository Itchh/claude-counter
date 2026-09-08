'use client'

import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { fmtTokensShort } from '@/lib/formatters'
import { MODEL_FAMILIES, toModelSegments, type ModelFamily } from '@/lib/models'
import { useBurnRates } from '@/lib/useBurnRates'
import { ARCADE, ARCADE_CHROME_RAMP, FONTS, PS1 } from '../ps1/theme'
import { Ps1Car } from '../ps1/Ps1Car'
import { CandyBar, Flame, ON_FIRE_TOKENS_PER_MIN } from './CandyBar'

// The leaderboard, as the window behind the top-right button.
//
// The top three stand on plinths and the rest run underneath as a flat list,
// because those are two different jobs: the podium is read from across the
// room and the list is read by somebody looking for their own name. Hierarchy
// is carried by size and elevation rather than by colour, so it survives a
// colourblind viewer and a washed-out projector both.
//
// The rank numerals are gone. Each place is its driver's own car on a
// turntable — the same model the race is running outside the window — because
// the plinth height and the order already say the place, and the numeral was
// spending the largest element on the screen's least surprising fact.

/** Spin speed of a podium car maxes out at this burn rate. */
const INTENSITY_CEILING_TOKENS_PER_MIN = 60_000
const PODIUM_HEIGHTS = [136, 176, 112] as const
const PODIUM_CAR_SIZE = { first: 112, other: 88 } as const

interface BoardRow {
  readonly key: string
  readonly name: string
  readonly rank: number
  readonly color: string
  readonly totalTokens: number
  readonly tokensByModel: Readonly<Record<string, number>>
  readonly isOnline: boolean
  readonly burnRate: number
}

function fallbackColor(rank: number): string {
  const ramp = [PS1.gold, PS1.cyan, PS1.green, PS1.hot, PS1.gold]
  return ramp[(rank - 1) % ramp.length]
}

export function PodiumBoard(): React.ReactElement {
  const data = useQuery(api.leaderboard.get)
  const burnRates = useBurnRates(data?.leaderboard, data?.updatedAt)

  if (!data) return <BoardSkeleton />

  const rows: ReadonlyArray<BoardRow> = data.leaderboard.map((entry) => ({
    key: entry.name.toLowerCase(),
    name: entry.name,
    rank: entry.rank,
    color: entry.color ?? fallbackColor(entry.rank),
    totalTokens: entry.totalTokens,
    tokensByModel: entry.tokensByModel,
    isOnline: entry.isOnline,
    burnRate: burnRates.get(entry.name.toLowerCase()) ?? 0,
  }))

  if (rows.length === 0) {
    return (
      <div style={{ padding: '48px 20px', textAlign: 'center' }}>
        <span className="gt-label" style={{ fontFamily: FONTS.hud, fontSize: '18px', color: PS1.hot }}>
          <span style={{ animation: 'blink 1.2s step-end infinite' }}>_</span> Grid empty — nobody
          has reported yet
        </span>
      </div>
    )
  }

  // Second, first, third: the podium's own order, so the tallest plinth sits
  // in the middle exactly as it does on a real one.
  const podium = [rows[1], rows[0], rows[2]].filter((row): row is BoardRow => row !== undefined)
  const field = rows.slice(3)

  // Only legend the families anyone has actually used, so the key never lists
  // a colour that appears nowhere on screen.
  const present = new Set<ModelFamily>()
  for (const row of rows) {
    for (const segment of toModelSegments(row.tokensByModel)) present.add(segment.family)
  }
  const legend = MODEL_FAMILIES.filter((meta) => present.has(meta.family))
  const anyOnFire = rows.some((row) => row.burnRate >= ON_FIRE_TOKENS_PER_MIN)

  return (
    <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: '14px' }}>
        {podium.map((row, index) => {
          const isFirst = row.rank === 1
          return (
            <div
              key={row.key}
              style={{
                width: '236px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              <Ps1Car
                color={row.color}
                size={isFirst ? PODIUM_CAR_SIZE.first : PODIUM_CAR_SIZE.other}
                variant={row.rank - 1}
                label={row.name}
                intensity={Math.min(1, row.burnRate / INTENSITY_CEILING_TOKENS_PER_MIN)}
              />
              <div
                style={{
                  width: '100%',
                  height: `${PODIUM_HEIGHTS[index]}px`,
                  background: ARCADE.groundDeep,
                  boxShadow: `inset 0 0 0 2px ${ARCADE.rule}`,
                  borderTop: `5px solid ${row.color}`,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  padding: '0 14px',
                }}
              >
                <span
                  style={{
                    fontFamily: FONTS.hud,
                    fontSize: isFirst ? '19px' : '16px',
                    letterSpacing: '0.1em',
                    backgroundImage: ARCADE_CHROME_RAMP,
                    WebkitBackgroundClip: 'text',
                    backgroundClip: 'text',
                    color: 'transparent',
                    filter: 'drop-shadow(2px 2px 0 #000)',
                  }}
                >
                  P{row.rank}
                </span>
                <span
                  className="gt-label"
                  style={{ fontFamily: FONTS.hud, fontSize: isFirst ? '26px' : '21px', color: ARCADE.value }}
                >
                  {row.name}
                </span>
                <span
                  className="gt-label"
                  style={{
                    fontFamily: FONTS.hud,
                    fontSize: isFirst ? '24px' : '19px',
                    color: ARCADE.amber,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {fmtTokensShort(row.totalTokens)}
                </span>
                <span className="arc-caption" style={{ fontSize: '11px' }}>
                  {row.isOnline ? 'Online' : 'Idle'}
                  {row.burnRate > 0 && ` · ${Math.round(row.burnRate / 1000)}K t/min`}
                </span>
                <CandyBar
                  tokensByModel={row.tokensByModel}
                  fallbackColor={row.color}
                  burnRate={row.burnRate}
                  height={12}
                />
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {field.map((row) => (
          <div
            key={row.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '14px',
              padding: '7px 8px',
              borderTop: `1px solid ${ARCADE.rule}`,
            }}
          >
            <span
              className="gt-label"
              style={{
                fontFamily: FONTS.hud,
                fontSize: '17px',
                color: ARCADE.grey,
                width: '3ch',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {row.rank}
            </span>
            <span style={{ width: '7px', height: '18px', background: row.color }} />
            <span
              className="gt-label"
              style={{ fontFamily: FONTS.hud, fontSize: '17px', color: ARCADE.value, width: '120px' }}
            >
              {row.name}
            </span>
            <div style={{ flex: 1 }}>
              <CandyBar
                tokensByModel={row.tokensByModel}
                fallbackColor={row.color}
                burnRate={row.burnRate}
                height={12}
              />
            </div>
            <span className="arc-caption" style={{ fontSize: '11px', width: '92px', textAlign: 'right' }}>
              {row.isOnline ? 'Online' : 'Idle'}
            </span>
            <span
              className="gt-label"
              style={{
                fontFamily: FONTS.hud,
                fontSize: '17px',
                color: row.isOnline ? ARCADE.telemetry : ARCADE.silver,
                width: '7ch',
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {fmtTokensShort(row.totalTokens)}
            </span>
          </div>
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '18px',
          flexWrap: 'wrap',
          paddingTop: '10px',
          borderTop: `1px solid ${ARCADE.rule}`,
        }}
      >
        {legend.map((meta) => (
          <span key={meta.family} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ width: '14px', height: '10px', background: meta.color }} />
            <span className="arc-caption" style={{ fontSize: '11px' }}>
              {meta.label}
            </span>
          </span>
        ))}
        {anyOnFire && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Flame height={18} />
            <span className="arc-caption" style={{ fontSize: '11px' }}>
              Burning over {Math.round(ON_FIRE_TOKENS_PER_MIN / 1000)}K t/min
            </span>
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Occupies the same boxes as the loaded board — three plinths at their real
 * heights, five rows at their real height — so nothing shifts when the query
 * resolves underneath it.
 */
function BoardSkeleton(): React.ReactElement {
  return (
    <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: '14px' }}>
        {PODIUM_HEIGHTS.map((height, index) => (
          <div key={height} style={{ width: '236px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}>
            <div style={{ height: `${index === 1 ? PODIUM_CAR_SIZE.first : PODIUM_CAR_SIZE.other}px`, width: '100%' }} />
            <div
              style={{
                width: '100%',
                height: `${height}px`,
                background: ARCADE.groundDeep,
                boxShadow: `inset 0 0 0 2px ${ARCADE.rule}`,
                opacity: 0.6,
              }}
            />
          </div>
        ))}
      </div>
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} style={{ height: '32px', borderTop: `1px solid ${ARCADE.rule}`, opacity: 0.5 }} />
      ))}
    </div>
  )
}
