'use client'

import { Suspense, lazy } from 'react'
import { GT, PS1, PS1_TYPE } from '../ps1/theme'
import { SCALED_SURFACE } from '../ps1/hudScale'
import type { CabinetGame } from './games'

export interface ShelfProps {
  readonly currentGame: CabinetGame | null
  readonly onPick: (game: CabinetGame) => void
  /** False while the shelf is hidden behind a game, which parks its loop. */
  readonly isLive: boolean
}

// The shelf carries a WebGL scene, so it defers the three bundle exactly as
// the channels do — a person who never leaves the race never pays for it.

const ShelfScene = lazy(async () => ({
  default: (await import('./ShelfScene')).ShelfScene,
}))

export function Shelf(props: ShelfProps): React.ReactElement {
  return (
    <Suspense fallback={<ShelfSkeleton />}>
      <ShelfScene {...props} />
    </Suspense>
  )
}

function ShelfSkeleton(): React.ReactElement {
  return (
    <div style={{ position: 'relative', background: PS1.void, ...SCALED_SURFACE }}>
      <div style={{ position: 'absolute', top: '14px', left: '18px' }}>
        <span
          className="gt-label"
          style={{ fontSize: `${PS1_TYPE.title}px`, color: GT.label, opacity: 0.6 }}
        >
          The Shelf
        </span>
      </div>

      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '40px',
        }}
      >
        {Array.from({ length: 3 }, (_, i) => (
          <span key={i} style={{ width: '72px', height: '86px', background: '#2c2c34', opacity: 0.5 }} />
        ))}
      </div>

      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: '28px',
          textAlign: 'center',
        }}
      >
        <span className="gt-label" style={{ color: GT.valueDim, fontSize: `${PS1_TYPE.body}px` }}>
          <span style={{ animation: 'blink 1.2s step-end infinite' }}>_</span> Dusting the shelf
        </span>
      </div>
    </div>
  )
}
