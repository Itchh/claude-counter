'use client'

import { ModeToggle } from '../ModeToggle'
import { PS1, FONTS } from './ps1/theme'
import { PS1_STYLES } from './ps1/styles'
import { BootSplash } from './ps1/BootSplash'
import { ChannelDeck } from './channels/ChannelDeck'
import { DECK_STYLES } from './channels/deckStyles'

// The console cabinet. Everything here is glass and chrome that sits over
// *every* channel — the CRT, the boot sequence, the mode toggle. Channels get
// the screen inside it and nothing else.

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

      {/* Tucked under the channel ident, which every channel already keeps
          clear. Bottom corners are contested: CH 01 puts its lap counter and
          totals there, CH 02 its status bar. */}
      <div style={{ position: 'absolute', top: '74px', right: '18px', zIndex: 82 }}>
        <ModeToggle />
      </div>
    </div>
  )
}
