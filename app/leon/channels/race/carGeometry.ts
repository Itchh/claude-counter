import * as THREE from 'three'
import { TARGET_LENGTH } from './cars'

// Splitting the baked wheels out of the pack's car bodies, at load time.
//
// The pack ships each car as one mesh with the wheels modelled in, plus a
// separate 16-vertex wheel that is plainly the same wheel — the author built
// the bodies by instancing it and then exported flat. That history is what
// makes this safe to undo: in seven of the eight cars the wheels are still
// their own connected shells inside the merged mesh, welded to nothing, so a
// connectivity pass finds them exactly. No name matching, no hand-tuned
// positions per car — the geometry itself says where its wheels are.
//
// Done at load rather than by a build script on purpose. The analysis is a
// few hundred vertices per car and runs once; a script would mean a second
// copy of every model in the repo and a pipeline to forget to re-run.

/** Weld tolerance when reconnecting the exporter's duplicated vertices. */
const WELD_PRECISION = 4

/** A shell this size, this round, this low, is a wheel. */
const WHEEL_MAX_VERTS = 48
/** Max shell diameter, as a fraction of the car's length. */
const WHEEL_MAX_SPAN = 0.28
/** The shell's underside must reach into this bottom fraction of the car. */
const WHEEL_GROUND_BAND = 0.18
/** Height/depth roundness ratio a tyre stays inside. Mirrors and skirts do not. */
const WHEEL_MIN_ROUNDNESS = 0.62

export interface WheelPlacement {
  /** Hub centre, in the same normalised space as the body. */
  readonly x: number
  readonly y: number
  readonly z: number
  readonly radius: number
  /** True for wheels ahead of the car's midpoint — the pair that steers. */
  readonly front: boolean
}

export interface SplitCar {
  readonly body: THREE.BufferGeometry
  readonly wheels: ReadonlyArray<WheelPlacement>
}

interface Component {
  readonly triangles: number[]
  readonly box: THREE.Box3
  readonly vertexCount: number
}

/**
 * Separates a loaded car into a body and its wheel placements, normalised into
 * track space (nose +Z, sitting on y=0, TARGET_LENGTH long).
 *
 * The normalising transform is computed from the car's *original* bounds,
 * wheels included, and then applied to both halves — the body alone has a
 * higher floor than the car it came from, and scaling it by its own box would
 * leave every model hovering over its own tyres at a slightly different
 * height.
 *
 * If no credible set of wheels is found (one van in the pack is welded into a
 * single shell) the car is returned whole with an empty wheel list, and the
 * caller shows it exactly as before — baked wheels, no spin. A van with
 * painted-on wheels is period-accurate; a van with holes cut in it is not.
 */
export function splitCarGeometry(source: THREE.BufferGeometry): SplitCar {
  const geometry = source.index ? source.toNonIndexed() : source
  const positions = geometry.getAttribute('position')
  const triangleCount = positions.count / 3

  // --- weld duplicated vertices back together, by position ----------------
  const welded = new Int32Array(positions.count)
  const seen = new Map<string, number>()
  let weldCount = 0
  for (let i = 0; i < positions.count; i++) {
    const key = `${positions.getX(i).toFixed(WELD_PRECISION)},${positions
      .getY(i)
      .toFixed(WELD_PRECISION)},${positions.getZ(i).toFixed(WELD_PRECISION)}`
    const existing = seen.get(key)
    if (existing === undefined) {
      seen.set(key, weldCount)
      welded[i] = weldCount
      weldCount += 1
    } else {
      welded[i] = existing
    }
  }

  // --- union-find over triangles -------------------------------------------
  const parent = new Int32Array(weldCount)
  for (let i = 0; i < weldCount; i++) parent[i] = i
  const find = (a: number): number => {
    let root = a
    while (parent[root] !== root) root = parent[root]
    while (parent[a] !== root) {
      const next = parent[a]
      parent[a] = root
      a = next
    }
    return root
  }
  for (let t = 0; t < triangleCount; t++) {
    const a = welded[t * 3]
    const b = welded[t * 3 + 1]
    const c = welded[t * 3 + 2]
    parent[find(b)] = find(a)
    parent[find(c)] = find(a)
  }

  // --- gather components ----------------------------------------------------
  const components = new Map<number, { triangles: number[]; box: THREE.Box3; verts: Set<number> }>()
  const point = new THREE.Vector3()
  for (let t = 0; t < triangleCount; t++) {
    const root = find(welded[t * 3])
    let entry = components.get(root)
    if (!entry) {
      entry = { triangles: [], box: new THREE.Box3(), verts: new Set() }
      components.set(root, entry)
    }
    entry.triangles.push(t)
    for (let corner = 0; corner < 3; corner++) {
      const index = t * 3 + corner
      point.set(positions.getX(index), positions.getY(index), positions.getZ(index))
      entry.box.expandByPoint(point)
      entry.verts.add(welded[index])
    }
  }

  geometry.computeBoundingBox()
  const carBox = geometry.boundingBox ?? new THREE.Box3()
  const carSize = new THREE.Vector3()
  carBox.getSize(carSize)

  // --- pick out the wheels --------------------------------------------------
  const wheelComponents: Component[] = []
  const restTriangles: number[] = []
  for (const entry of components.values()) {
    const size = new THREE.Vector3()
    entry.box.getSize(size)
    const span = Math.max(size.x, size.y, size.z)
    const roundness =
      Math.min(size.y, size.z) / Math.max(size.y, size.z, 0.0001)
    const isWheel =
      entry.verts.size <= WHEEL_MAX_VERTS &&
      span < carSize.z * WHEEL_MAX_SPAN &&
      entry.box.min.y < carBox.min.y + carSize.y * WHEEL_GROUND_BAND &&
      roundness > WHEEL_MIN_ROUNDNESS
    if (isWheel) {
      wheelComponents.push({
        triangles: entry.triangles,
        box: entry.box,
        vertexCount: entry.verts.size,
      })
    } else {
      restTriangles.push(...entry.triangles)
    }
  }

  // Fewer than four credible wheels means the heuristic is not to be trusted
  // on this model. All or nothing: half a set of live wheels next to half a
  // set of painted ones would be worse than either.
  if (wheelComponents.length < 4) {
    return { body: normalise(geometry.clone(), carBox), wheels: [] }
  }

  // --- rebuild the body without them ---------------------------------------
  const body = subsetTriangles(geometry, restTriangles)

  const centreZ = (carBox.min.z + carBox.max.z) / 2
  const wheels = wheelComponents.map((component) => {
    const centre = new THREE.Vector3()
    component.box.getCenter(centre)
    const size = new THREE.Vector3()
    component.box.getSize(size)
    return {
      x: centre.x,
      y: centre.y,
      z: centre.z,
      // The tyre's rolling radius is half its height — the z span matches on
      // a round wheel, but height is the one that must not clip the road.
      radius: size.y / 2,
      front: centre.z > centreZ,
    }
  })

  const transformed = normaliseWithWheels(body, carBox, wheels)
  return transformed
}

/** Copies the listed triangles (with UVs and normals) into a fresh geometry. */
function subsetTriangles(
  source: THREE.BufferGeometry,
  triangles: ReadonlyArray<number>,
): THREE.BufferGeometry {
  const result = new THREE.BufferGeometry()
  for (const name of ['position', 'normal', 'uv'] as const) {
    const attribute = source.getAttribute(name)
    if (!attribute) continue
    const itemSize = attribute.itemSize
    const array = new Float32Array(triangles.length * 3 * itemSize)
    let write = 0
    for (const t of triangles) {
      for (let corner = 0; corner < 3; corner++) {
        const read = (t * 3 + corner) * itemSize
        for (let k = 0; k < itemSize; k++) {
          array[write++] = (attribute.array as Float32Array)[read + k]
        }
      }
    }
    result.setAttribute(name, new THREE.BufferAttribute(array, itemSize))
  }
  return result
}

/** The transform normaliseCarGeometry applies, expressed against a given box. */
function normalise(geometry: THREE.BufferGeometry, box: THREE.Box3): THREE.BufferGeometry {
  const size = new THREE.Vector3()
  box.getSize(size)
  const scale = size.z > 0 ? TARGET_LENGTH / size.z : 1
  const centre = new THREE.Vector3()
  box.getCenter(centre)
  geometry.translate(-centre.x, -box.min.y, -centre.z)
  geometry.scale(scale, scale, scale)
  return geometry
}

function normaliseWithWheels(
  body: THREE.BufferGeometry,
  box: THREE.Box3,
  wheels: ReadonlyArray<{ x: number; y: number; z: number; radius: number; front: boolean }>,
): SplitCar {
  const size = new THREE.Vector3()
  box.getSize(size)
  const scale = size.z > 0 ? TARGET_LENGTH / size.z : 1
  const centre = new THREE.Vector3()
  box.getCenter(centre)

  normalise(body, box)

  return {
    body,
    wheels: wheels.map((wheel) => ({
      x: (wheel.x - centre.x) * scale,
      y: (wheel.y - box.min.y) * scale,
      z: (wheel.z - centre.z) * scale,
      radius: wheel.radius * scale,
      front: wheel.front,
    })),
  }
}
