#!/usr/bin/env node
//
// Re-fits a baked track's racing line to the road it was traced from.
//
// The bake's trace is a first draft, and the drafts have real faults on
// screen: Bushido Peak's line ties a knot through a farmyard, Lone Peak's
// takes boxy detours through the village, and Drift Yard's hugs an inner
// kerb it should be clearing. The runtime corridor holds cars off the
// barriers, but it is capped at a fraction of the road width — it can nudge
// a line, not rescue one — so the honest fix is the line itself.
//
// The method is an active contour over the road's own distance field:
//
//   1. Rasterise the road footprint from the baked GLB, exactly as the bake
//      did, and build a *signed* distance field — positive inside the road,
//      measured to the nearest edge; negative outside, measured back to the
//      tarmac. The sign is what lets a point that has left the road feel
//      which way home is.
//   2. Sample the current spline densely and relax it: every sample walks
//      uphill on the field towards the road's medial ridge, and a smoothing
//      term keeps the loop from wrinkling as it goes. The ascent fades out
//      once a sample has the clearance a car needs, so the line centres in
//      the pinches without straightening the honest racing arcs elsewhere.
//   3. Resample the relaxed loop back to the original control-point count,
//      carrying the original heights along, and write the JSON and a fresh
//      preview PNG.
//
// Usage: node scripts/fixRacingLine.mjs [slug ...]   (default: all baked tracks)

import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import sharp from 'sharp'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { rasteriseRoad, distanceTransform, despeckle, closeGaps } from './trackGrid.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_SLUGS = ['drift-yard', 'lone-peak', 'bushido-peak']

/** Dense samples the relaxation works on. */
const RELAX_SAMPLES = 720
/**
 * Longest arc a self-intersection may enclose and still be cut out, as a
 * fraction of the lap. A knot is a short excursion that crosses itself;
 * anything longer that intersects is the lap's own figure-eight geometry
 * (an overpass), which must never be "repaired".
 */
const KNOT_MAX_ARC = 0.09
/** Relaxation iterations. Converges long before this; cheap either way. */
const RELAX_ITERATIONS = 260
/** World units a sample may move per iteration, at full pull. */
const RELAX_STEP = 0.9
/**
 * Clearance a sample stops climbing at, in world units. A shade over the
 * corridor's own barrier clearance plus a car's half width: enough road either
 * side that the lane grid fits, not so much that the line is forced onto the
 * exact centre of a wide straight.
 */
const TARGET_CLEARANCE = 5.2
/**
 * Laplacian smoothing weight per iteration. Enough to unpick a knot and calm
 * the trace's grid-walk jitter; low enough that hairpins stay hairpins.
 */
const SMOOTHING = 0.12
/** Same detection thresholds the bake uses for anonymised rip materials. */
const RIP_MIN_TRIANGLES = 90
const RIP_MIN_CELLS = 400
const RIP_THINNESS = 0.28

function multiplyMatrices(a, b) {
  const out = new Array(16).fill(0)
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k]
      out[column * 4 + row] = sum
    }
  }
  return out
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function transformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ]
}

/**
 * Denormalisation factor for a quantised accessor. The baked GLBs store
 * positions as normalized Int16 (KHR_mesh_quantization), so the raw array
 * holds ±32767 and the real scale sits on the node — reading the ints
 * straight put the road ninety thousand units from its own racing line.
 */
function normalisationScale(accessor) {
  if (!accessor.getNormalized()) return 1
  const array = accessor.getArray()
  if (array instanceof Int16Array) return 1 / 32767
  if (array instanceof Uint16Array) return 1 / 65535
  if (array instanceof Int8Array) return 1 / 127
  if (array instanceof Uint8Array) return 1 / 255
  return 1
}

/** World-space triangles for every primitive whose material passes `accept`. */
function collectGeometry(document, accept, { upFacingOnly = false } = {}) {
  const positions = []
  const indices = []

  const visit = (node, parentMatrix) => {
    const matrix = multiplyMatrices(parentMatrix, node.getMatrix())
    const mesh = node.getMesh()
    if (mesh) {
      for (const primitive of mesh.listPrimitives()) {
        if (!accept(primitive.getMaterial()?.getName() ?? '')) continue
        const accessor = primitive.getAttribute('POSITION')
        const source = accessor?.getArray()
        if (!accessor || !source) continue
        const denormalise = normalisationScale(accessor)
        const base = positions.length / 3
        for (let i = 0; i < source.length; i += 3) {
          const [x, y, z] = transformPoint(
            matrix,
            source[i] * denormalise,
            source[i + 1] * denormalise,
            source[i + 2] * denormalise,
          )
          positions.push(x, y, z)
        }
        const primitiveIndices = primitive.getIndices()?.getArray()
        if (primitiveIndices) {
          for (const value of primitiveIndices) indices.push(base + value)
        } else {
          for (let i = 0; i < source.length / 3; i++) indices.push(base + i)
        }
      }
    }
    for (const child of node.listChildren()) visit(child, matrix)
  }

  for (const scene of document.getRoot().listScenes()) {
    for (const node of scene.listChildren()) visit(node, IDENTITY)
  }

  if (!upFacingOnly) {
    return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
  }

  const kept = []
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3]
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2]
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const length = Math.hypot(nx, ny, nz)
    if (length === 0 || Math.abs(ny) / length < 0.65) continue
    kept.push(indices[t], indices[t + 1], indices[t + 2])
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(kept) }
}

/** The bake's own ribbon test, re-run against the baked model. */
function detectRoadMaterials(document) {
  const names = document.getRoot().listMaterials().map((material) => material.getName())
  const chosen = []
  for (const name of names) {
    const { positions, indices } = collectGeometry(document, (n) => n === name, {
      upFacingOnly: true,
    })
    if (indices.length < RIP_MIN_TRIANGLES) continue
    const grid = rasteriseRoad(positions, indices)
    let cells = 0
    let edge = 0
    const { size, occupancy } = grid
    for (let gz = 1; gz < size - 1; gz++) {
      for (let gx = 1; gx < size - 1; gx++) {
        const i = gz * size + gx
        if (!occupancy[i]) continue
        cells++
        if (!occupancy[i - 1] || !occupancy[i + 1] || !occupancy[i - size] || !occupancy[i + size]) {
          edge++
        }
      }
    }
    if (cells < RIP_MIN_CELLS) continue
    if (edge / cells >= RIP_THINNESS) chosen.push(name)
  }
  return new Set(chosen)
}

/**
 * Signed distance field over the grid: positive cells sit on the road,
 * measured in world units to the nearest edge; negative cells are off it,
 * measured back to the tarmac. Bilinear-sampled so the relaxation feels a
 * gradient rather than a staircase.
 */
function buildSignedField(grid) {
  const inside = distanceTransform(grid)
  const inverted = {
    ...grid,
    occupancy: Uint8Array.from(grid.occupancy, (cell) => (cell ? 0 : 1)),
  }
  const outside = distanceTransform(inverted)

  const { size, minX, minZ, cell } = grid
  const signed = new Float32Array(size * size)
  for (let i = 0; i < signed.length; i++) {
    signed[i] = (grid.occupancy[i] ? inside[i] : -outside[i]) * cell
  }

  const sampleCell = (gx, gz) => {
    const cx = Math.min(size - 1, Math.max(0, gx))
    const cz = Math.min(size - 1, Math.max(0, gz))
    return signed[cz * size + cx]
  }

  const sample = (x, z) => {
    const fx = (x - minX) / cell - 0.5
    const fz = (z - minZ) / cell - 0.5
    const gx = Math.floor(fx)
    const gz = Math.floor(fz)
    const tx = fx - gx
    const tz = fz - gz
    const a = sampleCell(gx, gz)
    const b = sampleCell(gx + 1, gz)
    const c = sampleCell(gx, gz + 1)
    const d = sampleCell(gx + 1, gz + 1)
    return a + (b - a) * tx + ((c + (d - c) * tx) - (a + (b - a) * tx)) * tz
  }

  return { sample, cell }
}

/** Stats over a closed polyline: clearance to the road edge, and off-road share. */
function measureLine(points, field) {
  let worst = Infinity
  let sum = 0
  let offRoad = 0
  for (const point of points) {
    const clearance = field.sample(point.x, point.z)
    worst = Math.min(worst, clearance)
    sum += clearance
    if (clearance <= 0) offRoad++
  }
  return {
    worst,
    mean: sum / points.length,
    offRoadShare: offRoad / points.length,
  }
}

function relax(points, field, options = {}) {
  const {
    /** Clearance the uphill pull fades out at. */
    target = TARGET_CLEARANCE,
    /** Hard cap on how far any point may move from where it started. */
    maxMove = Infinity,
    smoothing = SMOOTHING,
  } = options
  const count = points.length
  const step = field.cell * 0.75
  const baseline = Number.isFinite(maxMove)
    ? points.map((point) => ({ x: point.x, z: point.z }))
    : null

  for (let iteration = 0; iteration < RELAX_ITERATIONS; iteration++) {
    for (let i = 0; i < count; i++) {
      const point = points[i]
      const clearance = field.sample(point.x, point.z)

      // How hard the field pulls. Full pull off the road or against a wall,
      // fading to nothing once the sample has the clearance asked for.
      const pull = Math.max(0, Math.min(1, 1 - clearance / target))
      if (pull > 0) {
        const gx = field.sample(point.x + step, point.z) - field.sample(point.x - step, point.z)
        const gz = field.sample(point.x, point.z + step) - field.sample(point.x, point.z - step)
        const length = Math.hypot(gx, gz)
        if (length > 1e-6) {
          point.x += (gx / length) * RELAX_STEP * pull
          point.z += (gz / length) * RELAX_STEP * pull
        }
      }

      // Laplacian smoothing, wrapped. This is what unpicks a knotted detour:
      // once the field stops holding a loop's points apart, the average pulls
      // the excursion straight through itself and it collapses.
      const previous = points[(i - 1 + count) % count]
      const next = points[(i + 1) % count]
      point.x += ((previous.x + next.x) / 2 - point.x) * smoothing
      point.z += ((previous.z + next.z) / 2 - point.z) * smoothing
      point.y += ((previous.y + next.y) / 2 - point.y) * smoothing

      // The leash. On a circuit whose field cannot be fully trusted, the
      // repair may pull a point towards better ground but never march the
      // whole line away from the trace.
      if (baseline) {
        const dx = point.x - baseline[i].x
        const dz = point.z - baseline[i].z
        const distance = Math.hypot(dx, dz)
        if (distance > maxMove) {
          const scale = maxMove / distance
          point.x = baseline[i].x + dx * scale
          point.z = baseline[i].z + dz * scale
        }
      }
    }
  }
}

/** Whether segments a-b and c-d cross on the ground plane. */
function segmentsIntersect(a, b, c, d) {
  const orient = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x)
  const o1 = orient(a, b, c)
  const o2 = orient(a, b, d)
  const o3 = orient(c, d, a)
  const o4 = orient(c, d, b)
  return o1 * o2 < 0 && o3 * o4 < 0
}

/**
 * Cuts self-intersection knots out of a closed polyline.
 *
 * A knot is the trace's worst failure mode on a rip: the medial-axis walk
 * takes a farmyard detour, crosses its own path on the way back, and the
 * cars drive a little pretzel through the buildings every lap. The loop is
 * found by testing non-adjacent segments for crossing within a short arc
 * (see KNOT_MAX_ARC) and removed by bridging straight across; the smoothing
 * pass afterwards rounds the bridge into the line.
 */
function cutKnots(points) {
  const maxArc = Math.round(points.length * KNOT_MAX_ARC)
  let cuts = 0
  let found = true
  while (found && cuts < 8) {
    found = false
    const count = points.length
    outer: for (let i = 0; i < count; i++) {
      for (let span = 2; span <= maxArc; span++) {
        const j = (i + span) % count
        const a = points[i]
        const b = points[(i + 1) % count]
        const c = points[j]
        const d = points[(j + 1) % count]
        if (!segmentsIntersect(a, b, c, d)) continue
        // Remove everything strictly inside the loop: (i+1 .. j).
        const removed = []
        for (let k = (i + 1) % count, taken = 0; taken < span; k = (k + 1) % count, taken++) {
          removed.push(k)
        }
        const keep = new Set(removed)
        const next = points.filter((_, index) => !keep.has(index))
        points.length = 0
        points.push(...next)
        cuts++
        found = true
        break outer
      }
    }
  }
  return cuts
}

/** Even arc-length resample of a closed polyline down to `count` points. */
function resampleClosed(points, count) {
  const lengths = [0]
  for (let i = 1; i <= points.length; i++) {
    const a = points[i - 1]
    const b = points[i % points.length]
    lengths.push(lengths[i - 1] + Math.hypot(b.x - a.x, b.z - a.z))
  }
  const total = lengths[points.length]

  const output = []
  let cursor = 0
  for (let i = 0; i < count; i++) {
    const target = (i / count) * total
    while (cursor < points.length - 1 && lengths[cursor + 1] < target) cursor++
    const a = points[cursor]
    const b = points[(cursor + 1) % points.length]
    const span = lengths[cursor + 1] - lengths[cursor]
    const t = span > 1e-9 ? (target - lengths[cursor]) / span : 0
    output.push({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    })
  }
  return output
}

/** Same preview drawing the bake writes, so the two stay comparable. */
async function writePreview(grid, points, path) {
  const { size } = grid
  const pixels = Buffer.alloc(size * size * 3)
  for (let i = 0; i < grid.occupancy.length; i++) {
    const road = grid.occupancy[i]
    pixels[i * 3] = road ? 96 : 22
    pixels[i * 3 + 1] = road ? 96 : 22
    pixels[i * 3 + 2] = road ? 118 : 30
  }

  const toCell = (point) => [
    Math.round((point.x - grid.minX) / grid.cell),
    Math.round((point.z - grid.minZ) / grid.cell),
  ]

  for (let n = 0; n < points.length; n++) {
    const [x0, z0] = toCell(points[n])
    const [x1, z1] = toCell(points[(n + 1) % points.length])
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(z1 - z0), 1)
    for (let step = 0; step <= steps; step++) {
      const gx = Math.round(x0 + ((x1 - x0) * step) / steps)
      const gz = Math.round(z0 + ((z1 - z0) * step) / steps)
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const px = gx + dx, pz = gz + dz
          if (px < 0 || pz < 0 || px >= size || pz >= size) continue
          const i = (pz * size + px) * 3
          pixels[i] = 255; pixels[i + 1] = 40; pixels[i + 2] = 90
        }
      }
    }
  }

  await sharp(pixels, { raw: { width: size, height: size, channels: 3 } }).png().toFile(path)
}

const round = (value) => Math.round(value * 1000) / 1000

async function fixTrack(slug) {
  const jsonPath = resolve(ROOT, `app/leon/channels/race/tracks/${slug}.track.json`)
  const glbPath = resolve(ROOT, `public/ps1/tracks/${slug}.glb`)
  const baked = JSON.parse(await readFile(jsonPath, 'utf8'))

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const document = await io.read(glbPath)

  let roadGeometry
  if (baked.roadMaterial === 'auto') {
    const roadMaterials = detectRoadMaterials(document)
    if (roadMaterials.size === 0) throw new Error(`${slug}: no ribbon materials found`)
    roadGeometry = collectGeometry(document, (name) => roadMaterials.has(name), {
      upFacingOnly: true,
    })
  } else {
    const wanted = new Set(baked.roadMaterial.split(','))
    roadGeometry = collectGeometry(document, (name) => wanted.has(name))
  }

  const grid = rasteriseRoad(roadGeometry.positions, roadGeometry.indices)
  if (baked.roadMaterial === 'auto') {
    // The same forgiveness the bake's trace ran with: a rip's road arrives in
    // spatial chunks whose seams rasterise as hairline gaps, and without the
    // close the field reads every seam as the edge of the world and pulls the
    // line towards the middle of whichever chunk it happens to be on.
    grid.occupancy = closeGaps(despeckle(grid.occupancy, grid.size, 60), grid.size, 6)
  }
  const field = buildSignedField(grid)

  // The spline exactly as the runtime builds it, sampled densely.
  const curve = new THREE.CatmullRomCurve3(
    baked.controlPoints.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
    true,
    'catmullrom',
    0.5,
  )
  const sampleCurve = (source) =>
    source
      .getSpacedPoints(RELAX_SAMPLES)
      .slice(0, RELAX_SAMPLES)
      .map((point) => ({ x: point.x, y: point.y, z: point.z }))

  let points = sampleCurve(curve)
  const before = measureLine(points, field)
  const controlCount = Math.max(baked.controlPoints.length, RELAX_SAMPLES / 5)
  let controls
  let refitPoints
  let final

  if (baked.roadMaterial === 'auto') {
    // A rip. Its field is only half-trustworthy — the ribbon test matches
    // riverbanks and hedgerows as readily as tarmac — so the trace is
    // *repaired*, never redrawn: knots cut, then a leashed relax that pulls
    // only where the line has genuinely left the footprint (target 2 rather
    // than a full car's clearance, so an on-road line feels no pull at all)
    // and never further than the leash allows. An earlier version ran the
    // full centring relax here and marched the line thirty-four units into
    // the river.
    const cuts = cutKnots(points)
    if (cuts > 0) console.log(`${slug}: cut ${cuts} self-intersection knot(s)`)
    relax(points, field, { target: 2, maxMove: 14, smoothing: 0.06 })
    controls = resampleClosed(points, controlCount)
    const refit = new THREE.CatmullRomCurve3(
      controls.map((point) => new THREE.Vector3(point.x, point.y, point.z)),
      true,
      'catmullrom',
      0.5,
    )
    refitPoints = sampleCurve(refit)
    final = measureLine(refitPoints, field)
  } else {
    // A marketplace circuit names its road material, the footprint is the
    // real tarmac, and the full relaxation is safe.
    //
    // A spline is not the polyline it was fitted to: Catmull-Rom through the
    // reduced control points overshoots exactly the corners the relaxation
    // just fixed. So relax and refit in rounds, each round relaxing the
    // spline the game would actually drive, until the two stop disagreeing.
    for (let round = 0; round < 4; round++) {
      relax(points, field)
      controls = resampleClosed(points, controlCount)
      const refit = new THREE.CatmullRomCurve3(
        controls.map((point) => new THREE.Vector3(point.x, point.y, point.z)),
        true,
        'catmullrom',
        0.5,
      )
      refitPoints = sampleCurve(refit)
      final = measureLine(refitPoints, field)
      if (final.worst > 0.5 && final.offRoadShare === 0) break
      points = refitPoints
    }
  }

  baked.controlPoints = controls.map((point) => [round(point.x), round(point.y), round(point.z)])
  await writeFile(jsonPath, JSON.stringify(baked, null, 2) + '\n')
  await writePreview(grid, refitPoints, resolve(ROOT, `app/leon/channels/race/tracks/${slug}.trace.png`))

  console.log(
    `${slug}: clearance worst ${before.worst.toFixed(1)} -> ${final.worst.toFixed(1)}, ` +
      `mean ${before.mean.toFixed(1)} -> ${final.mean.toFixed(1)}, ` +
      `off-road ${(before.offRoadShare * 100).toFixed(1)}% -> ${(final.offRoadShare * 100).toFixed(1)}%`,
  )
}

const slugs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SLUGS
for (const slug of slugs) {
  await fixTrack(slug)
}
