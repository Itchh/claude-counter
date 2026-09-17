'use client'

import { useCallback, useEffect, useState } from 'react'
import { TitleCard } from './TitleCard'
import type { TitleSpec } from './titleSpecs'

// A game's own start screen, and the rule about when it is allowed to appear.
//
// The cabinet rotates channels on a timer, so this can never wait for input
// the way the boot gate does — it holds for a beat over the game that is
// warming up behind it, then wipes. Coming back to a game plays its title
// again, which is what an attract loop did; a game that is merely off-screen
// plays nothing at all.

export interface GameTitleProps {
  readonly spec: TitleSpec
  /** The channel is the one on screen. False parks the card entirely. */
  readonly active: boolean
  /** How long the flag holds before wiping. */
  readonly holdMs?: number
}

export function GameTitle({ spec, active, holdMs }: GameTitleProps): React.ReactElement | null {
  // A run is one showing. The card plays on the game's FIRST activation only:
  // replaying it on every re-entry meant mounting and tearing down a WebGL
  // canvas per flick around the cabinet, and that create/destroy churn is
  // what was hanging the GPU channel mid-switch. One flag per game per
  // sitting is also how a real cartridge behaved — the title plays when the
  // machine loads it, not every time you glance back.
  const [run, setRun] = useState(() => (active ? 1 : 0))
  const [shownRun, setShownRun] = useState(0)

  useEffect(() => {
    if (active) setRun((current) => (current === 0 ? 1 : current))
  }, [active])

  const handleDismissed = useCallback((): void => {
    setShownRun(run)
  }, [run])

  if (!active || run === 0 || shownRun === run) return null

  return (
    <TitleCard
      key={run}
      spec={spec}
      mode="attract"
      holdMs={holdMs}
      onDismissed={handleDismissed}
    />
  )
}
