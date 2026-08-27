'use client'

import { Suspense, lazy } from 'react'
import { PS1 } from '../../ps1/theme'
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
 * tower top-left, readouts bottom — so nothing shifts when 3D arrives.
 */
function RaceSkeleton(): React.ReactElement {
  return (
    <div style={{ position: 'relative', height: '100%', width: '100%', background: PS1.void }}>
      <div className="ps1-floor" />

      <div style={{ position: 'absolute', top: '14px', left: '18px' }}>
        <span
          className="ps1-plate"
          style={{ fontSize: 'clamp(9px, 1.1vw, 13px)', color: PS1.gold, opacity: 0.5 }}
        >
          Stage 01 — Token Grand Prix
        </span>
      </div>

      <div
        className="ps1-panel"
        style={{
          position: 'absolute',
          left: '18px',
          top: '46px',
          minWidth: 'clamp(190px, 21vw, 260px)',
          padding: '8px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: '5px',
        }}
      >
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', height: '14px' }}>
            <span
              className="ps1-plate"
              style={{ width: '3ch', fontSize: 'clamp(8px, 0.9vw, 11px)', color: PS1.textFaint }}
            >
              P{i + 1}
            </span>
            <span style={{ width: '10px', height: '10px', background: PS1.panelDeep }} />
            <span style={{ flex: 1, height: '7px', background: PS1.panelDeep }} />
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
        <span
          className="ps1-plate"
          style={{ color: PS1.textDim, fontSize: 'clamp(10px, 1.2vw, 14px)' }}
        >
          <span style={{ animation: 'blink 1.2s step-end infinite' }}>_</span> Loading circuit
        </span>
      </div>
    </div>
  )
}
