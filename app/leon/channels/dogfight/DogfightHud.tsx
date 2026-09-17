'use client'

import { AnimatePresence, motion } from 'motion/react'
import { fmtTokensShort } from '@/lib/formatters'
import { ARCADE, FONTS, GT, PS1, PS1_TYPE } from '../../ps1/theme'
import { SCALED_SURFACE } from '../../ps1/hudScale'
import type { DogfightEventLine, PlaneMode } from './useDogfightSim'

// CH 03's furniture: squadron ident top-left, the patrol roster down the
// right the way the race keeps its tower, kill announcements in the middle,
// the camera's subject named bottom-left. The register is the gun-camera
// frame, not the arcade board — but the legibility system is the cabinet's
// one system: outlines and hard offsets, nothing in a box, no blur.

const OUTLINE = '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000'
const INK_SMALL = { textShadow: `${OUTLINE}, 2px 2px 0 rgba(0,0,0,0.92)` } as const
const INK_LARGE = { textShadow: `${OUTLINE}, 3px 3px 0 rgba(0,0,0,0.92)` } as const

/** The announcement chrome, shared vocabulary with the fight channel. */
const ANNOUNCE_RAMP =
  'linear-gradient(#ffe9a8 0%, #ffb020 44%, #ff5a1a 46%, #d21f1f 100%)'

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

export interface DogfightHudSnapshot {
  readonly pilots: ReadonlyArray<HudPilot>
  readonly events: ReadonlyArray<DogfightEventLine>
  readonly cameraSubject: string | null
}

interface DogfightHudProps {
  readonly snapshot: DogfightHudSnapshot | null
  readonly paused: boolean
}

const MODE_WORD: Readonly<Record<PlaneMode, string>> = {
  patrol: '',
  pursuit: 'ENGAGED',
  down: 'GOING DOWN',
  respawn: 'SCRAMBLING',
}

function PilotRow({ pilot, position }: { readonly pilot: HudPilot; readonly position: number }): React.ReactElement {
  const modeWord = MODE_WORD[pilot.mode]
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', height: '26px' }}>
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
    </div>
  )
}

export function DogfightHud({ snapshot, paused }: DogfightHudProps): React.ReactElement {
  // The kill feed's newest line doubles as the announcement — briefly. An
  // announcement that stays up is furniture.
  const headline = snapshot?.events.find(
    (line) =>
      (line.tone === 'kill' || line.tone === 'crit') && Date.now() - line.at < 3800,
  )

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
      {/* Squadron ident. */}
      <div style={{ position: 'absolute', top: '14px', left: '18px' }}>
        <span
          className="gt-label"
          style={{ fontSize: `${PS1_TYPE.title}px`, color: GT.label, ...INK_SMALL }}
        >
          Squadron Patrol
        </span>
        <span
          className="gt-label"
          style={{
            display: 'block',
            fontSize: `${PS1_TYPE.micro}px`,
            color: GT.valueDim,
            marginTop: '2px',
            ...INK_SMALL,
          }}
        >
          Angels one-five · over Kent
        </span>
      </div>

      {/* The patrol roster, down the right like the race's tower. */}
      <div
        style={{
          position: 'absolute',
          right: '18px',
          top: '58px',
          display: 'flex',
          flexDirection: 'column',
          gap: '3px',
        }}
      >
        {(snapshot?.pilots ?? []).map((pilot, index) => (
          <PilotRow key={pilot.key} pilot={pilot} position={index + 1} />
        ))}
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

      {/* Foot: whose wing the camera is on, and the quieter half of the feed. */}
      <div
        style={{
          position: 'absolute',
          left: '18px',
          right: '18px',
          bottom: '16px',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: '20px',
        }}
      >
        <span
          className="gt-label"
          style={{ fontSize: `${PS1_TYPE.micro}px`, color: GT.valueDim, minWidth: '200px', ...INK_SMALL }}
        >
          {snapshot?.cameraSubject !== null && snapshot?.cameraSubject !== undefined ? (
            <>
              <span style={{ color: GT.label }}>Camera</span> {snapshot.cameraSubject}
            </>
          ) : (
            <>
              <span style={{ color: GT.label }}>Camera</span> patrol wide
            </>
          )}
        </span>

        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '3px',
          }}
        >
          {(snapshot?.events ?? []).slice(0, 2).map((line) => (
            <span
              key={line.id}
              className="gt-label"
              style={{
                fontSize: `${PS1_TYPE.micro}px`,
                color:
                  line.tone === 'crit'
                    ? ARCADE.amber
                    : line.tone === 'kill'
                      ? ARCADE.label
                      : GT.valueDim,
                ...INK_SMALL,
              }}
            >
              {line.text}
            </span>
          ))}
        </div>

        {/* The hottest throttle in the air right now. */}
        <span
          className="gt-label"
          style={{
            fontSize: `${PS1_TYPE.micro}px`,
            color: GT.valueDim,
            minWidth: '200px',
            textAlign: 'right',
            ...INK_SMALL,
          }}
        >
          {snapshot && snapshot.pilots.length > 0 && (
            <TopThrottle pilots={snapshot.pilots} />
          )}
        </span>
      </div>

      {paused && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(4, 4, 10, 0.35)' }} />
      )}
    </div>
  )
}

function TopThrottle({ pilots }: { readonly pilots: ReadonlyArray<HudPilot> }): React.ReactElement {
  const hottest = pilots.reduce((best, pilot) =>
    pilot.burnRate > best.burnRate ? pilot : best,
  )
  return (
    <>
      <span style={{ color: GT.label }}>Full boost</span>{' '}
      <span style={{ color: ARCADE.value }}>{hottest.name}</span>{' '}
      <span style={{ color: ARCADE.telemetry }}>
        {fmtTokensShort(Math.round(hottest.burnRate))}/min
      </span>
    </>
  )
}
