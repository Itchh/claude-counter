'use client'

import { Suspense, lazy, useState } from 'react'
import { ARCADE, FONTS, GT, PS1_TYPE, UI_TYPE } from '../ps1/theme'
import { SCALED_CHROME } from '../ps1/hudScale'
import { PHOSPHOR } from './arcadeScreen'
import type { CabinetGame } from '../cabinet/games'
import type { RoomMode } from './BedroomScene'

export interface BedroomProps {
  readonly lastGame: CabinetGame | null
  readonly isLive: boolean
  readonly inputEnabled: boolean
  readonly onPick: (game: CabinetGame) => void
  readonly onSetup: () => void
}

// The room carries a WebGL scene, so it defers the three bundle exactly as
// the channels do. It is the first thing on screen, so the skeleton is the
// boot screen: a dark room and one lit word, which is what the scene itself
// shows until the model lands.
//
// The one piece of chrome the room has is the strip along the bottom naming
// the keys — the cabinet's own prompt, in the room's two registers. On the
// rail it says only that there is a way off it; on foot it says how to walk,
// how to look, and how to get back on.

const BedroomScene = lazy(async () => ({
  default: (await import('./BedroomScene')).BedroomScene,
}))

const SKELETON_GROUND = '#120c14'

/** One key and what it does, per mode, in the prompt's own type. */
const ROOM_HINTS: Readonly<Record<RoomMode, ReadonlyArray<readonly [string, string]>>> = {
  menu: [['W', 'look around']],
  look: [
    ['WASD', 'walk'],
    ['Drag', 'look'],
    ['Esc', 'back'],
  ],
}

export function Bedroom(props: BedroomProps): React.ReactElement {
  const [mode, setMode] = useState<RoomMode>('menu')

  return (
    <>
      <Suspense fallback={<BedroomSkeleton />}>
        <BedroomScene {...props} onModeChange={setMode} />
      </Suspense>
      {props.isLive && props.inputEnabled && <RoomHint mode={mode} />}
    </>
  )
}

function RoomHint({ mode }: { readonly mode: RoomMode }): React.ReactElement {
  return (
    <div
      key={mode}
      className="cab-room-hint"
      aria-hidden
      style={{
        position: 'absolute',
        left: '50%',
        bottom: '22px',
        transform: 'translateX(-50%)',
        zIndex: 94,
        pointerEvents: 'none',
        display: 'flex',
        gap: '18px',
        padding: '8px 14px',
        background: 'rgba(4, 4, 8, 0.72)',
        boxShadow: `inset 0 0 0 2px ${ARCADE.rule}`,
        ...SCALED_CHROME,
      }}
    >
      {ROOM_HINTS[mode].map(([key, label]) => (
        <span key={key} className="gt-label" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.caption}px`, color: ARCADE.grey, letterSpacing: '0.12em' }}>
          <span style={{ color: ARCADE.amber, marginRight: '6px' }}>{key}</span>
          {label.toUpperCase()}
        </span>
      ))}
    </div>
  )
}

function BedroomSkeleton(): React.ReactElement {
  return (
    <div
      aria-label="Loading the room"
      style={{
        position: 'relative',
        height: '100%',
        width: '100%',
        background: SKELETON_GROUND,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <span
        className="gt-label"
        style={{
          fontFamily: FONTS.body,
          fontSize: `${PS1_TYPE.title}px`,
          color: PHOSPHOR,
          letterSpacing: '0.18em',
          animation: 'blink 1.2s step-end infinite',
        }}
      >
        Powering up
      </span>
      <span
        className="gt-label"
        style={{
          position: 'absolute',
          bottom: '28px',
          fontSize: `${PS1_TYPE.micro}px`,
          color: GT.valueDim,
        }}
      >
        Claude Arcade
      </span>
    </div>
  )
}
