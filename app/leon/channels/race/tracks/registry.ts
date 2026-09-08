import driftYard from './drift-yard.track.json'
import lonePeak from './lone-peak.track.json'
import bushidoPeak from './bushido-peak.track.json'
import { RENDER_PROFILES, type BakedTrack, type TrackDefinition, type TrackSky } from './types'
import { PS1 } from '../../../ps1/theme'

// Every circuit the channel can run, and the rule for choosing between them.
//
// The geometry comes from the bake script; everything here is the art
// direction on top of it. Two things in particular are judgement calls that no
// script can make: which of a downloaded model's materials is the road and how
// it should be coloured, and how far the fog should reach on a circuit of this
// size. Both are wrong by default and right only once somebody looks.

/**
 * Fog is a distance, and a distance means nothing without a circuit to measure
 * it against. Tying both stops to the lap's own scale is what lets one shader
 * serve a 70-unit oval and a 340-unit road course: the far half of the track
 * dissolves in each case, which is exactly the trick the hardware was using
 * the fog for in the first place.
 */
function fogForRadius(radius: number): { near: number; far: number } {
  // Measured against how far the *model* reaches, not how big the lap is.
  // Those are two different distances and only one of them matters: a
  // downloaded circuit models the land immediately around its road and stops,
  // so a lap 340 units across can sit in a world only 450 across. Scaling the
  // fog to the lap left the far edge of that world fully lit, ending against
  // the sky in a hard line — which is the precise thing the era invented
  // distance fog to prevent. Finishing at 92% of the radius means the last of
  // the geometry has already gone before the geometry runs out.
  // The near stop sits well out. Pulling it in tinted the mid-ground towards
  // the sky before the eye had finished reading it, and on a circuit with real
  // texture pages that is throwing away the thing we just paid for.
  // 0.55/1.02 after the colour pipeline was fixed: the old, darker picture
  // could stand more haze, and the mountain rips — where every sightline is
  // long — were arriving as fog with a race in front of it. The far stop now
  // sits just past the world's edge, which still catches it before it can
  // silhouette against the sky.
  return { near: radius * 0.55, far: radius * 1.02 }
}

/**
 * Reads a baked track's generated numbers into a definition, leaving the
 * palette and fog to the caller. Control points arrive as `number[]` from
 * JSON, so they are narrowed to triples here rather than at every use site.
 */
function fromBaked(
  baked: BakedTrack,
  art: Pick<TrackDefinition, 'title' | 'surfaces' | 'sky'> & Partial<TrackDefinition>,
): TrackDefinition {
  // See `worldScale`: the traced line has to be scaled with the geometry it
  // was traced from, or the cars drive beside the road rather than on it.
  const worldScale = art.worldScale ?? 1
  return {
    slug: baked.slug,
    model: `/ps1/tracks/${baked.slug}.glb`,
    controlPoints: baked.controlPoints.map(
      ([x, y, z]) => [x * worldScale, y * worldScale, z * worldScale] as const,
    ),
    roadHalfWidth: baked.roadHalfWidth * worldScale,
    laneCount: 8,
    curveTension: 0.5,
    // An imported circuit brings its own barriers, fences and foliage.
    // Scattering ours on top of them puts oil drums through the grandstand.
    proceduralScenery: false,
    fog: fogForRadius(baked.modelRadius * worldScale),
    // Imported circuits are the later machine: they arrive with real texture
    // pages and enough geometry to deserve them, and at 450 units across the
    // earlier machine's wobble is noise rather than signature.
    render: RENDER_PROFILES.ps2,
    ...art,
  }
}

/**
 * The original hand-built oval. Kept in the rotation rather than deleted: it
 * is the only circuit whose road is generated from the spline rather than
 * loaded, so it is also the thing that proves the spline and the tarmac still
 * agree. When a kart leaves the road on an imported track, run this one — if
 * it behaves here, the fault is in the trace, not the simulation.
 */
/**
 * The dusk the whole channel used to run under, kept for the oval — it was
 * painted against these exact stops.
 */
const DUSK_SKY: TrackSky = {
  high: '#100a2e',
  mid: '#4a1f63',
  horizon: '#c8438b',
  glow: '#ff9d4d',
  dither: 0.22,
}

/**
 * A race-day afternoon, taken from the reference racers rather than invented:
 * the era's circuit games were overwhelmingly bright daylight pictures — deep
 * blue overhead, paling towards a white haze at the horizon — and most of
 * what made this channel read as murky was simply holding a big green
 * circuit under a purple evening. The haze doubles as the fog colour, so the
 * far end of the circuit dissolves into daylight the way those games' did.
 */
const RACE_DAY_SKY: TrackSky = {
  high: '#2f6fd4',
  mid: '#79aae6',
  horizon: '#dcecf7',
  glow: '#ffffff',
  dither: 0.07,
}

const TOKEN_OVAL: TrackDefinition = {
  slug: 'token-oval',
  title: 'Token Oval',
  model: null,
  controlPoints: [
    [0, 0, -34],
    [22, 0, -28],
    [34, 0, -8],
    [30, 0, 14],
    [12, 0, 26],
    [-8, 0, 30],
    [-26, 0, 20],
    [-36, 0, 0],
    [-30, 0, -20],
    [-14, 0, -34],
  ],
  roadHalfWidth: 7.4,
  laneCount: 8,
  curveTension: 0.5,
  proceduralScenery: true,
  fog: { near: 45, far: 165 },
  render: RENDER_PROFILES.ps1,
  sky: DUSK_SKY,
  surfaces: {
    // The road has to out-read the sky behind it or the karts float in the
    // dusk. Fully ambient because a flat surface gets no useful Gouraud
    // variation anyway.
    road: { color: '#6b6b9e', ambient: 1, doubleSided: true },
    // The era's red-and-white rumble strip rather than neon: the one
    // saturated red on the circuit, so the edge of the road is the thing the
    // eye finds first.
    kerb: { color: PS1.red, emissive: 0.4, doubleSided: true },
    // Infield. Deep teal against the magenta dusk — the era's own colour
    // pairing, and it does the working job too: a green ground and a grey
    // road separate by hue rather than by brightness, so the circuit still
    // reads as a shape from the high wide shot where fog has flattened
    // everything into the same value.
    ground: { color: '#1e4a47', ambient: 1, doubleSided: true },
    pillar: { color: PS1.cyan, emissive: 0.5 },
    startLine: { color: PS1.text, emissive: 0.6 },
  },
}

const DRIFT_YARD = fromBaked(driftYard as BakedTrack, {
  title: 'Drift Yard',
  sky: RACE_DAY_SKY,
  // The one circuit whose bake measured a pad rather than a road, so it
  // arrived scaled up by roughly the ratio between the two and put toy cars
  // on a giant's track. See `worldScale` on TrackDefinition.
  worldScale: 0.55,
  // Five lanes rather than eight. The road is now 8 units across and the lane
  // inset is a car's own body, which does not shrink with the venue: eight
  // lanes on this circuit put the field shoulder to shoulder with the outside
  // two hanging over the kerb.
  laneCount: 5,
  surfaces: {
    // Daylight art direction, and almost no art direction at all: under a
    // bright sky the correct move is to get out of the model's way. The tints
    // are the last few percent that keep every surface breathing the same
    // air, not a palette imposed on top — the reference racers are colourful
    // because their assets were, and this model's pages are.
    Asphalt: { color: '#c9c9cf', tint: 0.05, ambient: 1, distant: true },
    // See `lift` on TrackSurface: the ground goes under the road, the painted
    // lines go on top of it, and neither is left to the depth buffer to guess.
    Ground: { color: '#7ec464', tint: 0.08, ambient: 1, lift: -0.25, distant: true },
    // Painted lines and skid marks — on a drift circuit, the record of what
    // the place is for.
    Decals: { color: '#ffffff', tint: 0.03, ambient: 1, lift: 0.05, distant: true },
    // Foliage cards. The source page is a white branch atlas that takes its
    // colour from the material, so this is the one surface whose tint has to
    // do real work — a full, saturated tree green, straight off the trackside
    // of the reference games.
    Leafs_Mat: {
      color: '#3d8f3a',
      tint: 0.55,
      ambient: 0.9,
      doubleSided: true,
      // Mipmapped like the ground: a leaf card at three hundred units is a
      // few pixels of a masked texture, and nearest sampling makes whole
      // trees blink between frames. The threshold sits low because averaging
      // a cut-out's alpha thins it as it recedes.
      distant: true,
      alphaTest: 0.36,
    },
    // Barriers, fencing and gantries. Untextured in the source; concrete-white
    // in the sun, as every trackside wall of the era was.
    Metal: { color: '#e2e2e6', ambient: 0.78 },
  },
})

/**
 * A cold alpine morning for the mountain circuit: paler and colder than race
 * day, with a white haze that reads as altitude. The rip's own snow and rock
 * do the rest.
 */
const ALPINE_SKY: TrackSky = {
  high: '#4a7fc9',
  mid: '#93b9df',
  horizon: '#e8f1f7',
  glow: '#ffffff',
  dither: 0.07,
}

/**
 * Late golden hour for the Japanese mountain — the arcade era's other
 * favourite time of day, and the one this rip's warm rock and red gates were
 * authored for.
 */
const GOLDEN_SKY: TrackSky = {
  high: '#3c5a9e',
  mid: '#c98a5e',
  horizon: '#f7d9a0',
  glow: '#ffe9b0',
  dither: 0.1,
}

/**
 * The two game rips share one treatment, and it is deliberately almost
 * nothing. Their hundred materials are spatial chunks with the game's own
 * art already baked into the pages — the machine this look imitates is the
 * machine the assets actually shipped on — so the registry's whole job is a
 * faint glaze and mipmaps. Masks, sidedness and flat colours are read off
 * the source materials per chunk; see TrackModel.
 */
const RIP_SURFACE_DEFAULTS = { tint: 0.05, ambient: 0.9, distant: true } as const

const LONE_PEAK = fromBaked(lonePeak as BakedTrack, {
  title: 'Lone Peak',
  sky: ALPINE_SKY,
  surfaces: {
    // The rip's own backdrop — the distant mountains and valley town. The
    // game shipped this chunk untextured (it was designed to be read through
    // haze), so left alone it wore the pipeline's deliberate fallback grey
    // and filled half of every wide shot with "unfinished". Painted here to
    // sit between the terrain and ALPINE_SKY's mid stop, which is what a
    // backdrop is: scenery already half-way to being sky.
    Merged_materials: { color: '#a8bcd6', ambient: 1, distant: true },
  },
  surfaceDefaults: RIP_SURFACE_DEFAULTS,
})

const BUSHIDO_PEAK = fromBaked(bushidoPeak as BakedTrack, {
  title: 'Bushido Peak',
  sky: GOLDEN_SKY,
  surfaces: {
    // Same story as Lone Peak's backdrop, in this valley's own light: warm
    // rock headed towards GOLDEN_SKY's horizon rather than alpine haze.
    Merged_materials: { color: '#b08a66', ambient: 1, distant: true },
  },
  surfaceDefaults: RIP_SURFACE_DEFAULTS,
})

export const TRACKS: ReadonlyArray<TrackDefinition> = [
  DRIFT_YARD,
  LONE_PEAK,
  BUSHIDO_PEAK,
  TOKEN_OVAL,
]

/**
 * The venues that take a turn on the channel. The oval sits outside the
 * rotation — it is the debugging control, not a destination — but stays in
 * TRACKS so it can be pointed at directly when a trace goes wrong.
 */
const ROTATION: ReadonlyArray<TrackDefinition> = [DRIFT_YARD, LONE_PEAK, BUSHIDO_PEAK]

/** How long one venue holds the channel before the race moves on. */
export const RACE_WINDOW_MS = 20 * 60 * 1000

/**
 * Which circuit is being raced right now.
 *
 * The rotation advances on a fixed clock window rather than per leaderboard
 * period, so a screen that runs all day walks through every venue rather than
 * spending eight hours at one. Everything is derived from wall time and the
 * period key — no stored state, no randomness at runtime — so every viewer of
 * the same moment sees the same circuit, and a reload lands back on it.
 *
 * The shuffle is a hash, not Math.random, for the same reason: "random
 * cycling" here means *unpredictable order, agreed by everyone*, and only a
 * deterministic function gives both. Consecutive windows are guaranteed
 * different venues — a rotation that draws the same track twice reads as a
 * broken rotation, not as chance.
 */
export function trackForRaceWindow(
  periodKey: string | undefined,
  now: number,
): TrackDefinition {
  if (ROTATION.length === 0) return TRACKS[0]
  const window = Math.floor(now / RACE_WINDOW_MS)
  const pick = (value: number): number => hashString(`${periodKey ?? ''}:${value}`) % ROTATION.length
  let index = pick(window)
  if (index === pick(window - 1)) index = (index + 1) % ROTATION.length
  return ROTATION[index]
}

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash
}
