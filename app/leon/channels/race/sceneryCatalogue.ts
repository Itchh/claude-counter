import * as THREE from 'three'
import { createPs1Material, configurePs1Texture } from './Ps1Material'

// The trackside catalogue: which prop comes from which pack, and how big it
// actually is.
//
// Nothing in these packs is delivered at a usable scale — a soda machine and a
// cargo container both arrive about two units across, because each was
// modelled in isolation, and the barrel arrives three metres tall. So every
// prop carries its own real-world height in metres and is normalised to it on
// load, measured against what is already in the scene: the road is 14.8m
// wide, a car is 2.6m long, the kerb is 0.75m of rumble strip.
//
// Heights are the model's Y extent as it stands, not its longest side — a
// tyre lying flat is 0.25m tall and 0.75m across, and asking for 0.7 would
// inflate it into a tractor wheel. The industrial pack is already close to
// true metres, so most of these numbers agree with the source; the street
// pack and the loose barrel are not, and those are the ones this fixes.

export const SCENERY_MODELS = {
  industrial: '/ps1/scenery/industrial.glb',
  street: '/ps1/scenery/street-props.glb',
  barrel: '/ps1/scenery/barrel.glb',
} as const

export type SceneryPack = keyof typeof SCENERY_MODELS

/**
 * Where a prop belongs relative to the racing line.
 *
 * `barrier` hugs the kerb and lines up with the track, because that is what a
 * barrier is for. `verge` sits just off the tarmac. `yard` is the industrial
 * clutter further out, which the onboard camera only ever catches as a blur —
 * it is there to give the vertex wobble something to happen to.
 */
export type SceneryZone = 'barrier' | 'verge' | 'yard'

export interface SceneryProp {
  readonly pack: SceneryPack
  /** Node name inside the pack. Case-sensitive; see the pack's own hierarchy. */
  readonly node: string
  /** Real-world height in metres. The model is scaled uniformly to match. */
  readonly height: number
  readonly zone: SceneryZone
  /** Relative frequency. A field of nothing but propane tanks reads as a bug. */
  readonly weight: number
}

export const SCENERY_PROPS: ReadonlyArray<SceneryProp> = [
  // Barriers — the run-off furniture, aligned with the track.
  { pack: 'street', node: 'barriers1', height: 1.1, zone: 'barrier', weight: 3 },
  { pack: 'street', node: 'barriers2', height: 1.1, zone: 'barrier', weight: 3 },
  { pack: 'street', node: 'barriers3', height: 1.1, zone: 'barrier', weight: 2 },
  { pack: 'industrial', node: 'Tires', height: 0.8, zone: 'barrier', weight: 3 },
  { pack: 'industrial', node: 'Tire', height: 0.25, zone: 'barrier', weight: 2 },

  // Verge — close enough to read at speed from the onboard camera.
  { pack: 'barrel', node: 'Cylinder.001', height: 0.9, zone: 'verge', weight: 3 },
  { pack: 'industrial', node: 'BarrelOil', height: 0.9, zone: 'verge', weight: 3 },
  { pack: 'industrial', node: 'BarrelWater', height: 0.9, zone: 'verge', weight: 2 },
  { pack: 'industrial', node: 'BarrelWine', height: 0.9, zone: 'verge', weight: 1 },
  { pack: 'industrial', node: 'Crate', height: 0.9, zone: 'verge', weight: 2 },
  { pack: 'industrial', node: 'CrateWood', height: 0.6, zone: 'verge', weight: 2 },
  { pack: 'industrial', node: 'CrateMetal', height: 0.9, zone: 'verge', weight: 2 },
  { pack: 'industrial', node: 'Pallet', height: 0.15, zone: 'verge', weight: 2 },
  { pack: 'industrial', node: 'TrashCan', height: 0.9, zone: 'verge', weight: 2 },
  { pack: 'street', node: 'MailBox2', height: 1.3, zone: 'verge', weight: 1 },
  { pack: 'street', node: 'MailBox1', height: 1.0, zone: 'verge', weight: 1 },

  // Yard — the silhouettes on the horizon.
  { pack: 'industrial', node: 'CargoContainer', height: 2.6, zone: 'yard', weight: 3 },
  { pack: 'industrial', node: 'PropaneTank', height: 4.5, zone: 'yard', weight: 2 },
  { pack: 'industrial', node: 'TrashContainer', height: 1.7, zone: 'yard', weight: 2 },
  { pack: 'industrial', node: 'Dumpster', height: 1.4, zone: 'yard', weight: 2 },
  { pack: 'industrial', node: 'GeneratorUnit', height: 1.3, zone: 'yard', weight: 2 },
  { pack: 'industrial', node: 'Locker2', height: 1.9, zone: 'yard', weight: 1 },
  { pack: 'industrial', node: 'ConcretePipePile', height: 1.7, zone: 'yard', weight: 2 },
  { pack: 'industrial', node: 'MetalPipePile', height: 1.1, zone: 'yard', weight: 2 },
  { pack: 'industrial', node: 'Spool', height: 1.0, zone: 'yard', weight: 2 },
  { pack: 'street', node: 'SodaMachine', height: 1.9, zone: 'yard', weight: 1 },
]

/**
 * Seeded PRNG. The layout has to be identical on every load and every remount
 * — a WebGL context restore rebuilds this whole scene, and a circuit that
 * rearranged its own scenery on recovery would look like a fault rather than
 * a recovery. Deterministic placement also means the map is a real place: the
 * container on the outside of turn three is always there.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Picks a prop by weight, so the field is mixed rather than uniform. */
export function pickWeighted(
  props: ReadonlyArray<SceneryProp>,
  random: () => number,
): SceneryProp {
  const total = props.reduce((sum, prop) => sum + prop.weight, 0)
  let roll = random() * total
  for (const prop of props) {
    roll -= prop.weight
    if (roll <= 0) return prop
  }
  return props[props.length - 1]
}

/**
 * Lifts a named prop out of a loaded pack and puts it into track space:
 * upright, sitting on y=0, centred over its own footprint, and scaled to its
 * real height.
 *
 * The ancestor transform has to be baked in rather than ignored. These packs
 * are FBX conversions, so the pack's own root carries the Z-up to Y-up
 * rotation for everything inside it — read a node's geometry without that
 * matrix and every prop lies on its side.
 */
export function normaliseProp(scene: THREE.Object3D, prop: SceneryProp): THREE.Object3D | null {
  const source = scene.getObjectByName(prop.node)
  if (!source) {
    console.warn(`Scenery: node "${prop.node}" not found in the ${prop.pack} pack.`)
    return null
  }

  scene.updateMatrixWorld(true)

  const holder = new THREE.Group()
  const clone = source.clone(true)
  // Ancestors only: the clone already carries the node's own local transform.
  if (source.parent) clone.applyMatrix4(source.parent.matrixWorld)
  holder.add(clone)

  const box = new THREE.Box3().setFromObject(holder)
  const size = new THREE.Vector3()
  box.getSize(size)
  if (size.y <= 0) return null

  const scale = prop.height / size.y
  holder.scale.setScalar(scale)
  holder.updateMatrixWorld(true)

  // Re-measure after scaling rather than reasoning about it: cheaper to be
  // certain, and this runs once per prop kind at load.
  const scaled = new THREE.Box3().setFromObject(holder)
  const centre = new THREE.Vector3()
  scaled.getCenter(centre)
  // Contact patch at the origin, like the cars: props are placed on the
  // ground plane, not centred about it.
  clone.position.x -= centre.x / scale
  clone.position.z -= centre.z / scale
  clone.position.y -= scaled.min.y / scale

  return holder
}

/**
 * Swaps every material in a prop for the PS1 shader, keeping its texture page.
 *
 * Not optional. The scene has no lights at all — every surface in it is lit by
 * this shader's own Gouraud term — so a pack's imported PBR material has
 * nothing to reflect and renders as a black silhouette.
 *
 * Returns the created materials so the caller can dispose them; geometry and
 * textures stay owned by the loader's cache.
 */
export function applyPs1Materials(root: THREE.Object3D): ReadonlyArray<THREE.Material> {
  const created: THREE.Material[] = []
  const byTexture = new Map<string, THREE.ShaderMaterial>()

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    const source = Array.isArray(child.material) ? child.material[0] : child.material
    const map =
      source instanceof THREE.MeshStandardMaterial || source instanceof THREE.MeshBasicMaterial
        ? source.map
        : null
    const colour =
      source instanceof THREE.MeshStandardMaterial || source instanceof THREE.MeshBasicMaterial
        ? `#${source.color.getHexString()}`
        : '#9a9ab5'

    // One material per texture page, shared across every mesh and every copy
    // that uses it — these packs are a single atlas each, so this is one or
    // two programs for the whole circuit rather than one per crate.
    const key = map ? map.uuid : `flat:${colour}`
    let material = byTexture.get(key)
    if (!material) {
      material = createPs1Material({
        color: map ? '#ffffff' : colour,
        map: map ? configurePs1Texture(map) : undefined,
        // The pack's own texture already carries its painted shading; the
        // lighting model only has to stop the unlit side crushing to black.
        ambient: 0.62,
      })
      byTexture.set(key, material)
      created.push(material)
    }
    child.material = material
  })

  return created
}
