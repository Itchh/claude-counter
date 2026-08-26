'use client'

import { ModeProvider, useMode } from './ModeProvider'
import { StandardLeaderboard } from './StandardLeaderboard'
import { LeonLeaderboard } from './leon/LeonLeaderboard'

function ModeSwitch(): React.ReactElement {
  const { mode } = useMode()
  return mode === 'leon' ? <LeonLeaderboard /> : <StandardLeaderboard />
}

export default function Page(): React.ReactElement {
  return (
    <ModeProvider>
      <ModeSwitch />
    </ModeProvider>
  )
}
