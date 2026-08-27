// Cabinet-level chrome: the glass every channel is viewed through. Lives at
// deck level rather than inside a channel so the CRT never blinks out during a
// flick, and so a new channel inherits the look for free.

export const DECK_STYLES = `
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
