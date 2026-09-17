'use client'

import { ARCADE, FONTS, UI_TYPE } from '../ps1/theme'

// The cabinet's whole chrome: two words in the top-right corner, sitting on
// the picture rather than in a bar above it.
//
// Neither is an icon. A pictograph has to be learned, and the HUD face is a
// bitmap recreation with no symbol coverage to draw one in anyway — so the
// button says what it opens, and the lit state says whether it is open.
//
// In the stacked layout the same two words become a tab row across the top of
// the panel under the race. There is always one lit, because there is always
// a panel showing, so the lit one never turns into "Close".

export type CabinetWindowId = 'board' | 'menu'

const BUTTONS: ReadonlyArray<{ id: CabinetWindowId; label: string }> = [
  { id: 'board', label: 'Leaderboard' },
  { id: 'menu', label: 'Menu' },
]

const BUTTON_HEIGHT_PX = 48

interface TopBarProps {
  readonly open: CabinetWindowId | null
  readonly onOpen: (next: CabinetWindowId | null) => void
  /** `corner`: floating over the race. `tabs`: a full-width row of tabs. */
  readonly layout: 'corner' | 'tabs'
}

export function TopBar({ open, onOpen, layout }: TopBarProps): React.ReactElement {
  const isTabs = layout === 'tabs'
  return (
    <div
      role={isTabs ? 'tablist' : undefined}
      style={{
        display: 'flex',
        gap: isTabs ? '2px' : '8px',
        pointerEvents: 'auto',
        ...(isTabs ? { background: ARCADE.rule, borderBottom: `2px solid ${ARCADE.rule}` } : {}),
      }}
    >
      {BUTTONS.map((button) => {
        const isOpen = open === button.id
        return (
          <button
            key={button.id}
            type="button"
            role={isTabs ? 'tab' : undefined}
            aria-selected={isTabs ? isOpen : undefined}
            aria-expanded={isTabs ? undefined : isOpen}
            onClick={() => onOpen(isOpen && !isTabs ? null : button.id)}
            className="gt-label"
            style={{
              height: `${BUTTON_HEIGHT_PX}px`,
              padding: '0 20px',
              border: 'none',
              flex: isTabs ? 1 : undefined,
              background: isOpen ? ARCADE.amber : isTabs ? ARCADE.ground : 'rgba(5, 5, 5, 0.82)',
              color: isOpen ? '#000' : ARCADE.silver,
              boxShadow: isOpen || isTabs ? 'none' : `inset 0 0 0 2px ${ARCADE.rule}`,
              fontFamily: FONTS.body,
              fontSize: `${UI_TYPE.body + 1}px`,
              letterSpacing: '0.12em',
            }}
          >
            {isOpen && !isTabs ? 'Close' : button.label}
          </button>
        )
      })}
    </div>
  )
}
