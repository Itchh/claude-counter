import * as THREE from 'three'

// A uniform XZ grid over a model's triangles.
//
// Extracted from groundField.ts, which needed it first and explains at length
// why an index is not optional here: a ripped circuit is a quarter of a
// million triangles, and every question the race asks about the world — how
// high is the road, where is the barrier — is asked hundreds of times at
// mount and a handful of times a frame. Raycasting the model for those answers
// froze the channel for twenty seconds.
//
// The grid is shared because there are now two questions, not one, and they
// want opposite halves of the same model: the ground index keeps the triangles
// facing up, the barrier index keeps the ones standing on edge. Only the
// filter differs, so only the filter is passed in.

/** Smallest grid cell, in game units. A car is ~2 units across. */
const MIN_CELL_SIZE = 6
/** Cap on the grid's resolution per axis. See groundField.ts. */
const MAX_CELLS_PER_AXIS = 384
/** How many cells a triangle may span before it is filed as oversized. */
const MAX_CELL_SPAN = 12
/** Guard against a pathological model eating all the memory. */
const MAX_TRIANGLES = 400_000

export interface TriangleGrid {
  /** Nine floats per triangle — three world-space vertices, xyz. */
  readonly data: Float32Array
  /**
   * One byte per triangle: 1 if it came from a cut-out material, 0 if it is
   * solid. A rip draws its trees as crossed cards with a masked page, and
   * those cards are geometry like any other to the index — which is right
   * for the ground (a car under a tree is still on the road beneath it) and
   * wrong for a line of sight, where a leaf card is something a camera looks
   * through, not something it is pulled in front of. See `createGridRay`.
   */
  readonly soft: Uint8Array
  /** Triangles indexed. Zero means the filter matched nothing. */
  readonly count: number
  /** Triangle ids, grouped by cell. Read through `cellRange`. */
  readonly buckets: Int32Array
  /** Triangles too wide to file. Every query has to check all of them. */
  readonly oversized: Int32Array
  readonly cellSize: number
  /** `[start, end)` into `buckets` for the cell holding an x/z. */
  cellRange(x: number, z: number): readonly [number, number]
  /** Cell id for an x/z, or -1 outside the grid. Lets a ray skip repeats. */
  cellAt(x: number, z: number): number
  /** `[start, end)` into `buckets` for a cell id from `cellAt`. */
  cellSlots(cell: number): readonly [number, number]
}

export interface TriangleGridOptions {
  /**
   * Which triangles to keep, judged on the unnormalised face normal — its
   * `|y|` against its own length, which is the cosine of the face's tilt
   * without paying for a square root per triangle.
   */
  readonly accept: (absNormalY: number, normalLength: number) => boolean
}

const EMPTY_RANGE: readonly [number, number] = [0, 0]

export const EMPTY_GRID: TriangleGrid = {
  data: new Float32Array(0),
  soft: new Uint8Array(0),
  count: 0,
  buckets: new Int32Array(0),
  oversized: new Int32Array(0),
  cellSize: MIN_CELL_SIZE,
  cellRange: () => EMPTY_RANGE,
  cellAt: () => -1,
  cellSlots: () => EMPTY_RANGE,
}

/**
 * Whether a mesh's material is a cut-out: a masked page whose transparent
 * texels are discarded, or a blended one. On a rip that is foliage — leaf
 * cards, grass tufts, the odd fence mesh — and nothing structural. Read off
 * whatever material the mesh carries when the index is built: the circuit's
 * own PS1 shader keeps its threshold in a uniform, a stock three material in
 * `alphaTest`, and either may simply be flagged transparent.
 */
function isCutoutMaterial(material: THREE.Material | THREE.Material[]): boolean {
  const candidates = Array.isArray(material) ? material : [material]
  return candidates.some((candidate) => {
    if (candidate.transparent || candidate.alphaTest > 0) return true
    if (candidate instanceof THREE.ShaderMaterial) {
      const threshold: unknown = candidate.uniforms.uAlphaTest?.value
      return typeof threshold === 'number' && threshold > 0
    }
    return false
  })
}

/**
 * Indexes every triangle in a model that passes the filter. One pass over the
 * geometry — tens of milliseconds on a circuit, once, at mount.
 */
export function buildTriangleGrid(
  root: THREE.Object3D,
  { accept }: TriangleGridOptions,
): TriangleGrid {
  root.updateWorldMatrix(true, true)

  // Collected flat rather than as objects: a quarter of a million little
  // records is a quarter of a million allocations for the collector to walk,
  // and this is read inside a frame loop.
  const vertices: number[] = []
  const softness: number[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const edge1 = new THREE.Vector3()
  const edge2 = new THREE.Vector3()
  const normal = new THREE.Vector3()

  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  let considered = 0

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !child.visible) return
    const geometry = child.geometry as THREE.BufferGeometry
    const position = geometry.getAttribute('position')
    if (!position) return
    const index = geometry.getIndex()
    const count = index ? index.count : position.count
    const matrix = child.matrixWorld
    const soft = isCutoutMaterial(child.material) ? 1 : 0

    for (let i = 0; i < count; i += 3) {
      if (considered++ > MAX_TRIANGLES) break
      const ia = index ? index.getX(i) : i
      const ib = index ? index.getX(i + 1) : i + 1
      const ic = index ? index.getX(i + 2) : i + 2

      a.fromBufferAttribute(position, ia).applyMatrix4(matrix)
      b.fromBufferAttribute(position, ib).applyMatrix4(matrix)
      c.fromBufferAttribute(position, ic).applyMatrix4(matrix)

      edge1.subVectors(b, a)
      edge2.subVectors(c, a)
      normal.crossVectors(edge1, edge2)
      const length = normal.length()
      if (length === 0 || !accept(Math.abs(normal.y), length)) continue

      vertices.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
      softness.push(soft)
      minX = Math.min(minX, a.x, b.x, c.x)
      maxX = Math.max(maxX, a.x, b.x, c.x)
      minZ = Math.min(minZ, a.z, b.z, c.z)
      maxZ = Math.max(maxZ, a.z, b.z, c.z)
    }
  })

  const triangleCount = vertices.length / 9
  if (triangleCount === 0) return EMPTY_GRID

  const data = new Float32Array(vertices)
  const softFlags = Uint8Array.from(softness)
  const cellSize = Math.max(
    MIN_CELL_SIZE,
    Math.max(maxX - minX, maxZ - minZ) / MAX_CELLS_PER_AXIS,
  )
  const columns = Math.max(1, Math.ceil((maxX - minX) / cellSize) + 1)
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize) + 1)

  // Counting sort into a CSR-style layout: one pass to count how many
  // triangles land in each cell, a prefix sum for where each cell's run
  // starts, one pass to fill. No arrays of arrays, so the whole index is two
  // typed arrays and stays in cache while a frame loop reads it.
  const cellOf = (value: number, min: number): number => Math.floor((value - min) / cellSize)
  const counts = new Int32Array(columns * rows + 1)
  const oversized: number[] = []

  const forEachCell = (triangle: number, visit: (cell: number) => void): boolean => {
    const base = triangle * 9
    const x0 = cellOf(Math.min(data[base], data[base + 3], data[base + 6]), minX)
    const x1 = cellOf(Math.max(data[base], data[base + 3], data[base + 6]), minX)
    const z0 = cellOf(Math.min(data[base + 2], data[base + 5], data[base + 8]), minZ)
    const z1 = cellOf(Math.max(data[base + 2], data[base + 5], data[base + 8]), minZ)
    if (x1 - x0 > MAX_CELL_SPAN || z1 - z0 > MAX_CELL_SPAN) return false
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) visit(z * columns + x)
    }
    return true
  }

  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const filed = forEachCell(triangle, (cell) => {
      counts[cell + 1]++
    })
    if (!filed) oversized.push(triangle)
  }
  for (let cell = 0; cell < columns * rows; cell++) counts[cell + 1] += counts[cell]

  const buckets = new Int32Array(counts[columns * rows])
  const cursor = counts.slice(0, columns * rows)
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    forEachCell(triangle, (cell) => {
      buckets[cursor[cell]++] = triangle
    })
  }

  const oversizedList = new Int32Array(oversized)

  const cellAt = (x: number, z: number): number => {
    const column = cellOf(x, minX)
    const row = cellOf(z, minZ)
    if (column < 0 || row < 0 || column >= columns || row >= rows) return -1
    return row * columns + column
  }

  const cellSlots = (cell: number): readonly [number, number] =>
    cell < 0 ? EMPTY_RANGE : [counts[cell], counts[cell + 1]]

  return {
    data,
    soft: softFlags,
    count: triangleCount,
    buckets,
    oversized: oversizedList,
    cellSize,
    cellRange: (x, z) => cellSlots(cellAt(x, z)),
    cellAt,
    cellSlots,
  }
}

// A general ray against an indexed model.
//
// The two fields built on this grid each ask a narrow question — how high is
// the ground at an x/z, how far is the wall sideways — and both are cheap
// precisely because they are narrow. The camera turned out to need the wide
// one after all: "is there anything between the lens and the car". Nothing
// about a height column answers that, because the thing that ruined the shot
// was a tunnel, and a tunnel is a hole through a hill whose roof is above the
// camera and whose portal is a wall beside it. The camera sat nine metres
// behind a car that had gone inside, which put the lens in the rock, and the
// rock's inward-facing surfaces are not drawn — so the frame became the
// world seen from within, hollow and floorless.
//
// It is still an index query rather than a scene raycast: the ray walks the
// same XZ cells the other queries read and tests a handful of triangles,
// where three.js would test every triangle in every chunk it crosses. See
// groundField.ts for what that cost the first time somebody tried it.

/**
 * Distance along a ray to the first triangle it meets, or `Infinity` if it
 * travels `maxDistance` without touching one. Direction must be unit length.
 */
export type GridRay = (
  originX: number,
  originY: number,
  originZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  maxDistance: number,
) => number

/** Builds a ray query over an already-indexed model. Allocation-free to call. */
export function createGridRay(grid: TriangleGrid): GridRay {
  if (grid.count === 0) return () => Infinity

  const { data, soft, buckets, oversized, cellSize } = grid

  // One stamp per triangle, bumped per call: a triangle filed in four cells
  // the ray crosses is otherwise intersected four times.
  const stamps = new Int32Array(grid.count)
  let generation = 0

  // The triangles too wide to file — a rip's backdrop, mountain cards a
  // kilometre across — rejected on their box before anything else. Six
  // numbers turns almost all of them into one comparison.
  const oversizedBounds = new Float32Array(oversized.length * 6)
  for (let i = 0; i < oversized.length; i += 1) {
    const base = oversized[i] * 9
    const slot = i * 6
    oversizedBounds[slot] = Math.min(data[base], data[base + 3], data[base + 6])
    oversizedBounds[slot + 1] = Math.max(data[base], data[base + 3], data[base + 6])
    oversizedBounds[slot + 2] = Math.min(data[base + 1], data[base + 4], data[base + 7])
    oversizedBounds[slot + 3] = Math.max(data[base + 1], data[base + 4], data[base + 7])
    oversizedBounds[slot + 4] = Math.min(data[base + 2], data[base + 5], data[base + 8])
    oversizedBounds[slot + 5] = Math.max(data[base + 2], data[base + 5], data[base + 8])
  }

  return (originX, originY, originZ, dirX, dirY, dirZ, maxDistance) => {
    generation += 1
    let nearest = Infinity

    const test = (triangle: number): void => {
      if (stamps[triangle] === generation) return
      stamps[triangle] = generation
      // Foliage is looked through. A crane over the start line that stops
      // at the first leaf card is a crane inside a tree, and a chase camera
      // that ducks under every overhanging branch is a camera with hiccups.
      if (soft[triangle] === 1) return
      const hit = intersectTriangle(
        data,
        triangle * 9,
        originX,
        originY,
        originZ,
        dirX,
        dirY,
        dirZ,
      )
      if (hit >= 0 && hit < nearest) nearest = hit
    }

    const visitCell = (cell: number): void => {
      if (cell < 0) return
      const [from, to] = grid.cellSlots(cell)
      for (let slot = from; slot < to; slot += 1) test(buckets[slot])
    }

    // The grid is two-dimensional, so the walk follows the ray's shadow on
    // the XZ plane. A near-vertical ray has no shadow to walk and lives in
    // one column: stepping it would visit the same cell a hundred times.
    const horizontal = Math.hypot(dirX, dirZ)
    if (horizontal < 1e-6) {
      visitCell(grid.cellAt(originX, originZ))
    } else {
      // Half-cell steps rather than a proper DDA, as in barrierField: these
      // rays are a dozen units long against a six-unit cell, so exactness
      // would be bought for four or five lookups that already overlap.
      const step = cellSize * 0.5
      const spread = maxDistance * horizontal
      let travelled = 0
      let lastCell = -2
      while (travelled <= spread + step) {
        const cell = grid.cellAt(
          originX + (dirX / horizontal) * travelled,
          originZ + (dirZ / horizontal) * travelled,
        )
        if (cell !== lastCell) visitCell(cell)
        lastCell = cell
        travelled += step
      }
    }

    const endX = originX + dirX * maxDistance
    const endY = originY + dirY * maxDistance
    const endZ = originZ + dirZ * maxDistance
    const minX = Math.min(originX, endX)
    const maxX = Math.max(originX, endX)
    const minY = Math.min(originY, endY)
    const maxY = Math.max(originY, endY)
    const minZ = Math.min(originZ, endZ)
    const maxZ = Math.max(originZ, endZ)
    for (let i = 0; i < oversized.length; i += 1) {
      const slot = i * 6
      if (
        oversizedBounds[slot] > maxX ||
        oversizedBounds[slot + 1] < minX ||
        oversizedBounds[slot + 2] > maxY ||
        oversizedBounds[slot + 3] < minY ||
        oversizedBounds[slot + 4] > maxZ ||
        oversizedBounds[slot + 5] < minZ
      ) {
        continue
      }
      test(oversized[i])
    }

    return nearest <= maxDistance ? nearest : Infinity
  }
}

/**
 * Möller–Trumbore for a ray pointing anywhere.
 *
 * Double-sided, for the same reason the barrier version is: a ripped circuit
 * is single sheets of geometry whose facing records which side the original
 * game expected a player to stand on, and the camera arriving from the wrong
 * side is the whole problem being solved.
 *
 * Returns distance along the ray, or -1 for a miss.
 */
function intersectTriangle(
  data: Float32Array,
  base: number,
  originX: number,
  originY: number,
  originZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
): number {
  const ax = data[base]
  const ay = data[base + 1]
  const az = data[base + 2]

  const e1x = data[base + 3] - ax
  const e1y = data[base + 4] - ay
  const e1z = data[base + 5] - az
  const e2x = data[base + 6] - ax
  const e2y = data[base + 7] - ay
  const e2z = data[base + 8] - az

  const px = dirY * e2z - dirZ * e2y
  const py = dirZ * e2x - dirX * e2z
  const pz = dirX * e2y - dirY * e2x

  const determinant = e1x * px + e1y * py + e1z * pz
  if (Math.abs(determinant) < 1e-8) return -1
  const inverse = 1 / determinant

  const tx = originX - ax
  const ty = originY - ay
  const tz = originZ - az

  const u = (tx * px + ty * py + tz * pz) * inverse
  if (u < 0 || u > 1) return -1

  const qx = ty * e1z - tz * e1y
  const qy = tz * e1x - tx * e1z
  const qz = tx * e1y - ty * e1x

  const v = (dirX * qx + dirY * qy + dirZ * qz) * inverse
  if (v < 0 || u + v > 1) return -1

  const distance = (e2x * qx + e2y * qy + e2z * qz) * inverse
  return distance >= 0 ? distance : -1
}
