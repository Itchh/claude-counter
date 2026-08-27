// Chrome for the PS1 pass. Everything here is hard-edged on purpose: 2px
// bevels instead of shadows, ordered dither instead of gradients, and a
// perspective floor grid that fades into fog rather than into transparency.

export const PS1_STYLES = `
  .ps1-avatar {
    image-rendering: pixelated;
    display: block;
  }

  /* Bevelled console panel: light top-left, dark bottom-right, no radius. */
  .ps1-panel {
    background: #1b1b3d;
    box-shadow:
      inset 2px 2px 0 0 #4d4d92,
      inset -2px -2px 0 0 #0a0a18;
  }
  .ps1-panel-inset {
    background: #12122b;
    box-shadow:
      inset 2px 2px 0 0 #0a0a18,
      inset -2px -2px 0 0 #34346b;
  }

  /* Ordered dither, 4x4 Bayer approximated with two offset dot grids. The
     console had no alpha blending worth the name, so translucency was faked
     exactly like this. */
  .ps1-dither::after {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image:
      radial-gradient(circle at 1px 1px, rgba(255,255,255,0.05) 0.5px, transparent 0.5px),
      radial-gradient(circle at 3px 3px, rgba(0,0,0,0.35) 0.5px, transparent 0.5px);
    background-size: 4px 4px, 4px 4px;
  }

  /* Fogged perspective floor. Never scrolls fast enough to alias badly. */
  .ps1-floor {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
  }
  .ps1-floor::before {
    content: '';
    position: absolute;
    left: -50%;
    right: -50%;
    bottom: -30%;
    height: 90%;
    background-image:
      linear-gradient(rgba(0, 240, 255, 0.16) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0, 240, 255, 0.16) 1px, transparent 1px);
    background-size: 56px 56px;
    transform: perspective(340px) rotateX(72deg);
    transform-origin: bottom center;
    mask-image: linear-gradient(to top, rgba(0,0,0,0.55), transparent 72%);
    animation: ps1FloorScroll 6s linear infinite;
  }
  @keyframes ps1FloorScroll {
    from { background-position: 0 0, 0 0; }
    to { background-position: 0 56px, 0 0; }
  }

  /* Affine texture warp: the single most recognisable artefact of the era.
     Applied sparingly, to plate labels only. */
  .ps1-warp {
    animation: ps1Warp 5s ease-in-out infinite;
  }
  @keyframes ps1Warp {
    0%, 100% { transform: skewX(0deg) scaleY(1); }
    35% { transform: skewX(-0.9deg) scaleY(1.012); }
    70% { transform: skewX(0.7deg) scaleY(0.99); }
  }

  .ps1-plate {
    letter-spacing: 0.22em;
    text-transform: uppercase;
  }

  /* Boot sequence: the console's diamond, redrawn as a wireframe. */
  @keyframes ps1BootFade {
    0% { opacity: 0; }
    12% { opacity: 1; }
    72% { opacity: 1; }
    100% { opacity: 0; }
  }
  @keyframes ps1BootSpin {
    from { transform: rotate(0deg) scale(0.7); }
    to { transform: rotate(360deg) scale(1); }
  }
  @keyframes ps1BootRise {
    0% { transform: translateY(24px); opacity: 0; }
    100% { transform: translateY(0); opacity: 1; }
  }

  /* Race lane markings scroll under the karts to sell forward motion. */
  @keyframes ps1RoadScroll {
    from { background-position: 0 0; }
    to { background-position: -48px 0; }
  }
  .ps1-road {
    background-image: repeating-linear-gradient(
      90deg,
      rgba(214, 214, 242, 0.22) 0 14px,
      transparent 14px 48px
    );
    animation: ps1RoadScroll 1.1s linear infinite;
  }

  @keyframes ps1KartBounce {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-2px); }
  }

  /* ---------------------------------------------------------------------
     Control prompt strip. The slanted bar is the era's signature: a
     parallelogram cut from a solid, never a rounded pill. The fill is flat
     and the light edge sits only on the top and left, because a bevel is
     two lines, not a gradient.
  --------------------------------------------------------------------- */
  .ps1-hint-bar {
    position: relative;
    transform: skewX(-12deg);
    background: linear-gradient(90deg, rgba(10, 10, 24, 0.92), rgba(27, 27, 61, 0.78));
    box-shadow:
      inset 0 1px 0 0 rgba(77, 77, 146, 0.9),
      inset 1px 0 0 0 rgba(77, 77, 146, 0.9),
      inset 0 -1px 0 0 rgba(6, 6, 14, 0.9);
  }

  /* ---------------------------------------------------------------------
     Cursor and selection.

     A focused row is not "highlighted" — it is *selected*, which on this
     hardware meant a hard bright frame and a caret pointing at it. No glow,
     no scale, no transition on the frame itself: the console redrew the
     whole box in one field, so it either is selected or it is not.
  --------------------------------------------------------------------- */
  .ps1-cursor {
    position: relative;
  }
  .ps1-cursor-on {
    box-shadow:
      inset 2px 2px 0 0 #ffb020,
      inset -2px -2px 0 0 #7a5210;
    background: #23234d;
  }
  /* The caret. Steps rather than slides — a 2px hop on a 400ms beat, which
     is roughly the blink rate the menus of the period used. */
  .ps1-cursor-on::before {
    content: '';
    position: absolute;
    left: -14px;
    top: 50%;
    width: 0;
    height: 0;
    border-top: 6px solid transparent;
    border-bottom: 6px solid transparent;
    border-left: 9px solid #ffb020;
    transform: translateY(-50%);
    animation: ps1CaretStep 0.8s steps(1, end) infinite;
  }
  @keyframes ps1CaretStep {
    0%, 50% { margin-left: 0; }
    50.01%, 100% { margin-left: 3px; }
  }

  /* The panel that opens under a selected row. Inset, darker than its
     parent, and framed by a single hairline so it reads as carved into the
     row rather than floating over it. */
  .ps1-drawer {
    background: #0d0d20;
    box-shadow:
      inset 2px 2px 0 0 #0a0a18,
      inset -2px -2px 0 0 #34346b;
  }

  /* Condensed kerning for the bitmap faces. The HUD face is already square,
     so it wants a touch of tracking to stop numerals fusing, and none of the
     browser's optical kerning, which fights a fixed-width bitmap grid. */
  .ps1-hud {
    font-family: var(--font-ps1-hud);
    letter-spacing: 0.04em;
    font-kerning: none;
  }
  .ps1-codec {
    font-family: var(--font-ps1-codec);
    letter-spacing: 0.02em;
    font-kerning: none;
  }
`
