// The venue: Tekken 3's forest stage, reduced to what the console could hold.
// One set of stops shared by the painted sky, the shader fog and every
// material in the scene, so geometry dissolves into the backdrop rather than
// ending against it — the same contract the race's tracks keep per-venue.

export const ARENA_SKY = {
  high: '#0a1810',
  mid: '#1c3a24',
  horizon: '#4a6b3a',
  glow: '#8fae5a',
  /** Scanline dither strength over the gradient. */
  dither: 0.22,
} as const

/** Fog range in world units. Near enough that the tree wall melts away. */
export const ARENA_FOG_NEAR = 9
export const ARENA_FOG_FAR = 26

/** The fighting ground: a stone court this many units across. */
export const ARENA_FLOOR_SIZE = 60

/** Internal render height — the pixel grid. The earlier machine's lines. */
export const ARENA_INTERNAL_HEIGHT = 270
