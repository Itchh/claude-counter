'use client'

import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { RaceChannel } from '../channels/race/RaceChannel'
import { NavigationProvider } from '../ps1/navigation'
import { SCALED_CHROME } from '../ps1/hudScale'
import { TopBar, type CabinetWindowId } from './TopBar'
import { Window } from './Window'
import { PodiumBoard } from './PodiumBoard'
import { MenuWindow } from './MenuWindow'

// The cabinet: one screen, and two windows over it.
//
// It replaces the channel deck. The deck rotated between a race and a
// standings board on a timer, which meant the screen was showing the wrong one
// half the time and there was no way to ask for the other — the numbers arrived
// when the schedule felt like it. A race that never stops, with the board a
// button away, is the same two things without the wait.
//
// Opening either window pauses the race behind it. Not for performance: a
// paused picture is what says the cabinet is waiting for you rather than
// carrying on without you, and the dial going still is the honest signal.

export function Cabinet(): React.ReactElement {
  const [open, setOpen] = useState<CabinetWindowId | null>(null)

  const close = useCallback((): void => setOpen(null), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return

      // Escape closes a window before anything else can claim it — while one
      // is open it is the way out, and the race's own Escape (release the
      // camera) would otherwise fire in the same keystroke.
      if (event.key === 'Escape') {
        if (open === null) return
        event.preventDefault()
        event.stopPropagation()
        setOpen(null)
        return
      }

      // Typing into a field somewhere should never flick the cabinet.
      const target = event.target
      if (target instanceof HTMLElement && target.isContentEditable) return

      const key = event.key.toLowerCase()
      if (key === 'l') setOpen((current) => (current === 'board' ? null : 'board'))
      else if (key === 'm') setOpen((current) => (current === 'menu' ? null : 'menu'))
    }

    // Capture phase, so the shortcut is decided here before the race channel's
    // own window listeners see the same key.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  return (
    <NavigationProvider resetKey="cabinet">
      <div style={{ position: 'relative', height: '100%', width: '100%', overflow: 'hidden' }}>
        <RaceChannel isLive paused={open !== null} />

        <div
          style={{
            position: 'absolute',
            top: '14px',
            right: '18px',
            zIndex: 95,
            pointerEvents: 'none',
            ...SCALED_CHROME,
          }}
        >
          <TopBar open={open} onOpen={setOpen} />
        </div>

        <AnimatePresence>
          {open === 'board' && (
            <Window
              key="board"
              title="Leaderboard"
              subtitle="Every driver, all time"
              onClose={close}
            >
              <PodiumBoard />
            </Window>
          )}
          {open === 'menu' && (
            <Window
              key="menu"
              title="Paused"
              subtitle="Broadcast held · reporting never stops"
              onClose={close}
            >
              <MenuWindow />
            </Window>
          )}
        </AnimatePresence>
      </div>
    </NavigationProvider>
  )
}
