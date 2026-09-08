'use client'

import { Suspense, lazy } from 'react'
import { GT, PS1, PS1_TYPE } from '../../ps1/theme'
import { SCALED_SURFACE } from '../../ps1/hudScale'
import type { ChannelProps } from '../ChannelRegistry'

// three/R3F is ~600kb, so it is loaded only when this channel is first tuned
// to. The deck already imports this module lazily; `lazy` here defers the
// heavy three bundle one step further, until the component actually mounts.
//
// Plain React.lazy rather than next/dynamic: the deck is a client component
// that only ever renders after mount, so there is no SSR pass to opt out of.

const RaceScene = lazy(async () => ({
  default: (await import('./RaceScene')).RaceScene,
}))

export function RaceChannel(props: ChannelProps): React.ReactElement {
  return (
    <Suspense fallback={<RaceSkeleton />}>
      <RaceScene {...props} />
    </Suspense>
  )
}

/**
 * Occupies exactly the same regions as the loaded scene — full-bleed canvas,
 * slanted tower down the left, console bar across the foot — so nothing
 * shifts when 3D arrives. The bar in particular is 156px whether or not the
 * instruments have anything to say yet.
 */
function RaceSkeleton(): React.ReactElement {
  return (
    <div
      style={{ position: 'relative', background: PS1.void, ...SCALED_SURFACE }}
    >
      <div className="ps1-floor" />

      <div style={{ position: 'absolute', top: '14px', left: '18px' }}>
        <span className="gt-ident">
          <span
            className="gt-label"
            style={{ fontSize: `${PS1_TYPE.title}px`, color: GT.label, opacity: 0.6 }}
          >
            Stage 01 · Token Grand Prix
          </span>
        </span>
      </div>

      <div
        style={{
          position: 'absolute',
          left: '18px',
          top: '58px',
          minWidth: '320px',
          display: 'flex',
          flexDirection: 'column',
          gap: '3px',
        }}
      >
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="gt-tower-row" style={{ height: '26px', opacity: 0.5 }}>
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
          <span style={{ animation: 'blink 1.2s step-end infinite' }}>_</span> Loading circuit
        </span>
      </div>

      <div
        className="gt-bar"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: '156px',
        }}
      />
    </div>
  )
}
