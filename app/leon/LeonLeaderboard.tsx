'use client'

import { PS1, FONTS } from './ps1/theme'
import { PS1_STYLES } from './ps1/styles'
import { TitleScreen } from './ps1/TitleScreen'
import { Cabinet } from './cabinet/Cabinet'
import { CABINET_STYLES } from './cabinet/cabinetStyles'

// The console cabinet, and the whole product: the CRT, the boot sequence, the
// race. There is no other view to switch to, so this is what the page renders.
// The title screen sits on top until someone presses start.

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
      <style>{CABINET_STYLES}</style>

      <Cabinet />

      <div className="crt-overlay" />
      <div className="scanline-bar" />
      <TitleScreen />
    </div>
  )
}
