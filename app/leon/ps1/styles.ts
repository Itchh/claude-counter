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

  /* =====================================================================
     THE ARCADE KIT

     The platform's own UI kit, as CSS. Five treatments and three frames,
     and every screen's chrome is built from them — see ARCADE in theme.ts
     for the palette and the reasoning.

     The rule that governs all of it: depth is an offset, never a blur. An
     outline at 2px and a drop at 4px is what let these boards sit over a
     moving picture at 240 lines, and one blurred shadow in here would undo
     the entire thing. There is no glow in this section and there should
     never be.
  ===================================================================== */

  /* --------------------------------------------------------------------
     The treatments come in two weights, and choosing between them is the
     only decision this section asks of a caller.

     The kit draws its bevels at 2px and its drops at 4px, which is correct
     for the 26-64px display type it demonstrates them on — at 640x480 those
     offsets are a fraction of a glyph. Applied to a 10px label they are the
     whole glyph, and the first render of this board came out with the
     labels swallowed by their own shadows. So: light by default, heavy only
     on the display sizes the kit actually drew.

     Rule of thumb — heavy above 20px, light below.
  -------------------------------------------------------------------- */

  /* A label. Red, extruded a pixel into its own darker shade. */
  .arc-label {
    color: #e02020;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    white-space: nowrap;
    text-shadow: 0 1px 0 #6b0000, 1px 1px 0 #000;
  }
  /* The same label at display size: the kit's full bevel, boxed on all four
     sides so it holds over anything behind it. */
  .arc-label-lg {
    color: #e02020;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    white-space: nowrap;
    text-shadow:
      0 2px 0 #6b0000,
      2px 2px 0 #000, -2px 2px 0 #000, 2px -2px 0 #000, -2px -2px 0 #000,
      4px 4px 0 #000;
  }
  /* A name or a title: white, outlined, dropped. Display weight — this is
     the one treatment that is always used large. */
  .arc-label-plain {
    color: #ffffff;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    white-space: nowrap;
    text-shadow:
      2px 0 0 #000, -2px 0 0 #000, 0 2px 0 #000, 0 -2px 0 #000,
      3px 3px 0 #000;
  }

  /* A value. White, tabular, one hard pixel of drop. The workhorse, and
     deliberately the quietest thing here — a board is mostly values. */
  .arc-value {
    color: #ffffff;
    font-variant-numeric: tabular-nums;
    text-shadow: 1px 1px 0 #000;
  }
  
  /* A value that is still moving: a clock, a rate, a total counting up.
     Amber, bevelled from below in its own shadow rather than in black, which
     is what separates a live readout from a settled one at a glance. */
  .arc-value-live {
    color: #ffb000;
    font-variant-numeric: tabular-nums;
    text-shadow: 0 1px 0 #a05000, 1px 1px 0 #000;
  }

  /* A position. The kit's one decorative treatment: a two-stop metal ramp,
     white on top and silver below.

     The kit draws it as a gradient clipped to the glyphs, and that is where
     two attempts went. A drop-shadow filter over a transparent fill renders
     the shadow of the element's *box*, not of its letters — the old chrome
     lap counter shipped exactly that and came out as a grey slab. Clipping
     the ramp itself then worked in the abstract and disappeared in practice:
     against this bitmap face, with smoothing off, the clipped fill covers
     almost none of a stroke that is one pixel wide, and the board rendered
     its positions as two faint marks.

     So the ramp is built the way the hardware would have built it — as
     stacked offsets, a white face over a silver step, boxed in black. Two
     stops, same read, and it survives a face made of pixels. */
  .arc-chrome {
    color: #ffffff;
    font-variant-numeric: tabular-nums;
    /* Offsets are one pixel apart, not two: this face paints its glyphs at
       roughly half the em it is set at — a 34px numeral is 17px of ink — so
       the kit's own 2px/4px steps, measured against Press Start 2P, land as
       a third of a stroke here and the numeral disappears into its own
       bevel. Every treatment in this section is scaled the same way. */
    text-shadow:
      0 1px 0 #8a8a8a,
      0 2px 0 #c8c8c8,
      1px 0 0 #000, -1px 0 0 #000, 0 -1px 0 #000,
      0 3px 0 #000,
      2px 3px 0 #000;
  }

  /* A caption: a unit, a scale, the line under a value. Silver, one drop. */
  .arc-caption {
    color: #c8c8c8;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    text-shadow: 1px 1px 0 #000;
  }
  /* Meta. Grey, flat, no treatment at all — it is not meant to compete. */
  .arc-meta {
    color: #8a8a8a;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  /* A framed block. The kit never fills a panel; it draws a rule around one
     and lets the ground show through. */
  .arc-panel {
    background: #0a0a0a;
    border: 2px solid #1e1e1e;
  }
  /* A recess: telemetry, anything backlit. Blacker than the ground, framed
     in black rather than in grey, so it reads as cut into the face. */
  .arc-inset {
    background: #050505;
    border: 3px solid #000000;
  }
  /* A gauge bed. The one frame that is pure black on all sides — the bar
     inside it carries the colour, and a grey rule would compete with it. */
  .arc-gauge {
    background: #050505;
    box-shadow: inset 0 0 0 2px #000000;
    image-rendering: pixelated;
  }

  /* Telemetry: green on near-black, the LCD register. Used for live status
     lines and nothing decorative. */
  .arc-telemetry {
    color: #4cff3c;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    text-shadow: 1px 1px 0 #000;
  }

  
  /* The head and foot of a board. Flat black with one hard rule facing the
     content — the kit's frames are drawn, never lit, so there is no gradient
     fade into the picture the way the race console bar has. */
  .arc-header {
    background: #0a0a0a;
    border-bottom: 6px solid #000000;
    box-shadow: inset 0 -8px 0 -6px #1e1e1e;
  }
  .arc-footer {
    background: #0a0a0a;
    border-top: 6px solid #000000;
    box-shadow: inset 0 8px 0 -6px #1e1e1e;
  }

  /* A selected row. The kit inverts a selection, but a leaderboard row
     carries a coloured gauge that inversion would destroy — so the frame
     goes white and the ground lifts one step instead, which is the same
     gesture at the strength this row can take. */
  .arc-row-on {
    border-color: #ffffff;
    background: #141414;
    /* An outline as well as a border colour, because not everything this
       lands on has a border to recolour: the timeline row is a bare wrapper
       around two panels of its own, so recolouring its (absent) border left
       the cursor invisible there. Inset, so it never changes the layout. */
    outline: 2px solid #ffffff;
    outline-offset: -2px;
  }
  /* The caret that used to ride beside a selected row, kept. A cursor that
     only tints its row is a cursor you have to hunt for; the arrow is what
     says "this one" from across a room. */
  .arc-row-on::before {
    content: '';
    position: absolute;
    left: -14px;
    top: 50%;
    width: 0;
    height: 0;
    border-top: 6px solid transparent;
    border-bottom: 6px solid transparent;
    border-left: 9px solid #ffb000;
    transform: translateY(-50%);
    animation: ps1CaretStep 0.8s steps(1, end) infinite;
  }

  /* The panel that opens under a selected row: blacker than the row, framed
     rather than filled. */
  .arc-drawer {
    background: #050505;
    border: 2px solid #1e1e1e;
  }

  /* A running band: the ticker, a status line. A slot cut in the ground,
     ruled top and bottom, never bevelled. */
  .arc-strip {
    background: #050505;
    border-top: 2px solid #1e1e1e;
    border-bottom: 2px solid #1e1e1e;
  }
  /* The one cell of colour a ticker line is allowed — see Ticker.tsx. */
  .ticker-chip {
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-right: 10px;
    box-shadow: 0 0 0 2px #000;
  }

  /* A pre-rendered car turning on its sheet. The frames are stacked
     vertically, so the animation walks the background down one frame at a
     time — see carSprite.ts for why the car is an image and not a canvas. */
  .ps1-car-sprite {
    image-rendering: pixelated;
    background-repeat: no-repeat;
    background-position: 0 0;
    animation-name: ps1CarTurn;
    animation-iteration-count: infinite;
  }
  /* Twelve frames, stepped — but the end stop is 109.0909%, not 100%.
     A percentage background-position is a fraction of (container - image), so
     with a sheet twelve frames tall the nth frame sits at n/11 of the range,
     while steps(12) over 0-100% lands on n/12. The two only agree at n=0, and
     everywhere else the element showed the bottom of one frame above the top
     of the next — two half cars, which at 48px read as noise and at podium
     size read as two cars. 12/11 of the range puts every step on a frame. */
  @keyframes ps1CarTurn {
    from { background-position: 0 0; }
    to { background-position: 0 109.0909%; }
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

  /* =====================================================================
     RACE INSTRUMENTATION

     The second visual register. Everything above this line is menu
     furniture — blue, bevelled, boxy. Everything below is the in-race
     console: a black bar tinted green at the foot of the picture, gold
     condensed labels, white numerals, an amber LCD and a metal dial.

     They are kept apart on purpose. Mixing the two is the single most
     common way a "retro racer" pass ends up looking like a website with a
     pixel font on it: the era's games never dressed the HUD in the menu's
     clothes, because the HUD had to be legible over a moving picture and
     the menu did not.
  ===================================================================== */

  /* The console bar. Opaque at the foot, fading up into the picture, so
     the road appears to run underneath it rather than stopping at it. */
  .gt-bar {
    background:
      linear-gradient(to bottom,
        rgba(4, 4, 10, 0) 0%,
        rgba(4, 4, 10, 0.86) 14%,
        #04040a 30%,
        #071408 62%,
        #123a17 100%);
    box-shadow: inset 0 1px 0 0 rgba(143, 143, 156, 0.55);
  }

  /* Condensed gold caps. Tight tracking and a hard 1px drop, which is how
     these labels were drawn — a shadow one pixel down and right, never a
     blur, so they hold over a bright sky. */
  .gt-label {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    text-shadow: 1px 1px 0 rgba(0, 0, 0, 0.9);
    white-space: nowrap;
  }

  /* A row of the position tower, which is also the door to that driver's
     paint shop. No plate behind it at rest — the tower sits on the picture,
     and a panel would cost a rectangle of road to say something the ink
     outline already says. The hover state is the smallest mark that reads as
     a target: a hairline of the kit's own red down the leading edge. */
  .gt-tower-row {
    cursor: default;
    box-shadow: inset 0 0 0 0 transparent;
  }
  .gt-tower-row:hover,
  .gt-tower-row:focus-visible {
    background: rgba(224, 32, 32, 0.14) !important;
    box-shadow: inset 2px 0 0 0 #e02020;
    outline: none;
  }

  /* Vertical rule between instrument groups. One hairline pair, light then
     dark, which is the same two-line bevel used everywhere else. */
  .gt-divider {
    width: 2px;
    align-self: stretch;
    background: linear-gradient(to right, rgba(0,0,0,0.85) 1px, rgba(160,160,175,0.28) 1px);
  }

  /* ------------------------------------------------------------------
     Amber LCD. The bed carries every segment unlit; the value sits over
     it. Both are the same face at the same size, so the digits land on
     the grid exactly.
  ------------------------------------------------------------------ */
  .gt-lcd {
    position: relative;
    display: inline-flex;
    align-items: baseline;
    padding: 2px 6px;
    background: #0a0a06;
    box-shadow:
      inset 2px 2px 0 0 #000,
      inset -2px -2px 0 0 #3a3a44;
  }
  .gt-lcd-digits {
    position: relative;
    display: inline-block;
  }
  .gt-lcd-bed {
    color: #241a06;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
    line-height: 1;
  }
  .gt-lcd-lit {
    position: absolute;
    left: 0;
    top: 0;
    color: #ff8c1a;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.04em;
    line-height: 1;
    text-align: right;
    /* Right-aligned over the bed so the number grows leftwards, the way a
       real seven-segment readout fills. */
    width: 100%;
    text-shadow: 0 0 6px rgba(255, 140, 26, 0.45);
  }
  .gt-lcd-unit {
    margin-left: 5px;
    color: #ff8c1a;
    opacity: 0.75;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  /* ------------------------------------------------------------------
     Gear plate and warning lamps. Stamped metal: light top-left, dark
     bottom-right, flat face between.
  ------------------------------------------------------------------ */
  .gt-gear {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 34px;
    padding: 2px 8px;
    font-size: 30px;
    line-height: 1.05;
    color: #f4f4f8;
    background: #2c2c34;
    box-shadow:
      inset 2px 2px 0 0 #c9c9d4,
      inset -2px -2px 0 0 #1c1c22;
    text-shadow: 1px 1px 0 rgba(0, 0, 0, 0.8);
  }
  .gt-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* Sized to its word rather than to a 22px square: the lamps carry names
       now, and a fixed square either clipped them or set them at a size
       nobody could read from the room. */
    min-width: 22px;
    padding: 0 8px;
    height: 22px;
    font-size: 13px;
    text-transform: uppercase;
    white-space: nowrap;
    /* An unlit lamp still has to be readable — that is the whole reason the
       cluster shows plates that are off. It sat at #3f3f4a, which was fine
       for a single capital and illegible once the plate carried a word. */
    color: #6c6c7a;
    background: #16161c;
    box-shadow:
      inset 1px 1px 0 0 #55555f,
      inset -1px -1px 0 0 #0a0a0e;
  }
  .gt-chip-lit {
    color: #f4f4f8;
    background: #2c2c34;
  }

  /* The needle has mass. Short, eased, and never instant — but not spring,
     because a tachometer needle does not overshoot on the way down. */
  .gt-needle {
    transition: transform 320ms cubic-bezier(0.22, 0.61, 0.36, 1);
  }

  /* While the subject is burning the needle is resampled every 80ms, so the
     easing above would smear each flutter into the next and the dial would
     read as one slow drift. Live, it tracks. */
  .gt-needle-live {
    transition: transform 80ms linear;
  }

  /* ------------------------------------------------------------------
     Chrome lap counter. Italic, outlined, with a vertical metal ramp
     clipped to the glyphs — the one decorative piece of type on screen.
  ------------------------------------------------------------------ */
  .gt-chrome {
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    transform: skewX(-9deg);
  }
  .gt-chrome-num,
  .gt-chrome-slash,
  .gt-chrome-suffix {
    /* Solid fill with a hard offset shadow, not a gradient clipped to the
       glyphs. The clipped version is prettier on paper and was invisible in
       practice: a transparent text fill plus a drop-shadow filter renders the
       shadow of the element's box rather than of its letters, so the counter
       came out as a grey slab with the word LAP beside it. Outlined type of
       this era was a solid colour and a one-pixel offset anyway. */
    color: #f6f6fb;
    text-shadow:
      2px 2px 0 rgba(0, 0, 0, 0.9),
      -1px -1px 0 rgba(0, 0, 0, 0.55),
      0 0 10px rgba(255, 255, 255, 0.12);
  }
  .gt-chrome-num { font-size: 46px; line-height: 1; }
  .gt-chrome-slash { font-size: 34px; line-height: 1; }
  .gt-chrome-suffix { font-size: 20px; line-height: 1; letter-spacing: 0.1em; margin-left: 6px; }

  /* ------------------------------------------------------------------
     Position tower. On a race screen the standings are a stack of slanted
     plates down the edge of the picture, not a boxed panel: each row is
     its own cut parallelogram so the list reads as motion.
  ------------------------------------------------------------------ */
  .gt-tower-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 3px 14px 3px 8px;
    transform: skewX(-11deg);
    background: linear-gradient(90deg, rgba(4, 4, 10, 0.92), rgba(10, 24, 12, 0.72));
    box-shadow:
      inset 0 1px 0 0 rgba(160, 160, 175, 0.35),
      inset 0 -1px 0 0 rgba(0, 0, 0, 0.9);
  }
  /* The contents ride level while the plate stays cut. */
  .gt-tower-row > * {
    transform: skewX(11deg);
  }
  .gt-tower-leader {
    background: linear-gradient(90deg, rgba(46, 30, 4, 0.95), rgba(10, 24, 12, 0.72));
    box-shadow:
      inset 0 1px 0 0 rgba(255, 176, 32, 0.75),
      inset 0 -1px 0 0 rgba(0, 0, 0, 0.9);
  }

  /* The stage ident, bottom-cut like a livery decal. */
  .gt-ident {
    display: inline-block;
    padding: 4px 18px 4px 12px;
    transform: skewX(-11deg);
    background: linear-gradient(90deg, rgba(4, 4, 10, 0.94), rgba(18, 58, 23, 0.55));
    box-shadow: inset 0 1px 0 0 rgba(255, 176, 32, 0.6);
  }
  .gt-ident > * { display: inline-block; transform: skewX(11deg); }

  /* The same console bar, flipped, for the head of a screen. Its green edge
     faces out of the picture in both cases: on a race screen the tint sits
     at the bottom of the frame, so at the top it belongs at the top. */
  .gt-bar-top {
    background:
      linear-gradient(to top,
        rgba(4, 4, 10, 0) 0%,
        rgba(4, 4, 10, 0.86) 14%,
        #04040a 30%,
        #071408 62%,
        #123a17 100%);
    box-shadow: inset 0 -1px 0 0 rgba(143, 143, 156, 0.55);
  }

  /* A thin console strip for a running band — the ticker, a status line.
     Flat black-green with a hairline top and bottom, no bevel: it is a slot
     cut in the console, not a raised box. */
  .gt-strip {
    background: linear-gradient(to bottom, #04040a, #0b1e0e);
    box-shadow:
      inset 0 1px 0 0 rgba(160, 160, 175, 0.3),
      inset 0 -1px 0 0 rgba(0, 0, 0, 0.9);
  }

  /* A label/value pair as the console draws it: gold caps above, white
     numerals below, tight together so the pair reads as one instrument. */
  .gt-stack {
    display: inline-flex;
    flex-direction: column;
    gap: 1px;
    line-height: 1.1;
  }

  /* A results-board row. Those games listed standings on a flat dark plate
     with a single light rule along the top — no box, no bevel on all four
     sides — so a column of them reads as one board rather than as a stack of
     separate panels. The left edge carries the accent instead. */
  .gt-row {
    background: linear-gradient(90deg, rgba(6, 6, 12, 0.94), rgba(11, 26, 14, 0.82));
    box-shadow:
      inset 0 1px 0 0 rgba(160, 160, 175, 0.28),
      inset 0 -1px 0 0 rgba(0, 0, 0, 0.9);
  }
  /* Selected: the whole plate lifts to the gold register. Still one rule at
     the top and one down the left — a selection is brighter, not thicker. */
  .gt-row.ps1-cursor-on {
    background: linear-gradient(90deg, rgba(46, 30, 4, 0.95), rgba(11, 26, 14, 0.82));
    box-shadow:
      inset 0 1px 0 0 rgba(255, 176, 32, 0.85),
      inset 3px 0 0 0 rgba(255, 176, 32, 0.85),
      inset 0 -1px 0 0 rgba(0, 0, 0, 0.9);
  }

  /* The tower row as the standings board draws it: no plate, no rules.
     Written here, at the end, and as two classes rather than inline, because
     of where the other two rules live. The plate rule further up this file
     comes AFTER the newer base rule, so it wins on order; an inline override
     beats both but takes the paint shop's hover hairline with it, since a
     hover state cannot be expressed inline. Two classes and last word in the
     file keeps the flat look and gives the hairline back. */
  .gt-tower-row.arc-tower-row {
    background: transparent;
    box-shadow: none;
  }
  .gt-tower-row.arc-tower-row:hover,
  .gt-tower-row.arc-tower-row:focus-visible {
    box-shadow: inset 2px 0 0 0 #e02020;
  }

  /* A recess in the console: portraits, gauges, anything set into the face. */
  .gt-inset {
    background: #05050a;
    box-shadow:
      inset 2px 2px 0 0 #000,
      inset -2px -2px 0 0 rgba(160, 160, 175, 0.35);
  }
`
