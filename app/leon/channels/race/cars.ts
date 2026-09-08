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

/** The shared wheel and the ground-blob shadow, from the same pack. */
export const WHEEL_MODEL = { objUrl: '/ps1/cars/wheel.obj', textureUrl: '/ps1/cars/wheel.png' } as const
// The ground blob, generated rather than shipped — see
// scripts/makeShadowBlob.mjs.
//
// The pack's own car_shadow.png is a hard binary mask that is fully opaque
// across the whole middle of the page, so every car sat on a black slab with
// a stepped rectangular edge. (Its sibling car_shadow_alpha.png is an INVERSE
// mask — white marks the shadow — which is how an earlier build ended up
// drawing a white card under every car.) The replacement is an ellipse held
// as three flat steps of low opacity, blended rather than cut out: the
// console spent its hardware semi-transparency on exactly this, and the era's
// racers all show the tarmac's own texture reading straight through the
// shadow. See scripts/makeShadowBlob.mjs for the steps and why they are hard.
export const SHADOW_TEXTURE_URL = '/ps1/cars/shadow-stepped.png'

/**
 * A livery: one of the pack's own painted texture pages, plus the colour that
 * page mostly reads as. The hex values are *measured* from the pixels (mean of
 * the page with near-black and near-white excluded), not guessed from the
 * filenames — "red" in a filename tells you nothing about how dark a red the
 * artist mixed.
 */
export interface CarLivery {
  readonly textureUrl: string
  readonly hex: string
}

/** Every non-snow livery the pack ships, per car. First entry is the base page. */
export const CAR_LIVERIES: ReadonlyArray<ReadonlyArray<CarLivery>> = [
  [
    { textureUrl: '/ps1/cars/car1.png', hex: '#2d415f' },
    { textureUrl: '/ps1/cars/variants/car_red.png', hex: '#5f281d' },
    { textureUrl: '/ps1/cars/variants/car_gray.png', hex: '#656665' },
  ],
  [
    { textureUrl: '/ps1/cars/car2.png', hex: '#512e25' },
    { textureUrl: '/ps1/cars/variants/car2_black.png', hex: '#343434' },
    { textureUrl: '/ps1/cars/variants/car2_red.png', hex: '#512e25' },
  ],
  [
    { textureUrl: '/ps1/cars/car3.png', hex: '#7e7126' },
    { textureUrl: '/ps1/cars/variants/car3_red.png', hex: '#592419' },
    { textureUrl: '/ps1/cars/variants/car3_yellow.png', hex: '#7e7126' },
  ],
  [
    { textureUrl: '/ps1/cars/car4.png', hex: '#826640' },
    { textureUrl: '/ps1/cars/variants/car4_grey.png', hex: '#3a3939' },
    { textureUrl: '/ps1/cars/variants/car4_lightgrey.png', hex: '#7a7a7a' },
    { textureUrl: '/ps1/cars/variants/car4_lightorange.png', hex: '#826640' },
  ],
  [
    { textureUrl: '/ps1/cars/car5.png', hex: '#394d4a' },
    { textureUrl: '/ps1/cars/variants/car5_green.png', hex: '#394d4a' },
    { textureUrl: '/ps1/cars/variants/car5_grey.png', hex: '#474746' },
  ],
  [{ textureUrl: '/ps1/cars/car6.png', hex: '#63442f' }],
  [
    { textureUrl: '/ps1/cars/car7.png', hex: '#634434' },
    { textureUrl: '/ps1/cars/variants/car7_black.png', hex: '#2f3030' },
    { textureUrl: '/ps1/cars/variants/car7_brown.png', hex: '#634434' },
    { textureUrl: '/ps1/cars/variants/car7_green.png', hex: '#29362f' },
    { textureUrl: '/ps1/cars/variants/car7_grey.png', hex: '#5c5c5c' },
    { textureUrl: '/ps1/cars/variants/car7_red.png', hex: '#642929' },
  ],
  [
    { textureUrl: '/ps1/cars/car8.png', hex: '#474759' },
    { textureUrl: '/ps1/cars/variants/Car8_grey.png', hex: '#585757' },
    { textureUrl: '/ps1/cars/variants/Car8_purple.png', hex: '#474759' },
  ],
]

/**
 * The page whose overall colour sits nearest the driver's own.
 *
 * This replaced the colour wash. Tinting kept the driver's hue but muddied
 * every page it touched; picking between the artist's own paint jobs keeps the
 * textures exactly as authored, which is the whole reason to use a painted
 * pack at all. The match is coarse — three or four liveries cannot span a hue
 * wheel — but it only has to beat "always the same page", and the tower still
 * carries the driver's true colour.
 */
export function liveryFor(index: number, driverHex: string | null): string {
  const liveries = CAR_LIVERIES[((index % CAR_LIVERIES.length) + CAR_LIVERIES.length) % CAR_LIVERIES.length]
  if (!driverHex || liveries.length === 1) return liveries[0].textureUrl

  const target = new THREE.Color(driverHex)
  let best = liveries[0]
  let bestDistance = Infinity
  for (const livery of liveries) {
    const colour = new THREE.Color(livery.hex)
    const distance =
      (colour.r - target.r) ** 2 + (colour.g - target.g) ** 2 + (colour.b - target.b) ** 2
    if (distance < bestDistance) {
      bestDistance = distance
      best = livery
    }
  }
  return best.textureUrl
}

/** Track-space length every car is scaled to, so the field stays even. */
export const TARGET_LENGTH = 2.6

/**
 * Which way the models face down their own Z axis.
 *
 * The pack has no stated convention and the eight cars agree with each other,
 * so this is one constant rather than per-model data. Racer.tsx points a
 * kart's +Z along the track tangent, so a car facing -Z in its own file needs
 * turning about.
 *
 * Measured, not assumed: the pack models nose-first down +Z, so turning them
 * about is what put the whole grid into reverse — headlights to the chase
 * camera, boots leading down the straight.
 */
const MODEL_FACES_NEGATIVE_Z = false

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
