'use client'

import { AnimatePresence, motion } from 'motion/react'
import { fmtTokensShort } from '@/lib/formatters'
import { GT, PS1, PS1_TYPE } from '../../ps1/theme'
import { SCALED_SURFACE } from '../../ps1/hudScale'
import {
  ChromeCounter,
  GearBox,
  HudLabel,
  HudValue,
  LcdReadout,
  StatusCluster,
  Tachometer,
  burnRateToGear,
  formatLapTime,
  type StatusChip,
} from '../../ps1/gtHud'
import { Minimap } from './Minimap'
import type { SimRacer } from './useRaceSim'
import type { ActiveShot } from './CameraDirector'

// CH 01's instrument panel, built to the shape every console racer of the era
// used: a full-width console bar across the foot of the picture, and nothing
// else in the middle of the screen.
//
// The layout is not decoration — it is the era's answer to a real problem.
// The picture is moving and the driver is looking at the horizon, so every
// readout is banked at the bottom edge where the eye can drop to it and come
// straight back. Splits sit left because they are read between corners; the
// map sits centre-left because it is glanced at; the dial sits far right
// because it is read peripherally and never actually looked at.
//
// The one rule kept from before: every number is a real one. Speed is live
// tokens per minute, the dial reads the same figure, the gear is which band
// of that dial the needle is in, and the splits are recorded lap times from
// the simulation — not a plausible-looking clock.

/**
 * The reference racers' text palette, used by everything that floats over the
 * picture. Saturated primaries for labels and accents, plain white for
 * values, the LCD yellow for numbers that tick — and black offsets instead of
 * boxes, because a shadow costs no picture and a panel costs a rectangle of
 * it. The console bar at the foot of the screen keeps its own GT palette;
 * these are for the type that sits on the sky.
 */
const RR = {
  /** Small caps naming a readout. The gold every era HUD label wore. */
  label: '#ffb020',
  /** The leader's rank numeral. */
  gold: '#ffd23d',
  /** Value text. Paper white; the label carries the colour. */
  value: '#ffffff',
  /** Live numbers — the amber-green of a segment display. */
  readout: '#ffe14d',
  /** Anything present but not currently mattering. */
  dim: '#c9cddb',
} as const

/**
 * The era's whole legibility system: a solid black offset, no blur. Blur is a
 * soft light source; an offset is ink. On a bright daylight scene the hard
 * edge is also simply what survives — a soft shadow vanishes into a white
 * horizon and takes the text with it.
 */
// The offset alone was not enough. The reference HUDs were set in fat display
// faces whose strokes could carry a bare drop shadow; this HUD face is a thin
// bitmap recreation, and over a white horizon its hairline strokes dissolved.
// A four-direction outline inks the letterform's whole edge first, and the
// offset then does what it always did — lifts the text off the picture.
const OUTLINE = '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000'
const HARD_SHADOW_SMALL = { textShadow: `${OUTLINE}, 2px 2px 0 rgba(0,0,0,0.92)` } as const
const HARD_SHADOW_LARGE = { textShadow: `${OUTLINE}, 3px 3px 0 rgba(0,0,0,0.92)` } as const

/** Splits shown in the lap-time block. Three, as the reference does. */
const VISIBLE_SPLITS = 3
/** Height of the console bar. Fixed: instrumentation does not reflow. */
const BAR_HEIGHT = 156

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
}

/**
 * "JACK'S RACER", but "CHRIS' RACER" — a trailing s takes a bare apostrophe.
 * Cheap to get right and conspicuous when wrong on a wall-sized screen.
 */
function possessive(name: string): string {
  const upper = name.toUpperCase()
  return upper.endsWith('S') ? `${upper}'` : `${upper}'S`
}

/**
 * The last three completed laps, oldest first, padded with empty rows.
 *
 * Padding rather than truncating is the point: the block is three lines tall
 * from the first frame, so the bar never grows a row underneath the driver's
 * eye once the third lap lands.
 */
function recentSplits(lapTimes: ReadonlyArray<number>): ReadonlyArray<number | null> {
  const tail = lapTimes.slice(-VISIBLE_SPLITS)
  const padding = Array.from({ length: VISIBLE_SPLITS - tail.length }, () => null)
  return [...tail, ...padding]
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
}: RaceHudProps): React.ReactElement {
  const leader = racers[0]
  const shotKind = activeShot?.kind ?? null
  // The ident names whoever the camera is on, whether the director chose them
  // or the viewer did — the label underneath is what says which.
  const povName =
    shotKind === 'onboard' || shotKind === 'follow' ? (activeShot?.name ?? null) : null
  const povColor = activeShot?.color ?? PS1.cyan
  const isManual = shotKind === 'follow' || shotKind === 'free'

  // The instruments read the car the camera is on. That is what a race HUD
  // is: the telemetry of whoever you are watching. It falls back to the
  // leader during a trackside or replay shot, because a dead dial reads as a
  // broken screen rather than as "no subject".
  const subject = racers.find((racer) => racer.key === activeShot?.racerKey) ?? leader
  const splits = recentSplits(subject?.lapTimes ?? [])
  const burnRate = subject?.velocityTokensPerMin ?? 0

  const chips: ReadonlyArray<StatusChip> = [
    {
      id: 'live',
      // Single ASCII capitals, not pictographs. The HUD face is a bitmap
      // recreation with no symbol coverage, so a glyph outside its set falls
      // back to a different font at a different weight — a lamp that changes
      // typeface when it lights is worse than no lamp.
      glyph: 'B',
      lit: subject?.isActive ?? false,
      color: PS1.green,
      title: 'Burning — subject is spending tokens right now',
    },
    {
      id: 'auto',
      glyph: 'A',
      lit: !isManual,
      color: GT.label,
      title: 'Camera on the automatic director',
    },
    {
      id: 'flag',
      glyph: 'L',
      lit: (subject?.lapTimes.length ?? 0) > 0,
      color: PS1.cyan,
      title: 'Lap logged — at least one completed lap on the board',
    },
  ]

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
      {/* Stage ident. Floating type with a hard shadow, not a boxed plate —
          the reference racers put nothing behind their HUD text but the
          picture, and got their legibility from a solid black offset instead.
          The two-colour, two-size stack (small saturated label over a big
          white value) is the era's whole typographic system in one lockup. */}
      <div style={{ position: 'absolute', top: '14px', left: '20px', ...HARD_SHADOW_SMALL }}>
        <div
          className="gt-label"
          style={{
            fontSize: `${PS1_TYPE.label}px`,
            color: RR.label,
            letterSpacing: '0.14em',
          }}
        >
          Stage 01
        </div>
        <div
          className="gt-label"
          style={{
            fontSize: `${PS1_TYPE.display - 14}px`,
            color: RR.value,
            letterSpacing: '0.04em',
            marginTop: '2px',
            ...HARD_SHADOW_LARGE,
          }}
        >
          {trackTitle}
        </div>
      </div>

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
          {/* The leaderboard. Rebuilt to the reference racers' system:
              nothing behind the text, hierarchy carried entirely by size and
              colour, contrast carried entirely by a hard black offset shadow.
              The rank numeral is the big saturated element (gold for the
              leader, white for the field, the driver's own colour when the
              camera is on them), the name is white value-text beside it, and
              the score sits in the era's readout yellow. The leader's row is
              simply *larger* — which is the entire way those games said
              "this one matters" — and no row has a box, a plate, or a rule. */}
          <div
            style={{
              position: 'absolute',
              left: '20px',
              top: '84px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            {racers.map((racer, index) => {
              const isPov = activeShot?.racerKey === racer.key
              const isLeader = index === 0
              const rankColor = isPov ? racer.color : isLeader ? RR.gold : RR.value
              const rowSize = isLeader ? PS1_TYPE.title : PS1_TYPE.body
              return (
                <div
                  key={racer.key}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: '10px',
                    minWidth: '300px',
                  }}
                >
                  <span
                    className="gt-label"
                    style={{
                      width: '2.4ch',
                      textAlign: 'right',
                      fontSize: `${rowSize + 6}px`,
                      fontVariantNumeric: 'tabular-nums',
                      color: rankColor,
                      ...HARD_SHADOW_LARGE,
                    }}
                  >
                    {index + 1}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontSize: `${rowSize}px`,
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      color: RR.value,
                      opacity: isLeader || isPov ? 1 : 0.88,
                      ...HARD_SHADOW_SMALL,
                    }}
                    title={racer.name}
                  >
                    {racer.name}
                  </span>
                  <span
                    className="gt-label"
                    style={{
                      fontSize: `${Math.max(PS1_TYPE.label, rowSize - 4)}px`,
                      fontVariantNumeric: 'tabular-nums',
                      color: racer.isActive ? RR.readout : RR.dim,
                      ...HARD_SHADOW_SMALL,
                    }}
                  >
                    {fmtTokensShort(racer.score)}
                  </span>
                </div>
              )
            })}
          </div>

          {/* POV ident. Only present during an onboard shot, and keyed on the
              name so switching subject replays the entrance rather than
              silently swapping the text. */}
          <AnimatePresence mode="wait">
            {povName && (
              <motion.div
                key={povName}
                initial={{ opacity: 0, x: -14 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 8 }}
                transition={{ duration: 0.22, ease: 'easeOut' }}
                style={{
                  position: 'absolute',
                  left: '18px',
                  bottom: `${BAR_HEIGHT + 14}px`,
                }}
              >
                <span
                  className="gt-ident"
                  style={{ boxShadow: `inset 0 1px 0 0 ${povColor}`, borderLeft: `3px solid ${povColor}` }}
                >
                  <span
                    className="gt-label"
                    style={{ fontSize: `${PS1_TYPE.title}px`, color: povColor }}
                  >
                    {possessive(povName)} Racer
                  </span>
                  <span
                    className="gt-label"
                    style={{ fontSize: `${PS1_TYPE.micro}px`, color: GT.valueDim, marginLeft: '12px' }}
                  >
                    {shotKind === 'follow' ? 'Following' : 'Onboard'}
                  </span>
                </span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Camera state. Present only once the viewer has taken the camera
              off the director, and carrying the way back — a wall-mounted
              deck has no Esc key within reach. */}
          <AnimatePresence>
            {isManual && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                style={{
                  position: 'absolute',
                  bottom: `${BAR_HEIGHT + 14}px`,
                  right: '18px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                }}
              >
                <span className="gt-ident">
                  <span
                    className="gt-label"
                    style={{ fontSize: `${PS1_TYPE.label}px`, color: PS1.cyan }}
                  >
                    {shotKind === 'free' ? 'Free camera' : 'Manual camera'}
                  </span>
                </span>
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
                  Esc — resume broadcast
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* ============================================================
              THE CONSOLE BAR
          ============================================================ */}
          <div
            className="gt-bar"
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: `${BAR_HEIGHT}px`,
              display: 'flex',
              alignItems: 'center',
              gap: '20px',
              padding: '0 24px',
            }}
          >
            {/* LAP TIME + TOTAL TIME */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '210px' }}>
              <HudLabel size={16}>Lap time</HudLabel>
              {splits.map((split, index) => (
                <div
                  key={`split-${index}`}
                  style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}
                >
                  <HudValue size={16} dim>
                    {index + 1}:
                  </HudValue>
                  {/* The most recent completed lap is the one being compared
                      against, so it carries the gold — everything else is a
                      reference value and stays white. */}
                  <HudValue
                    size={17}
                    dim={split === null}
                    highlight={
                      split !== null && index === splits.filter((s) => s !== null).length - 1
                        ? GT.label
                        : null
                    }
                  >
                    {formatLapTime(split)}
                  </HudValue>
                </div>
              ))}
              <div style={{ marginTop: '6px' }}>
                <HudLabel size={16}>Total time</HudLabel>
              </div>
              <HudValue size={19}>{formatLapTime(subject?.totalClock ?? null)}</HudValue>
            </div>

            <span className="gt-divider" />

            {/* Circuit map */}
            <Minimap racersRef={racersRef} focusKey={activeShot?.racerKey ?? null} />

            <span className="gt-divider" />

            {/* Lamps and the lap odometer, stacked on the centre line. */}
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '10px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                <StatusCluster chips={chips} />
                {/* The speaker. A real button among the lamps, because sound
                    is the one instrument the viewer operates — and the click
                    that lights it is also what the browser requires before an
                    AudioContext may make any noise at all. */}
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
                  SND
                </button>
              </div>
              <ChromeCounter value={subject?.lap ?? 0} suffix="Lap" />
              <span
                className="gt-label"
                style={{ fontSize: '11px', color: GT.valueDim }}
              >
                {fmtTokensShort(racers.reduce((sum, racer) => sum + racer.score, 0))} tokens today
              </span>
            </div>

            <span className="gt-divider" />

            {/* Gear and speed. Speed is the honest one: tokens per minute. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <HudLabel size={15}>Gear</HudLabel>
                <GearBox gear={burnRateToGear(burnRate)} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <HudLabel size={15}>Speed</HudLabel>
                <LcdReadout value={burnRate} unit="t/m" digits={5} size={26} />
              </div>
            </div>

            <Tachometer value={burnRate} caption="×5k tokens/min" size={124} />
          </div>
        </>
      )}
    </div>
  )
}
