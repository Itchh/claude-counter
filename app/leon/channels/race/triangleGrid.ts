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
  count: 0,
  buckets: new Int32Array(0),
  oversized: new Int32Array(0),
  cellSize: MIN_CELL_SIZE,
  cellRange: () => EMPTY_RANGE,
  cellAt: () => -1,
  cellSlots: () => EMPTY_RANGE,
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
      minX = Math.min(minX, a.x, b.x, c.x)
      maxX = Math.max(maxX, a.x, b.x, c.x)
      minZ = Math.min(minZ, a.z, b.z, c.z)
      maxZ = Math.max(maxZ, a.z, b.z, c.z)
    }
  })

  const triangleCount = vertices.length / 9
  if (triangleCount === 0) return EMPTY_GRID

  const data = new Float32Array(vertices)
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
    count: triangleCount,
    buckets,
    oversized: oversizedList,
    cellSize,
    cellRange: (x, z) => cellSlots(cellAt(x, z)),
    cellAt,
    cellSlots,
  }
}
