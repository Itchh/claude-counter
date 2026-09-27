#!/usr/bin/env node
//
// Writes down, per circuit, the two things a race needs to know about a road:
// the path the cars follow, and the walls they must not touch.
//
// Both already existed, and neither was written down. The path was a trace
// off the road's footprint — a first draft, produced before anyone had seen
// the model rendered, and on the mountain rips it runs a metre or two wide of
// the tarmac in places. The walls were measured in the browser, every time
// the channel loaded, by firing rays at whatever had just been added to the
// scene: correct in principle, invisible in practice. Nobody could look at a
// circuit and say where its boundaries were, or correct one that was wrong,
// because the answer only existed for the few milliseconds it took to
// compute and was never the same twice if the model changed.
//
// So the measurement moves here, offline, and its result becomes source. Two
// consequences worth being explicit about:
//
//   * The boundaries are DATA. `<slug>.track.json` now carries, for every
//     sample around the lap, how far the wall stands either side of the
//     line — in the same lateral units the simulation clamps in. It can be
//     read, plotted, argued with, and edited by hand where the geometry
//     lies (a gap in a rail, a gantry leg the rays caught).
//
//   * The path is CORRECTED AGAINST THEM. Once the walls are known, the
//     middle of the free road is known too, and a traced line that runs wide
//     of it can simply be moved onto it. That is the fix for the screenshot
//     this work started from: a car on the verge, grinding along the outside
//     of a rail, because the line it was following had never been on the
//     road there in the first place.
//
// Measured against the BAKED model in `public`, not the source asset — see
// glbTriangles.mjs. Usage:
//
//   node scripts/bakeCorridor.mjs --slug lone-peak
//   node scripts/bakeCorridor.mjs --all

import * as THREE from 'three'
import sharp from 'sharp'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTriangles, filterByNormal } from './glbTriangles.mjs'

// --- The same numbers the simulation uses -----------------------------------
//
// Deliberately restated rather than imported: this is a Node script and the
// runtime is TypeScript inside a bundler. Where a constant has a twin in
// `app/leon/channels/race`, the twin is named in the comment, and the two are
// only allowed to differ if somebody decides they should.

/** Minimum |normal.y| for a triangle to be ground. Twin: groundField.ts. */
const GROUND_NORMAL_Y = 0.25
/** Maximum |normal.y| for a triangle to be a wall. Twin: barrierField.ts. */
const WALL_NORMAL_Y = 0.4
/** Heights above the road the sideways rays fire at. Twin: TrackModel.tsx. */
const PROBE_HEIGHTS = [0.4, 1.05]
/** Points around the lap the road is measured at. Twin: CORRIDOR_SAMPLES. */
const SAMPLES = 192
/**
 * How far the rays look for a wall, as a multiple of the nominal half width.
 *
 * Far wider than the runtime's 1.9, and for a reason that only applies here:
 * the runtime was measuring a corridor around a line it had to trust, so a
 * wall four road-widths away was noise. This script is allowed to MOVE the
 * line, so it has to be able to see the far barrier from a trace that has
 * wandered onto the verge — which is exactly the case it exists to fix.
 */
const PROBE_REACH = 4
/**
 * Passes of measure-then-recentre.
 *
 * Recentring moves the line, which changes what the rays can see, which
 * changes where the middle is — so this is iterative, and the step is capped
 * (MAX_SHIFT_PER_PASS) rather than taken whole. Six is where the mountain
 * circuits stop improving by anything you could see: on the measure that
 * matters, how close the finished line runs to a wall, the rips go from a
 * median of 4.5 units of clearance to 7, and from fifty samples a lap
 * within a car's width of a barrier to twenty.
 */
const RECENTRE_PASSES = 6
/**
 * Most the line may move sideways in one pass, in game units.
 *
 * A limit, not a target. Without it a single sample that found the wall of a
 * building behind the trees drags the racing line off the tarmac in one
 * step, and the next pass measures from there and agrees with itself.
 */
const MAX_SHIFT_PER_PASS = 3
/**
 * Most the line may end up from where the trace put it, in game units.
 *
 * The trace is a first draft, but it is a first draft taken off the road's
 * own footprint — it knows something the walls do not. Correcting it by a
 * road's width is a correction; correcting it by four is this script
 * deciding the circuit goes somewhere else, and the honest response to a
 * trace that wrong is to re-trace it, not to let a ray drag it into a wood.
 */
const MAX_TOTAL_DRIFT = 8
/**
 * How wide the gap between two walls may be before it stops being a road, as
 * a multiple of the nominal width.
 *
 * This is the whole judgement in the recentring, so it is worth stating
 * plainly. A guardrail either side of a mountain road is a road: the gap
 * measures about what the road measures, its middle is the middle of the
 * tarmac, and a line running wide of that middle should be moved onto it. A
 * rock face on one side and a treeline eighty units away on the other is not
 * a road — it is a road plus a verge plus a hillside — and its "middle" is
 * out in the scenery. The first case is corrected and the second is left
 * exactly where the trace put it, because between two bad answers, the
 * measurement that came off the road's own footprint is the better one.
 */
const PLAUSIBLE_WIDTH = 1.6

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TRACK_DIR = resolve(root, 'app/leon/channels/race/tracks')
const MODEL_DIR = resolve(root, 'public/ps1/tracks')

const UP = new THREE.Vector3(0, 1, 0)
const round = (value) => Math.round(value * 1000) / 1000

// --- A uniform XZ grid, so a ray costs a handful of triangles ---------------
//
// The same structure as triangleGrid.ts, rewritten small: a quarter of a
// million triangles against eight hundred rays is minutes of brute force and
// under a second indexed.

const MIN_CELL_SIZE = 6
const MAX_CELLS_PER_AXIS = 384
const MAX_CELL_SPAN = 12

function buildGrid(data) {
  const count = data.length / 9
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < data.length; i += 3) {
    minX = Math.min(minX, data[i])
    maxX = Math.max(maxX, data[i])
    minZ = Math.min(minZ, data[i + 2])
    maxZ = Math.max(maxZ, data[i + 2])
  }
  const cellSize = Math.max(
    MIN_CELL_SIZE,
    Math.max(maxX - minX, maxZ - minZ) / MAX_CELLS_PER_AXIS,
  )
  const columns = Math.max(1, Math.ceil((maxX - minX) / cellSize) + 1)
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize) + 1)
  const cellOf = (value, min) => Math.floor((value - min) / cellSize)

  const counts = new Int32Array(columns * rows + 1)
  const oversized = []
  const forEachCell = (triangle, visit) => {
    const base = triangle * 9
    const x0 = cellOf(Math.min(data[base], data[base + 3], data[base + 6]), minX)
    const x1 = cellOf(Math.max(data[base], data[base + 3], data[base + 6]), minX)
    const z0 = cellOf(Math.min(data[base + 2], data[base + 5], data[base + 8]), minZ)
    const z1 = cellOf(Math.max(data[base + 2], data[base + 5], data[base + 8]), minZ)
    if (x1 - x0 > MAX_CELL_SPAN || z1 - z0 > MAX_CELL_SPAN) return false
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) visit(z * columns + x)
    return true
  }

  for (let triangle = 0; triangle < count; triangle++) {
    if (!forEachCell(triangle, (cell) => { counts[cell + 1]++ })) oversized.push(triangle)
  }
  for (let cell = 0; cell < columns * rows; cell++) counts[cell + 1] += counts[cell]
  const buckets = new Int32Array(counts[columns * rows])
  const cursor = counts.slice(0, columns * rows)
  for (let triangle = 0; triangle < count; triangle++) {
    forEachCell(triangle, (cell) => { buckets[cursor[cell]++] = triangle })
  }

  const cellAt = (x, z) => {
    const column = cellOf(x, minX)
    const row = cellOf(z, minZ)
    if (column < 0 || row < 0 || column >= columns || row >= rows) return -1
    return row * columns + column
  }

  return {
    data,
    count,
    buckets,
    oversized: Int32Array.from(oversized),
    cellSize,
    cellAt,
    cellSlots: (cell) => (cell < 0 ? [0, 0] : [counts[cell], counts[cell + 1]]),
  }
}

/**
 * Möller–Trumbore for a horizontal ray, double-sided — a rip's barrier is one
 * sheet of geometry and a car arriving from behind it is the case that
 * matters. Twin: barrierField.ts.
 */
function rayTriangleFlat(data, base, ox, oy, oz, dx, dz) {
  const ax = data[base]
  const ay = data[base + 1]
  const az = data[base + 2]
  const e1x = data[base + 3] - ax
  const e1y = data[base + 4] - ay
  const e1z = data[base + 5] - az
  const e2x = data[base + 6] - ax
  const e2y = data[base + 7] - ay
  const e2z = data[base + 8] - az

  const px = -dz * e2y
  const py = dz * e2x - dx * e2z
  const pz = dx * e2y
  const determinant = e1x * px + e1y * py + e1z * pz
  if (Math.abs(determinant) < 1e-8) return -1
  const inverse = 1 / determinant

  const tx = ox - ax
  const ty = oy - ay
  const tz = oz - az
  const u = (tx * px + ty * py + tz * pz) * inverse
  if (u < 0 || u > 1) return -1

  const qx = ty * e1z - tz * e1y
  const qy = tz * e1x - tx * e1z
  const qz = tx * e1y - ty * e1x
  const v = (dx * qx + dz * qz) * inverse
  if (v < 0 || u + v > 1) return -1

  const distance = (e2x * qx + e2y * qy + e2z * qz) * inverse
  return distance >= 0 ? distance : -1
}

/** Distance to the first wall along a horizontal direction, or Infinity. */
function castLateral(grid, x, y, z, dx, dz, maxDistance) {
  const { data, buckets, cellSize } = grid
  let nearest = Infinity
  const seen = new Set()
  const test = (triangle) => {
    if (seen.has(triangle)) return
    seen.add(triangle)
    const hit = rayTriangleFlat(data, triangle * 9, x, y, z, dx, dz)
    if (hit >= 0 && hit < nearest) nearest = hit
  }

  const step = cellSize * 0.5
  let travelled = 0
  let lastCell = -2
  while (travelled <= maxDistance + step) {
    const cell = grid.cellAt(x + dx * travelled, z + dz * travelled)
    if (cell !== lastCell && cell >= 0) {
      const [from, to] = grid.cellSlots(cell)
      for (let slot = from; slot < to; slot++) test(buckets[slot])
    }
    lastCell = cell
    travelled += step
  }
  for (const triangle of grid.oversized) test(triangle)
  return nearest <= maxDistance ? nearest : Infinity
}

/**
 * Surface height at an x/z, taking whichever surface lies nearest `hintY`.
 *
 * The hint is what keeps a road that runs under a bridge from measuring the
 * bridge, and a valley road from measuring the mountainside above it. Twin:
 * groundField.ts.
 */
function heightAt(grid, x, z, hintY) {
  const cell = grid.cellAt(x, z)
  if (cell < 0) return Number.NaN
  const [from, to] = grid.cellSlots(cell)
  const { data, buckets } = grid
  let best = Number.NaN
  let bestGap = Infinity

  const consider = (triangle) => {
    const base = triangle * 9
    const y = verticalHit(data, base, x, z)
    if (Number.isNaN(y)) return
    const gap = Math.abs(y - hintY)
    if (gap < bestGap) {
      bestGap = gap
      best = y
    }
  }
  for (let slot = from; slot < to; slot++) consider(buckets[slot])
  for (const triangle of grid.oversized) consider(triangle)
  return best
}

/** Height of the triangle at `base` directly over an x/z, or NaN. */
function verticalHit(data, base, x, z) {
  const ax = data[base]
  const az = data[base + 2]
  const bx = data[base + 3]
  const bz = data[base + 5]
  const cx = data[base + 6]
  const cz = data[base + 8]

  const area = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz)
  if (Math.abs(area) < 1e-9) return Number.NaN
  const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / area
  const v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / area
  const w = 1 - u - v
  const tolerance = -1e-6
  if (u < tolerance || v < tolerance || w < tolerance) return Number.NaN
  return u * data[base + 1] + v * data[base + 4] + w * data[base + 7]
}

// --- The measurement --------------------------------------------------------

function makeCurve(points, tension) {
  return new THREE.CatmullRomCurve3(
    points.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
    true,
    'catmullrom',
    tension,
  )
}

/**
 * Walks the lap and asks, at every sample, how far it is to the wall on each
 * side — measured at road level, because a ray fired at the spline's own
 * guessed height on a mountain circuit is as likely to be underground as in
 * the air.
 *
 * Returns offsets in the circuit's own lateral convention: positive along
 * `UP × tangent`, so `right` is positive, `left` is negative, and `null` on
 * either means the rays reached their limit without touching anything — an
 * open verge, which is a fact about the road and not a missing measurement.
 */
function measure(curve, ground, walls, nominal) {
  const reach = nominal * PROBE_REACH
  const point = new THREE.Vector3()
  const tangent = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const left = new Array(SAMPLES).fill(null)
  const right = new Array(SAMPLES).fill(null)
  const roadY = new Array(SAMPLES).fill(Number.NaN)
  // Where each sample was taken and which way its rays went, kept only so the
  // preview can draw the walls back in world space.
  const frames = new Array(SAMPLES)
  let previousY = Number.NaN

  for (let row = 0; row < SAMPLES; row++) {
    const t = row / SAMPLES
    curve.getPointAt(t, point)
    curve.getTangentAt(t, tangent).normalize()
    normal.crossVectors(UP, tangent).normalize()

    // The previous sample's road beats the spline's own y as a hint, while
    // the two still agree about roughly where the road is. Twin: TrackModel's
    // HEIGHT_PLAUSIBLE_BAND.
    const hint =
      Number.isNaN(previousY) || Math.abs(previousY - point.y) > 12 ? point.y : previousY
    const surface = heightAt(ground, point.x, point.z, hint)
    const level = Number.isNaN(surface) ? point.y : surface
    if (!Number.isNaN(surface)) previousY = surface
    roadY[row] = level
    frames[row] = {
      point: [point.x, level, point.z],
      normal: [normal.x, 0, normal.z],
    }

    for (const side of [1, -1]) {
      let nearest = Infinity
      for (const height of PROBE_HEIGHTS) {
        const hit = castLateral(
          walls,
          point.x,
          level + height,
          point.z,
          normal.x * side,
          normal.z * side,
          reach,
        )
        if (hit < nearest) nearest = hit
      }
      if (!Number.isFinite(nearest)) continue
      if (side === 1) right[row] = nearest
      else left[row] = -nearest
    }
  }

  return { left, right, roadY, frames }
}

/**
 * The lateral correction that puts the line in the middle of the free road —
 * where there is evidence of a road to be in the middle of.
 *
 * Only the two-walls-and-a-plausible-gap case moves the line. Everything else
 * returns zero, which is not a failure: an open verge, a single rock face, a
 * gap eighty units wide are all facts about the trackside rather than about
 * the road, and a wall a car will never reach says nothing about where the
 * tarmac is. See PLAUSIBLE_WIDTH.
 *
 * Worth naming the case this deliberately does NOT fix, so nobody expects it
 * to: a line traced outside the barriers altogether. From out there the rail
 * is a near wall on the road side and the trees are a far wall on the other,
 * so the midpoint pulls *away* from the circuit — confidently, and in the
 * wrong direction. Walls cannot tell you which side of themselves you are
 * supposed to be on. That is a re-trace (scripts/bakeTrack.mjs), and the
 * boundary data written here is what makes it visible.
 */
function correctionFor(leftOffset, rightOffset, nominal) {
  if (leftOffset === null || rightOffset === null) return 0
  if (rightOffset - leftOffset > nominal * 2 * PLAUSIBLE_WIDTH) return 0
  return (leftOffset + rightOffset) / 2
}

/** A three-tap average around a closed lap. */
function smoothClosed(values) {
  const out = new Array(values.length)
  for (let i = 0; i < values.length; i++) {
    const before = values[(i - 1 + values.length) % values.length]
    const after = values[(i + 1) % values.length]
    out[i] = (before + values[i] + after) / 3
  }
  return out
}

/**
 * Redraws the control points onto the middle of the free road, and onto the
 * road's measured height while it is there.
 *
 * Resampled from the curve rather than nudged in place: the corrections are
 * measured at even distances around the lap and the control points are not,
 * so moving each control point by its nearest correction would shear the line
 * where the two spacings disagree. Sampling the corrected curve at the same
 * count the trace produced keeps the file the shape it was.
 */
function recentre(curve, shifts, ground, count) {
  const smoothed = smoothClosed(smoothClosed(shifts))
  const point = new THREE.Vector3()
  const tangent = new THREE.Vector3()
  const normal = new THREE.Vector3()
  const points = []

  for (let i = 0; i < count; i++) {
    const t = i / count
    curve.getPointAt(t, point)
    curve.getTangentAt(t, tangent).normalize()
    normal.crossVectors(UP, tangent).normalize()

    const scaled = t * shifts.length
    const row = Math.floor(scaled) % shifts.length
    const next = (row + 1) % shifts.length
    const blend = scaled - Math.floor(scaled)
    const shift = smoothed[row] + (smoothed[next] - smoothed[row]) * blend

    point.addScaledVector(normal, shift)
    const surface = heightAt(ground, point.x, point.z, point.y)
    points.push([point.x, Number.isNaN(surface) ? point.y : surface, point.z])
  }
  return points
}

// --- The drawing ------------------------------------------------------------

/** Edge of the preview, in pixels, and the margin inside it. */
const PREVIEW_SIZE = 1000
const PREVIEW_MARGIN = 40

/**
 * A plan view of what was decided: the path in red, the left wall in blue,
 * the right wall in orange, and a grey hairline joining the two walls wherever
 * both were found.
 *
 * Here for the same reason bakeTrack writes its trace preview. These are
 * eighteen hundred numbers per circuit, and the only way to know whether they
 * describe a road is to look at them: a corridor that pinches to nothing at a
 * gantry, a stretch where the rays found a treeline instead of a rail, a
 * hairpin the line cuts through the inside of — all obvious in a picture and
 * all invisible in a JSON array.
 */
async function writePreview(points, measured, path) {
  const pixels = Buffer.alloc(PREVIEW_SIZE * PREVIEW_SIZE * 3, 18)

  const wall = (row, side) => {
    const offset = side === 1 ? measured.right[row] : measured.left[row]
    if (offset === null) return null
    const { point, normal } = measured.frames[row]
    return [point[0] + normal[0] * offset, point[2] + normal[2] * offset]
  }

  const lines = []
  const path2d = points.map(([x, , z]) => [x, z])
  lines.push({ colour: [255, 60, 90], closed: true, points: path2d, width: 2 })

  for (const side of [1, -1]) {
    const colour = side === 1 ? [255, 168, 64] : [90, 170, 255]
    let run = []
    for (let row = 0; row <= SAMPLES; row++) {
      const spot = wall(row % SAMPLES, side)
      if (spot === null) {
        if (run.length > 1) lines.push({ colour, closed: false, points: run, width: 1 })
        run = []
        continue
      }
      run.push(spot)
    }
    if (run.length > 1) lines.push({ colour, closed: false, points: run, width: 1 })
  }

  // The rungs, drawn first so the walls and the line sit on top of them.
  const rungs = []
  for (let row = 0; row < SAMPLES; row += 2) {
    const left = wall(row, -1)
    const right = wall(row, 1)
    if (left === null || right === null) continue
    rungs.push({ colour: [70, 70, 80], closed: false, points: [left, right], width: 0 })
  }

  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const line of [...rungs, ...lines]) {
    for (const [x, z] of line.points) {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minZ = Math.min(minZ, z)
      maxZ = Math.max(maxZ, z)
    }
  }
  const span = Math.max(maxX - minX, maxZ - minZ) || 1
  const scale = (PREVIEW_SIZE - PREVIEW_MARGIN * 2) / span
  const toPixel = ([x, z]) => [
    Math.round(PREVIEW_MARGIN + (x - minX) * scale),
    Math.round(PREVIEW_MARGIN + (z - minZ) * scale),
  ]

  const plot = (px, pz, colour) => {
    if (px < 0 || pz < 0 || px >= PREVIEW_SIZE || pz >= PREVIEW_SIZE) return
    const i = (pz * PREVIEW_SIZE + px) * 3
    pixels[i] = colour[0]
    pixels[i + 1] = colour[1]
    pixels[i + 2] = colour[2]
  }

  for (const line of [...rungs, ...lines]) {
    const count = line.closed ? line.points.length : line.points.length - 1
    for (let n = 0; n < count; n++) {
      const [x0, z0] = toPixel(line.points[n])
      const [x1, z1] = toPixel(line.points[(n + 1) % line.points.length])
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0), 1)
      for (let step = 0; step <= steps; step++) {
        const px = Math.round(x0 + ((x1 - x0) * step) / steps)
        const pz = Math.round(z0 + ((z1 - z0) * step) / steps)
        for (let dz = -line.width; dz <= line.width; dz++) {
          for (let dx = -line.width; dx <= line.width; dx++) plot(px + dx, pz + dz, line.colour)
        }
      }
    }
  }

  await sharp(pixels, {
    raw: { width: PREVIEW_SIZE, height: PREVIEW_SIZE, channels: 3 },
  }).png().toFile(path)
}

// --- Reporting --------------------------------------------------------------

function report(slug, left, right, nominal) {
  let open = 0
  let narrowest = Infinity
  const widths = []
  for (let row = 0; row < left.length; row++) {
    if (left[row] === null || right[row] === null) {
      open++
      continue
    }
    const width = right[row] - left[row]
    widths.push(width)
    narrowest = Math.min(narrowest, width)
  }
  widths.sort((a, b) => a - b)
  const median = widths.length > 0 ? widths[Math.floor(widths.length / 2)] : Number.NaN
  const openShare = Math.round((open / left.length) * 100)
  console.log(
    `  boundaries: nominal width ${(nominal * 2).toFixed(1)}, ` +
      `median measured ${median.toFixed(1)}, narrowest ${narrowest.toFixed(1)}, ` +
      `${openShare}% of the lap open on at least one side.`,
  )
  if (openShare > 60) {
    console.warn(
      '  most of this lap has no wall either side. The cars will run on the ' +
        'nominal width there, which is the old behaviour — check the model ' +
        'actually has barriers before trusting the corridor.',
    )
  }
}

// --- One circuit ------------------------------------------------------------

async function bake(slug, passes = RECENTRE_PASSES) {
  const jsonPath = resolve(TRACK_DIR, `${slug}.track.json`)
  const glbPath = resolve(MODEL_DIR, `${slug}.glb`)
  const track = JSON.parse(await readFile(jsonPath, 'utf8'))

  console.log(`${slug}: reading ${glbPath}`)
  const triangles = await readTriangles(glbPath)
  const ground = buildGrid(filterByNormal(triangles, (absY) => absY >= GROUND_NORMAL_Y))
  const walls = buildGrid(filterByNormal(triangles, (absY) => absY <= WALL_NORMAL_Y))
  console.log(
    `  ${(triangles.length / 9).toLocaleString()} triangles — ` +
      `${ground.count.toLocaleString()} ground, ${walls.count.toLocaleString()} wall`,
  )
  if (walls.count === 0) throw new Error(`${slug}: the model has no wall geometry to measure.`)

  const nominal = track.roadHalfWidth
  const tension = 0.5
  let points = track.controlPoints
  let curve = makeCurve(points, tension)
  let measured = measure(curve, ground, walls, nominal)

  // How far each sample has been moved from where the trace put it, so the
  // total can be capped rather than only each step. Accumulated in the
  // lateral frame of whichever pass applied it, which is an approximation —
  // the frame turns slightly as the line moves — and a perfectly good one for
  // a cap whose whole job is to catch corrections of the wrong order.
  const drift = new Array(SAMPLES).fill(0)

  for (let pass = 0; pass < passes; pass++) {
    const shifts = measured.left.map((leftOffset, row) => {
      const wanted = correctionFor(leftOffset, measured.right[row], nominal)
      const stepped = Math.max(-MAX_SHIFT_PER_PASS, Math.min(MAX_SHIFT_PER_PASS, wanted))
      const capped = Math.max(
        -MAX_TOTAL_DRIFT,
        Math.min(MAX_TOTAL_DRIFT, drift[row] + stepped),
      )
      const applied = capped - drift[row]
      drift[row] = capped
      return applied
    })

    const moved = shifts.reduce((sum, value) => sum + Math.abs(value), 0) / shifts.length
    const worst = shifts.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
    const corrected = shifts.filter((value) => Math.abs(value) > 0.05).length
    points = recentre(curve, shifts, ground, points.length)
    curve = makeCurve(points, tension)
    measured = measure(curve, ground, walls, nominal)
    console.log(
      `  pass ${pass + 1}: ${corrected} of ${SAMPLES} samples corrected, ` +
        `${moved.toFixed(2)} on average, ${worst.toFixed(2)} at most`,
    )
  }

  const totalDrift = drift.reduce((sum, value) => sum + Math.abs(value), 0) / drift.length
  const peggedDrift = drift.filter((value) => Math.abs(value) >= MAX_TOTAL_DRIFT - 0.01).length
  console.log(
    `  line: moved ${totalDrift.toFixed(2)} from the trace on average, ` +
      `${peggedDrift} samples at the ${MAX_TOTAL_DRIFT} unit limit`,
  )
  if (peggedDrift > SAMPLES * 0.1) {
    console.warn(
      '  a tenth of this lap wanted moving further than the limit allows. The ' +
        'traced line is off the road there rather than wide of its middle — ' +
        're-trace it with scripts/bakeTrack.mjs rather than trusting this.',
    )
  }

  report(slug, measured.left, measured.right, nominal)

  const bounds = points.reduce(
    (box, [x, , z]) => ({
      minX: Math.min(box.minX, x),
      maxX: Math.max(box.maxX, x),
      minZ: Math.min(box.minZ, z),
      maxZ: Math.max(box.maxZ, z),
    }),
    { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity },
  )

  const next = {
    ...track,
    controlPoints: points.map((point) => point.map(round)),
    bounds: {
      minX: round(bounds.minX),
      maxX: round(bounds.maxX),
      minZ: round(bounds.minZ),
      maxZ: round(bounds.maxZ),
    },
    boundaries: {
      samples: SAMPLES,
      probeHeights: PROBE_HEIGHTS,
      left: measured.left.map((value) => (value === null ? null : round(value))),
      right: measured.right.map((value) => (value === null ? null : round(value))),
    },
  }
  await writeFile(jsonPath, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`  wrote ${jsonPath}`)

  const previewPath = resolve(TRACK_DIR, `${slug}.boundaries.png`)
  await writePreview(points, measured, previewPath)
  console.log(`  wrote ${previewPath}  <- look at it before trusting any of this`)
}

async function main() {
  const argv = process.argv.slice(2)
  const slugs = []
  let passes = RECENTRE_PASSES
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--slug') slugs.push(argv[++i])
    else if (argv[i] === '--all') slugs.push('drift-yard', 'lone-peak', 'bushido-peak')
    // Zero measures the boundaries and leaves the traced line alone, which is
    // how you see what the recentring is actually buying.
    else if (argv[i] === '--passes') passes = Number(argv[++i])
  }
  if (slugs.length === 0) {
    console.error('usage: node scripts/bakeCorridor.mjs --slug <name> | --all [--passes n]')
    process.exit(1)
  }
  for (const slug of slugs) await bake(slug, passes)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
