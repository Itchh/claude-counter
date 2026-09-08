'use client'

import { PS1, FONTS } from './ps1/theme'
import { PS1_STYLES } from './ps1/styles'
import { BootSplash } from './ps1/BootSplash'
import { ChannelDeck } from './channels/ChannelDeck'
import { DECK_STYLES } from './channels/deckStyles'

// The console cabinet, and the whole product: the CRT, the boot sequence, the
// deck. There is no other view to switch to, so this is what the page renders.
// Channels get the screen inside it and nothing else.

export function LeonLeaderboard(): React.ReactElement {
  return (
    <div
      className="ps1-type"
      style={{
        fontFamily: FONTS.hud,
        background: PS1.void,
        color: PS1.text,
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        position: 'relative',
        animation: 'screenFlicker 4s infinite',
      }}
    >
      <style>{PS1_STYLES}</style>
      <style>{DECK_STYLES}</style>

      <ChannelDeck />

      <div className="crt-overlay" />
      <div className="scanline-bar" />
      <BootSplash />
    </div>
  )
}
