'use client'

import { ARCADE, FONTS } from '../ps1/theme'

// The cabinet's whole chrome: two words in the top-right corner, sitting on
// the picture rather than in a bar above it.
//
// Neither is an icon. A pictograph has to be learned, and the HUD face is a
// bitmap recreation with no symbol coverage to draw one in anyway — so the
// button says what it opens, and the lit state says whether it is open.

export type CabinetWindowId = 'board' | 'menu'

const BUTTONS: ReadonlyArray<{ id: CabinetWindowId; label: string }> = [
  { id: 'board', label: 'Leaderboard' },
  { id: 'menu', label: 'Menu' },
]

interface TopBarProps {
  readonly open: CabinetWindowId | null
  readonly onOpen: (next: CabinetWindowId | null) => void
}

export function TopBar({ open, onOpen }: TopBarProps): React.ReactElement {
  return (
    <div style={{ display: 'flex', gap: '8px', pointerEvents: 'auto' }}>
      {BUTTONS.map((button) => {
        const isOpen = open === button.id
        return (
          <button
            key={button.id}
            type="button"
            aria-expanded={isOpen}
            onClick={() => onOpen(isOpen ? null : button.id)}
            className="gt-label"
            style={{
              height: '44px',
              padding: '0 20px',
              border: 'none',
              background: isOpen ? ARCADE.amber : 'rgba(5, 5, 5, 0.82)',
              color: isOpen ? '#000' : ARCADE.silver,
              boxShadow: isOpen ? 'none' : `inset 0 0 0 2px ${ARCADE.rule}`,
              fontFamily: FONTS.hud,
              fontSize: '17px',
              letterSpacing: '0.12em',
            }}
          >
            {isOpen ? 'Close' : button.label}
          </button>
        )
      })}
    </div>
  )
}
