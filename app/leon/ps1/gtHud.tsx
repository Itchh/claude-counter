'use client'

import { useEffect, useState } from 'react'
import { GT, FONTS } from './theme'

// The in-race instrument set, as the arcade sims of the period drew it.
//
// The defining choice is that a race HUD is *instrumentation*, not menu
// chrome. Menus of the era were blue bevelled boxes; the race screen was a
// black console bar tinted green at the foot of the picture, carrying gold
// condensed labels over white numerals, an amber LCD, and a real analogue
// dial with a needle. Nothing in here glows, and nothing is rounded — a
// bevel is two hard lines, a dial is a circle with ticks, and depth comes
// from a light edge and a dark edge rather than from a shadow.
//
// Every piece is presentational: values arrive already computed, so the same
// dial can read a burn rate here and something else on the next channel.

/** Full-scale burn rate on the tachometer, in tokens per minute. */
export const TACHO_FULL_SCALE = 40_000
/** Where the red arc starts, as a fraction of full scale. */
const REDLINE_FRACTION = 0.625
/** Sweep of the dial, in degrees, measured clockwise from straight down. */
const DIAL_START_DEG = -125
const DIAL_END_DEG = 125
const DIAL_DIVISIONS = 8
/** Gears in the box. Six, as every car in those games had. */
const GEAR_COUNT = 6

/**
 * `1'18"548` — the notation those games used, and the reason lap times are
 * readable at a glance: the separators differ, so the eye never has to count
 * digit groups. A null lap is drawn as its own placeholder rather than as an
 * empty row, because a missing split still occupies a line on the board.
 */
export function formatLapTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return `--'--"---`
  const total = Math.max(0, seconds)
  const minutes = Math.floor(total / 60)
  const secs = Math.floor(total % 60)
  const millis = Math.floor((total % 1) * 1000)
  return `${String(minutes).padStart(2, '0')}'${String(secs).padStart(2, '0')}"${String(millis).padStart(3, '0')}`
}

/** Gold condensed caps naming a readout. Never carries a value itself. */
export function HudLabel({
  children,
  size = 15,
}: {
  readonly children: React.ReactNode
  readonly size?: number
}): React.ReactElement {
  return (
    <span
      className="gt-label"
      style={{ fontFamily: FONTS.hud, fontSize: `${size}px`, color: GT.label }}
    >
      {children}
    </span>
  )
}

/** A white numeric value. Tabular by default — these sit in columns. */
export function HudValue({
  children,
  size = 18,
  dim = false,
  highlight = null,
}: {
  readonly children: React.ReactNode
  readonly size?: number
  readonly dim?: boolean
  /** Overrides the paper white, for the current lap or a personal best. */
  readonly highlight?: string | null
}): React.ReactElement {
  return (
    <span
      style={{
        fontFamily: FONTS.hud,
        fontSize: `${size}px`,
        color: highlight ?? (dim ? GT.valueDim : GT.value),
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '0.02em',
        lineHeight: 1.15,
      }}
    >
      {children}
    </span>
  )
}

/**
 * The amber LCD. Lit digits sit on a visible unlit bed, which is what makes a
 * segment display read as a display rather than as orange text — the console
 * versions always showed the dead segments.
 */
export function LcdReadout({
  value,
  unit,
  digits = 3,
  size = 30,
}: {
  readonly value: number
  readonly unit: string
  /** Width of the bed, in digits. Fixed so the number never shifts the box. */
  readonly digits?: number
  readonly size?: number
}): React.ReactElement {
  const shown = String(Math.max(0, Math.round(value))).slice(-digits)
  return (
    <span className="gt-lcd" style={{ fontFamily: FONTS.hud }}>
      {/* The lit digits are positioned against the BED, not against the whole
          readout. Aligning them to the outer box right-aligned them past the
          unit label, so a full-width value slid sideways off its own
          segments. */}
      <span className="gt-lcd-digits">
        <span className="gt-lcd-bed" style={{ fontSize: `${size}px` }} aria-hidden>
          {'8'.repeat(digits)}
        </span>
        <span className="gt-lcd-lit" style={{ fontSize: `${size}px` }}>
          {shown}
        </span>
      </span>
      <span className="gt-lcd-unit" style={{ fontSize: `${Math.round(size * 0.42)}px` }}>
        {unit}
      </span>
    </span>
  )
}

/** The bevelled metal plate a gear number is stamped into. */
export function GearBox({ gear }: { readonly gear: number }): React.ReactElement {
  return (
    <span className="gt-gear" style={{ fontFamily: FONTS.hud }}>
      {gear}
    </span>
  )
}

export interface StatusChip {
  readonly id: string
  /**
   * What the lamp is called, spelled out.
   *
   * These were single capitals — B, A, L — on the grounds that the era's
   * clusters were stamped letters. They were, but on a dashboard the driver
   * had already learned; on a screen in an office nobody has a manual, and
   * an unlit plate reading "L" tells a passer-by nothing at all. The word
   * costs a few pixels of a bar that has room for them.
   */
  readonly label: string
  readonly lit: boolean
  readonly color?: string
  readonly title: string
}

/**
 * The warning-lamp cluster. Dark plates that light up, never plates that
 * appear — a lamp you only see when it fires reads as a glitch, and half the
 * point of a cluster is knowing which lamps exist while they are off.
 */
export function StatusCluster({
  chips,
}: {
  readonly chips: ReadonlyArray<StatusChip>
}): React.ReactElement {
  return (
    <span style={{ display: 'inline-flex', gap: '6px' }}>
      {chips.map((chip) => (
        <span
          key={chip.id}
          title={chip.title}
          className={`gt-chip${chip.lit ? ' gt-chip-lit' : ''}`}
          style={{
            fontFamily: FONTS.hud,
            letterSpacing: '0.08em',
            ...(chip.lit && chip.color ? { color: chip.color } : {}),
          }}
        >
          {chip.label}
        </span>
      ))}
    </span>
  )
}

function polar(cx: number, cy: number, radius: number, degrees: number): [number, number] {
  const radians = ((degrees - 90) * Math.PI) / 180
  return [cx + radius * Math.cos(radians), cy + radius * Math.sin(radians)]
}

/**
 * The analogue tachometer.
 *
 * Drawn as an SVG rather than a sprite so the needle can sit at a real angle
 * instead of the nearest frame, and sized in a fixed viewBox so the whole dial
 * scales as one object. The needle carries a short transition because a real
 * one has mass; the ticks do not move at all.
 */
/** How often the idle flutter is resampled while the subject is burning. */
const REV_TICK_MS = 80
/** Amplitude of the slow breathe and the fine flutter, as a fraction of scale. */
const REV_BREATHE = 0.05
const REV_FLUTTER = 0.022

/** Deterministic noise, so the flutter is not a new random walk every mount. */
function revNoise(step: number): number {
  const value = Math.sin(step * 12.9898) * 43758.5453
  return value - Math.floor(value)
}

export function Tachometer({
  value,
  fullScale = TACHO_FULL_SCALE,
  caption,
  size = 118,
  live = false,
}: {
  /** The live figure, in the same unit as `fullScale`. */
  readonly value: number
  readonly fullScale?: number
  readonly caption: string
  readonly size?: number
  /**
   * Whether the subject is actually burning tokens right now.
   *
   * A held throttle never sits still in a real car — the needle breathes with
   * the engine and flutters on top of that — so a needle that only ever parked
   * at a value read as a printed dial rather than an instrument. It falls dead
   * still the moment the subject stops, which makes idle itself information.
   */
  readonly live?: boolean
}): React.ReactElement {
  const [rev, setRev] = useState(0)

  useEffect(() => {
    if (!live) {
      setRev(0)
      return
    }
    let step = 0
    const id = setInterval(() => {
      step += 1
      setRev(Math.sin(step / 8) * REV_BREATHE + (revNoise(step) - 0.5) * REV_FLUTTER)
    }, REV_TICK_MS)
    return () => clearInterval(id)
  }, [live])

  const fraction = Math.max(0, Math.min(1, value / fullScale + rev))
  const sweep = DIAL_END_DEG - DIAL_START_DEG
  const needleAngle = DIAL_START_DEG + fraction * sweep
  const centre = 60

  const majorTicks = Array.from({ length: DIAL_DIVISIONS + 1 }, (_, index) => {
    const t = index / DIAL_DIVISIONS
    const angle = DIAL_START_DEG + t * sweep
    const [x1, y1] = polar(centre, centre, 46, angle)
    const [x2, y2] = polar(centre, centre, 38, angle)
    const [lx, ly] = polar(centre, centre, 29, angle)
    return { index, angle, x1, y1, x2, y2, lx, ly, hot: t >= REDLINE_FRACTION }
  })

  const [redStartX, redStartY] = polar(centre, centre, 50, DIAL_START_DEG + REDLINE_FRACTION * sweep)
  const [redEndX, redEndY] = polar(centre, centre, 50, DIAL_END_DEG)

  return (
    <span
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '2px',
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 120 120"
        role="img"
        aria-label={caption}
        style={{ display: 'block' }}
      >
        <circle cx={centre} cy={centre} r={57} fill={GT.dialRim} />
        <circle cx={centre} cy={centre} r={53} fill={GT.dialFace} />
        {/* The red arc, laid under the ticks so they cut through it. */}
        <path
          d={`M ${redStartX} ${redStartY} A 50 50 0 0 1 ${redEndX} ${redEndY}`}
          fill="none"
          stroke={GT.redline}
          strokeWidth={5}
        />
        {majorTicks.map((tick) => (
          <g key={tick.index}>
            <line
              x1={tick.x1}
              y1={tick.y1}
              x2={tick.x2}
              y2={tick.y2}
              stroke={tick.hot ? GT.redline : GT.dialTick}
              strokeWidth={2.5}
            />
            <text
              x={tick.lx}
              y={tick.ly + 4}
              textAnchor="middle"
              fill={tick.hot ? GT.redline : GT.dialTick}
              fontFamily={FONTS.hud}
              fontSize={11}
            >
              {tick.index}
            </text>
          </g>
        ))}
        <g
          className={live ? 'gt-needle gt-needle-live' : 'gt-needle'}
          style={{ transform: `rotate(${needleAngle}deg)`, transformOrigin: '60px 60px' }}
        >
          <polygon points="57,62 63,62 61,20 59,20" fill={GT.needle} />
        </g>
        <circle cx={centre} cy={centre} r={7} fill={GT.metalFace} stroke={GT.metalHi} strokeWidth={2} />
      </svg>
      <span
        className="gt-label"
        style={{ fontFamily: FONTS.hud, fontSize: '10px', color: GT.valueDim }}
      >
        {caption}
      </span>
    </span>
  )
}

/**
 * The big lap counter. Italic, bevelled and set in outlined chrome — the one
 * piece of type on the screen that is allowed to be decorative, because in
 * every game of the period it was the only number you could read from the
 * back of an arcade.
 *
 * `of` is optional. Those games always printed `2/3` because a race had a
 * finish; this one does not — laps accumulate all day — so the denominator is
 * omitted rather than invented, and the counter reads as an odometer.
 */
export function ChromeCounter({
  value,
  of = null,
  suffix,
}: {
  readonly value: number
  readonly of?: number | null
  readonly suffix: string
}): React.ReactElement {
  return (
    <span className="gt-chrome" style={{ fontFamily: FONTS.hud }}>
      <span className="gt-chrome-num">{value}</span>
      {of !== null && (
        <>
          <span className="gt-chrome-slash">/</span>
          <span className="gt-chrome-num">{of}</span>
        </>
      )}
      <span className="gt-chrome-suffix">{suffix}</span>
    </span>
  )
}

/**
 * Gear from burn rate.
 *
 * A real gearbox is a function of engine speed, and this car's "engine" is a
 * token rate, so the gear is simply which band of the tachometer the needle
 * currently sits in. It is a readout of the same number the dial shows rather
 * than a second invented one — which is the whole rule this HUD is built on.
 */
export function burnRateToGear(tokensPerMin: number, fullScale = TACHO_FULL_SCALE): number {
  const fraction = Math.max(0, Math.min(0.999, tokensPerMin / fullScale))
  return 1 + Math.floor(fraction * GEAR_COUNT)
}
