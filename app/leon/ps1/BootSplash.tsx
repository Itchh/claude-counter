'use client'

import { useEffect, useState } from 'react'
import { PS1 } from './theme'

// The boot sequence is doing real work: it covers the first Convex round-trip,
// so the leaderboard never appears half-populated. It is a loading state that
// happens to be in character.

const BOOT_DURATION_MS = 2600

export function BootSplash(): React.ReactElement | null {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const id = setTimeout(() => setVisible(false), BOOT_DURATION_MS)
    return () => clearTimeout(id)
  }, [])

  if (!visible) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '24px',
        pointerEvents: 'none',
        background: PS1.void,
        animation: `ps1BootFade ${BOOT_DURATION_MS}ms ease-in-out forwards`,
      }}
    >
      <svg
        width="120"
        height="120"
        viewBox="0 0 100 100"
        aria-hidden="true"
        style={{ animation: 'ps1BootSpin 2.4s ease-out forwards' }}
      >
        <polygon
          points="50,6 94,50 50,94 6,50"
          fill="none"
          stroke={PS1.cyan}
          strokeWidth="1.5"
        />
        <polygon
          points="50,24 76,50 50,76 24,50"
          fill="none"
          stroke={PS1.hot}
          strokeWidth="1.5"
        />
        <polygon points="50,42 58,50 50,58 42,50" fill={PS1.gold} />
      </svg>

      <div
        className="ps1-plate"
        style={{
          fontSize: 'clamp(11px, 1.4vw, 16px)',
          color: PS1.text,
          animation: 'ps1BootRise 900ms ease-out 600ms both',
        }}
      >
        Season One
      </div>
      <div
        className="ps1-plate"
        style={{
          fontSize: 'clamp(8px, 0.9vw, 11px)',
          color: PS1.textFaint,
          animation: 'ps1BootRise 900ms ease-out 900ms both',
        }}
      >
        Reading memory card…
      </div>
    </div>
  )
}
