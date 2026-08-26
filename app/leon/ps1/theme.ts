// PS1-era visual constants for Leon mode.
//
// The look is built from what the hardware actually did, not from nostalgia
// filters: 15-bit colour (5 bits per channel, hence the visible banding),
// integer vertex snapping (the famous wobble), flat/Gouraud vertex lighting,
// distance fog to hide the near clip plane, and chunky bevelled menu chrome
// drawn from 2px hard-edged highlights rather than gradients or blur.

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
