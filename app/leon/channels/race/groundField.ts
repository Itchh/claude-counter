import * as THREE from 'three'
import { buildTriangleGrid } from './triangleGrid'

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
// So the triangles are indexed once instead — see triangleGrid.ts, which now
// holds the index itself because the barriers need the same one. Everything
// that matters here asks the same narrow question — "what is the surface
// height at this x/z" — which is a 2D lookup, and a uniform grid over the XZ
// plane answers it from a handful of candidates rather than from the whole
// model.
//
// One thing falls out of only answering that question: near-vertical
// triangles are dropped at build time. A wall has no height *at* an x/z, it
// has a height range, and keeping them would double the index to answer a
// question nobody asks here. They are not thrown away, though — barrierField
// builds its own index from exactly the triangles this one rejects, because
// "where is the wall" turned out to be the other half of keeping a car on the
// road.

/**
 * Minimum |normal.y| for a triangle to count as ground. 0.25 keeps everything
 * up to a 75-degree bank — steeper than any road, shallow enough to drop
 * building walls, fences and tree cards.
 */
const MIN_NORMAL_Y = 0.25
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
  const grid = buildTriangleGrid(root, {
    accept: (absNormalY, length) => absNormalY >= MIN_NORMAL_Y * length,
  })
  if (grid.count === 0) return EMPTY_FIELD

  const { data, buckets, oversized } = grid
  if (oversized.length > OVERSIZED_WARNING) {
    console.warn(
      `groundField: ${oversized.length} triangles are too wide to file, ` +
        'and every height query scans all of them. The circuit may need a ' +
        'coarser MAX_CELL_SPAN or a decimated terrain.',
    )
  }

  return {
    size: grid.count,

    heightAt(x, z, hintY) {
      const [from, to] = grid.cellRange(x, z)
      let best = Number.NaN
      for (let slot = from; slot < to; slot += 1) {
        const height = heightInTriangle(data, buckets[slot] * 9, x, z)
        if (Number.isNaN(height)) continue
        // Nearest to what the caller already believes, so a bridge overhead
        // never captures a car driving underneath it.
        if (Number.isNaN(best) || Math.abs(height - hintY) < Math.abs(best - hintY)) best = height
      }
      for (let i = 0; i < oversized.length; i += 1) {
        const height = heightInTriangle(data, oversized[i] * 9, x, z)
        if (Number.isNaN(height)) continue
        if (Number.isNaN(best) || Math.abs(height - hintY) < Math.abs(best - hintY)) best = height
      }
      return best
    },

    highestBelow(x, z, y) {
      // A hand's width of tolerance: a camera sitting exactly on the tarmac
      // should find the tarmac, not the surface below it.
      const ceiling = y + 0.5
      const [from, to] = grid.cellRange(x, z)
      let best = Number.NaN
      for (let slot = from; slot < to; slot += 1) {
        const height = heightInTriangle(data, buckets[slot] * 9, x, z)
        if (Number.isNaN(height) || height > ceiling) continue
        if (Number.isNaN(best) || height > best) best = height
      }
      for (let i = 0; i < oversized.length; i += 1) {
        const height = heightInTriangle(data, oversized[i] * 9, x, z)
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
