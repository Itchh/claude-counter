import * as THREE from 'three'

// Where the ground is, answered in constant time.
//
// This exists because the obvious implementation does not survive contact
// with a real circuit. Asking three for the height under a point is one
// downward raycast, and a raycast against an imported track tests every
// triangle in every chunk whose bounding box the ray crosses — Bushido Peak
// is 275,000 triangles across a hundred chunks. One ray is a millisecond or
// two. The height measurement takes thirteen hundred of them and ran for
// TWENTY SECONDS on mount, blocking the main thread the whole time: no
// frames, no simulation, the cars frozen where they stood, and on some
// machines the GPU watchdog gave up and took the WebGL context with it.
//
// So the triangles are indexed once instead. Everything that matters here
// asks the same narrow question — "what is the surface height at this x/z"
// — which is a 2D lookup, and a uniform grid over the XZ plane answers it
// from a handful of candidates rather than from the whole model.
//
// Two things fall out of only answering that question. Near-vertical
// triangles are dropped at build time: a wall has no height *at* an x/z,
// it has a height range, and keeping them would double the index to answer
// a question nobody asks. And the grid is flat, not a tree — a circuit is
// a ribbon on a landscape, so its triangles are spread thinly across the
// plane and a bucket is small wherever you look.

/** Smallest grid cell, in game units. A car is ~2 units across. */
const MIN_CELL_SIZE = 6
/**
 * Cap on the grid's resolution per axis.
 *
 * A ripped circuit is not the size of its race: Bushido Peak's road fits in
 * about 1,300 units and its backdrop mountains reach 11,000, so a grid sized
 * to the model at a car's scale is nearly four million cells before a single
 * triangle is filed. The cell grows to fit instead.
 */
const MAX_CELLS_PER_AXIS = 384
/**
 * How many cells a triangle may span before it is filed as oversized.
 *
 * This is the rule that makes the index affordable on a real model. A
 * backdrop is a handful of triangles kilometres wide, and stamping one of
 * those into every cell it covers is hundreds of thousands of entries for
 * one triangle — the first version of this file did exactly that and the
 * index it built was worse than useless. The big ones go in a list that
 * every query checks, which is cheap precisely because there are so few.
 */
const MAX_CELL_SPAN = 12
/**
 * Minimum |normal.y| for a triangle to count as ground. 0.25 keeps everything
 * up to a 75-degree bank — steeper than any road, shallow enough to drop
 * building walls, fences and tree cards.
 */
const MIN_NORMAL_Y = 0.25
/** Guard against a pathological model eating all the memory. */
const MAX_TRIANGLES = 400_000
/** Oversized triangles past which every query is doing real work. */
const OVERSIZED_WARNING = 1500

export interface GroundField {
  /**
   * Surface height at an x/z, or NaN if nothing was found.
   *
   * `hintY` disambiguates: a circuit with a bridge over it has two surfaces
   * at one x/z, and the one that matters is whichever lies nearest the height
   * the caller already believes it is at.
   */
  heightAt(x: number, z: number, hintY: number): number
  /**
   * Highest surface at or below `y`, or NaN if there is none. What a camera
   * needs: the floor it is standing on, rather than the surface nearest a
   * height it already assumed.
   */
  highestBelow(x: number, z: number, y: number): number
  /** Triangles indexed. Zero means the model had no ground-facing geometry. */
  readonly size: number
}

/**
 * Indexes every ground-facing triangle in a model. Costs one pass over the
 * geometry — tens of milliseconds on a circuit, once, at mount.
 */
export function buildGroundField(root: THREE.Object3D): GroundField {
  root.updateWorldMatrix(true, true)

  // Collected flat rather than as objects: a quarter of a million little
  // {a,b,c} records is a quarter of a million allocations for the garbage
  // collector to walk, and this is read inside a frame loop.
  const vertices: number[] = []
  const vertex = new THREE.Vector3()
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
      // Unnormalised: only the ratio to the triangle's own area matters, and
      // a length() here is a square root per triangle for nothing.
      if (Math.abs(normal.y) < MIN_NORMAL_Y * normal.length()) continue

      vertices.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
      minX = Math.min(minX, a.x, b.x, c.x)
      maxX = Math.max(maxX, a.x, b.x, c.x)
      minZ = Math.min(minZ, a.z, b.z, c.z)
      maxZ = Math.max(maxZ, a.z, b.z, c.z)
    }
  })

  const triangleCount = vertices.length / 9
  if (triangleCount === 0) return EMPTY_FIELD

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
  const cellOf = (value: number, min: number): number =>
    Math.floor((value - min) / cellSize)
  const counts = new Int32Array(columns * rows + 1)
  /** Triangles too wide to file. Checked by every query — see MAX_CELL_SPAN. */
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

  // Read every frame, so the query is written as one loop over typed arrays
  // with no closures and no iterators allocated per call.
  const oversizedList = new Int32Array(oversized)
  if (oversizedList.length > OVERSIZED_WARNING) {
    console.warn(
      `groundField: ${oversizedList.length} triangles are too wide to file, ` +
        'and every height query scans all of them. The circuit may need a ' +
        'coarser MAX_CELL_SPAN or a decimated terrain.',
    )
  }

  const cellRange = (x: number, z: number): readonly [number, number] => {
    const column = cellOf(x, minX)
    const row = cellOf(z, minZ)
    if (column < 0 || row < 0 || column >= columns || row >= rows) return [0, 0]
    const cell = row * columns + column
    return [counts[cell], counts[cell + 1]]
  }

  return {
    size: triangleCount,

    heightAt(x, z, hintY) {
      const [from, to] = cellRange(x, z)
      let best = Number.NaN
      for (let slot = from; slot < to; slot += 1) {
        const height = heightInTriangle(data, buckets[slot] * 9, x, z)
        if (Number.isNaN(height)) continue
        // Nearest to what the caller already believes, so a bridge overhead
        // never captures a car driving underneath it.
        if (Number.isNaN(best) || Math.abs(height - hintY) < Math.abs(best - hintY)) best = height
      }
      for (let i = 0; i < oversizedList.length; i += 1) {
        const height = heightInTriangle(data, oversizedList[i] * 9, x, z)
        if (Number.isNaN(height)) continue
        if (Number.isNaN(best) || Math.abs(height - hintY) < Math.abs(best - hintY)) best = height
      }
      return best
    },

    highestBelow(x, z, y) {
      // A hand's width of tolerance: a camera sitting exactly on the tarmac
      // should find the tarmac, not the surface below it.
      const ceiling = y + 0.5
      const [from, to] = cellRange(x, z)
      let best = Number.NaN
      for (let slot = from; slot < to; slot += 1) {
        const height = heightInTriangle(data, buckets[slot] * 9, x, z)
        if (Number.isNaN(height) || height > ceiling) continue
        if (Number.isNaN(best) || height > best) best = height
      }
      for (let i = 0; i < oversizedList.length; i += 1) {
        const height = heightInTriangle(data, oversizedList[i] * 9, x, z)
        if (Number.isNaN(height) || height > ceiling) continue
        if (Number.isNaN(best) || height > best) best = height
      }
      return best
    },
  }
}

const EMPTY_FIELD: GroundField = {
  size: 0,
  heightAt: () => Number.NaN,
  highestBelow: () => Number.NaN,
}

/**
 * Height of the triangle's plane at an x/z, or NaN if the point lies outside
 * it. Barycentric, in 2D — the y coordinates are only read once the point is
 * known to be inside, so a miss costs six multiplies.
 */
function heightInTriangle(
  data: Float32Array,
  base: number,
  x: number,
  z: number,
): number {
  const ax = data[base]
  const az = data[base + 2]
  const bx = data[base + 3]
  const bz = data[base + 5]
  const cx = data[base + 6]
  const cz = data[base + 8]

  const v0x = cx - ax
  const v0z = cz - az
  const v1x = bx - ax
  const v1z = bz - az
  const v2x = x - ax
  const v2z = z - az

  const dot00 = v0x * v0x + v0z * v0z
  const dot01 = v0x * v1x + v0z * v1z
  const dot02 = v0x * v2x + v0z * v2z
  const dot11 = v1x * v1x + v1z * v1z
  const dot12 = v1x * v2x + v1z * v2z

  const denominator = dot00 * dot11 - dot01 * dot01
  // Degenerate in plan view: a triangle standing exactly on edge. It has no
  // height at this point, only a range, so it is not ours to answer with.
  if (denominator === 0) return Number.NaN

  const inverse = 1 / denominator
  const u = (dot11 * dot02 - dot01 * dot12) * inverse
  const v = (dot00 * dot12 - dot01 * dot02) * inverse
  if (u < 0 || v < 0 || u + v > 1) return Number.NaN

  const ay = data[base + 1]
  const by = data[base + 4]
  const cy = data[base + 7]
  return ay + u * (cy - ay) + v * (by - ay)
}
