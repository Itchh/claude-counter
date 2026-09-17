'use client'

import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import { TitleCard } from './TitleCard'
import { RACE_TITLE } from './titleSpecs'

// The attract screen. It is a real gate, not decoration: the cabinet behind it
// is mounted and warming its first Convex round-trip while this sits on top, so
// nothing is ever seen half-populated, and the race only appears once someone
// has actually pressed something.
//
// The board's own query is subscribed to here so the loading bar has something
// true to wait on. It costs nothing twice — Convex dedupes a subscription to
// the same function and arguments, so this is the same round-trip the
// leaderboard is already making, watched from the screen that is holding for
// it rather than guessed at with a timer.
//
// The flag, the cloth shader and the furniture now live in TitleCard, which
// each game also uses for its own start screen. This is only the cabinet's
// choice of which one boots the machine.

export function TitleScreen(): React.ReactElement | null {
  const board = useQuery(api.leaderboard.get)
  return <TitleCard spec={RACE_TITLE} mode="gate" loading={board === undefined} />
}
