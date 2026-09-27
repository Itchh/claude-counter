import manifest from './stages.json'

// Every venue the fight can be held in, and the rule for choosing between
// them.
//
// Same split as the race's tracks. The geometry — where the floor is along
// the line, how far either way a fighter can stand — is measured by
// scripts/bakeStages.mjs and arrives as generated JSON that nobody should
// be typing. The art direction on top of it — the name on the HUD, the sky
// and with it the fog, what the source model's pages need — is judgement,
// and lives here where it can be argued with.
//
// The baked locations lead the rotation, so the first bout of the day is
// held somewhere real. The forest court — built from boxes in fog, the venue
// the channel opened with — closes it, kept because the channel is not
// obliged to throw away where it started.

export interface StageSky {
  readonly high: string
  readonly mid: string
  readonly horizon: string
  readonly glow: string
  /** Scanline dither strength over the gradient. */
  readonly dither: number
}

export interface StageMaterialTreatment {
  /** Alpha below which a textured fragment is discarded. For leaf cards. */
  readonly alphaTest?: number
  /** Lifts a surface out of the lighting model. */
  readonly ambient?: number
}

/** The venue's camera: see StageDefinition.camera. Distance and fov are multipliers on the scene's defaults. */
export interface StageCamera {
  /** World z the ring line sits on. */
  readonly ringZ: number
  /** Multiplies the scene's stand-off distance. 1 is the default. */
  readonly distance: number
  /** Multiplies the scene's field of view. 1 is the default. */
  readonly fov: number
}
const DEFAULT_CAMERA: StageCamera = { ringZ: 0, distance: 1, fov: 1 }

/** The measured line: where a fighter can stand, and how high the floor is. */
export interface StageLine {
  readonly minX: number
  readonly maxX: number
  /** Floor height relative to the centre, one sample per `step` from -extent to +extent. */
  readonly floors: ReadonlyArray<number>
  readonly step: number
}

export interface StageDefinition {
  readonly slug: string
  /** Shown on the HUD. The place's name, not the file's. */
  readonly title: string
  /** Baked model under `/ps1/stages`, or null for the built forest court. */
  readonly model: string | null
  readonly sky: StageSky
  /** Fog range in world units. Near enough that the far end melts away. */
  readonly fog: { readonly near: number; readonly far: number }
  readonly line: StageLine
  /**
   * World units per fighter unit. The simulation fights at the fighters'
   * own scale — a body is 1.83 tall, a stance is 1.55 either side of
   * centre — and the scene multiplies by this to put them in the venue.
   * The scanned venues are big: the Kings' Chamber spans a hundred units,
   * and a life-size fighter in it reads as a figurine in a hall. Scaling
   * the fighters up (and the camera with them, so the framing is the same
   * shot) is the honest fix; shrinking the stage would shrink the pillars
   * they were measured against. See ringLine and ringFloorAt.
   */
  readonly fighterScale: number
  /**
   * Where the ring sits and how the camera stands off it, per venue. A scan
   * has colonnades where it has them: Kings' Chamber's pillar rows fall at
   * z ≈ -3 and z ≈ 5, and the default camera — three and a half fighter
   * units back, times the scale — stood inside the far row with a column
   * between it and the pair. `ringZ` slides the pair along the hall and
   * `cameraDistance` scales the stand-off so the lens stays in the clear
   * lane; `fov` widens to keep the framing the same from closer in.
   */
  readonly camera: StageCamera
  /** Per-material treatment, keyed by the model's own material names. */
  readonly surfaces: Readonly<Record<string, StageMaterialTreatment>>
  /** Treatment for every material `surfaces` does not name. */
  readonly surfaceDefaults: StageMaterialTreatment
}

interface ManifestMaterial {
  readonly name: string
  readonly alphaMode: string
  readonly doubleSided: boolean
  readonly textured: boolean
}

interface ManifestStage {
  readonly slug: string
  readonly triangles: number
  readonly bounds: { readonly min: ReadonlyArray<number>; readonly max: ReadonlyArray<number> }
  readonly line: { readonly extent: { readonly minX: number; readonly maxX: number }; readonly step: number; readonly floors: ReadonlyArray<number> }
  readonly materials: ReadonlyArray<ManifestMaterial>
}

interface Manifest {
  readonly stages: ReadonlyArray<ManifestStage>
}

const BAKED: Manifest = manifest

/** The forest court's own line: flat, and as wide as the original stance allowed. */
const COURT_LINE: StageLine = { minX: -3.6, maxX: 3.6, floors: [0, 0], step: 7.2 }

/**
 * The original venue's sky — Tekken 3's forest, reduced to what the console
 * could hold — kept exactly as it was so the court looks as it always did.
 */
export const COURT_SKY: StageSky = {
  high: '#0a1810',
  mid: '#1c3a24',
  horizon: '#4a6b3a',
  glow: '#8fae5a',
  dither: 0.22,
}

function fromBaked(
  baked: ManifestStage,
  art: Pick<StageDefinition, 'title' | 'sky' | 'fog' | 'fighterScale'> & Partial<Pick<StageDefinition, 'camera'>> &
    Partial<Pick<StageDefinition, 'surfaces' | 'surfaceDefaults'>>,
): StageDefinition {
  // What the source said about its own pages is the default treatment: a
  // material the model masked is a cut-out here too.
  const surfaces: Record<string, StageMaterialTreatment> = {}
  for (const material of baked.materials) {
    if (material.alphaMode === 'MASK' || material.alphaMode === 'BLEND') {
      surfaces[material.name] = { alphaTest: 0.5 }
    }
  }
  return {
    slug: baked.slug,
    model: `/ps1/stages/${baked.slug}.glb`,
    line: {
      minX: baked.line.extent.minX,
      maxX: baked.line.extent.maxX,
      floors: baked.line.floors,
      step: baked.line.step,
    },
    surfaces: { ...surfaces, ...(art.surfaces ?? {}) },
    surfaceDefaults: art.surfaceDefaults ?? {},
    title: art.title,
    sky: art.sky,
    fog: art.fog,
    fighterScale: art.fighterScale,
    camera: art.camera ?? DEFAULT_CAMERA,
  }
}

function bakedStage(slug: string): ManifestStage {
  const found = BAKED.stages.find((stage) => stage.slug === slug)
  if (!found) throw new Error(`stages.json has no stage "${slug}" — run scripts/bakeStages.mjs`)
  return found
}

export const STAGES: ReadonlyArray<StageDefinition> = [
  fromBaked(bakedStage('kings-chamber'), {
    title: "Kings' Chamber",
    // Torchlight in sandstone: an amber ground that goes to black overhead.
    sky: { high: '#07040a', mid: '#2a1a10', horizon: '#6a4020', glow: '#c07a30', dither: 0.2 },
    fog: { near: 8, far: 24 },
    fighterScale: 1.6,
    // Between the colonnades: pair a step back, lens inside the near row.
    camera: { ringZ: -0.8, distance: 0.75, fov: 1.14 },
    surfaceDefaults: { ambient: 0.7 },
  }),
  fromBaked(bakedStage('moss-shrine'), {
    title: 'Moss Shrine',
    // Wet green afternoon under a canopy.
    sky: { high: '#142a1e', mid: '#3a5a3c', horizon: '#8aa070', glow: '#d8e0a0', dither: 0.18 },
    fog: { near: 12, far: 34 },
    fighterScale: 1.4,
    surfaceDefaults: { ambient: 0.66 },
  }),
  fromBaked(bakedStage('temple-of-winds'), {
    title: 'Temple of the Winds',
    // Bleached noon: a scan's page carries its own sun, so the sky is pale
    // and the fog is far.
    sky: { high: '#3a6ab0', mid: '#8ab0d8', horizon: '#e8e0c8', glow: '#fff4d0', dither: 0.14 },
    fog: { near: 16, far: 44 },
    fighterScale: 1.5,
    // The right-hand columns stand at z ≈ 4; the lens stops short of them.
    camera: { ringZ: -0.6, distance: 0.8, fov: 1.1 },
    surfaceDefaults: { ambient: 0.78 },
  }),
  {
    slug: 'forest-court',
    title: 'Forest Court',
    model: null,
    sky: COURT_SKY,
    fog: { near: 9, far: 26 },
    line: COURT_LINE,
    // Built to the fighters in the first place.
    fighterScale: 1,
    camera: DEFAULT_CAMERA,
    surfaces: {},
    surfaceDefaults: {},
  },
]

/**
 * The stage a bout is held on. One per bout, in order, so every fight moves
 * the card somewhere new and the rotation comes round again.
 */
export function stageForBout(bout: number): StageDefinition {
  return STAGES[((bout % STAGES.length) + STAGES.length) % STAGES.length]
}

export function stageBySlug(slug: string): StageDefinition {
  return STAGES.find((stage) => stage.slug === slug) ?? STAGES[0]
}

/**
 * The floor's height under a point on the line, from the bake's samples.
 * Linear between samples, held flat beyond the last one.
 */
export function stageFloorAt(line: StageLine, x: number): number {
  const count = line.floors.length
  if (count === 0) return 0
  const extent = ((count - 1) / 2) * line.step
  const position = (x + extent) / line.step
  const lower = Math.max(0, Math.min(count - 1, Math.floor(position)))
  const upper = Math.max(0, Math.min(count - 1, lower + 1))
  const t = Math.max(0, Math.min(1, position - lower))
  return line.floors[lower] + (line.floors[upper] - line.floors[lower]) * t
}

/** The stage's line in fighter units: where the simulation may stand them. */
export interface RingLine {
  readonly minX: number
  readonly maxX: number
}

/**
 * The measured line brought down to the fighters' scale, for the
 * simulation's clamps. A fighter at ring x stands at world x * fighterScale.
 */
export function ringLine(stage: StageDefinition): RingLine {
  return { minX: stage.line.minX / stage.fighterScale, maxX: stage.line.maxX / stage.fighterScale }
}

/**
 * The floor under a ring x, in fighter units — the world height divided by
 * the same scale, so a fighter placed inside the scaled group lands on it.
 */
export function ringFloorAt(stage: StageDefinition, ringX: number): number {
  return stageFloorAt(stage.line, ringX * stage.fighterScale) / stage.fighterScale
}

/** Every baked venue, warmed before its bout comes round. */
export function stageModelUrls(): ReadonlyArray<string> {
  return STAGES.flatMap((stage) => (stage.model ? [stage.model] : []))
}
