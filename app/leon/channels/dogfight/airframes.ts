import { AIRFRAME_COUNT } from '@/lib/livery'
import { stableBucket } from '@/lib/stableHash'
import manifest from './airframes.json'

// The squadron. Five airframes baked from downloaded models — see
// scripts/bakePlanes.mjs — every one turned to fly down +z and scaled to the
// same nose-to-tail length, so the simulation flies one plane and the reader
// supplies the type. Identity by silhouette, exactly as the cars: eight
// Spitfires in eight colours is a chart with wings.
//
// What the bake measured lives in airframes.json beside this file: the span,
// where the hub is, how wide the airscrew's disc. What it could not measure
// — where the guns are — is written here by hand against those numbers, in
// the same normalised units.

export interface Airframe {
  readonly slug: string
  /** The type, as the hangar prints it. */
  readonly name: string
  /** One line under the name. */
  readonly note: string
  readonly modelUrl: string
  readonly length: number
  readonly span: number
  readonly height: number
  /** The airscrew's axis, on the airframe's own centreline. */
  readonly hub: readonly [number, number, number]
  /** Radius of the disc the airscrew sweeps. */
  readonly propRadius: number
  /**
   * True when the baked model carries a `propeller` node to spin. False for
   * the photogrammetry scan whose blades are fused into the cowling, which
   * gets a built airscrew at `hub` instead.
   */
  readonly hasProp: boolean
  /** Muzzle positions, in airframe space. Tracer leaves from each of these. */
  readonly guns: ReadonlyArray<readonly [number, number, number]>
}

interface ManifestAirframe {
  readonly slug: string
  readonly length: number
  readonly span: number
  readonly height: number
  readonly hub: ReadonlyArray<number>
  readonly propRadius: number
  readonly hasProp: boolean
}

interface ManifestTerrain {
  readonly slug: string
  readonly width: number
  readonly depth: number
  readonly floor: number
  readonly peak: number
}

interface Manifest {
  readonly airframes: ReadonlyArray<ManifestAirframe>
  readonly terrain: ManifestTerrain
}

const BAKED: Manifest = manifest

interface AirframeAuthoring {
  readonly name: string
  readonly note: string
  readonly guns: ReadonlyArray<readonly [number, number, number]>
}

/**
 * The hand-written half. Gun positions are read off the baked silhouettes:
 * wing guns sit a third of the way out along the span just behind the
 * leading edge, cowl guns straddle the centreline a hair above the hub.
 */
const AUTHORING: Readonly<Record<string, AirframeAuthoring>> = {
  spitfire: {
    name: 'Spitfire',
    note: 'Eight Brownings in the wings',
    guns: [
      [-0.42, -0.03, 0.35],
      [0.42, -0.03, 0.35],
      [-0.58, -0.03, 0.32],
      [0.58, -0.03, 0.32],
    ],
  },
  corsair: {
    name: 'F4U Corsair',
    note: 'Six fifties, three a wing',
    guns: [
      [-0.62, -0.2, 0.3],
      [0.62, -0.2, 0.3],
      [-0.74, -0.19, 0.28],
      [0.74, -0.19, 0.28],
    ],
  },
  zero: {
    name: 'A6M Zero',
    note: 'Cowl guns and wing cannon',
    guns: [
      [-0.07, 0.09, 0.9],
      [0.07, 0.09, 0.9],
      [-0.5, -0.02, 0.3],
      [0.5, -0.02, 0.3],
    ],
  },
  camel: {
    name: 'Sopwith Camel',
    note: 'Twin Vickers over the cowling',
    guns: [
      [-0.06, 0.22, 0.8],
      [0.06, 0.22, 0.8],
    ],
  },
  yak: {
    name: 'Yak-11',
    note: 'One cowl gun, and nerve',
    guns: [
      [-0.08, 0.05, 0.9],
      [0.08, 0.05, 0.9],
    ],
  },
}

function toAirframe(baked: ManifestAirframe): Airframe {
  const authored = AUTHORING[baked.slug]
  if (!authored) throw new Error(`Airframe "${baked.slug}" is baked but not authored`)
  const [hubX = 0, hubY = 0, hubZ = 0] = baked.hub
  return {
    slug: baked.slug,
    name: authored.name,
    note: authored.note,
    modelUrl: `/ps1/planes/${baked.slug}.glb`,
    length: baked.length,
    span: baked.span,
    height: baked.height,
    hub: [hubX, hubY, hubZ],
    propRadius: baked.propRadius,
    hasProp: baked.hasProp,
    guns: authored.guns,
  }
}

export const AIRFRAMES: ReadonlyArray<Airframe> = BAKED.airframes.map(toAirframe)

if (AIRFRAMES.length !== AIRFRAME_COUNT) {
  // The catalogue, the mutation's check and the hangar's cycle are all built
  // to AIRFRAME_COUNT; a bake that adds a plane has to update lib/livery.ts.
  throw new Error(`airframes.json has ${AIRFRAMES.length} airframes; lib/livery.ts expects ${AIRFRAME_COUNT}`)
}

/**
 * The airframe a pilot is drawn in: the one they chose in the hangar, or —
 * until they have — the one their key hashes to. Every surface that draws a
 * plane goes through this, so a choice made in the window lands on the
 * patrol in the same subscription tick.
 */
export function airframeOf(key: string, chosen: number | null | undefined): number {
  if (chosen !== null && chosen !== undefined && Number.isInteger(chosen) && chosen >= 0 && chosen < AIRFRAMES.length) {
    return chosen
  }
  return stableBucket(key, AIRFRAMES.length)
}

export function airframeFor(index: number): Airframe {
  return AIRFRAMES[((index % AIRFRAMES.length) + AIRFRAMES.length) % AIRFRAMES.length]
}

/** The hillside under the patrol, as the bake left it. */
export const TERRAIN = {
  modelUrl: `/ps1/theatre/${BAKED.terrain.slug}.glb`,
  width: BAKED.terrain.width,
  depth: BAKED.terrain.depth,
  floor: BAKED.terrain.floor,
  peak: BAKED.terrain.peak,
} as const
