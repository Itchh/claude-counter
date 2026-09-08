'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../../../convex/_generated/api'
import { motion, AnimatePresence, useSpring, useTransform } from 'motion/react'
import type { LeaderboardEntry } from '@/types'
import { fmtTokens, fmtTokensShort, fmtTime } from '@/lib/formatters'
import { useBurnRates } from '@/lib/useBurnRates'
import { buildTokenAxis } from '@/lib/tokenTicks'
import {
  MODEL_FAMILIES,
  toModelSegments,
  type ModelFamily,
  type ModelSegment,
} from '@/lib/models'
import { Timeline } from '../Timeline'
import { Ticker } from '../Ticker'
import { Toasts } from '../Toasts'
import { ARCADE, PS1, FONTS, toPowerStats, type PowerStats } from '../ps1/theme'
import { SCALED_SURFACE } from '../ps1/hudScale'
import { ROW_PREFIX, useNavItem } from '../ps1/navigation'
import { Ps1Car } from '../ps1/Ps1Car'
import { RaceStrip } from '../ps1/RaceStrip'
import type { ChannelProps } from './ChannelRegistry'

const FLASH_DURATION = 800
const REFRESH_FLASH_DURATION = 1000
const FANFARE_DURATION = 1600
const HOT_TOKENS_PER_MIN = 30_000
const GRIDLINE_COLOR = 'rgba(255, 255, 255, 0.06)'
/** Spin speed of the bust maxes out at this burn rate. */
const INTENSITY_CEILING_TOKENS_PER_MIN = 60_000

function useClockTime(active: boolean): string {
  const [time, setTime] = useState('')

  useEffect(() => {
    if (!active) return
    const update = (): void => {
      setTime(
        new Date().toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      )
    }
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [active])

  return time
}

/**
 * A player's colour, for the gauge and nothing else.
 *
 * The kit gives every screen the same four registers — red labels, white
 * values, amber for anything live, chrome for a position — and a name
 * printed in the player's own magenta belongs to none of them. So the colour
 * survives exactly where it is doing work: inside the bar, where five of
 * them next to each other are the comparison the screen exists to make.
 */
function fallbackColor(rank: number): string {
  if (rank === 1) return PS1.hot
  if (rank <= 3) return PS1.cyan
  return '#7a7a9e'
}

function gaugeColor(rank: number, userColor: string | null): string {
  return userColor ?? fallbackColor(rank)
}

function darkenHex(hex: string, amount: number): string {
  const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - amount)
  const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - amount)
  const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - amount)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

function barGradient(rank: number, userColor: string | null): string {
  const base = gaugeColor(rank, userColor)
  const dark = darkenHex(base, 40)
  return `repeating-linear-gradient(90deg, ${base} 0px, ${base} 4px, ${dark} 4px, ${dark} 6px)`
}

/**
 * Candy-bar segment fill. Same 4px/2px retro hatch as the solid bars so a
 * stacked bar still reads as the same object, just striped by model.
 */
function segmentGradient(color: string): string {
  const dark = darkenHex(color, 40)
  return `repeating-linear-gradient(90deg, ${color} 0px, ${color} 4px, ${dark} 4px, ${dark} 6px)`
}

function AnimatedTokens({ value, formatter }: { value: number; formatter: (n: number) => string }): React.ReactElement {
  const spring = useSpring(0, { stiffness: 120, damping: 20 })
  const display = useTransform(spring, (v) => formatter(Math.round(v)))
  const [text, setText] = useState(formatter(0))

  useEffect(() => {
    spring.set(value)
  }, [spring, value])

  useEffect(() => {
    const unsubscribe = display.on('change', (v) => setText(v))
    return unsubscribe
  }, [display])

  return <>{text}</>
}

/**
 * A label/value pair, the kit's most-used component.
 *
 * Red caps, white numeral, and amber when the value is live — which is the
 * kit's only rule about colour and the reason the eye can find the one
 * moving number on a board of twenty.
 */
function StatPlate({
  label,
  value,
  live = false,
}: {
  readonly label: string
  readonly value: string
  readonly live?: boolean
}): React.ReactElement {
  return (
    <span
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        lineHeight: 1,
        gap: '3px',
      }}
    >
      <span className="arc-label" style={{ fontSize: 'clamp(7px, 0.8vw, 10px)' }}>
        {label}
      </span>
      <span
        className={live ? 'arc-value-live' : 'arc-value'}
        style={{ fontSize: 'clamp(10px, 1.2vw, 15px)' }}
      >
        {value}
      </span>
    </span>
  )
}

const STYLES = `
  /* A rank change. Was a coloured wash; the kit has no wash, so the row
     inverts for a beat instead — a palette swap, which is what the hardware
     could actually afford. */
  @keyframes flashUp {
    0% { background: #143a14; }
    100% { background: transparent; }
  }
  @keyframes flashDown {
    0% { background: #3a1414; }
    100% { background: transparent; }
  }
  /* One frame on, one frame off. A fade would be a blend the console could
     not do, and reads as a pulse rather than as a cursor. */
  @keyframes arcBlink {
    0%, 49% { opacity: 1; }
    50%, 100% { opacity: 0; }
  }
  @keyframes glitch {
    0%, 90%, 100% { transform: translate(0); filter: none; }
    92% { transform: translate(-2px, 1px); filter: hue-rotate(90deg); }
    94% { transform: translate(2px, -1px); filter: hue-rotate(-90deg); }
    96% { transform: translate(-1px, -1px); filter: hue-rotate(45deg); }
    98% { transform: translate(1px, 1px); filter: none; }
  }
  @keyframes screenFlicker {
    0%, 97%, 100% { opacity: 1; }
    98% { opacity: 0.97; }
    99% { opacity: 0.99; }
  }
  .flash-up { animation: flashUp 0.8s steps(2, end); }
  .flash-down { animation: flashDown 0.8s steps(2, end); }

  .bar-block {
    height: clamp(11px, 1.2vw, 16px);
    image-rendering: pixelated;
  }
  .bar-track {
    height: clamp(11px, 1.2vw, 16px);
    position: relative;
    overflow: hidden;
  }

  .bar-segment {
    height: 100%;
    /* Hairline gap so touching segments stay legible without a border box. */
    box-shadow: inset -1px 0 0 #000;
  }
  .bar-segment:last-child {
    box-shadow: none;
  }
  /* Legend swatch: the same fill as the bar it explains, in the same black
     frame, so the key is unmistakably a sample of the thing. */
  .legend-swatch {
    display: inline-block;
    width: clamp(14px, 1.6vw, 22px);
    height: clamp(7px, 0.8vw, 10px);
    image-rendering: pixelated;
    box-shadow: 0 0 0 2px #000;
  }

  /* Online lamp. A square, not a dot with a halo: the kit's warning lamps
     are lit and unlit cells of the same shape, and the unlit one still has
     to be visible or the row loses a column when someone logs off. */
  .arc-lamp {
    display: inline-block;
    width: clamp(8px, 0.9vw, 12px);
    height: clamp(8px, 0.9vw, 12px);
    box-shadow: 0 0 0 2px #000;
  }
  .arc-lamp-on { background: #4cff3c; }
  .arc-lamp-off { background: #123a10; }
`

export function StandingsChannel({ isLive }: ChannelProps): React.ReactElement {
  const data = useQuery(api.leaderboard.get)
  const events = useQuery(api.leaderboard.getEvents)
  const [justRefreshed, setJustRefreshed] = useState(false)
  const [flashMap, setFlashMap] = useState<Record<string, 'up' | 'down'>>({})
  const [loaded, setLoaded] = useState(false)
  const [fanfareColor, setFanfareColor] = useState<string | null>(null)
  const prevRanks = useRef<Map<string, number>>(new Map())
  const prevUpdatedAt = useRef<string>('')
  const prevLeaderKey = useRef<string | null>(null)
  const clock = useClockTime(isLive)
  const burnRates = useBurnRates(data?.leaderboard, data?.updatedAt)

  useEffect(() => {
    if (!data) return

    const leader = data.leaderboard[0]
    if (leader) {
      const leaderKey = leader.name.toLowerCase()
      if (prevLeaderKey.current && prevLeaderKey.current !== leaderKey) {
        setFanfareColor(leader.color ?? PS1.hot)
        setTimeout(() => setFanfareColor(null), FANFARE_DURATION)
      }
      prevLeaderKey.current = leaderKey
    }

    if (prevUpdatedAt.current && data.updatedAt !== prevUpdatedAt.current) {
      setJustRefreshed(true)
      setTimeout(() => setJustRefreshed(false), REFRESH_FLASH_DURATION)
    }
    prevUpdatedAt.current = data.updatedAt

    if (prevRanks.current.size > 0) {
      const flashes: Record<string, 'up' | 'down'> = {}
      for (const entry of data.leaderboard) {
        const key = entry.name.toLowerCase()
        const prev = prevRanks.current.get(key)
        if (prev !== undefined && prev !== entry.rank) {
          flashes[key] = entry.rank < prev ? 'up' : 'down'
        }
      }
      if (Object.keys(flashes).length > 0) {
        setFlashMap(flashes)
        setTimeout(() => setFlashMap({}), FLASH_DURATION)
      }
    }

    const newRanks = new Map<string, number>()
    for (const entry of data.leaderboard) {
      newRanks.set(entry.name.toLowerCase(), entry.rank)
    }
    prevRanks.current = newRanks

    if (!loaded) setLoaded(true)
  }, [data, loaded])

  const maxTokens = data?.leaderboard[0]?.totalTokens ?? 1
  const axis = buildTokenAxis(maxTokens)

  // Only legend the families anyone has actually used, so the key never lists
  // a colour that appears nowhere on screen.
  const presentFamilies = new Set<ModelFamily>()
  for (const entry of data?.leaderboard ?? []) {
    for (const segment of toModelSegments(entry.tokensByModel)) {
      presentFamilies.add(segment.family)
    }
  }
  const legend = MODEL_FAMILIES.filter((meta) => presentFamilies.has(meta.family))

  return (
    <div
      style={{
        animation: fanfareColor
          ? 'screenShake 0.6s ease-in-out'
          : 'screenFlicker 4s infinite',
        fontFamily: FONTS.hud,
        background: ARCADE.ground,
        color: ARCADE.value,
        display: 'grid',
        gridTemplateRows: 'auto 1fr auto auto auto',
        overflow: 'hidden',
        position: 'relative',
        ...SCALED_SURFACE,
      }}
    >
      <style>{STYLES}</style>
      <div className="ps1-floor" />
      <Toasts events={events} />

      {/* NEW #1 FANFARE BURST */}
      <AnimatePresence>
        {fanfareColor && (
          <motion.div
            key="fanfare-burst"
            // A new leader used to bloom a coloured halo across the screen.
            // The kit has no bloom, so it flashes instead: two hard frames of
            // the leader's own colour over the board, stepped rather than
            // faded, which is what a palette-swap celebration actually looked
            // like on this hardware.
            initial={{ opacity: 0.35 }}
            animate={{ opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: FANFARE_DURATION / 1000, ease: 'linear' }}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 99,
              pointerEvents: 'none',
              background: fanfareColor,
              mixBlendMode: 'screen',
            }}
          />
        )}
      </AnimatePresence>

      {/* TOP BAR */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="arc-header"
        style={{
          position: 'relative',
          zIndex: 2,
          // Right padding clears the deck's channel ident, which floats above.
          padding: '12px 210px 12px 28px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          {/* The board's own title, in the kit's display treatment: white,
              outlined on all four sides, dropped four pixels. */}
          <span
            className="arc-label-plain ps1-warp"
            style={{
              fontFamily: FONTS.codec,
              fontSize: 'clamp(13px, 1.6vw, 20px)',
              animation: 'glitch 8s infinite',
            }}
          >
            Season One / Claude Leaderboard
          </span>
        </div>
        {/* The clock is an instrument, so it is drawn as one. */}
        <span className="gt-stack" style={{ alignItems: 'flex-end' }}>
          <span className="arc-label" style={{ fontSize: '11px' }}>
            Session clock
          </span>
          <span className="arc-value-live" style={{ fontSize: 'clamp(12px, 1.4vw, 17px)' }}>
            {clock}
          </span>
        </span>
      </motion.div>

      {/* LEADERBOARD */}
      <div
        style={{
          position: 'relative',
          zIndex: 2,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: 'clamp(4px, 0.9vh, 12px)',
          padding: '10px 28px 0',
          overflow: 'hidden',
        }}
      >
        <AnimatePresence mode="popLayout">
          {!data || data.leaderboard.length === 0 ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="arc-label-lg"
              style={{
                textAlign: 'center',
                fontSize: 'clamp(14px, 2vw, 24px)',
              }}
            >
              <span style={{ animation: 'arcBlink 1.2s steps(1, end) infinite' }}>_</span>{' '}
              Insert player one
            </motion.div>
          ) : (
            data.leaderboard.map((entry: LeaderboardEntry, i: number) => (
              <StandingRow
                key={entry.name.toLowerCase()}
                entry={entry}
                index={i}
                flash={flashMap[entry.name.toLowerCase()]}
                maxTokens={maxTokens}
                stepPercent={axis.stepPercent}
                burnRate={
                  entry.isOnline ? (burnRates.get(entry.name.toLowerCase()) ?? 0) : 0
                }
                loaded={loaded}
              />
            ))
          )}
        </AnimatePresence>

        {/* TOKEN AXIS + MODEL LEGEND */}
        {data && data.leaderboard.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.4, delay: 0.3 }}
            className="arc-caption"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexWrap: 'wrap',
              gap: 'clamp(12px, 2vw, 28px)',
              fontSize: 'clamp(8px, 0.9vw, 11px)',
            }}
          >
            <span>Scale {fmtTokensShort(axis.ticks[axis.ticks.length - 1]?.value ?? 0)}</span>
            {legend.map((meta) => (
              <span
                key={meta.family}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}
              >
                <span
                  className="legend-swatch"
                  style={{ background: segmentGradient(meta.color) }}
                />
                {meta.label}
              </span>
            ))}
          </motion.div>
        )}
      </div>

      {/* TIMELINE + SELF-PLAYING RACE */}
      <TimelineRow entries={data?.leaderboard} burnRates={burnRates} />

      {/* EVENT TICKER */}
      <Ticker events={events} />

      {/* REPORTER MAINTENANCE */}

      {/* BOTTOM BAR */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.4 }}
        className="arc-footer"
        style={{
          position: 'relative',
          zIndex: 2,
          padding: '12px 28px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        {/* Three instruments, not three sentences. Each is a gold label over
            a white value, which is the only pattern the console bar knows —
            and it is what lets the eye find the pot without reading. */}
        <span className="gt-stack">
          <span className="arc-label" style={{ fontSize: '12px' }}>
            Pot
          </span>
          <span className="arc-value-live" style={{ fontSize: 'clamp(13px, 1.5vw, 19px)' }}>
            <AnimatedTokens value={data?.totalTokens ?? 0} formatter={fmtTokens} />
          </span>
        </span>

        <span className="gt-stack" style={{ alignItems: 'center' }}>
          <span className="arc-label" style={{ fontSize: '12px' }}>
            Link
          </span>
          {/* The one green readout on the board — the kit's telemetry
              register, reserved for whether the thing is actually running. */}
          <span
            className={data ? 'arc-telemetry' : 'arc-meta'}
            style={{ fontSize: 'clamp(11px, 1.2vw, 15px)' }}
          >
            {!data ? (
              'Linking…'
            ) : (
              <>
                <span style={{ animation: 'arcBlink 1.2s steps(1, end) infinite' }}>_</span> Syncing
                live
              </>
            )}
          </span>
        </span>

        <span className="gt-stack" style={{ alignItems: 'flex-end' }}>
          <span className="arc-label" style={{ fontSize: '12px' }}>
            Saved
          </span>
          <motion.span
            className="arc-value"
            animate={{ color: justRefreshed ? ARCADE.amber : ARCADE.value }}
            transition={{ duration: 0.5 }}
            style={{ fontSize: 'clamp(13px, 1.5vw, 19px)' }}
          >
            {data ? fmtTime(data.updatedAt) : '--:--:--'}
          </motion.span>
        </span>
      </motion.div>
    </div>
  )
}


/**
 * One competitor. Split out of the list so it can own a cursor stop — hooks
 * cannot live inside a `.map` callback, and the row needs `useNavItem` to know
 * whether it is selected and whether its drawer is open.
 */
function StandingRow({
  entry,
  index,
  flash,
  maxTokens,
  stepPercent,
  burnRate,
  loaded,
}: {
  readonly entry: LeaderboardEntry
  readonly index: number
  readonly flash: 'up' | 'down' | undefined
  readonly maxTokens: number
  readonly stepPercent: number
  readonly burnRate: number
  readonly loaded: boolean
}): React.ReactElement {
  const key = entry.name.toLowerCase()
  const i = index
  // The prefix is what the number keys count — see ROW_PREFIX.
  const nav = useNavItem(`${ROW_PREFIX}${key}`)

  const ratio = entry.totalTokens / maxTokens
  const segments = toModelSegments(entry.tokensByModel)
  const isFirst = entry.rank === 1
  const isHot = burnRate >= HOT_TOKENS_PER_MIN
  const stats = toPowerStats(entry.totalTokens, burnRate)
  const gauge = gaugeColor(entry.rank, entry.color)

  return (
                <motion.div
                  ref={nav.ref}
                  onClick={nav.focus}
                  layout
                  initial={{ opacity: 0, y: 20, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2 } }}
                  transition={{
                    layout: { type: 'spring', stiffness: 300, damping: 30 },
                    opacity: { duration: 0.3, delay: loaded ? 0 : i * 0.08 },
                    y: { type: 'spring', stiffness: 200, damping: 25, delay: loaded ? 0 : i * 0.08 },
                    scale: { duration: 0.2, delay: loaded ? 0 : i * 0.08 },
                  }}
                  whileHover={{ scale: 1.005, transition: { duration: 0.15 } }}
                  className={[
                    'arc-panel',
                    'relative',
                    'ps1-cursor',
                    nav.isFocused ? 'arc-row-on' : '',
                    flash === 'up' ? 'flash-up' : flash === 'down' ? 'flash-down' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    padding: 'clamp(6px, 0.9vh, 12px) clamp(10px, 1.2vw, 16px)',
                  }}
                >
                  {/* The row proper. The drawer opens beneath it inside the
                      same bevelled box, so an expanded row still reads as one
                      object rather than as a row with a panel floating under
                      it. */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'clamp(10px, 1.4vw, 18px)',
                    }}
                  >
                  {/* CHARACTER PORTRAIT */}
                  <div
                    className="arc-inset"
                    style={{
                      position: 'relative',
                      flex: '0 0 auto',
                      padding: '3px',
                      lineHeight: 0,
                    }}
                  >
                    {/* Their car, not their face. This is a racing channel:
                        the row's job is to say who is winning and what they
                        are driving, and five near-identical busts said
                        neither. The variant follows their place, which is
                        how the race hands cars out too — see carModelFor. */}
                    <Ps1Car
                      color={gauge}
                      size={48}
                      variant={index}
                      label={entry.name}
                      intensity={Math.min(1, burnRate / INTENSITY_CEILING_TOKENS_PER_MIN)}
                    />
                    <span
                      className="arc-caption"
                      style={{
                        position: 'absolute',
                        bottom: 0,
                        left: 0,
                        right: 0,
                        textAlign: 'center',
                        fontSize: '9px',
                        lineHeight: 1.4,
                        fontVariantNumeric: 'tabular-nums',
                        background: ARCADE.groundDeep,
                        textShadow: 'none',
                      }}
                    >
                      LV{stats.level}
                    </span>
                  </div>

                  {/* RANK */}
                  {/* Position, in the kit's one decorative treatment. A
                      chrome numeral is how these boards said "this is the
                      standing" without a label — see .arc-chrome. */}
                  <motion.span
                    layout="position"
                    className="arc-chrome"
                    style={{
                      flex: '0 0 auto',
                      width: '2.6ch',
                      textAlign: 'right',
                      fontSize: 'clamp(20px, 2.6vw, 34px)',
                      lineHeight: 1,
                    }}
                  >
                    {String(entry.rank).padStart(2, '0')}
                  </motion.span>

                  {/* ONLINE DOT */}
                  <motion.span
                    className={`arc-lamp ${entry.isOnline ? 'arc-lamp-on' : 'arc-lamp-off'}`}
                    style={{ flex: '0 0 auto' }}
                    animate={{ scale: entry.isOnline ? [1, 1.3, 1] : 1 }}
                    transition={{ scale: { duration: 0.3 } }}
                  />

                  {/* BAR COLUMN: name above, gauge below */}
                  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span
                        className="arc-label-plain"
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontSize: 'clamp(14px, 1.9vw, 24px)',
                          lineHeight: 1,
                        }}
                      >
                        {isFirst ? '\u25c6 ' : ''}
                        {entry.name}
                        {/* Burning is a state, so it is drawn as a label —
                            red, bevelled, blinking on a step rather than
                            fading. The old neon flicker was the one piece of
                            bloom left on the board. */}
                        {isHot && (
                          <span
                            className="arc-label"
                            style={{
                              animation: 'arcBlink 1.2s steps(1, end) infinite',
                              fontSize: '0.5em',
                              verticalAlign: 'middle',
                              marginLeft: '12px',
                            }}
                          >
                            Burning
                          </span>
                        )}
                      </span>
                      {/* The running total. Amber, because it is still
                          moving — the kit's whole rule for live values. */}
                      <span
                        className="arc-value-live"
                        style={{
                          flex: '0 0 auto',
                          paddingLeft: '12px',
                          fontSize: 'clamp(12px, 1.5vw, 18px)',
                          lineHeight: 1,
                        }}
                      >
                        <AnimatedTokens value={entry.totalTokens} formatter={fmtTokens} />
                      </span>
                    </div>

                    {/* POWER GAUGE */}
                    <div
                      className="bar-track arc-gauge"
                      style={{
                        background: `repeating-linear-gradient(to right, ${GRIDLINE_COLOR} 0 1px, transparent 1px ${stepPercent}%), ${ARCADE.groundDeep}`,
                      }}
                    >
                      <motion.div
                        className="bar-block"
                        animate={{ width: `${ratio * 100}%` }}
                        transition={{ type: 'spring', stiffness: 60, damping: 15 }}
                        style={{
                          display: 'flex',
                          // Reporters older than v3 send no model split. Until
                          // theirs lands we keep the original solid bar rather
                          // than showing a misleading single-model stack.
                          ...(segments.length === 0
                            ? { background: barGradient(entry.rank, entry.color) }
                            : {}),
                        }}
                      >
                        {segments.map((segment) => (
                          <motion.span
                            key={segment.family}
                            className="bar-segment"
                            title={`${segment.label} — ${fmtTokens(segment.tokens)} (${Math.round(segment.share * 100)}%)`}
                            initial={false}
                            animate={{ width: `${segment.share * 100}%` }}
                            transition={{ type: 'spring', stiffness: 60, damping: 15 }}
                            style={{ background: segmentGradient(segment.color) }}
                          />
                        ))}
                      </motion.div>
                    </div>
                  </div>

                  {/* STAT BLOCK */}
                  <div
                    className="arc-inset"
                    style={{
                      flex: '0 0 auto',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'clamp(8px, 1.1vw, 16px)',
                      padding: '6px 10px',
                      minWidth: 'clamp(150px, 17vw, 210px)',
                    }}
                  >
                    {/* Three label/value pairs, exactly as the kit draws
                        them: red caps over a white numeral, and amber only
                        where the number is still moving. */}
                    <StatPlate label="PWR" value={String(stats.power)} />
                    <StatPlate label="SPD" value={String(stats.speed)} live={burnRate > 0} />
                    <StatPlate label="Today" value={fmtTokensShort(entry.tokensToday)} />
                  </div>
                  </div>

                  <AnimatePresence initial={false}>
                    {nav.isExpanded && (
                      <RowDrawer
                        entry={entry}
                        segments={segments}
                        stats={stats}
                        burnRate={burnRate}
                      />
                    )}
                  </AnimatePresence>
                </motion.div>
  )
}

/**
 * What a row keeps back until you ask for it. The row itself has to survive
 * being read from across an office, so it carries a name, a gauge and three
 * numbers; everything with more than one decimal place of interest lives
 * here, one keystroke away.
 *
 * Height animates from 0 rather than the panel fading in: the console had no
 * alpha blending worth the name, and a menu opening was always a box growing.
 */
function RowDrawer({
  entry,
  segments,
  stats,
  burnRate,
}: {
  readonly entry: LeaderboardEntry
  readonly segments: ReadonlyArray<ModelSegment>
  readonly stats: PowerStats
  readonly burnRate: number
}): React.ReactElement {
  const cacheShare =
    entry.totalTokens > 0 ? Math.round((entry.cacheTokens / entry.totalTokens) * 100) : 0

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.16, ease: 'linear' }}
      style={{ overflow: 'hidden' }}
    >
      <div
        className="arc-drawer"
        style={{
          marginTop: 'clamp(6px, 0.8vh, 10px)',
          padding: 'clamp(8px, 1vh, 12px) clamp(10px, 1.2vw, 16px)',
          display: 'grid',
          gap: 'clamp(8px, 1.1vw, 16px)',
          gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
        }}
      >
        {/* MODEL SPLIT — the stacked bar above, itemised. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0 }}>
          <span className="arc-label" style={{ fontSize: 'clamp(7px, 0.8vw, 10px)' }}>
            Model split
          </span>
          {segments.length === 0 ? (
            <span className="arc-meta" style={{ fontSize: 'clamp(9px, 1vw, 12px)' }}>
              No split reported — reporter predates v3.
            </span>
          ) : (
            segments.map((segment) => (
              <div
                key={segment.family}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  fontSize: 'clamp(9px, 1vw, 12px)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                <span
                  className="legend-swatch"
                  style={{ background: segmentGradient(segment.color), flex: '0 0 auto' }}
                />
                <span
                  className="arc-caption"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    textShadow: 'none',
                  }}
                >
                  {segment.label}
                </span>
                <span style={{ color: ARCADE.value }}>{fmtTokens(segment.tokens)}</span>
                <span className="arc-meta" style={{ width: '4ch', textAlign: 'right' }}>
                  {Math.round(segment.share * 100)}%
                </span>
              </div>
            ))
          )}
        </div>

        {/* LEDGER — the numbers the gauge cannot carry. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <span className="arc-label" style={{ fontSize: 'clamp(7px, 0.8vw, 10px)' }}>
            Ledger
          </span>
          <DrawerStat label="Level" value={`LV${stats.level}`} />
          <DrawerStat label="In" value={fmtTokens(entry.inputTokens)} />
          <DrawerStat label="Out" value={fmtTokens(entry.outputTokens)} />
          <DrawerStat label="Cache" value={`${fmtTokens(entry.cacheTokens)} · ${cacheShare}%`} />
          <DrawerStat label="Sessions" value={String(entry.sessionCount)} />
          <DrawerStat
            label="Burn"
            value={burnRate > 0 ? `${Math.round(burnRate).toLocaleString()}/min` : 'Idle'}
            live={burnRate > 0}
          />
          <DrawerStat label="Last seen" value={fmtTime(entry.lastSeen)} />
        </div>
      </div>
    </motion.div>
  )
}

function DrawerStat({
  label,
  value,
  live = false,
}: {
  readonly label: string
  readonly value: string
  readonly live?: boolean
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: '12px',
        fontSize: 'clamp(9px, 1vw, 12px)',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      <span className="arc-meta">{label}</span>
      <span style={{ color: live ? ARCADE.amber : ARCADE.value }}>{value}</span>
    </div>
  )
}

/**
 * The chart strip. Selecting it is worth something on its own: at rest it is
 * a sparkline squeezed into a fifth of the screen, and opening it hands that
 * band roughly double the height, which is the difference between seeing that
 * a line moved and seeing where.
 *
 * The race strip beside it grows too rather than being pushed out — they are
 * two readings of the same day and separating them would be a lie.
 */
function TimelineRow({
  entries,
  burnRates,
}: {
  readonly entries: ReadonlyArray<LeaderboardEntry> | undefined
  readonly burnRates: ReadonlyMap<string, number>
}): React.ReactElement {
  const nav = useNavItem('timeline')

  return (
    <motion.div
      ref={nav.ref}
      onClick={nav.focus}
      initial={{ opacity: 0, y: 20 }}
      animate={{
        opacity: 1,
        y: 0,
        height: nav.isExpanded ? 'clamp(240px, 38vh, 380px)' : 'clamp(140px, 21vh, 200px)',
      }}
      transition={{
        duration: 0.5,
        delay: 0.3,
        height: { duration: 0.18, ease: 'linear', delay: 0 },
      }}
      className={['ps1-cursor', nav.isFocused ? 'arc-row-on' : ''].filter(Boolean).join(' ')}
      style={{
        position: 'relative',
        zIndex: 2,
        display: 'grid',
        gap: '10px',
        padding: '10px 28px 0',
        gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)',
      }}
    >
      <div
        className="arc-panel"
        style={{ minWidth: 0, height: '100%', padding: '6px 10px', overflow: 'hidden' }}
      >
        <Timeline />
      </div>
      <RaceStrip entries={entries} burnRates={burnRates} />
    </motion.div>
  )
}
