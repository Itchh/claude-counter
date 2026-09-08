import * as THREE from 'three'
import { buildTriangleGrid } from './triangleGrid'

// Where the walls are.
//
// The other half of keeping a car on the road, and the half that was missing.
// The height field answers "how high is the ground here", which is enough to
// stop a car sinking into the tarmac and nothing like enough to stop it
// driving through a guardrail: a barrier is vertical, so it has no height at
// an x/z at all, and the ground index drops it at build time for exactly that
// reason. A car whose sideways position was bounded by one number — the
// circuit's nominal half width — therefore walked straight through the rails,
// the fences and the rock faces wherever the road was narrower than that
// number or the traced centreline sat off to one side of it.
//
// So the triangles the ground index throws away are indexed here instead, and
// asked the only question a road needs: fire a ray sideways off the
// centreline and see how far it gets. What comes back is the real width of the
// gap the cars have to drive down, measured off the geometry that is actually
// drawn rather than off a number in a JSON file.
//
// It is a *lateral* ray rather than a general collision query on purpose.
// Cars here live in track space — distance around the lap, distance across it
// — so the corridor is measured in the same coordinates the simulation
// clamps in, and there is no third representation of the road to disagree
// with the other two.

/**
 * Maximum |normal.y| for a triangle to count as a wall.
 *
 * 0.4 catches anything standing at 66 degrees or steeper. Deliberately
 * overlapping the ground index's own 0.25 cut-off: the band between the two
 * is a surface too steep to drive and too shallow to be honest wall — the
 * face of a kerb, a bank, the shoulder of a ditch — and a car should be
 * stopped by all of them.
 */
const MAX_NORMAL_Y = 0.4

export interface BarrierField {
  /**
   * Distance from a point to the first wall along a horizontal direction, or
   * `Infinity` if the ray reaches `maxDistance` without touching anything.
   *
   * `dirX`/`dirZ` must be unit length in the XZ plane. The ray is flat: it
   * travels at the height it starts at, which is what makes it a question
   * about the road rather than about the scenery above it.
   */
  distanceTo(
    x: number,
    y: number,
    z: number,
    dirX: number,
    dirZ: number,
    maxDistance: number,
  ): number
  /** Triangles indexed. Zero means the model had no walls to find. */
  readonly size: number
}

const EMPTY_FIELD: BarrierField = {
  size: 0,
  distanceTo: () => Infinity,
}

export function buildBarrierField(root: THREE.Object3D): BarrierField {
  const grid = buildTriangleGrid(root, {
    accept: (absNormalY, length) => absNormalY <= MAX_NORMAL_Y * length,
  })
  if (grid.count === 0) return EMPTY_FIELD

  const { data, buckets, oversized, cellSize } = grid

  // Which triangles this ray has already tested. A triangle spans several
  // cells, and a ray crossing four of them would otherwise intersect it four
  // times. Stamped with a per-call number rather than cleared, so the cost of
  // the bookkeeping is one write per candidate instead of one pass over the
  // model per ray.
  const stamps = new Int32Array(grid.count)
  let generation = 0

  // Bounds for the triangles too wide to file, which every ray has to check.
  // A rip's vertical oversized geometry is its backdrop — mountain cards
  // kilometres across — and testing one of those properly for every probe is
  // the difference between a millisecond and a stall. Six numbers per
  // triangle turns almost all of them into one comparison.
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

  return {
    size: grid.count,

    distanceTo(x, y, z, dirX, dirZ, maxDistance) {
      generation += 1
      let nearest = Infinity

      const test = (triangle: number): void => {
        if (stamps[triangle] === generation) return
        stamps[triangle] = generation
        const hit = rayTriangle(data, triangle * 9, x, y, z, dirX, dirZ)
        if (hit >= 0 && hit < nearest) nearest = hit
      }

      // Walked in half-cell steps rather than by a proper DDA. The ray is a
      // dozen units long against a six-unit cell, so this visits four or five
      // cells and the exactness a DDA buys would be spent on nothing.
      const step = cellSize * 0.5
      let travelled = 0
      let lastCell = -2
      while (travelled <= maxDistance + step) {
        const cell = grid.cellAt(x + dirX * travelled, z + dirZ * travelled)
        if (cell !== lastCell && cell >= 0) {
          const [from, to] = grid.cellSlots(cell)
          for (let slot = from; slot < to; slot += 1) test(buckets[slot])
        }
        lastCell = cell
        travelled += step
      }

      // The oversized list, rejected on bounds first. The ray is a dozen
      // units long, so its own box misses a backdrop card by kilometres.
      const endX = x + dirX * maxDistance
      const endZ = z + dirZ * maxDistance
      const rayMinX = Math.min(x, endX)
      const rayMaxX = Math.max(x, endX)
      const rayMinZ = Math.min(z, endZ)
      const rayMaxZ = Math.max(z, endZ)
      for (let i = 0; i < oversized.length; i += 1) {
        const slot = i * 6
        if (
          oversizedBounds[slot] > rayMaxX ||
          oversizedBounds[slot + 1] < rayMinX ||
          oversizedBounds[slot + 2] > y ||
          oversizedBounds[slot + 3] < y ||
          oversizedBounds[slot + 4] > rayMaxZ ||
          oversizedBounds[slot + 5] < rayMinZ
        ) {
          continue
        }
        test(oversized[i])
      }

      return nearest <= maxDistance ? nearest : Infinity
    },
  }
}

/**
 * Möller–Trumbore, for a ray that is always horizontal.
 *
 * Double-sided: a rip's barrier is a single sheet of geometry whose facing
 * says which side the game expected you to look from, and a car arriving from
 * the other side is exactly the case this is here to catch.
 *
 * Returns the distance along the ray, or -1 for a miss.
 */
function rayTriangle(
  data: Float32Array,
  base: number,
  originX: number,
  originY: number,
  originZ: number,
  dirX: number,
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

  // direction × e2, with direction.y == 0 folded out.
  const px = -dirZ * e2y
  const py = dirZ * e2x - dirX * e2z
  const pz = dirX * e2y

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

  const v = (dirX * qx + dirZ * qz) * inverse
  if (v < 0 || u + v > 1) return -1

  const distance = (e2x * qx + e2y * qy + e2z * qz) * inverse
  return distance >= 0 ? distance : -1
}
