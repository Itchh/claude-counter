'use client'

import { AnimatePresence, motion } from 'motion/react'
import { fmtTokensShort } from '@/lib/formatters'
import { isCpuKey } from '@/lib/cpuRoster'
import { ARCADE, FONTS, GARAGE, GT, PS1, PS1_TYPE } from '../../ps1/theme'
import { SCALED_SURFACE } from '../../ps1/hudScale'
import { ChromeCounter, RevBar, StopwatchMark, formatLapTime } from '../../ps1/gtHud'
import { Timecode } from '../../ps1/Timecode'
import { Minimap } from './Minimap'
import { toMph } from './gearbox'
import type { SimRacer } from './useRaceSim'
import type { ActiveShot } from './CameraDirector'

// CH 01's instrument panel, laid out to the furniture map the late-90s
// touring car games used — and nothing else in the middle of the screen.
//
// Four corners and a strip along the top. The lap counter top-left in chrome,
// with the circuit trace tucked under it. The three clocks a driver races
// against across the top centre: the lap that is running, the best in the
// book, and the split just set. Position top-right in red, big enough to
// read from the back of the room, with the field listed under it. The
// running total bottom-left beside a stopwatch. And bottom-right the engine:
// a segmented rev bar, the gear in lemon, and the road speed under it.
//
// Two rules carried over from the earlier boards, and they are the ones that
// matter. Every number is a real one: the gear and the revs are the
// simulation's own gearbox on the car the camera is watching, the speed is
// that car's road speed, and every clock is recorded by the simulation. And
// nothing sits in a box — a panel costs a rectangle of picture, an outline
// plus a hard offset costs none, which is why those screens stayed legible
// over a moving road.

/**
 * The reference racers' text palette. White outlined labels — not red, on
 * this generation of screen — lemon for the engine, red for a position and
 * a split, LCD green for a record, paper white for the clock that is running.
 */
const RR = {
  label: '#ffffff',
  lemon: GARAGE.lemon,
  red: ARCADE.label,
  value: '#ffffff',
  record: ARCADE.telemetry,
  dim: GT.valueDim,
  gold: '#ffc21a',
} as const

/**
 * The era's whole legibility system: an outline that inks the letterform's
 * edge, then a solid offset that lifts it off the picture. No blur — blur is a
 * soft light source, and over a bright horizon it vanishes and takes the text
 * with it.
 */
const OUTLINE = '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000'
const INK_SMALL = { textShadow: `${OUTLINE}, 2px 2px 0 rgba(0,0,0,0.92)` } as const
const INK_LARGE = { textShadow: `${OUTLINE}, 3px 3px 0 rgba(0,0,0,0.92)` } as const
/** The big numerals lean, as the reference's do. */
const LEAN = { display: 'inline-block', transform: 'skewX(-9deg)' } as const

/** Cap heights of the three clocks across the top, and the total below. */
const TIME_PX = 36
const SPLIT_PX = 24
const TOTAL_PX = 28
const POSITION_PX = 64
const GEAR_PX = 60
const SPEED_PX = 30
const MINIMAP_PX = 120
const REV_BAR_PX = 150

interface RaceHudProps {
  /** Sampled slowly, for the numbers. */
  readonly racers: ReadonlyArray<SimRacer>
  /** Live sim state, for the map — it needs every frame, React does not. */
  readonly racersRef: React.RefObject<SimRacer[]>
  readonly isEmpty: boolean
  readonly activeShot: ActiveShot | null
  /** Hands the camera back to the director. Wired to the resume chip. */
  readonly onReleaseCamera: () => void
  /** The circuit's name. The channel runs a different one each race. */
  readonly trackTitle: string
  /** True while a cabinet window is open over the race. */
  readonly paused: boolean
  /** Opens a driver's car select. The tower is one of the two ways in. */
  readonly onOpenSetup: (racerKey: string) => void
}

/**
 * Elapsed time on the lap currently being run.
 *
 * Derived rather than stored: the simulation already records the total clock
 * and every completed split, so the current lap is what is left over.
 */
function currentLapElapsed(racer: SimRacer | undefined): number | null {
  if (!racer) return null
  const completed = racer.lapTimes.reduce((sum, lap) => sum + lap, 0)
  return Math.max(0, racer.totalClock - completed)
}

/** The driver's best lap so far — the record the current one is racing. */
function bestLap(racer: SimRacer | undefined): number | null {
  if (!racer || racer.lapTimes.length === 0) return null
  return Math.min(...racer.lapTimes)
}

/** The last completed lap. Null until one is in the book. */
function lastLap(racer: SimRacer | undefined): number | null {
  if (!racer || racer.lapTimes.length === 0) return null
  return racer.lapTimes[racer.lapTimes.length - 1]
}

/** A white outlined label, leaning. Never carries a value. */
function Label({
  children,
  size = PS1_TYPE.label,
}: {
  readonly children: React.ReactNode
  readonly size?: number
}): React.ReactElement {
  return (
    <span
      className="gt-label"
      style={{
        ...LEAN,
        fontFamily: FONTS.hud,
        fontSize: `${size}px`,
        letterSpacing: '0.14em',
        color: RR.label,
        ...INK_SMALL,
      }}
    >
      {children}
    </span>
  )
}

/**
 * Label beside clock, the strip's whole typographic system in one row. A
 * duration, so it is drawn on segments — see ps1/Timecode.tsx for why.
 */
function ClockRow({
  label,
  value,
  size,
  color,
}: {
  readonly label: string
  readonly value: string
  readonly size: number
  readonly color: string
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
      <span style={{ width: '5.2em', fontSize: `${PS1_TYPE.label}px`, display: 'inline-flex', justifyContent: 'flex-end' }}>
        <Label>{label}</Label>
      </span>
      <span style={{ display: 'inline-flex', filter: 'drop-shadow(2px 2px 0 rgba(0,0,0,0.92))' }}>
        <Timecode value={value} size={size} color={color} label={`${label} ${value}`} />
      </span>
    </div>
  )
}

export function RaceHud({
  racers,
  racersRef,
  isEmpty,
  trackTitle,
  activeShot,
  onReleaseCamera,
  paused,
  onOpenSetup,
}: RaceHudProps): React.ReactElement {
  const leader = racers[0]
  const shotKind = activeShot?.kind ?? null
  const isManual = shotKind === 'follow' || shotKind === 'free'

  // The instruments read the car the camera is on. That is what a race HUD is:
  // the telemetry of whoever you are watching. It falls back to the leader
  // during a trackside shot, because a dead bar reads as a broken screen
  // rather than as "no subject".
  const subject = racers.find((racer) => racer.key === activeShot?.racerKey) ?? leader
  const subjectIndex = subject ? racers.findIndex((racer) => racer.key === subject.key) : -1
  const burnRate = subject?.velocityTokensPerMin ?? 0
  const gear = subject?.gear ?? 1
  const rpm = subject?.rpm ?? 0
  const mph = Math.round(toMph(subject?.speed ?? 0))
  const live = (subject?.isActive ?? false) && !paused

  return (
    // Above the canvas, which is itself lifted above the painted sky. Without
    // a layer here the HUD is only visible where the scene happens to be
    // transparent — i.e. the sky — and the readouts vanish behind the road.
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        zIndex: 2,
        pointerEvents: 'none',
        ...SCALED_SURFACE,
      }}
    >
      {isEmpty ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span className="gt-label" style={{ color: PS1.hot, fontSize: `${PS1_TYPE.title}px` }}>
            <span style={{ animation: 'blink 1.2s step-end infinite' }}>_</span> Grid empty —
            waiting for entrants
          </span>
        </div>
      ) : (
        <>
          {/* TOP LEFT — the lap counter in chrome, the trace under it. */}
          <div
            style={{
              position: 'absolute',
              left: '18px',
              top: '8px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            <ChromeCounter value={subject?.lap ?? 0} suffix="Lap" />
            <span className="gt-label" style={{ fontFamily: FONTS.hud, fontSize: `${PS1_TYPE.micro}px`, color: RR.dim, ...INK_SMALL }}>
              Stage 01 · {trackTitle}
            </span>
            <Minimap racersRef={racersRef} focusKey={activeShot?.racerKey ?? null} size={MINIMAP_PX} />
          </div>

          {/* TOP CENTRE — the three clocks. Running lap in white, the record
              in green, the split just set in red. Dropped in the narrow
              layout, where they would sit on top of both corners. */}
          <div
            className="cab-narrow-hide"
            style={{
              position: 'absolute',
              left: '50%',
              top: '10px',
              transform: 'translateX(-50%)',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            }}
          >
            <ClockRow label="Time" value={formatLapTime(currentLapElapsed(subject))} size={TIME_PX} color={RR.value} />
            <ClockRow label="Best" value={formatLapTime(bestLap(subject))} size={SPLIT_PX} color={RR.record} />
            <div style={{ height: '6px' }} />
            <ClockRow label="Split" value={formatLapTime(lastLap(subject))} size={SPLIT_PX} color={RR.red} />
          </div>

          {/* TOP RIGHT — position, then the field under it. Sits below the
              cabinet's own corner buttons. */}
          <div
            style={{
              position: 'absolute',
              right: '18px',
              top: '8px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: '8px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '14px' }}>
              <Label size={PS1_TYPE.body}>Pos</Label>
              <span
                className="gt-label"
                style={{
                  ...LEAN,
                  fontSize: `${POSITION_PX}px`,
                  lineHeight: 1,
                  color: RR.red,
                  fontVariantNumeric: 'tabular-nums',
                  ...INK_LARGE,
                }}
              >
                {subjectIndex + 1}
              </span>
            </div>
            {/* Fixed columns, not a flexing name, so the two halves of a row
                never drift apart. Three columns: place, colour, name, score. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {racers.map((racer, index) => {
                const isSubject = racer.key === subject?.key
                // A CPU driver's score is a fiction dealt by lib/cpuRoster, so
                // the tower prints the word instead of the number.
                const isCpu = isCpuKey(racer.key)
                return (
                  <button
                    key={racer.key}
                    type="button"
                    onClick={() => onOpenSetup(racer.key)}
                    title={`Select car — ${racer.name}`}
                    className="gt-tower-row arc-tower-row"
                    style={{
                      pointerEvents: 'auto',
                      border: 'none',
                      padding: '1px 0',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '7px',
                      textAlign: 'left',
                      font: 'inherit',
                    }}
                  >
                    <span
                      className="gt-label"
                      style={{
                        width: '1.6ch',
                        textAlign: 'right',
                        fontSize: `${PS1_TYPE.label}px`,
                        fontVariantNumeric: 'tabular-nums',
                        color: index === 0 ? RR.lemon : RR.value,
                        ...INK_SMALL,
                      }}
                    >
                      {index + 1}
                    </span>
                    <span
                      style={{
                        width: '5px',
                        height: '15px',
                        background: racer.color,
                        boxShadow: '1px 1px 0 #000',
                      }}
                    />
                    <span
                      title={racer.name}
                      className="gt-label"
                      style={{
                        width: '92px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: `${PS1_TYPE.label}px`,
                        color: RR.value,
                        opacity: isSubject ? 1 : 0.85,
                        ...INK_SMALL,
                      }}
                    >
                      {racer.name}
                    </span>
                    <span
                      className="gt-label"
                      style={{
                        width: '60px',
                        textAlign: 'right',
                        fontSize: `${PS1_TYPE.micro}px`,
                        fontVariantNumeric: 'tabular-nums',
                        color: isCpu || !racer.isActive ? RR.dim : RR.record,
                        ...INK_SMALL,
                      }}
                    >
                      {isCpu ? 'CPU' : fmtTokensShort(racer.score)}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* BOTTOM LEFT — whose car the camera is on, and the running total
              beside its stopwatch. */}
          <div
            style={{
              position: 'absolute',
              left: '18px',
              bottom: '16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span
                  style={{
                    width: '9px',
                    height: '26px',
                    background: subject?.color ?? PS1.cyan,
                    boxShadow: '2px 2px 0 #000',
                  }}
                />
                <span
                  className="gt-label"
                  style={{ fontSize: `${PS1_TYPE.body}px`, color: RR.value, ...INK_SMALL }}
                >
                  {subject?.name ?? '—'}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '2px' }}>
                <span className="gt-label" style={{ fontFamily: FONTS.hud, fontSize: `${PS1_TYPE.micro}px`, color: RR.gold, ...INK_SMALL }}>
                  {isManual ? (shotKind === 'free' ? 'Free camera' : 'Following') : 'Onboard'} ·{' '}
                  {fmtTokensShort(subject?.score ?? 0)} tokens · {(burnRate / 1000).toFixed(1)}K t/min
                </span>
                {isManual && (
                  <button
                    type="button"
                    onClick={onReleaseCamera}
                    className="gt-label"
                    style={{
                      pointerEvents: 'auto',
                      background: '#2c2c34',
                      border: 'none',
                      boxShadow: 'inset 2px 2px 0 0 #c9c9d4, inset -2px -2px 0 0 #1c1c22',
                      color: GT.label,
                      fontFamily: FONTS.hud,
                      fontSize: `${PS1_TYPE.micro}px`,
                      padding: '4px 10px',
                    }}
                  >
                    C — resume broadcast
                  </button>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <StopwatchMark />
              <span style={{ display: 'inline-flex', filter: 'drop-shadow(2px 2px 0 rgba(0,0,0,0.92))' }}>
                <Timecode
                  value={formatLapTime(subject?.totalClock ?? null)}
                  size={TOTAL_PX}
                  color={RR.red}
                  label={`Total ${formatLapTime(subject?.totalClock ?? null)}`}
                />
              </span>
            </div>
          </div>

          {/* BOTTOM RIGHT — the engine. The rev bar on the left, the gear in
              lemon beside it, the road speed under the gear. All three are
              the simulation's own readings on the subject car. */}
          <div
            style={{
              position: 'absolute',
              right: '18px',
              bottom: '6px',
              display: 'flex',
              alignItems: 'flex-end',
              gap: '4px',
            }}
          >
            <RevBar rpm={rpm} size={REV_BAR_PX} live={live} />
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', paddingBottom: '18px' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
                <Label size={PS1_TYPE.micro}>Gear</Label>
                <span
                  className="gt-label"
                  style={{
                    ...LEAN,
                    fontSize: `${GEAR_PX}px`,
                    lineHeight: 1,
                    color: RR.lemon,
                    fontVariantNumeric: 'tabular-nums',
                    ...INK_LARGE,
                  }}
                >
                  {gear}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginTop: '-4px' }}>
                <Label size={PS1_TYPE.micro}>MpH</Label>
                <span
                  className="gt-label"
                  style={{
                    ...LEAN,
                    fontSize: `${SPEED_PX}px`,
                    lineHeight: 1,
                    color: RR.lemon,
                    fontVariantNumeric: 'tabular-nums',
                    ...INK_SMALL,
                  }}
                >
                  {mph}
                </span>
              </div>
            </div>
          </div>

          {/* The hold. A window is open; the picture is still, and says so. */}
          <AnimatePresence>
            {paused && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.14 }}
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: '118px',
                  transform: 'translateX(-50%)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                }}
              >
                <span style={{ display: 'flex', gap: '4px' }}>
                  <span style={{ width: '7px', height: '24px', background: ARCADE.amber }} />
                  <span style={{ width: '7px', height: '24px', background: ARCADE.amber }} />
                </span>
                <span
                  className="gt-label"
                  style={{ fontSize: '24px', letterSpacing: '0.2em', color: ARCADE.amber, ...INK_LARGE }}
                >
                  Paused
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  )
}
