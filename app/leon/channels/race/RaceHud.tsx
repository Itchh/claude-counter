'use client'

import { AnimatePresence, motion } from 'motion/react'
import { fmtTokensShort } from '@/lib/formatters'
import { ARCADE, GT, PS1, PS1_TYPE } from '../../ps1/theme'
import { SCALED_SURFACE } from '../../ps1/hudScale'
import { Tachometer, burnRateToGear, formatLapTime } from '../../ps1/gtHud'
import { Timecode } from '../../ps1/Timecode'
import { Minimap } from './Minimap'
import type { SimRacer } from './useRaceSim'
import type { ActiveShot } from './CameraDirector'

// CH 01's instrument panel, laid out to the furniture map every arcade racer
// of the period used — and nothing else in the middle of the screen.
//
// The console bar is gone. It cost 156 pixels of picture along the whole foot
// of the frame and, being a fixed height, capped how large any instrument in
// it could be — so on a wall-mounted screen the readouts stayed small while
// the road they sat under got bigger. The reference machines banked everything
// into the four corners instead: circuit trace and its records top-left, the
// clock and the position dead centre, lap time on the right, and the
// tachometer bottom-right with a green segment readout tucked into its
// lower-left corner. That is what this is.
//
// Two rules carried over from the bar, and they are the ones that matter.
// Every number is a real one: speed is live tokens per minute, the dial reads
// the same figure, the gear is which band of that dial the needle sits in, and
// every clock is recorded by the simulation. And nothing sits in a box — a
// panel costs a rectangle of picture, an outline plus a hard offset costs
// none, which is why those screens stayed legible over a moving road.

/**
 * The reference racers' text palette. Red labels with a maroon bevel under
 * them, gold for the clock, paper white for values, LCD green for anything
 * live. The label carries the colour; the value almost never does.
 */
const RR = {
  label: ARCADE.label,
  labelShadow: ARCADE.labelShadow,
  gold: '#ffc21a',
  value: '#ffffff',
  live: ARCADE.telemetry,
  dim: GT.valueDim,
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

/** Gears in the ladder bottom-left. Six, as every car in those games had. */
const GEAR_STEPS = ['1', '2', '3', '4', '5', '6'] as const

interface RaceHudProps {
  /** Sampled slowly, for the numbers. */
  readonly racers: ReadonlyArray<SimRacer>
  /** Live sim state, for the map — it needs every frame, React does not. */
  readonly racersRef: React.RefObject<SimRacer[]>
  readonly isEmpty: boolean
  readonly activeShot: ActiveShot | null
  /** Hands the camera back to the director. Wired to the resume chip. */
  readonly onReleaseCamera: () => void
  /** Whether the broadcast's sound is armed. Muted by default. */
  readonly audioOn: boolean
  /** The speaker chip. The click doubles as the browser's audio gesture. */
  readonly onToggleAudio: () => void
  /** The circuit's name. The channel runs a different one each race. */
  readonly trackTitle: string
  /** True while a cabinet window is open over the race. */
  readonly paused: boolean
  /** Opens a driver's paint shop. The tower is the only way in. */
  readonly onOpenSetup: (racerKey: string) => void
}

/**
 * Elapsed time on the lap currently being run.
 *
 * Derived rather than stored: the simulation already records the total clock
 * and every completed split, so the current lap is what is left over. It is
 * the one clock on screen that is moving, which is why it gets the gold.
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

/** A red label with the kit's hard bevel under it. Never carries a value. */
function RedLabel({
  children,
  size = 15,
}: {
  readonly children: React.ReactNode
  readonly size?: number
}): React.ReactElement {
  return (
    <span
      className="gt-label"
      style={{
        fontSize: `${size}px`,
        letterSpacing: '0.16em',
        color: RR.label,
        textShadow: `1px 1px 0 ${RR.labelShadow}, ${OUTLINE}`,
      }}
    >
      {children}
    </span>
  )
}

/** Label over value, the era's entire typographic system in one lockup. */
function Readout({
  label,
  value,
  size = 26,
  color = RR.value,
  align = 'left',
}: {
  readonly label: string
  readonly value: string
  readonly size?: number
  readonly color?: string
  readonly align?: 'left' | 'center' | 'right'
}): React.ReactElement {
  return (
    <div style={{ textAlign: align, lineHeight: 1.05 }}>
      <div>
        <RedLabel>{label}</RedLabel>
      </div>
      {/* A duration, so it is drawn on segments rather than set in the HUD
          face. See ps1/Timecode.tsx for why that line is drawn where it is —
          the position numeral two boxes over is not a duration and stays in
          the ordinary face. */}
      <span
        style={{
          display: 'flex',
          justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start',
          // The bed is drawn, not blurred, so the ink under it is a hard
          // offset exactly as it is under the lettering beside it.
          filter: 'drop-shadow(2px 2px 0 rgba(0,0,0,0.92))',
        }}
      >
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
  audioOn,
  onToggleAudio,
  paused,
  onOpenSetup,
}: RaceHudProps): React.ReactElement {
  const leader = racers[0]
  const shotKind = activeShot?.kind ?? null
  const isManual = shotKind === 'follow' || shotKind === 'free'

  // The instruments read the car the camera is on. That is what a race HUD is:
  // the telemetry of whoever you are watching. It falls back to the leader
  // during a trackside shot, because a dead dial reads as a broken screen
  // rather than as "no subject".
  const subject = racers.find((racer) => racer.key === activeShot?.racerKey) ?? leader
  const subjectIndex = subject ? racers.findIndex((racer) => racer.key === subject.key) : -1
  const burnRate = subject?.velocityTokensPerMin ?? 0
  const gear = subject ? String(burnRateToGear(burnRate)) : '—'

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
          {/* TOP LEFT — the trace, then the two clocks that qualify it. */}
          <div
            style={{
              position: 'absolute',
              left: '18px',
              top: '10px',
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
            }}
          >
            <RedLabel size={13}>Stage 01 · {trackTitle}</RedLabel>
            <Minimap racersRef={racersRef} focusKey={activeShot?.racerKey ?? null} size={172} />
            <Readout label="Record" value={formatLapTime(bestLap(subject))} size={24} />
            <Readout label="Total" value={formatLapTime(subject?.totalClock ?? null)} size={24} />
          </div>

          {/* TOP CENTRE — the clock that is moving, and where you are in the
              field. The two numbers a driver actually races against. */}
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '8px',
              transform: 'translateX(-50%)',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '30px',
            }}
          >
            <Readout
              label="Time"
              value={formatLapTime(currentLapElapsed(subject))}
              size={48}
              color={RR.gold}
              align="center"
            />
            <div style={{ textAlign: 'center', lineHeight: 1.05 }}>
              <div>
                <RedLabel>Position</RedLabel>
              </div>
              <span
                className="gt-label"
                style={{ fontSize: '52px', color: RR.value, fontVariantNumeric: 'tabular-nums', ...INK_LARGE }}
              >
                {String(subjectIndex + 1).padStart(2, '0')}
              </span>
              <span
                className="gt-label"
                style={{ fontSize: '26px', color: RR.dim, ...INK_SMALL }}
              >
                /{String(racers.length).padStart(2, '0')}
              </span>
            </div>
          </div>

          {/* RIGHT — lap time where the reference puts it, and the order
              underneath. On a screen the whole room watches, "who else is out
              there" is the question a lone position numeral cannot answer.
              Sits below the cabinet's own corner buttons. */}
          <div
            style={{
              position: 'absolute',
              right: '18px',
              top: '72px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: '10px',
            }}
          >
            <Readout label="Lap time" value={formatLapTime(lastLap(subject))} size={24} align="right" />
            {/* Fixed columns, not a flexing name: with `flex: 1` on the name
                the lap column was pushed to whatever width the widest name
                allowed, so the two halves of a row drifted apart and stopped
                reading as one line.

                Three columns, and there used to be four. The fourth was a
                bar showing each driver's score as a share of the leader's —
                the same number as the figure beside it, drawn twice — and it
                was the widest thing in the tower. Dropping it bought back
                sixty pixels, which went into the type: a board on a wall is
                read at a glance from across a room, and at that distance a
                legible name beats a second opinion about the number next to
                it. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {racers.map((racer, index) => {
                const isSubject = racer.key === subject?.key
                return (
                  <button
                    key={racer.key}
                    type="button"
                    onClick={() => onOpenSetup(racer.key)}
                    title={`Paint shop — ${racer.name}`}
                    className="gt-tower-row arc-tower-row"
                    style={{
                      pointerEvents: 'auto',
                      // No plate behind it, and no rules either — see
                      // .arc-tower-row. Done in CSS rather than inline so the
                      // row keeps the hover mark that opens the paint shop.
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
                        fontSize: `${PS1_TYPE.body}px`,
                        fontVariantNumeric: 'tabular-nums',
                        color: index === 0 ? RR.gold : RR.value,
                        ...INK_SMALL,
                      }}
                    >
                      {index + 1}
                    </span>
                    <span
                      style={{
                        width: '5px',
                        height: '17px',
                        background: racer.color,
                        boxShadow: '1px 1px 0 #000',
                      }}
                    />
                    <span
                      title={racer.name}
                      className="gt-label"
                      style={{
                        width: '78px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: `${PS1_TYPE.body}px`,
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
                        width: '58px',
                        textAlign: 'right',
                        fontSize: `${PS1_TYPE.label}px`,
                        fontVariantNumeric: 'tabular-nums',
                        color: racer.isActive ? RR.live : RR.dim,
                        ...INK_SMALL,
                      }}
                    >
                      {fmtTokensShort(racer.score)}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* BOTTOM LEFT — the gear ladder, and whose car the camera is on. */}
          <div
            style={{
              position: 'absolute',
              left: '18px',
              bottom: '18px',
              display: 'flex',
              alignItems: 'flex-end',
              gap: '14px',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column-reverse', gap: '2px' }}>
              {GEAR_STEPS.map((step) => {
                const lit = step === gear
                return (
                  <span
                    key={step}
                    className="gt-label"
                    style={{
                      fontSize: '11px',
                      width: '22px',
                      textAlign: 'center',
                      color: lit ? '#000' : ARCADE.silver,
                      background: lit ? RR.live : 'rgba(4,4,10,0.7)',
                      boxShadow: `inset 0 0 0 1px ${lit ? '#000' : ARCADE.rule}`,
                    }}
                  >
                    {step}
                  </span>
                )
              })}
            </div>

            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span
                  style={{
                    width: '9px',
                    height: '30px',
                    background: subject?.color ?? PS1.cyan,
                    boxShadow: '2px 2px 0 #000',
                  }}
                />
                <span
                  className="gt-label"
                  style={{ fontSize: `${PS1_TYPE.body + 6}px`, color: RR.value, ...INK_SMALL }}
                >
                  {subject?.name ?? '—'}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '2px' }}>
                <span className="gt-label" style={{ fontSize: '13px', color: RR.gold, ...INK_SMALL }}>
                  {isManual ? (shotKind === 'free' ? 'Free camera' : 'Following') : 'Onboard'} · lap{' '}
                  {subject?.lap ?? 0} · {fmtTokensShort(subject?.score ?? 0)} tokens
                </span>
                <button
                  type="button"
                  onClick={onToggleAudio}
                  title={audioOn ? 'Mute the broadcast' : 'Sound on'}
                  className={`gt-chip${audioOn ? ' gt-chip-lit' : ''}`}
                  style={{
                    pointerEvents: 'auto',
                    border: 'none',
                    font: 'inherit',
                    width: 'auto',
                    padding: '0 8px',
                    letterSpacing: '0.08em',
                    ...(audioOn ? { color: PS1.green } : {}),
                  }}
                >
                  Sound
                </button>
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
                      fontSize: `${PS1_TYPE.micro}px`,
                      padding: '4px 10px',
                    }}
                  >
                    C — resume broadcast
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* BOTTOM RIGHT — the dial, with the segment readout tucked into its
              lower-left exactly as the reference does: gear above, rate below.
              The needle only breathes while the subject is actually burning. */}
          <div
            style={{
              position: 'absolute',
              right: '18px',
              bottom: '12px',
              display: 'flex',
              alignItems: 'flex-end',
              gap: '14px',
            }}
          >
            <div style={{ textAlign: 'left', paddingBottom: '14px' }}>
              <div>
                <span className="gt-label" style={{ fontSize: '20px', color: RR.live, ...INK_SMALL }}>
                  {gear}
                </span>
              </div>
              <span
                className="gt-label"
                style={{
                  fontSize: '30px',
                  color: RR.live,
                  fontVariantNumeric: 'tabular-nums',
                  ...INK_SMALL,
                }}
              >
                {(burnRate / 1000).toFixed(1)}
              </span>
              <span className="gt-label" style={{ fontSize: '15px', color: RR.live, marginLeft: '4px', ...INK_SMALL }}>
                K t/min
              </span>
            </div>
            <Tachometer
              value={burnRate}
              caption="×1k tokens/min"
              size={168}
              live={(subject?.isActive ?? false) && !paused}
            />
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
                  top: '104px',
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
