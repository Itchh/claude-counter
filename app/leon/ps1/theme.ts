// PS1-era visual constants for Leon mode.
//
// The look is built from what the hardware actually did, not from nostalgia
// filters: 15-bit colour (5 bits per channel, hence the visible banding),
// integer vertex snapping (the famous wobble), flat/Gouraud vertex lighting,
// distance fog to hide the near clip plane, and chunky bevelled menu chrome
// drawn from 2px hard-edged highlights rather than gradients or blur.

/**
 * The two faces, split by job. HUD is the square condensed one from the life
 * bars — labels, numbers, menu items, anything that has to sit in a box.
 * Codec is wider and only earns its place on headings and idents.
 *
 * Declared in globals.css; referenced here so components never hardcode the
 * family string.
 */
export const FONTS = {
  hud: 'var(--font-ps1-hud)',
  codec: 'var(--font-ps1-codec)',
} as const

export const PS1 = {
  void: '#07070d',
  fog: '#141430',
  panel: '#1b1b3d',
  panelDeep: '#12122b',
  bevelLight: '#4d4d92',
  bevelDark: '#0a0a18',
  text: '#d6d6f2',
  textDim: '#7a7ab0',
  textFaint: '#4a4a75',
  hot: '#ff2d95',
  cyan: '#00f0ff',
  green: '#00ff88',
  gold: '#ffb020',
  red: '#ff4d4d',
} as const

/**
 * The arcade-sim HUD palette, taken from the late-90s console racers rather
 * than from the menu chrome above.
 *
 * Those games ran two visual registers at once and never mixed them: the menus
 * were blue bevelled boxes, but the in-race HUD was a black console bar tinted
 * green at the foot of the screen, carrying gold condensed labels, white
 * numerals, an amber LCD speed readout and a real analogue dial. That split is
 * why a race screen of the period reads as instrumentation and a menu reads as
 * furniture — so both palettes live here side by side, and a component picks
 * the one that matches its job.
 */
export const GT = {
  /** The console bar: black at the top edge, tinted green at the bottom. */
  barTop: '#04040a',
  barMid: '#071408',
  barBottom: '#123a17',
  /** Hairline that separates the bar from the picture above it. */
  barEdge: '#8f8f9c',
  /** Condensed caps that name a readout. Never used for a value. */
  label: '#ffb020',
  /** Numerals. Paper white, because the label carries the colour. */
  value: '#f4f4f8',
  valueDim: '#9a9aa6',
  /** Amber LCD: lit segments, and the unlit bed they sit in. */
  lcd: '#ff8c1a',
  lcdBed: '#241a06',
  /** Bevelled metal for gear boxes and status chips. */
  metalHi: '#c9c9d4',
  metalFace: '#5a5a66',
  metalLo: '#1c1c22',
  /** The map: a plain white line drawing, no fill, no glow. */
  mapLine: '#f4f4f8',
  mapMarker: '#3b6dff',
  /** The tachometer. */
  dialFace: '#0b0b10',
  dialRim: '#a8a8b6',
  dialTick: '#e6e6ee',
  needle: '#ff6a1a',
  redline: '#d21f1f',
} as const

/**
 * The arcade UI kit — the platform's own, drawn in Figma and exported as the
 * kit file, and from here on the ground for every piece of deck chrome.
 *
 * It is a third register alongside the two above, and the one that wins on
 * flat screens: not the menu's blue bevelled furniture and not the race bar's
 * green console, but the attract-mode board — black ground, red labels cut
 * with a lower bevel, white numerals outlined in black, amber for anything
 * live, a two-stop chrome ramp for positions, and one green LCD.
 *
 * Nothing in it glows. Every piece of depth is a hard offset: an outline at
 * one or two pixels and a drop at four. That is the whole reason the era's
 * boards stayed legible over a moving picture, and a blur anywhere in here
 * undoes it.
 */
export const ARCADE = {
  /** The ground. Everything else is drawn on this. */
  ground: '#0a0a0a',
  /** A recess in the ground — LCD beds, telemetry plates. */
  groundDeep: '#050505',
  /** Panel rules. The kit draws a frame, never a fill. */
  rule: '#1e1e1e',
  /** Every label. Red, with `labelShadow` sitting under it as the bevel. */
  label: '#e02020',
  labelShadow: '#6b0000',
  /** Primary values. Paper white — the label carries the colour. */
  value: '#ffffff',
  /** Captions and units. */
  silver: '#c8c8c8',
  /** Meta: the line under a caption that nobody reads twice. */
  grey: '#8a8a8a',
  /** Anything live: a running clock, a rate, a number still moving. */
  amber: '#ffb000',
  amberShadow: '#a05000',
  /** LCD green, and the unlit bed it sits in. */
  telemetry: '#4cff3c',
  telemetryBed: '#123a10',
  /** Outline and drop. Not a colour choice — the kit's structure. */
  outline: '#000000',
  /** Menu ground. Used for the head of a screen and nothing else. */
  menuBlue: '#1030c0',
  /** Attract mode and hazards. The only saturated non-signal colour. */
  hazard: '#ff00a0',
  /** The two-stop ramp that makes a numeral read as chrome. */
  chromeHigh: '#ffffff',
  chromeLow: '#8a8a8a',
  chromeFoot: '#c8c8c8',
} as const

/** The chrome ramp as a CSS image, for clipping to glyphs or filling a chip. */
export const ARCADE_CHROME_RAMP = `linear-gradient(${ARCADE.chromeHigh} 0%, ${ARCADE.chromeHigh} 46%, ${ARCADE.chromeLow} 46%, ${ARCADE.chromeFoot} 100%)`

/**
 * Dusk backdrop for the 3D channels. The era's racers almost never rendered a
 * black void: the far plane was hidden behind a painted sky that the fog
 * colour matched exactly, so geometry dissolved into the horizon instead of
 * ending at it. These three stops are that sky, and PS1.fog is sampled from
 * the middle one — change one and change the other.
 */
export const PS1_SKY = {
  high: '#100a2e',
  mid: '#4a1f63',
  horizon: '#c8438b',
  glow: '#ff9d4d',
} as const

/**
 * Type scale for the 3D channels, in pixels.
 *
 * Deliberately fixed rather than viewport-relative. The old `clamp(9px,
 * 1.1vw, 13px)` pattern hit its ceiling almost immediately, so a wall-sized
 * display rendered exactly the same 13px as a laptop — the bigger the screen,
 * the smaller the type read. Fixed sizes with real steps between them give
 * the HUD an actual hierarchy, and the room reads it from across the office.
 */
export const PS1_TYPE = {
  /** Lap count. The one number visible from the far end of the room. */
  display: 44,
  /** Channel and stage idents. */
  title: 22,
  /** Driver names in the tower, POV ident. */
  body: 18,
  /** Scores, positions, secondary readouts. */
  label: 14,
  /** Units, footnotes, anything that only matters up close. */
  micro: 12,
} as const

/** 15-bit colour: 5 bits per channel, exactly as the console's framebuffer. */
const COLOR_LEVELS = 32
const CHANNEL_MAX = 255

export function quantize15Bit(channel: number): number {
  const clamped = Math.max(0, Math.min(CHANNEL_MAX, channel))
  const step = CHANNEL_MAX / (COLOR_LEVELS - 1)
  return Math.round(Math.round(clamped / step) * step)
}

export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

export function hexToRgb(hex: string): Rgb {
  const clean = hex.replace('#', '')
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  }
}

/** Vertex-lit, fogged, then crushed to 15-bit. The whole shader, basically. */
export function shadeToCss(base: Rgb, lambert: number, fogAmount: number): string {
  const fog = hexToRgb(PS1.fog)
  const mix = (channel: number, fogChannel: number): number =>
    quantize15Bit(channel * lambert * (1 - fogAmount) + fogChannel * fogAmount)
  return `rgb(${mix(base.r, fog.r)},${mix(base.g, fog.g)},${mix(base.b, fog.b)})`
}

/**
 * Stat block derived from real usage. Tokens are the only currency this app
 * has, so every game-facing number has to fall out of them.
 */
export interface PowerStats {
  readonly level: number
  readonly power: number
  readonly speed: number
}

// Levelling is deliberately square-root shaped: a linear curve pins everyone
// at the cap within a week, and the point of a level is to separate players,
// not to reward raw volume. 1M tokens = LV1, 100M = LV10, 9.8B = LV99.
const TOKENS_PER_LEVEL_UNIT = 1_000_000
const MAX_LEVEL = 99
const POWER_SCALE = 1_000_000
const SPEED_SCALE = 1_000

export function toPowerStats(totalTokens: number, tokensPerMinute: number): PowerStats {
  const rawLevel = Math.floor(Math.sqrt(Math.max(0, totalTokens) / TOKENS_PER_LEVEL_UNIT))
  return {
    level: Math.max(1, Math.min(MAX_LEVEL, rawLevel)),
    power: Math.round(totalTokens / POWER_SCALE),
    speed: Math.round(tokensPerMinute / SPEED_SCALE),
  }
}
