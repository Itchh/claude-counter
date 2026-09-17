// The theatre: a summer afternoon over the south of England, reduced to what
// the console could hold. One set of stops shared by the painted sky, the
// shader fog and every material in the scene — same contract as the other
// venues keep.

export const THEATRE_SKY = {
  high: '#2a5a9a',
  mid: '#6a94bd',
  horizon: '#cfd4c2',
  glow: '#fff0c0',
  /** Scanline dither strength over the gradient. */
  dither: 0.16,
} as const

/** Fog range in world units. The haze the whole battle happened in. */
export const THEATRE_FOG_NEAR = 34
export const THEATRE_FOG_FAR = 95

/** Radius of the combat box the patrol wheels inside. */
export const COMBAT_BOX_RADIUS = 26

/** Altitude band, world units above the fields. */
export const ALTITUDE_FLOOR = 7
export const ALTITUDE_CEILING = 15

/** Internal render height — the pixel grid. */
export const THEATRE_INTERNAL_HEIGHT = 270
