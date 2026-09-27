'use client'

import { useMemo } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { fmtTokensShort } from '@/lib/formatters'
import { isCpuKey } from '@/lib/cpuRoster'
import { ARCADE, FONTS, GT, PS1, PS1_TYPE } from '../../ps1/theme'
import { SCALED_SURFACE } from '../../ps1/hudScale'
import { Tachometer } from '../../ps1/gtHud'
import type { DogfightEventLine, PlaneMode } from './useDogfightSim'

// CH 03's furniture, in the register of the arcade flight games: a gold
// score block top-left that counts what the camera's subject is doing —
// score, multikill, hit, combo — a tally of crossed-out silhouettes for
// their kills top-right, the patrol roster under it the way the race keeps
// its tower, an altimeter under the score and an airspeed dial with the
// airframe bar in the bottom corner, and a gunsight pinned to whichever
// plane the subject is chasing (drawn by the scene, which knows where it is). The legibility system is the cabinet's one
// system: outlines and hard offsets, nothing in a box, no blur.
//
// The dials are the race's own tachometer redressed — same rim, face and
// needle — because a cabinet with two kinds of instrument is two cabinets.

const OUTLINE = '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000'
const INK_SMALL = { textShadow: `${OUTLINE}, 2px 2px 0 rgba(0,0,0,0.92)` } as const

/** The announcement chrome, shared vocabulary with the fight channel. */
const ANNOUNCE_RAMP =
  'linear-gradient(#ffe9a8 0%, #ffb020 44%, #ff5a1a 46%, #d21f1f 100%)'
/** The score block's gold: the arcade flight games' one colour for figures. */
const SCORE_RAMP = 'linear-gradient(#fff2b0 0%, #ffc63a 48%, #d98a00 52%, #ffb020 100%)'
const SCORE_SKEW = 'skewX(-8deg)'

/** World units of airspeed to miles per hour, and altitude to angels. */
const MPH_PER_UNIT = 17
const AIRSPEED_FULL_SCALE_MPH = 400
/** One angel is a thousand feet; a world unit of altitude reads as one. */
const ANGELS_PER_UNIT = 1
const ALTIMETER_FULL_SCALE = 20
const DIAL_SIZE = 96

/** Points per event, as the arcade board would print them. */
const HIT_POINTS = 250
const CRIT_POINTS = 750
const MULTIKILL_POINTS = 1000
/** How long a hit and a multikill line stay lit after the event. */
const HIT_HOLD_MS = 1600
const MULTIKILL_HOLD_MS = 8000
/** Silhouettes per row in the tally, and the most it ever draws. */
const TALLY_ROW = 5
const TALLY_MAX = 10

export interface HudPilot {
  readonly key: string
  readonly name: string
  readonly color: string
  readonly hpFrac: number
  readonly kills: number
  readonly burnRate: number
  readonly mode: PlaneMode
  readonly rank: number
}

/** The plane the camera is on, and what its guns have been doing. */
export interface HudSubject {
  readonly key: string
  readonly name: string
  readonly rank: number
  readonly score: number
  readonly hpFrac: number
  readonly kills: number
  readonly mode: PlaneMode
  /** World units per second and above the fields. */
  readonly speed: number
  readonly altitude: number
  /** Kills inside the multikill window, and when the last landed. */
  readonly multikill: number
  readonly lastKillAt: number
  /** Consecutive bursts without a gap, and when the last one landed. */
  readonly combo: number
  readonly lastHitAt: number
  readonly lastHitCrit: boolean
}

export interface DogfightHudSnapshot {
  readonly pilots: ReadonlyArray<HudPilot>
  readonly events: ReadonlyArray<DogfightEventLine>
  readonly subject: HudSubject | null
}

interface DogfightHudProps {
  readonly snapshot: DogfightHudSnapshot | null
  readonly paused: boolean
  /** Opens a pilot's hangar. The roster is the only way in. */
  readonly onOpenHangar: (pilotKey: string) => void
  /** Rides with a pilot: the camera takes their tail. Null when nobody's. */
  readonly followKey: string | null
  /** Picks a pilot to ride with, or the same one again to let go. */
  readonly onFollow: (pilotKey: string) => void
  /** The signed-in pilot, whose row opens the hangar instead. */
  readonly myKey: string | null
}

const MODE_WORD: Readonly<Record<PlaneMode, string>> = {
  patrol: '',
  pursuit: 'ENGAGED',
  down: 'GOING DOWN',
  respawn: 'SCRAMBLING',
}

function PilotRow({
  pilot,
  position,
  onOpen,
  followed,
  mine,
}: {
  readonly pilot: HudPilot
  readonly position: number
  readonly onOpen: () => void
  /** The camera is on this pilot's tail. */
  readonly followed: boolean
  /** The signed-in pilot's own row: it opens the hangar, not the camera. */
  readonly mine: boolean
}): React.ReactElement {
  const modeWord = MODE_WORD[pilot.mode]
  return (
    <button
      type="button"
      onClick={onOpen}
      title={mine ? `Hangar — ${pilot.name}` : `Ride with ${pilot.name} — or press ${position}`}
      className="gt-tower-row arc-tower-row"
      style={{
        outline: followed ? `2px solid ${GT.label}` : 'none',
        outlineOffset: '2px',
        // The one thing on the HUD that takes the pointer: a row is the way
        // into the hangar, exactly as the race's tower row is the way into
        // the paint shop.
        pointerEvents: 'auto',
        border: 'none',
        padding: 0,
        background: 'none',
        font: 'inherit',
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        height: '26px',
      }}
    >
      <span
        className="gt-label"
        style={{
          width: '3ch',
          fontSize: `${PS1_TYPE.label}px`,
          color: GT.valueDim,
          ...INK_SMALL,
        }}
      >
        P{position}
      </span>
      <span
        style={{
          width: '10px',
          height: '10px',
          background: pilot.color,
          boxShadow: `1px 1px 0 ${ARCADE.outline}`,
          flex: '0 0 auto',
        }}
      />
      <span
        className="gt-label"
        style={{
          fontSize: `${PS1_TYPE.label}px`,
          color: pilot.mode === 'down' ? GT.valueDim : ARCADE.value,
          minWidth: '9ch',
          ...INK_SMALL,
        }}
      >
        {pilot.name}
      </span>
      {/* A CPU pilot wears the word, in the dim register the down state uses. */}
      {isCpuKey(pilot.key) && (
        <span
          className="gt-label"
          style={{ fontSize: `${PS1_TYPE.micro}px`, color: GT.valueDim, ...INK_SMALL }}
        >
          CPU
        </span>
      )}
      {/* The airframe: a short bar, teal over red, framed hard. */}
      <span
        style={{
          width: '64px',
          height: '8px',
          background: ARCADE.label,
          boxShadow: `0 0 0 1px #e8e8f0, 2px 2px 0 rgba(0,0,0,0.8)`,
          position: 'relative',
          overflow: 'hidden',
          flex: '0 0 auto',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            width: `${Math.min(1, Math.max(0, pilot.hpFrac)) * 100}%`,
            background: PS1.cyan,
          }}
        />
      </span>
      <span
        className="gt-label"
        style={{ fontSize: `${PS1_TYPE.micro}px`, color: GT.label, minWidth: '4ch', ...INK_SMALL }}
      >
        {pilot.kills > 0 ? `✕${pilot.kills}` : ''}
      </span>
      {modeWord !== '' && (
        <span
          className="gt-label"
          style={{
            fontSize: `${PS1_TYPE.micro}px`,
            color: pilot.mode === 'down' ? ARCADE.label : ARCADE.amber,
            ...INK_SMALL,
          }}
        >
          {modeWord}
        </span>
      )}
    </button>
  )
}

// --- The score block ---------------------------------------------------------

/** A gold figure in the arcade flight register: leaning, ramped, outlined. */
function GoldFigure({ children, size }: { readonly children: React.ReactNode; readonly size: number }): React.ReactElement {
  return (
    <span
      style={{
        display: 'inline-block',
        fontFamily: FONTS.codec,
        fontSize: `${size}px`,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '0.08em',
        transform: SCORE_SKEW,
        backgroundImage: SCORE_RAMP,
        backgroundClip: 'text',
        WebkitBackgroundClip: 'text',
        color: 'transparent',
        filter: `drop-shadow(1px 1px 0 ${ARCADE.outline}) drop-shadow(-1px -1px 0 ${ARCADE.outline}) drop-shadow(2px 3px 0 rgba(0,0,0,0.9))`,
      }}
    >
      {children}
    </span>
  )
}

function ScoreLine({
  label,
  color,
  value,
  multiplier,
  lit,
}: {
  readonly label: string
  readonly color: string
  readonly value: string
  readonly multiplier?: number
  readonly lit: boolean
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: '12px',
        opacity: lit ? 1 : 0.28,
        transition: 'opacity 240ms step-end',
      }}
    >
      <span
        className="gt-label"
        style={{ width: '9ch', fontSize: `${PS1_TYPE.micro}px`, color, ...INK_SMALL }}
      >
        {label}
      </span>
      <GoldFigure size={PS1_TYPE.label}>{value}</GoldFigure>
      {multiplier !== undefined && multiplier > 1 && (
        <span
          className="gt-label"
          style={{ fontSize: `${PS1_TYPE.micro}px`, color: ARCADE.amber, ...INK_SMALL }}
        >
          x{multiplier}
        </span>
      )}
    </div>
  )
}

/** Three stars for the leader, two for the podium, one for the rest. */
function starsFor(rank: number): number {
  if (rank <= 1) return 3
  if (rank <= 3) return 2
  return 1
}

function ScoreBlock({ subject, now }: { readonly subject: HudSubject; readonly now: number }): React.ReactElement {
  const hitLit = now - subject.lastHitAt < HIT_HOLD_MS
  const multikillLit = subject.multikill >= 2 && now - subject.lastKillAt < MULTIKILL_HOLD_MS
  const comboLit = hitLit && subject.combo >= 2
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ color: GT.label, fontSize: `${PS1_TYPE.micro}px`, letterSpacing: '0.1em', ...INK_SMALL }}>
          {'★'.repeat(starsFor(subject.rank))}
        </span>
        <span
          className="gt-label"
          style={{ fontSize: `${PS1_TYPE.label}px`, color: ARCADE.value, ...INK_SMALL }}
        >
          {subject.name}
        </span>
      </div>
      <GoldFigure size={PS1_TYPE.title + 4}>{fmtTokensShort(Math.round(subject.score))}</GoldFigure>
      <ScoreLine
        label="Multikill"
        color={PS1.green}
        value={String(MULTIKILL_POINTS)}
        multiplier={subject.multikill}
        lit={multikillLit}
      />
      <ScoreLine
        label="Hit"
        color={PS1.cyan}
        value={String(subject.lastHitCrit ? CRIT_POINTS : HIT_POINTS)}
        lit={hitLit}
      />
      <ScoreLine
        label="Combo"
        color={GT.label}
        value={String(HIT_POINTS)}
        multiplier={subject.combo}
        lit={comboLit}
      />
    </div>
  )
}

// --- The tally -----------------------------------------------------------------

/** A plane in plan, nose up, crossed out in red. The arcade kill tally. */
function TallyGlyph(): React.ReactElement {
  return (
    <svg width="26" height="18" viewBox="0 0 26 18" aria-hidden style={{ display: 'block', filter: 'drop-shadow(1px 1px 0 #000)' }}>
      <path d="M13 1 L15 6 L25 9 L25 11 L15 10 L14 15 L17 17 L9 17 L12 15 L11 10 L1 11 L1 9 L11 6 Z" fill={GT.dialTick} />
      <line x1="3" y1="16" x2="23" y2="2" stroke={ARCADE.label} strokeWidth="3" />
    </svg>
  )
}

function KillTally({ kills }: { readonly kills: number }): React.ReactElement {
  const shown = Math.min(TALLY_MAX, kills)
  const rows = Math.max(1, Math.ceil(shown / TALLY_ROW))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {Array.from({ length: rows }, (_, row) => (
          <div key={row} style={{ display: 'flex', gap: '3px', justifyContent: 'flex-end' }}>
            {Array.from({ length: Math.min(TALLY_ROW, shown - row * TALLY_ROW) }, (_, index) => (
              <TallyGlyph key={index} />
            ))}
          </div>
        ))}
      </div>
      {/* The count, on a steel roundel — the same metal as the gear box. */}
      <span
        style={{
          width: '34px',
          height: '34px',
          borderRadius: '50%',
          background: GT.metalFace,
          boxShadow: `inset 2px 2px 0 ${GT.metalHi}, inset -2px -2px 0 ${GT.metalLo}, 0 0 0 2px #000`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: FONTS.codec,
          fontSize: `${PS1_TYPE.label}px`,
          color: GT.value,
          ...INK_SMALL,
        }}
      >
        {kills}
      </span>
    </div>
  )
}

// --- Instruments ---------------------------------------------------------------

function polar(cx: number, cy: number, radius: number, degrees: number): readonly [number, number] {
  const radians = ((degrees - 90) * Math.PI) / 180
  return [cx + radius * Math.cos(radians), cy + radius * Math.sin(radians)]
}

/**
 * The altimeter: a full-circle dial in the tachometer's dress, ten marks
 * round the face, the needle counting angels. Full circle rather than the
 * tacho's sweep because that is how the instrument is drawn and read.
 */
function Altimeter({ angels }: { readonly angels: number }): React.ReactElement {
  const centre = 60
  const divisions = 10
  const fraction = Math.max(0, Math.min(1, angels / ALTIMETER_FULL_SCALE))
  const needleAngle = fraction * 360
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
      <svg width={DIAL_SIZE} height={DIAL_SIZE} viewBox="0 0 120 120" role="img" aria-label="Altimeter" style={{ display: 'block' }}>
        <circle cx={centre} cy={centre} r={57} fill={GT.dialRim} />
        <circle cx={centre} cy={centre} r={53} fill={GT.dialFace} />
        {Array.from({ length: divisions }, (_, index) => {
          const angle = (index / divisions) * 360
          const [x1, y1] = polar(centre, centre, 46, angle)
          const [x2, y2] = polar(centre, centre, 38, angle)
          const [lx, ly] = polar(centre, centre, 29, angle)
          return (
            <g key={index}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={GT.dialTick} strokeWidth={2.5} />
              <text x={lx} y={ly + 4} textAnchor="middle" fill={GT.dialTick} fontFamily={FONTS.hud} fontSize={12}>
                {index * 2}
              </text>
            </g>
          )
        })}
        <g className="gt-needle" style={{ transform: `translate(60px, 60px) rotate(${needleAngle}deg)` }}>
          <polygon points="-3,2 3,2 1,-40 -1,-40" fill={GT.needle} />
        </g>
        <circle cx={centre} cy={centre} r={7} fill={GT.metalFace} stroke={GT.metalHi} strokeWidth={2} />
      </svg>
      <span className="gt-label" style={{ fontFamily: FONTS.hud, fontSize: '12px', color: GT.valueDim }}>
        Altitude
      </span>
    </span>
  )
}

/** The airframe as a segmented green bar — the arcade game's health. */
function AirframeBar({ fraction }: { readonly fraction: number }): React.ReactElement {
  const segments = 12
  const lit = Math.round(Math.min(1, Math.max(0, fraction)) * segments)
  return (
    <span
      style={{
        display: 'flex',
        gap: '2px',
        padding: '3px',
        background: ARCADE.ground,
        boxShadow: `0 0 0 1px ${GT.metalHi}, 2px 2px 0 rgba(0,0,0,0.8)`,
      }}
    >
      {Array.from({ length: segments }, (_, index) => (
        <span
          key={index}
          style={{
            width: '8px',
            height: '10px',
            background: index < lit ? (fraction < 0.3 ? ARCADE.label : ARCADE.telemetry) : ARCADE.telemetryBed,
          }}
        />
      ))}
    </span>
  )
}

/**
 * The gunsight: a diamond and a bead, amber. Drawn by the scene over the
 * plane the subject is actually chasing — see TargetSight — not parked in
 * the middle of the picture, where it was a shape with no referent.
 */
export function Gunsight(): React.ReactElement {
  const sprite = useMemo(() => gunsightSprite(), [])
  return (
    <div
      aria-hidden
      style={{
        width: `${GUNSIGHT_TEXELS * GUNSIGHT_SCALE}px`,
        height: `${GUNSIGHT_TEXELS * GUNSIGHT_SCALE}px`,
        backgroundImage: sprite ? `url(${sprite})` : undefined,
        backgroundSize: '100% 100%',
        imageRendering: 'pixelated',
      }}
    />
  )
}

/** The sight's page: a diamond ring, a bead, four ticks, all one texel wide. */
const GUNSIGHT_TEXELS = 17
/** Drawn at four screen pixels a texel: the era's sprite, magnified, not vectorised. */
const GUNSIGHT_SCALE = 4
/** The centre texel; the page is odd-sized so there is one. */
const GUNSIGHT_CENTRE = 8
/** Manhattan radius of the diamond, of the bead, and where the ticks run. */
const GUNSIGHT_RING = 7
const GUNSIGHT_BEAD = 2
const GUNSIGHT_TICKS: ReadonlyArray<number> = [4, 5]
let gunsightSpriteUrl: string | null = null

/**
 * Paints the sight once, at texel size, and hands back a data URL. Painted
 * rather than drawn as SVG: a stroked polygon anti-aliases into greys at
 * the edges, and a sight is the one mark on the HUD that must be a hard
 * shape. Every texel is either gold, its black ink, or nothing — and every
 * line is exactly one texel wide, which is what keeps it a sight and not a
 * badge.
 */
function gunsightSprite(): string | null {
  if (gunsightSpriteUrl !== null) return gunsightSpriteUrl
  if (typeof document === 'undefined') return null
  const size = GUNSIGHT_TEXELS
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const lit = new Set<string>()
  const light = (x: number, y: number): void => {
    lit.add(`${x},${y}`)
  }
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const ring = Math.abs(x - GUNSIGHT_CENTRE) + Math.abs(y - GUNSIGHT_CENTRE)
      if (ring === GUNSIGHT_RING || ring === GUNSIGHT_BEAD) light(x, y)
    }
  }
  for (const step of GUNSIGHT_TICKS) {
    light(GUNSIGHT_CENTRE, GUNSIGHT_CENTRE - step)
    light(GUNSIGHT_CENTRE, GUNSIGHT_CENTRE + step)
    light(GUNSIGHT_CENTRE - step, GUNSIGHT_CENTRE)
    light(GUNSIGHT_CENTRE + step, GUNSIGHT_CENTRE)
  }
  // Ink: every empty texel below or right of a lit one — a dropped shadow,
  // one texel, the way the HUD's type is inked.
  ctx.fillStyle = '#000'
  for (const key of lit) {
    const [x, y] = key.split(',').map(Number)
    if (!lit.has(`${x + 1},${y + 1}`)) ctx.fillRect(x + 1, y + 1, 1, 1)
  }
  ctx.fillStyle = GT.label
  for (const key of lit) {
    const [x, y] = key.split(',').map(Number)
    ctx.fillRect(x, y, 1, 1)
  }
  gunsightSpriteUrl = canvas.toDataURL('image/png')
  return gunsightSpriteUrl
}

// --- The HUD -------------------------------------------------------------------

export function DogfightHud({ snapshot, paused, onOpenHangar, followKey, onFollow, myKey }: DogfightHudProps): React.ReactElement {
  const now = Date.now()
  // The kill feed's newest line doubles as the announcement — briefly. An
  // announcement that stays up is furniture.
  const headline = snapshot?.events.find(
    (line) => (line.tone === 'kill' || line.tone === 'crit') && now - line.at < 3800,
  )
  const subject = snapshot?.subject ?? null

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 3,
        pointerEvents: 'none',
        fontFamily: FONTS.hud,
        ...SCALED_SURFACE,
      }}
    >
      {/* Top-left: the score block for whoever the camera is on, and the
          altimeter under it. */}
      <div style={{ position: 'absolute', top: '14px', left: '18px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {subject ? (
          <ScoreBlock subject={subject} now={now} />
        ) : (
          <span className="gt-label" style={{ fontSize: `${PS1_TYPE.title}px`, color: GT.label, ...INK_SMALL }}>
            Squadron Patrol
          </span>
        )}
        {subject && (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '10px' }}>
            <Altimeter angels={subject.altitude * ANGELS_PER_UNIT} />
            <span
              style={{
                marginBottom: '18px',
                fontFamily: FONTS.codec,
                fontSize: `${PS1_TYPE.label}px`,
                color: GT.lcd,
                ...INK_SMALL,
              }}
            >
              ANGELS {Math.max(0, Math.round(subject.altitude * ANGELS_PER_UNIT))}
            </span>
          </div>
        )}
      </div>

      {/* Top-right: the subject's tally, then the roster under it. */}
      <div
        style={{
          position: 'absolute',
          right: '18px',
          top: '14px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: '10px',
        }}
      >
        {subject && subject.kills > 0 && <KillTally kills={subject.kills} />}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          {(snapshot?.pilots ?? []).map((pilot, index) => (
            <PilotRow
              key={pilot.key}
              pilot={pilot}
              position={index + 1}
              followed={followKey === pilot.key}
              mine={myKey !== null && pilot.key === myKey}
              onOpen={() => (myKey !== null && pilot.key === myKey ? onOpenHangar(pilot.key) : onFollow(pilot.key))}
            />
          ))}
        </div>
      </div>

      {/* Kill announcements, centre picture, in the house chrome. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <AnimatePresence>
          {headline && (
            <motion.span
              key={headline.id}
              className="gt-label"
              initial={{ opacity: 0, scale: 1.5 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              style={{
                fontSize: `${PS1_TYPE.title + 10}px`,
                letterSpacing: '0.1em',
                textAlign: 'center',
                backgroundImage: ANNOUNCE_RAMP,
                backgroundClip: 'text',
                WebkitBackgroundClip: 'text',
                color: 'transparent',
                filter: `drop-shadow(2px 2px 0 ${ARCADE.outline}) drop-shadow(-1px -1px 0 ${ARCADE.outline}) drop-shadow(3px 4px 0 rgba(0,0,0,0.85))`,
              }}
            >
              {headline.text}
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {/* Bottom-right: the airframe bar, the airspeed dial and its readout. */}
      {subject && (
        <div
          style={{
            position: 'absolute',
            right: '18px',
            bottom: '16px',
            display: 'flex',
            alignItems: 'flex-end',
            gap: '12px',
          }}
        >
          <span style={{ marginBottom: '22px' }}>
            <AirframeBar fraction={subject.hpFrac} />
          </span>
          <Tachometer
            value={subject.speed * MPH_PER_UNIT}
            fullScale={AIRSPEED_FULL_SCALE_MPH}
            caption="Airspeed"
            size={DIAL_SIZE}
            live={subject.mode !== 'down' && subject.mode !== 'respawn'}
          />
          <span
            style={{
              marginBottom: '18px',
              fontFamily: FONTS.codec,
              fontSize: `${PS1_TYPE.label}px`,
              color: GT.lcd,
              ...INK_SMALL,
            }}
          >
            {Math.round(subject.speed * MPH_PER_UNIT)} <span style={{ fontSize: `${PS1_TYPE.micro}px` }}>mph</span>
          </span>
        </div>
      )}

      {paused && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(4, 4, 10, 0.35)' }} />
      )}
    </div>
  )
}
