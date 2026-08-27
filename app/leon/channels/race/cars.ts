import * as THREE from 'three'

// The grid. Eight low-poly cars from GGBot's PSX pack, one per driver, each
// with its own livery — see public/ps1/cars/CREDITS.txt.
//
// Identity by model rather than by tint is the point. Eight identical shapes
// in eight colours is a chart with wheels; eight different cars is a field,
// and at 288 pixels tall a silhouette survives where a hue does not. The
// driver's own colour still appears, but only as a wash over the paintwork —
// see TINT_STRENGTH.
//
// The budget these were built to is the same one the console had: ~250
// vertices and a single 128×128 page per car. Nothing here needs decimating.

export interface CarModel {
  readonly objUrl: string
  readonly textureUrl: string
}

export const CAR_MODELS: ReadonlyArray<CarModel> = Array.from({ length: 8 }, (_, index) => ({
  objUrl: `/ps1/cars/car${index + 1}.obj`,
  textureUrl: `/ps1/cars/car${index + 1}.png`,
}))

export function carModelFor(index: number): CarModel {
  return CAR_MODELS[((index % CAR_MODELS.length) + CAR_MODELS.length) % CAR_MODELS.length]
}

/**
 * How far a car is pulled towards its driver's colour. Low on purpose: enough
 * that you can pick your own car out of a pack, not so much that the livery
 * turns into a single flat wash and every model looks the same again.
 */
export const TINT_STRENGTH = 0.3

/** Track-space length every car is scaled to, so the field stays even. */
const TARGET_LENGTH = 2.6

/**
 * Which way the models face down their own Z axis.
 *
 * The pack has no stated convention and the eight cars agree with each other,
 * so this is one constant rather than per-model data. Racer.tsx points a
 * kart's +Z along the track tangent, so a car facing -Z in its own file needs
 * turning about.
 */
const MODEL_FACES_NEGATIVE_Z = true

/**
 * Puts a loaded car into track space: sitting on the road, centred over its
 * own footprint, facing forwards, and the same length as every other car.
 *
 * Done to the geometry once at load rather than with a wrapper transform per
 * instance — the vertex snapping in Ps1Material quantises *after* the model
 * matrix, so a nested scale would change how coarsely a car wobbles depending
 * on which car it was. The whole field has to jitter on the same grid.
 */
export function normaliseCarGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const normalised = geometry.clone()

  if (MODEL_FACES_NEGATIVE_Z) {
    normalised.rotateY(Math.PI)
  }

  normalised.computeBoundingBox()
  const box = normalised.boundingBox
  if (!box) return normalised

  const size = new THREE.Vector3()
  box.getSize(size)
  const scale = size.z > 0 ? TARGET_LENGTH / size.z : 1
  normalised.scale(scale, scale, scale)

  // Re-measure rather than scaling the old box: cheaper to be certain than to
  // reason about whether rotateY left the bounds axis-aligned.
  normalised.computeBoundingBox()
  const scaled = normalised.boundingBox
  if (!scaled) return normalised

  const centre = new THREE.Vector3()
  scaled.getCenter(centre)
  // Centred left-to-right and front-to-back, but sitting *on* y=0 rather than
  // centred about it — a car's contact patch is its origin, not its middle.
  normalised.translate(-centre.x, -scaled.min.y, -centre.z)
  // The pack's own normals are kept. Recomputing them would average across
  // shared vertices and smooth away the faceting, which on a model built to
  // this budget is most of what the shading has to work with.

  return normalised
}
