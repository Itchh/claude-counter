'use client'

import { Suspense, lazy } from 'react'
import { GT, PS1, PS1_TYPE } from '../../ps1/theme'
import { SCALED_SURFACE } from '../../ps1/hudScale'
import { GameTitle } from '../../ps1/GameTitle'
import { DOGFIGHT_TITLE } from '../../ps1/titleSpecs'

export interface DogfightChannelProps {
  /** True while the patrol is the thing on screen. Scenes idle when false. */
  readonly isLive: boolean
  /** True while a cabinet window is open over it — the sky holds still. */
  readonly paused?: boolean
}

// Same loading contract as the other channels: three/R3F is heavy, so the
// scene module is deferred until the channel actually mounts.

const DogfightScene = lazy(async () => ({
  default: (await import('./DogfightScene')).DogfightScene,
}))

export function DogfightChannel(props: DogfightChannelProps): React.ReactElement {
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Suspense fallback={<DogfightSkeleton />}>
        <DogfightScene {...props} />
      </Suspense>

      {/* The game's own start screen. It sits over the skeleton as well as
          the scene, so the flag is what covers the three/R3F load rather
          than a bare placeholder. */}
      <GameTitle spec={DOGFIGHT_TITLE} active={props.isLive} />
    </div>
  )
}

/**
 * Occupies the same regions as the loaded scene — ident top-left, roster
 * slots down the right — so nothing shifts when 3D arrives.
 */
function DogfightSkeleton(): React.ReactElement {
  return (
    <div style={{ position: 'relative', background: PS1.void, ...SCALED_SURFACE }}>
      <div className="ps1-floor" />

      <div style={{ position: 'absolute', top: '14px', left: '18px' }}>
        <span
          className="gt-label"
          style={{ fontSize: `${PS1_TYPE.title}px`, color: GT.label, opacity: 0.6 }}
        >
          Squadron Patrol
        </span>
      </div>

      <div
        style={{
          position: 'absolute',
          right: '18px',
          top: '58px',
          minWidth: '230px',
          display: 'flex',
          flexDirection: 'column',
          gap: '3px',
        }}
      >
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', height: '26px', opacity: 0.5 }}>
            <span
              className="gt-label"
              style={{ width: '3ch', fontSize: `${PS1_TYPE.label}px`, color: GT.valueDim }}
            >
              P{i + 1}
            </span>
            <span style={{ width: '10px', height: '10px', background: '#2c2c34' }} />
            <span style={{ flex: 1, height: '7px', background: '#2c2c34' }} />
          </div>
        ))}
      </div>

      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span className="gt-label" style={{ color: GT.valueDim, fontSize: `${PS1_TYPE.body}px` }}>
          <span style={{ animation: 'blink 1.2s step-end infinite' }}>_</span> Scrambling squadron
        </span>
      </div>
    </div>
  )
}
