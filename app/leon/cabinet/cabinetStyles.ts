// Cabinet-level chrome: the glass the whole screen is viewed through. Lives
// here rather than inside the race so the CRT covers the windows too — a
// leaderboard that sat outside the scanlines would read as a browser dialog
// pasted over a console.

import { NARROW_BREAKPOINT_PX } from '../ps1/hudScale'

export const CABINET_STYLES = `
  /* -------------------------------------------------------------------
     The narrow layout. Below the breakpoint the race is a band across
     the top of the screen and the board or menu sits underneath it, so
     anything laid out for a wide window has to reflow here: the menu's
     two columns become one, the podium's three plinths shrink to fit,
     and the HUD's centre lockup — which collides with both corners once
     the picture is a phone wide — is dropped.
  ------------------------------------------------------------------- */
  @media (max-width: ${NARROW_BREAKPOINT_PX - 1}px) {
    .cab-narrow-hide { display: none !important; }
    .cab-menu-grid { grid-template-columns: 1fr !important; }
    .cab-window-body { padding-left: 14px !important; padding-right: 14px !important; }
  }

  /* -------------------------------------------------------------------
     A driver on the board, as a pick. The board's rows and plinths open
     the paint shop, so they have to look like something you can press
     without gaining chrome the board was designed without: the row lifts
     a little off the ground on hover and the keyboard gets a hard outline
     rather than the UA's own halo, which on a CRT reads as a smear.
  ------------------------------------------------------------------- */
  .cab-pick {
    transition: filter 90ms steps(2, end), transform 90ms steps(2, end);
  }
  .cab-pick:hover {
    filter: brightness(1.22);
  }
  .cab-pick:active {
    transform: translateY(1px);
  }
  .cab-pick:focus-visible {
    outline: 2px solid #fff;
    outline-offset: -2px;
  }
  @media (prefers-reduced-motion: reduce) {
    .cab-pick { transition: none; }
    .cab-pick:active { transform: none; }
  }

  /* The window's entrance: veil fades, panel rises a few pixels. Compositor
     only — see Window.tsx for why this is not a Motion transition. */
  @keyframes cabWindowVeil {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes cabWindowPanel {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .cab-window-veil { animation: cabWindowVeil 140ms ease-out both; }
  .cab-window-panel { animation: cabWindowPanel 160ms ease-out both; }
  @media (prefers-reduced-motion: reduce) {
    .cab-window-veil, .cab-window-panel { animation: none; }
  }

  /* The key prompt: shown on entering a game, gone by itself. */
  @keyframes cabKeyPrompt {
    0% { opacity: 0; transform: translateY(6px); }
    8% { opacity: 1; transform: translateY(0); }
    85% { opacity: 1; }
    100% { opacity: 0; }
  }
  .cab-key-prompt { animation: cabKeyPrompt 9s ease-out both; }

  /* The room's hint strip: the same prompt, but it stays — the keys it
     names change with the mode, and it comes in on the window's beat. */
  .cab-room-hint { animation: cabWindowPanel 160ms ease-out both; }
  @media (prefers-reduced-motion: reduce) {
    .cab-room-hint { animation: none; }
  }

  @keyframes scanline {
    0% { transform: translateY(-100%); }
    100% { transform: translateY(100vh); }
  }
  @keyframes screenFlicker {
    0%, 97%, 100% { opacity: 1; }
    98% { opacity: 0.97; }
    99% { opacity: 0.99; }
  }
  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  .crt-overlay {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 100;
  }
  .crt-overlay::before {
    content: '';
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(
      0deg,
      rgba(0, 0, 0, 0.15) 0px,
      rgba(0, 0, 0, 0.15) 1px,
      transparent 1px,
      transparent 3px
    );
  }
  .crt-overlay::after {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(
      ellipse at center,
      transparent 55%,
      rgba(0, 0, 0, 0.55) 100%
    );
  }
  .scanline-bar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 4px;
    background: rgba(255, 255, 255, 0.04);
    z-index: 101;
    pointer-events: none;
    animation: scanline 8s linear infinite;
  }
`
