// The theatre: a summer afternoon over the south of England, reduced to what
// the console could hold. One set of stops shared by the painted sky, the
// shader fog and every material in the scene — same contract as the other
// venues keep.
//
// The stops are read off the skybox's own page (scripts/bakeSkybox.mjs
// prints them), so the fog the ground dissolves into is the band the dome
// wears at the same height, and the horizon is one line rather than two.

export const THEATRE_SKY = {
  /** The zenith. */
  high: '#305fc9',
  /** The dome's wall a few degrees under the seam: where the ground fogs to. */
  mid: '#5cd2ff',
  /** The seam itself, the bright haze line at eye level. */
  horizon: '#b0dffc',
  glow: '#fff0c0',
  /** Scanline dither strength over the fallback gradient. */
  dither: 0.16,
} as const

/**
 * The sky: a cube hung on the camera, drawn first and unfogged. Half-extent
 * one in the bake, so `radius` is its size in world units — kept inside the
 * camera's far plane, corners included, or the top of the sky is clipped.
 */
export const SKYBOX = {
  modelUrl: '/ps1/theatre/skydays.glb',
  radius: 120,
} as const

/**
 * Fog range in world units. Starts past the far side of the combat box so
 * the patrol is drawn clean from the wide shot, and closes far enough out
 * that the fields under it read as fields before they go to haze.
 */
export const THEATRE_FOG_NEAR = 70
export const THEATRE_FOG_FAR = 230

/** Radius of the combat box the patrol wheels inside. */
export const COMBAT_BOX_RADIUS = 26

/** Altitude band, world units above the fields. */
export const ALTITUDE_FLOOR = 7
export const ALTITUDE_CEILING = 15

/** Internal render height — the pixel grid. */
export const THEATRE_INTERNAL_HEIGHT = 270
