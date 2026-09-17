'use client'

import { Suspense, lazy } from 'react'
import { GT, PS1, PS1_TYPE } from '../../ps1/theme'
import { SCALED_SURFACE } from '../../ps1/hudScale'
import { GameTitle } from '../../ps1/GameTitle'
import { FIGHT_TITLE } from '../../ps1/titleSpecs'

export interface FightChannelProps {
  /** True while the fight is the thing on screen. Scenes idle when false. */
  readonly isLive: boolean
  /** True while a cabinet window is open over it — the bout holds still. */
  readonly paused?: boolean
}

// Same loading contract as the race: three/R3F is heavy, so the scene module
// is deferred until the channel actually mounts.

const FightScene = lazy(async () => ({
  default: (await import('./FightScene')).FightScene,
}))

export function FightChannel(props: FightChannelProps): React.ReactElement {
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Suspense fallback={<FightSkeleton />}>
        <FightScene {...props} />
      </Suspense>

      {/* The game's own start screen. It sits over the skeleton as well as
          the scene, so the flag is what covers the three/R3F load rather
          than a bare placeholder. */}
      <GameTitle spec={FIGHT_TITLE} active={props.isLive} />
    </div>
  )
}

/**
 * Occupies the same regions as the loaded scene — stage ident top-left, the
 * two bar slots across the top — so nothing shifts when 3D arrives.
 */
function FightSkeleton(): React.ReactElement {
  return (
    <div style={{ position: 'relative', background: PS1.void, ...SCALED_SURFACE }}>
      <div className="ps1-floor" />

      <div style={{ position: 'absolute', top: '14px', left: '18px' }}>
        <span
          className="gt-label"
          style={{ fontSize: `${PS1_TYPE.title}px`, color: GT.label, opacity: 0.6 }}
        >
          Stage 01 · Iron Fist
        </span>
      </div>

      <div
        style={{
          position: 'absolute',
          top: '58px',
          left: '18px',
          right: '18px',
          display: 'flex',
          gap: '60px',
          opacity: 0.5,
        }}
      >
        <span style={{ flex: 1, height: '18px', background: '#2c2c34' }} />
        <span style={{ flex: 1, height: '18px', background: '#2c2c34' }} />
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
          <span style={{ animation: 'blink 1.2s step-end infinite' }}>_</span> Loading arena
        </span>
      </div>
    </div>
  )
}
