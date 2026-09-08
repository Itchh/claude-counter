#!/usr/bin/env node
//
// Turns a line drawn on a printed plan back into a circuit's centreline.
//
// The bake traces the racing line automatically (see trackGrid.mjs) and on a
// real road course it gets some of it wrong — a rip's road network has
// junctions, service roads and car parks, and no amount of image processing
// knows which of them the race uses. A person looking at a plan knows
// immediately. So: render the circuit from above with its current line on it
// (scripts/planTrack.mjs), let someone draw the real lap over the top in one
// unmistakable colour, and read it back here.
//
// Three problems have to be solved for that to work, and each is the reason
// for a section below.
//
//   1. The drawing comes back as a SCREENSHOT — cropped, rescaled, not the
//      image we sent. So the plan's own control-point dots are used as
//      registration marks: their world positions are known exactly, which
//      makes recovering the scale and offset a least-squares fit rather than
//      a guess.
//   2. A drawn stroke is a RIBBON, not a path. It is marched rather than
//      skeletonised — step along it, look ahead in a cone, take the centroid
//      of what is in front — which is robust to a wobbly hand and to the
//      stroke crossing itself at a junction.
//   3. The plan is FLAT and the circuit is not. Sampling the height straight
//      down at each point gives the mountain above a tunnel, not the tunnel.
//      So every candidate surface at each point is collected, and the path
//      through them that changes height least is chosen — which is what a
//      road is.
//
// Usage:
//   node scripts/traceFromPlan.mjs --slug bushido-peak --image drawn.png \
//     [--colour cyan] [--points 72] [--dry]

import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import sharp from 'sharp'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// --- the plan's own geometry ------------------------------------------------
//
// Must match planTrack.mjs / the plan renderer exactly, or nothing lands where
// it should. The frame is derived from the line the plan was drawn with, which
// is why the OLD control points are needed even though they are about to be
// replaced.

const PLAN_SIZE = 1400
const PLAN_MARGIN = 1.35

function planFrame(controlPoints) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const [x, , z] of controlPoints) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
  }
  const centreX = (minX + maxX) / 2
  const centreZ = (minZ + maxZ) / 2
  const span = Math.max(maxX - minX, maxZ - minZ) * PLAN_MARGIN
  return {
    span,
    centreX,
    centreZ,
    toPixel: (x, z) => [
      ((x - (centreX - span / 2)) / span) * PLAN_SIZE,
      ((z - (centreZ - span / 2)) / span) * PLAN_SIZE,
    ],
    toWorld: (px, py) => [
      (px / PLAN_SIZE) * span + centreX - span / 2,
      (py / PLAN_SIZE) * span + centreZ - span / 2,
    ],
  }
}

// --- masks ------------------------------------------------------------------

const COLOURS = {
  // The stroke. Generous, because a screenshot has been through a compressor
  // and an anti-aliased edge is every colour between the line and the map.
  cyan: (r, g, b) => b > 150 && g > 150 && b - r > 45,
  red: (r, g, b) => r > 150 && r - g > 60 && r - b > 60,
  magenta: (r, g, b) => r > 150 && b > 150 && r - g > 60 && b - g > 60,
}

/**
 * The plan's control-point dots, which are the registration marks.
 *
 * Tight, because the alternative is registering the drawing against autumn
 * trees. The dots are drawn at a known colour and lit by one flat light, so
 * they land in a narrow band; a maple in October does not.
 */
const isMark = (r, g, b) => r > 225 && g > 145 && g < 205 && b < 70

function maskOf(data, width, height, channels, test) {
  const mask = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i += 1) {
    const p = i * channels
    if (test(data[p], data[p + 1], data[p + 2])) mask[i] = 1
  }
  return mask
}

/**
 * Splits a colour mask into its connected pieces, largest first.
 *
 * Two things make this necessary. The plan labels its own grid in cyan, so a
 * colour test picks up "x=-300" as enthusiastically as the line drawn over
 * the circuit — those come back as tiny pieces and are dropped on size. And
 * the drawn line itself is not one piece: it passes behind the plan's own
 * control-point dots, which cut it into segments. This one arrived in six.
 */
function components(mask, width, height) {
  const seen = new Uint8Array(mask.length)
  const found = []
  const stack = []
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue
    seen[start] = 1
    stack.length = 0
    stack.push(start)
    const pixels = []
    while (stack.length > 0) {
      const index = stack.pop()
      pixels.push(index)
      const x = index % width
      const y = (index / width) | 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const j = ny * width + nx
        if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j) }
      }
    }
    found.push(pixels)
  }
  found.sort((a, b) => b.length - a.length)
  return found
}

/** Connected components of a mask, as centroids with pixel counts. */
function blobs(mask, width, height, minPixels) {
  const seen = new Uint8Array(mask.length)
  const found = []
  const stack = []
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue
    seen[start] = 1
    stack.length = 0
    stack.push(start)
    let sumX = 0, sumY = 0, count = 0
    while (stack.length > 0) {
      const index = stack.pop()
      const x = index % width
      const y = (index / width) | 0
      sumX += x; sumY += y; count += 1
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const j = ny * width + nx
        if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j) }
      }
    }
    if (count >= minPixels) found.push({ x: sumX / count, y: sumY / count, count })
  }
  return found
}

// --- registration -----------------------------------------------------------

/**
 * Recovers the screenshot's scale and offset from the registration marks.
 *
 * By consensus, not by least squares. The obvious fit — pair each mark with
 * its nearest neighbour and minimise — assumes the two sets are the same
 * points, and they are not: the drawing hides some marks, the screenshot
 * crops others, and the colour test finds a few things that are not marks at
 * all. One such outlier drags a least-squares fit, and the first version of
 * this drifted to a scale of 1.6 on an image that was plainly at 1.27.
 *
 * So: propose a transform from two marks, count how many others agree, keep
 * whichever proposal the most marks vote for, and only then refine on those.
 * Rotation is not solved for — nobody rotates a screenshot, and every
 * parameter left out is a parameter that cannot go wrong.
 */
function fitTransform(expected, observed, sizeRatio) {
  const INLIER_PX = 10
  const BIN = 8

  // The scale is scanned, not guessed. Every guess tried here — the ratio of
  // the clouds' extents, then of their median spacings — was thrown off by
  // the fact that the marks left visible are a biased sample: they are the
  // ones the drawing did NOT cover, which means the ones furthest from the
  // lap. A scan costs a few hundred thousand additions and cannot be biased.
  //
  // The window is set by the screenshot's own size against the plan's: a
  // screenshot is somewhere between the whole plan and a close crop of it.
  const lowest = Math.max(0.4, sizeRatio * 0.75)
  const highest = sizeRatio * 2.2

  // Voting, not sampling. Two-point RANSAC needs to draw two correct pairings
  // at once, which on ninety marks is a one-in-five-thousand shot per attempt
  // — the first version of this drew six thousand times and still failed. If
  // the scale is fixed, though, a single pairing determines the offset, so
  // every pairing can simply vote for one and the true offset wins by a
  // landslide.
  let best = null
  const steps = Math.ceil((highest - lowest) / (lowest * 0.004))
  for (let step = 0; step <= steps; step += 1) {
    const scale = lowest * Math.pow(1.004, step)
    const votes = new Map()
    for (const e of expected) {
      const ex = scale * e.x
      const ey = scale * e.y
      for (const o of observed) {
        const key = `${Math.round((o.x - ex) / BIN)},${Math.round((o.y - ey) / BIN)}`
        const cell = votes.get(key)
        if (cell) { cell.x += o.x - ex; cell.y += o.y - ey; cell.n += 1 }
        else votes.set(key, { x: o.x - ex, y: o.y - ey, n: 1 })
      }
    }
    for (const cell of votes.values()) {
      if (cell.n < 6) continue
      const offsetX = cell.x / cell.n
      const offsetY = cell.y / cell.n
      let inliers = 0
      for (const e of expected) {
        const ex = scale * e.x + offsetX
        const ey = scale * e.y + offsetY
        for (const o of observed) {
          if (Math.hypot(o.x - ex, o.y - ey) <= INLIER_PX) { inliers += 1; break }
        }
      }
      if (!best || inliers > best.inliers) best = { scale, offsetX, offsetY, inliers }
    }
  }

  if (!best || best.inliers < 12) {
    throw new Error(
      `registration failed — only ${best?.inliers ?? 0} marks agreed. ` +
        'Is --frame the track file the plan was rendered from?',
    )
  }

  // Refine by annealing: pair every expected mark with the observed one it
  // sits on, solve, then tighten the radius and do it again. A single pass at
  // a loose radius lets a near-miss pairing pull the scale, and the pull
  // recruits more near-misses — this run drifted from 1.35 to 1.44 that way,
  // which is six metres of road at this circuit's size.
  let { scale, offsetX, offsetY } = best
  for (const radius of [INLIER_PX, 8, 6, 4, 3, 2.5]) {
    const pairs = []
    for (const e of expected) {
      const ex = scale * e.x + offsetX
      const ey = scale * e.y + offsetY
      let nearest = null
      let nearestDistance = radius
      for (const o of observed) {
        const d = Math.hypot(o.x - ex, o.y - ey)
        if (d < nearestDistance) { nearestDistance = d; nearest = o }
      }
      if (nearest) pairs.push([e, nearest])
    }
    if (pairs.length < 8) break

    // Solved about the centroids, one scale shared by both axes. The first
    // version pooled x and y into a single regression with a single
    // intercept, which is not a similarity fit at all — the two axes have
    // different offsets — and the bias in it let the scale walk from 1.35 to
    // 1.49 over a few passes while quietly shedding inliers.
    let meanEX = 0, meanEY = 0, meanOX = 0, meanOY = 0
    for (const [e, o] of pairs) {
      meanEX += e.x; meanEY += e.y; meanOX += o.x; meanOY += o.y
    }
    meanEX /= pairs.length; meanEY /= pairs.length
    meanOX /= pairs.length; meanOY /= pairs.length

    let numerator = 0
    let denominator = 0
    for (const [e, o] of pairs) {
      const ex = e.x - meanEX, ey = e.y - meanEY
      numerator += ex * (o.x - meanOX) + ey * (o.y - meanOY)
      denominator += ex * ex + ey * ey
    }
    if (denominator < 1e-9) break
    scale = numerator / denominator
    offsetX = meanOX - scale * meanEX
    offsetY = meanOY - scale * meanEY
    best.inliers = pairs.length
  }

  return { scale, offsetX, offsetY, inliers: best.inliers }
}


// --- marching the stroke ----------------------------------------------------


/**
 * Traces one connected piece of stroke end to end.
 *
 * By geodesic, not by marching. Marching a stroke — step forward, take the
 * centroid of what is ahead — is intuitive and was the first thing here, but
 * it stops at anything it cannot see past and leaves the rest of the piece
 * untraced, which then arrives at the stitching stage as a hole the width of
 * the circuit.
 *
 * The geodesic cannot do that. Two breadth-first passes over the piece's own
 * pixels find the two points furthest apart *through the ink* — the classic
 * double sweep for a graph's diameter — and the path between them is the
 * piece, all of it, in order. It is the shape's own length, so no parameter
 * governs how far it gets.
 */
function traceSegment(pixels, width, height, step) {
  const inPiece = new Uint8Array(width * height)
  for (const index of pixels) inPiece[index] = 1

  /** Breadth-first over the ink. Returns the furthest pixel and the tree. */
  const sweep = (from) => {
    const previous = new Int32Array(width * height).fill(-1)
    const seen = new Uint8Array(width * height)
    const queue = [from]
    seen[from] = 1
    let furthest = from
    for (let head = 0; head < queue.length; head += 1) {
      const index = queue[head]
      furthest = index
      const x = index % width
      const y = (index / width) | 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const j = ny * width + nx
        if (!inPiece[j] || seen[j]) continue
        seen[j] = 1
        previous[j] = index
        queue.push(j)
      }
    }
    return { furthest, previous }
  }

  const first = sweep(pixels[0])
  const second = sweep(first.furthest)

  const path = []
  for (let index = second.furthest; index >= 0; index = second.previous[index]) {
    path.push({ x: index % width, y: (index / width) | 0 })
  }

  // Thin it to roughly one point per step, and pull each point onto the
  // ribbon's middle: a geodesic runs along whichever edge of the stroke is
  // shorter, and a lap traced down the inside of every corner is a lap that
  // cuts them.
  const spaced = []
  let last = null
  for (const point of path) {
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < step) continue
    let sumX = 0, sumY = 0, count = 0
    const radius = Math.ceil(step * 1.2)
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (dx * dx + dy * dy > radius * radius) continue
        const x = Math.round(point.x + dx)
        const y = Math.round(point.y + dy)
        if (x < 0 || y < 0 || x >= width || y >= height) continue
        if (!inPiece[y * width + x]) continue
        sumX += x; sumY += y; count += 1
      }
    }
    const centred = count > 0 ? { x: sumX / count, y: sumY / count } : point
    spaced.push(centred)
    last = centred
  }
  return spaced.length >= 2 ? spaced : path
}

/**
 * Joins the traced pieces into one closed lap.
 *
 * Solved exactly rather than greedily. Greedy nearest-end chaining looks
 * sufficient — the pieces are long and their gaps are the width of a dot —
 * but one early wrong turn cascades, and the first run of this did exactly
 * that: it hopped the wrong way across the infield and laid eight control
 * points through the middle of the circuit. With a handful of pieces the
 * whole arrangement can simply be enumerated, orientations included, and the
 * one with the least total gap is the lap. Above that many, fall back.
 */
function stitch(segments) {
  const endsOf = (segment, reversed) => ({
    head: reversed ? segment[segment.length - 1] : segment[0],
    tail: reversed ? segment[0] : segment[segment.length - 1],
  })
  const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

  const order = (arrangement) => {
    let total = 0
    for (let i = 0; i < arrangement.length; i += 1) {
      const current = endsOf(segments[arrangement[i].index], arrangement[i].reversed)
      const next = endsOf(
        segments[arrangement[(i + 1) % arrangement.length].index],
        arrangement[(i + 1) % arrangement.length].reversed,
      )
      total += gap(current.tail, next.head)
    }
    return total
  }

  if (segments.length <= 8) {
    let best = null
    let bestCost = Infinity
    const permute = (chosen, left) => {
      if (left.length === 0) {
        // The first piece's orientation is fixed: a closed loop reads the
        // same either way round, so trying both only doubles the work.
        const cost = order(chosen)
        if (cost < bestCost) { bestCost = cost; best = chosen.slice() }
        return
      }
      for (const [i, index] of left.entries()) {
        const rest = left.slice(0, i).concat(left.slice(i + 1))
        for (const reversed of [false, true]) {
          chosen.push({ index, reversed })
          permute(chosen, rest)
          chosen.pop()
        }
      }
    }
    const rest = segments.map((_, i) => i).slice(1)
    permute([{ index: 0, reversed: false }], rest)

    const path = []
    for (const { index, reversed } of best) {
      const piece = reversed ? segments[index].slice().reverse() : segments[index]
      path.push(...piece)
    }
    return { path, cost: bestCost }
  }

  const remaining = segments.slice(1)
  const chain = segments[0].slice()
  let cost = 0
  while (remaining.length > 0) {
    const tail = chain[chain.length - 1]
    let bestIndex = 0
    let bestDistance = Infinity
    let bestReversed = false
    for (const [index, segment] of remaining.entries()) {
      const toHead = gap(segment[0], tail)
      const toEnd = gap(segment[segment.length - 1], tail)
      if (toHead < bestDistance) { bestDistance = toHead; bestIndex = index; bestReversed = false }
      if (toEnd < bestDistance) { bestDistance = toEnd; bestIndex = index; bestReversed = true }
    }
    const [segment] = remaining.splice(bestIndex, 1)
    cost += bestDistance
    chain.push(...(bestReversed ? segment.slice().reverse() : segment))
  }
  return { path: chain, cost }
}

/** Even spacing by arc length, around a closed path. */
function resample(path, count) {
  const lengths = [0]
  for (let i = 1; i <= path.length; i += 1) {
    const a = path[i - 1]
    const b = path[i % path.length]
    lengths.push(lengths[i - 1] + Math.hypot(b.x - a.x, b.y - a.y))
  }
  const total = lengths[lengths.length - 1]
  const out = []
  let cursor = 0
  for (let i = 0; i < count; i += 1) {
    const target = (i / count) * total
    while (cursor < lengths.length - 2 && lengths[cursor + 1] < target) cursor += 1
    const a = path[cursor]
    const b = path[(cursor + 1) % path.length]
    const segment = lengths[cursor + 1] - lengths[cursor]
    const t = segment > 0 ? (target - lengths[cursor]) / segment : 0
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
  }
  return out
}

// --- the model's surfaces ---------------------------------------------------

const MIN_NORMAL_Y = 0.25
const CELL_SIZE = 8

/** Every ground-facing triangle, filed by cell. Mirrors app/.../groundField.ts. */
async function loadSurfaces(path) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const document = await io.read(path)
  const triangles = []
  /** Triangle indices per material name — the road detector's raw material. */
  const byMaterial = new Map()

  const worldOf = (node) => {
    const matrix = node.getWorldMatrix()
    return (p) => [
      matrix[0] * p[0] + matrix[4] * p[1] + matrix[8] * p[2] + matrix[12],
      matrix[1] * p[0] + matrix[5] * p[1] + matrix[9] * p[2] + matrix[13],
      matrix[2] * p[0] + matrix[6] * p[1] + matrix[10] * p[2] + matrix[14],
    ]
  }

  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    const transform = worldOf(node)
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION')
      const indices = primitive.getIndices()
      if (!position) continue
      const count = indices ? indices.getCount() : position.getCount()
      const materialName = primitive.getMaterial()?.getName() ?? 'unnamed'
      const bucket = byMaterial.get(materialName) ?? []
      byMaterial.set(materialName, bucket)
      const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0]
      for (let i = 0; i < count; i += 3) {
        position.getElement(indices ? indices.getScalar(i) : i, a)
        position.getElement(indices ? indices.getScalar(i + 1) : i + 1, b)
        position.getElement(indices ? indices.getScalar(i + 2) : i + 2, c)
        const wa = transform(a), wb = transform(b), wc = transform(c)
        const ux = wb[0] - wa[0], uy = wb[1] - wa[1], uz = wb[2] - wa[2]
        const wx = wc[0] - wa[0], wy = wc[1] - wa[1], wz = wc[2] - wa[2]
        const nx = uy * wz - uz * wy
        const ny = uz * wx - ux * wz
        const nz = ux * wy - uy * wx
        const area = Math.hypot(nx, ny, nz)
        if (area === 0 || Math.abs(ny) / area < MIN_NORMAL_Y) continue
        bucket.push(triangles.length)
        triangles.push([wa, wb, wc])
      }
    }
  }

  const grid = new Map()
  const key = (x, z) => `${Math.floor(x / CELL_SIZE)},${Math.floor(z / CELL_SIZE)}`
  for (const [index, [a, b, c]] of triangles.entries()) {
    const x0 = Math.floor(Math.min(a[0], b[0], c[0]) / CELL_SIZE)
    const x1 = Math.floor(Math.max(a[0], b[0], c[0]) / CELL_SIZE)
    const z0 = Math.floor(Math.min(a[2], b[2], c[2]) / CELL_SIZE)
    const z1 = Math.floor(Math.max(a[2], b[2], c[2]) / CELL_SIZE)
    // A backdrop triangle can be kilometres wide; filing it in every cell it
    // covers would be most of the index. They are checked separately.
    if (x1 - x0 > 12 || z1 - z0 > 12) {
      const list = grid.get('oversized') ?? []
      list.push(index)
      grid.set('oversized', list)
      continue
    }
    for (let z = z0; z <= z1; z += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const k = `${x},${z}`
        const list = grid.get(k) ?? []
        list.push(index)
        grid.set(k, list)
      }
    }
  }

  /** Every surface height at an x/z, nearest-first is the caller's problem. */
  const heightsAt = (x, z) => {
    const candidates = [
      ...(grid.get(key(x, z)) ?? []),
      ...(grid.get('oversized') ?? []),
    ]
    const heights = []
    for (const index of candidates) {
      const [a, b, c] = triangles[index]
      const v0x = c[0] - a[0], v0z = c[2] - a[2]
      const v1x = b[0] - a[0], v1z = b[2] - a[2]
      const v2x = x - a[0], v2z = z - a[2]
      const d00 = v0x * v0x + v0z * v0z
      const d01 = v0x * v1x + v0z * v1z
      const d02 = v0x * v2x + v0z * v2z
      const d11 = v1x * v1x + v1z * v1z
      const d12 = v1x * v2x + v1z * v2z
      const denominator = d00 * d11 - d01 * d01
      if (denominator === 0) continue
      const u = (d11 * d02 - d01 * d12) / denominator
      const v = (d00 * d12 - d01 * d02) / denominator
      if (u < 0 || v < 0 || u + v > 1) continue
      heights.push(a[1] + u * (c[1] - a[1]) + v * (b[1] - a[1]))
    }
    heights.sort((p, q) => p - q)
    // Two surfaces a few centimetres apart are one road with a kerb on it.
    return heights.filter((height, i) => i === 0 || height - heights[i - 1] > 1.5)
  }

  return { heightsAt, count: triangles.length, triangles, byMaterial }
}

// --- finding the tarmac -----------------------------------------------------

/** World units per cell in the road grid. Half a car's width. */
const ROAD_CELL = 1
/** How far either side of the drawn line the road is looked for. */
const CORRIDOR = 45
/**
 * Edge-to-area ratio above which a material is a ribbon rather than a field.
 *
 * The same test the bake uses to find a road without being told which
 * material it is: a road is long and narrow, so almost all of it is edge,
 * while a car park or a hillside is mostly middle. It is a shape test, not a
 * colour one, which is why it survives a rip's hundred anonymous materials.
 */
const RIBBON_THINNESS = 0.2
/** A material needs at least this many cells to be worth considering. */
const MIN_ROAD_CELLS = 300

/**
 * Rasterises the circuit's road surface into a grid around the drawn line,
 * and measures how far every road cell sits from the nearest edge.
 *
 * The distance field is the whole point: its ridge IS the middle of the road,
 * so snapping a hand-drawn line onto the tarmac becomes "walk sideways until
 * the distance stops increasing" rather than anything that needs to know what
 * a road looks like.
 */
function buildRoadField(surfaces, line) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const [x, z] of line) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
  }
  minX -= CORRIDOR; maxX += CORRIDOR; minZ -= CORRIDOR; maxZ += CORRIDOR

  const width = Math.ceil((maxX - minX) / ROAD_CELL) + 1
  const height = Math.ceil((maxZ - minZ) / ROAD_CELL) + 1
  const cellOf = (x, z) => [
    Math.floor((x - minX) / ROAD_CELL),
    Math.floor((z - minZ) / ROAD_CELL),
  ]

  /** Fills a grid with one material's up-facing footprint. */
  const rasterise = (indices, into) => {
    let painted = 0
    for (const index of indices) {
      const [a, b, c] = surfaces.triangles[index]
      const lowX = Math.min(a[0], b[0], c[0])
      const highX = Math.max(a[0], b[0], c[0])
      const lowZ = Math.min(a[2], b[2], c[2])
      const highZ = Math.max(a[2], b[2], c[2])
      if (highX < minX || lowX > maxX || highZ < minZ || lowZ > maxZ) continue
      const [x0, z0] = cellOf(Math.max(lowX, minX), Math.max(lowZ, minZ))
      const [x1, z1] = cellOf(Math.min(highX, maxX), Math.min(highZ, maxZ))
      for (let gz = z0; gz <= z1; gz += 1) {
        for (let gx = x0; gx <= x1; gx += 1) {
          const px = minX + (gx + 0.5) * ROAD_CELL
          const pz = minZ + (gz + 0.5) * ROAD_CELL
          // Point in triangle, in plan view.
          const v0x = c[0] - a[0], v0z = c[2] - a[2]
          const v1x = b[0] - a[0], v1z = b[2] - a[2]
          const v2x = px - a[0], v2z = pz - a[2]
          const d00 = v0x * v0x + v0z * v0z
          const d01 = v0x * v1x + v0z * v1z
          const d02 = v0x * v2x + v0z * v2z
          const d11 = v1x * v1x + v1z * v1z
          const d12 = v1x * v2x + v1z * v2z
          const denominator = d00 * d11 - d01 * d01
          if (denominator === 0) continue
          const u = (d11 * d02 - d01 * d12) / denominator
          const v = (d00 * d12 - d01 * d02) / denominator
          if (u < 0 || v < 0 || u + v > 1) continue
          const cell = gz * width + gx
          if (!into[cell]) { into[cell] = 1; painted += 1 }
        }
      }
    }
    return painted
  }

  // Which materials are roads? Each is rasterised on its own and judged by
  // how much of it is edge.
  const road = new Uint8Array(width * height)
  const chosen = []
  for (const [name, indices] of surfaces.byMaterial) {
    if (indices.length < 30) continue
    const scratch = new Uint8Array(width * height)
    const cells = rasterise(indices, scratch)
    if (cells < MIN_ROAD_CELLS) continue
    let edge = 0
    for (let gz = 1; gz < height - 1; gz += 1) {
      for (let gx = 1; gx < width - 1; gx += 1) {
        const cell = gz * width + gx
        if (!scratch[cell]) continue
        if (
          !scratch[cell - 1] || !scratch[cell + 1] ||
          !scratch[cell - width] || !scratch[cell + width]
        ) edge += 1
      }
    }
    const thinness = edge / cells
    if (thinness < RIBBON_THINNESS) continue
    chosen.push({ name, cells, thinness })
    for (let i = 0; i < road.length; i += 1) if (scratch[i]) road[i] = 1
  }

  // Chamfer distance to the nearest non-road cell, in cells. Two passes is
  // exact enough for a field whose only job is to say which way is inwards.
  const distance = new Float32Array(width * height)
  const big = width + height
  for (let i = 0; i < distance.length; i += 1) distance[i] = road[i] ? big : 0
  for (let gz = 1; gz < height; gz += 1) {
    for (let gx = 1; gx < width; gx += 1) {
      const cell = gz * width + gx
      distance[cell] = Math.min(
        distance[cell],
        distance[cell - 1] + 1,
        distance[cell - width] + 1,
        distance[cell - width - 1] + 1.414,
      )
    }
  }
  for (let gz = height - 2; gz >= 0; gz -= 1) {
    for (let gx = width - 2; gx >= 0; gx -= 1) {
      const cell = gz * width + gx
      distance[cell] = Math.min(
        distance[cell],
        distance[cell + 1] + 1,
        distance[cell + width] + 1,
        distance[cell + width + 1] + 1.414,
      )
    }
  }

  return {
    chosen,
    width,
    height,
    minX,
    minZ,
    cell: ROAD_CELL,
    road,
    /** Distance to the road's edge at a world point, in world units. */
    depthAt: (x, z) => {
      const gx = Math.floor((x - minX) / ROAD_CELL)
      const gz = Math.floor((z - minZ) / ROAD_CELL)
      if (gx < 0 || gz < 0 || gx >= width || gz >= height) return 0
      return distance[gz * width + gx] * ROAD_CELL
    },
  }
}

/**
 * Slides each point sideways onto the middle of the road.
 *
 * A line drawn over a plan by hand is a statement of intent — this way round
 * the lake, through the town, under the hill — and not a statement about
 * exactly which metre of tarmac. So the drawing decides the route and the
 * model decides the lane: each point searches perpendicular to its own
 * heading for the deepest point of the road, which is its centre.
 *
 * The search is biased towards staying put, and the offsets are smoothed
 * along the lap afterwards. Both for the same reason: a point that jumps to
 * the far side of a junction because the tarmac happens to be wider there
 * takes the lap with it.
 */
function snapToRoad(line, field, reach, halfWidth) {
  // Depth is worth having up to a road's own half-width and no further. A
  // circuit contains plazas, car parks and junctions that are forty units of
  // continuous tarmac, and an uncapped search walks straight into the middle
  // of them — the first run of this took the lap through a shrine courtyard.
  // What is wanted is the middle of something ROAD-shaped, so the reward
  // stops where a road stops.
  const useful = halfWidth * 1.4
  const offsets = line.map(([x, z], i) => {
    const [px, pz] = line[(i - 1 + line.length) % line.length]
    const [nx, nz] = line[(i + 1) % line.length]
    const tangentX = nx - px
    const tangentZ = nz - pz
    const length = Math.hypot(tangentX, tangentZ) || 1
    // Perpendicular, in plan.
    const sideX = -tangentZ / length
    const sideZ = tangentX / length

    let bestOffset = 0
    let bestScore = -Infinity
    for (let offset = -reach; offset <= reach; offset += 0.5) {
      const depth = field.depthAt(x + sideX * offset, z + sideZ * offset)
      if (depth <= 0) continue
      // Depth wins, distance moved is the tie-breaker — a road is rarely
      // more than a few metres deeper on one side than the other, so this
      // stays near the drawing wherever the drawing was already on tarmac.
      const score = Math.min(depth, useful) - Math.abs(offset) * 0.12
      if (score > bestScore) { bestScore = score; bestOffset = offset }
    }
    return { offset: bestOffset, sideX, sideZ, found: bestScore > -Infinity }
  })

  // Smooth the offsets, not the points: smoothing positions rounds off the
  // corners the drawing was drawn to capture, while smoothing how far each
  // point moved keeps the shape and removes only the jitter.
  const smoothed = offsets.map((entry, i) => {
    let sum = 0
    let weight = 0
    for (let k = -2; k <= 2; k += 1) {
      const neighbour = offsets[(i + k + offsets.length) % offsets.length]
      if (!neighbour.found) continue
      const w = 3 - Math.abs(k)
      sum += neighbour.offset * w
      weight += w
    }
    return weight > 0 ? sum / weight : entry.offset
  })

  return line.map(([x, z], i) => [
    x + offsets[i].sideX * smoothed[i],
    z + offsets[i].sideZ * smoothed[i],
  ])
}

/**
 * Picks one height per point so the lap stays a road.
 *
 * This is the tunnel problem, and it is why the obvious answer — take the
 * surface nearest the old line, or the highest, or the lowest — fails. Under
 * a mountain the road is the lowest surface; on a viaduct it is the highest;
 * at the tunnel mouth it is neither, it is simply *continuous with the metre
 * before it*. So the choice is made for the whole lap at once: a shortest
 * path through the candidate heights, paying for every metre of climb, which
 * is the same thing as saying "roads do not teleport".
 */
function chooseElevation(candidateLists, anchorHeight) {
  const n = candidateLists.length
  const cost = candidateLists.map(() => [])
  const from = candidateLists.map(() => [])

  // The first point is pinned outright rather than merely nudged: it is the
  // one height a person has already sanity-checked by racing on it, and a
  // fixed start is what makes the closing edge below meaningful.
  let anchorIndex = 0
  candidateLists[0].forEach((height, i) => {
    if (Math.abs(height - anchorHeight) < Math.abs(candidateLists[0][anchorIndex] - anchorHeight)) {
      anchorIndex = i
    }
  })
  candidateLists[0].forEach((height, i) => {
    cost[0][i] = i === anchorIndex ? 0 : Infinity
    from[0][i] = -1
  })

  for (let step = 1; step < n; step += 1) {
    candidateLists[step].forEach((height, i) => {
      let best = Infinity
      let bestFrom = -1
      candidateLists[step - 1].forEach((previous, j) => {
        const climb = Math.abs(height - previous)
        // Squared, so one big jump costs far more than the same climb spread
        // over several samples — a gradient is fine, a cliff is not.
        const total = cost[step - 1][j] + climb * climb
        if (total < best) { best = total; bestFrom = j }
      })
      cost[step][i] = best
      from[step][i] = bestFrom
    })
  }

  // A lap is a loop, so the last point answers to the first. Without this the
  // chain is free to wander off at the end for nothing — and it did: the final
  // four points of the first run climbed ninety metres onto the hillside above
  // the tunnel, because nothing was asking them to come back and meet the
  // start line they were about to cross.
  const closing = candidateLists[0][anchorIndex]
  let bestEnd = 0
  let bestTotal = Infinity
  candidateLists[n - 1].forEach((height, i) => {
    const wrap = (height - closing) ** 2
    if (cost[n - 1][i] + wrap < bestTotal) {
      bestTotal = cost[n - 1][i] + wrap
      bestEnd = i
    }
  })
  const chosen = new Array(n)
  let cursor = bestEnd
  for (let step = n - 1; step >= 0; step -= 1) {
    chosen[step] = candidateLists[step][cursor]
    cursor = from[step][cursor]
    if (cursor < 0 && step > 0) cursor = 0
  }
  return chosen
}

// --- main -------------------------------------------------------------------

/** Centre, then a ring: nine probes is enough to find a road beside a point. */
const PROBE_OFFSETS = [
  [0, 0],
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [0.7, 0.7], [0.7, -0.7], [-0.7, 0.7], [-0.7, -0.7],
]

/**
 * Solves the lap's elevation from the model and writes the track file.
 *
 * Shared by both entry points — a lap read off a drawing and a lap already in
 * the file that only needed re-snapping — because the half that turns x/z
 * into a circuit is the same either way, and it is the half with the
 * interesting problem in it.
 */
async function writeLap(track, jsonPath, onRoad, surfaces, anchorSeed, { dry = false, source = null } = {}) {
  // Sampled over a small disc rather than at the point itself. A line drawn
  // by hand on a screenshot lands within a metre or two of where it was
  // meant to, and a metre off the edge of a mountain road is a hundred metres
  // of hillside — the elevation would rather look slightly sideways than
  // climb a cliff. The x/z stays exactly as given; only the search widens.
  const PROBE_RADIUS = 14
  const candidates = onRoad.map(([x, z]) => {
    const heights = []
    for (const [dx, dz] of PROBE_OFFSETS) {
      for (const height of surfaces.heightsAt(x + dx * PROBE_RADIUS, z + dz * PROBE_RADIUS)) {
        heights.push(height)
      }
    }
    heights.sort((a, b) => a - b)
    const distinct = heights.filter((height, i) => i === 0 || height - heights[i - 1] > 1.5)
    return distinct.length > 0 ? distinct : [Number.NaN]
  })

  const missing = candidates.filter((list) => Number.isNaN(list[0])).length
  if (missing > 0) console.warn(`  ${missing} of ${onRoad.length} points found no surface at all`)

  const filled = candidates.map((list) => (Number.isNaN(list[0]) ? [anchorSeed] : list))
  const elevations = chooseElevation(filled, anchorSeed)

  const controlPoints = onRoad.map(([x, z], i) => [
    Number(x.toFixed(3)),
    Number(elevations[i].toFixed(3)),
    Number(z.toFixed(3)),
  ])

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (const [x, , z] of controlPoints) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
  }

  let climb = 0
  for (let i = 0; i < controlPoints.length; i += 1) {
    climb = Math.max(
      climb,
      Math.abs(controlPoints[i][1] - controlPoints[(i + 1) % controlPoints.length][1]),
    )
  }
  console.log(
    `lap: ${controlPoints.length} points, x ${minX.toFixed(0)}..${maxX.toFixed(0)}, ` +
      `z ${minZ.toFixed(0)}..${maxZ.toFixed(0)}, y ${Math.min(...elevations).toFixed(0)}..` +
      `${Math.max(...elevations).toFixed(0)}, biggest step ${climb.toFixed(1)}`,
  )

  if (dry) {
    await writeFile('/tmp/traced-points.json', JSON.stringify(controlPoints))
    console.log('dry run — points written to /tmp/traced-points.json')
    return
  }

  track.controlPoints = controlPoints
  track.bounds = {
    minX: Number(minX.toFixed(3)),
    maxX: Number(maxX.toFixed(3)),
    minZ: Number(minZ.toFixed(3)),
    maxZ: Number(maxZ.toFixed(3)),
  }
  if (source) track.tracedFrom = source
  await writeFile(jsonPath, `${JSON.stringify(track, null, 2)}\n`)
  console.log(`wrote ${jsonPath}`)
}

/**
 * Re-fits the lap already in the track file to the road, with no drawing.
 *
 * The same two stages the image path ends with — slide each point onto the
 * middle of the tarmac, then re-solve the elevation — which is exactly what
 * is wanted after a bake changes, or when a lap is nearly right and only
 * wanders in a couple of corners.
 */
async function snapExisting(track, jsonPath, slug, wanted) {
  const flat = track.controlPoints.map(([x, , z]) => [x, z])
  const surfaces = await loadSurfaces(resolve(root, `public/ps1/tracks/${slug}.glb`))
  console.log(`model: ${surfaces.count} ground triangles`)

  const field = buildRoadField(surfaces, flat)
  console.log(`road: ${field.chosen.length} ribbon materials`)
  const onRoad = snapToRoad(flat, field, Number(arg('snap', '16')), track.roadHalfWidth ?? 7.4)

  let moved = 0
  for (const [i, [x, z]] of onRoad.entries()) {
    moved += Math.hypot(x - flat[i][0], z - flat[i][1])
  }
  console.log(`snapped: average ${(moved / onRoad.length).toFixed(1)} units`)

  await writeLap(track, jsonPath, onRoad, surfaces, track.controlPoints[0][1], {
    dry: process.argv.includes('--dry'),
  })
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}

async function main() {
  const slug = arg('slug')
  const imagePath = arg('image')
  const snapOnly = process.argv.includes('--snap-only')
  const colour = arg('colour', 'cyan')
  const wanted = Number(arg('points', '72'))
  if (!Number.isFinite(wanted) || wanted < 8) {
    throw new Error(`--points must be a number of at least 8, got "${arg('points')}"`)
  }
  const dry = process.argv.includes('--dry')
  if (!slug || (!imagePath && !snapOnly)) {
    throw new Error('usage: --slug <name> --image <plan.png> | --slug <name> --snap-only')
  }

  const jsonPath = resolve(root, `app/leon/channels/race/tracks/${slug}.track.json`)
  const track = JSON.parse(await readFile(jsonPath, 'utf8'))

  // The frame has to come from the points the PLAN WAS DRAWN WITH, which are
  // not necessarily the ones in the file — the moment this script writes a
  // new lap, the old frame is gone, and a second run against the same
  // drawing would read it through the wrong window. Pass --frame with a copy
  // of the track file as it was when the plan was rendered.
  const framePath = arg('frame')
  const frameTrack = framePath
    ? JSON.parse(await readFile(resolve(framePath), 'utf8'))
    : track
  const frame = planFrame(frameTrack.controlPoints)

  // --snap-only skips the drawing entirely and re-fits the lap already in
  // the file to the road. Everything from here to the elevation pass is about
  // reading a line out of an image, and there is no image.
  if (snapOnly) {
    await snapExisting(track, jsonPath, slug, wanted)
    return
  }

  const { data, info } = await sharp(imagePath).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  console.log(`image ${width}x${height}`)

  // 1. Registration.
  const painted = maskOf(data, width, height, channels, COLOURS[colour])
  const markMask = maskOf(data, width, height, channels, isMark)
  // A mark the drawing crosses is a mark whose centroid has moved: the line
  // covers one side of it and the blob's middle shifts by several pixels.
  // Those are the marks nearest the lap — exactly the ones a fit weights
  // most — so they are dropped rather than trusted. Six pixels of margin
  // covers the stroke's own soft edge.
  const shadowed = new Uint8Array(markMask.length)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!painted[y * width + x]) continue
      for (let dy = -6; dy <= 6; dy += 1) {
        for (let dx = -6; dx <= 6; dx += 1) {
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          shadowed[ny * width + nx] = 1
        }
      }
    }
  }
  const cleanMarks = new Uint8Array(markMask.length)
  for (let i = 0; i < markMask.length; i += 1) cleanMarks[i] = markMask[i] && !shadowed[i] ? 1 : 0
  const marks = blobs(cleanMarks, width, height, 60)
    // A dot is round and about the same size as its fellows. Autumn foliage
    // is neither, and this is cheaper than teaching the colour test about it.
    .filter((blob) => blob.count < 2000)
  // From the frame track, not the live one: these are the dots the plan was
  // printed with, and after a first run the live file no longer has them.
  const expected = frameTrack.controlPoints.map(([x, , z]) => {
    const [px, py] = frame.toPixel(x, z)
    return { x: px, y: py }
  })
  const fit = fitTransform(expected, marks, width / PLAN_SIZE)
  {
    // The residual is the honest measure of whether the drawing can be
    // trusted: it is the distance, in world units, between where a
    // registration mark is and where the fit says it should be.
    let sum = 0
    let worst = 0
    let paired = 0
    for (const point of expected) {
      const px = fit.scale * point.x + fit.offsetX
      const py = fit.scale * point.y + fit.offsetY
      let nearest = Infinity
      for (const mark of marks) {
        nearest = Math.min(nearest, Math.hypot(mark.x - px, mark.y - py))
      }
      if (nearest > 10) continue
      sum += nearest * nearest
      worst = Math.max(worst, nearest)
      paired += 1
    }
    const rms = Math.sqrt(sum / Math.max(1, paired))
    const unitsPerPixel = frame.span / PLAN_SIZE / fit.scale
    console.log(
      `registration: ${marks.length} clean marks, ${fit.inliers} agreed; ` +
        `scale ${fit.scale.toFixed(4)}; ` +
        `residual ${rms.toFixed(1)}px (${(rms * unitsPerPixel).toFixed(1)} units)`,
    )
  }

  // 2. The stroke.
  const step = Math.max(6, Math.round(9 * fit.scale))
  // Big pieces only: the plan's own cyan grid labels come back as specks.
  const pieces = components(painted, width, height).filter((piece) => piece.length > 1500)
  console.log(`stroke: ${pieces.length} pieces (${pieces.map((p) => p.length).join(', ')} px)`)
  const segments = pieces.map((piece) => traceSegment(piece, width, height, step))
  const { path, cost } = stitch(segments)
  let joinGap = 0
  for (let i = 1; i < path.length; i += 1) {
    joinGap = Math.max(joinGap, Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y))
  }
  const closingGap = Math.hypot(path[0].x - path[path.length - 1].x, path[0].y - path[path.length - 1].y)
  console.log(
    `lap: ${path.length} steps, widest join ${Math.round(joinGap)}px, ` +
      `total joined ${Math.round(cost)}px, closing gap ${Math.round(closingGap)}px`,
  )
  const sampled = resample(path, wanted)

  // 3. Back to world.
  const planPixels = sampled.map((p) => ({
    x: (p.x - fit.offsetX) / fit.scale,
    y: (p.y - fit.offsetY) / fit.scale,
  }))
  const flat = planPixels.map((p) => frame.toWorld(p.x, p.y))

  // 4. Onto the tarmac.
  const surfaces = await loadSurfaces(resolve(root, `public/ps1/tracks/${slug}.glb`))
  console.log(`model: ${surfaces.count} ground triangles`)

  const snapReach = Number(arg('snap', '16'))
  let onRoad = flat
  if (snapReach > 0) {
    const field = buildRoadField(surfaces, flat)
    console.log(
      `road: ${field.chosen.length} ribbon materials ` +
        `(${field.chosen.slice(0, 4).map((entry) => `${entry.name} ${entry.cells}`).join(', ')})`,
    )
    onRoad = snapToRoad(flat, field, snapReach, track.roadHalfWidth ?? 7.4)

    if (process.argv.includes('--road-debug')) {
      // The road as the snapper sees it, with the drawn line in red and the
      // snapped one in green. Forty "ribbon materials" is a claim worth
      // looking at rather than believing.
      const pixels = Buffer.alloc(field.width * field.height * 3)
      for (let i = 0; i < field.road.length; i += 1) {
        const shade = field.road[i] ? 90 : 20
        pixels[i * 3] = shade; pixels[i * 3 + 1] = shade; pixels[i * 3 + 2] = shade
      }
      const plot = (points, r, g, b) => {
        for (const [x, z] of points) {
          const gx = Math.round((x - field.minX) / field.cell)
          const gz = Math.round((z - field.minZ) / field.cell)
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              const px = gx + dx, pz = gz + dy
              if (px < 0 || pz < 0 || px >= field.width || pz >= field.height) continue
              const at = (pz * field.width + px) * 3
              pixels[at] = r; pixels[at + 1] = g; pixels[at + 2] = b
            }
          }
        }
      }
      plot(flat, 255, 60, 60)
      plot(onRoad, 60, 255, 120)
      await sharp(pixels, { raw: { width: field.width, height: field.height, channels: 3 } })
        .png()
        .toFile('/tmp/road-field.png')
      console.log(`road field written to /tmp/road-field.png (${field.width}x${field.height})`)
    }
    let moved = 0
    let worst = 0
    for (const [i, [x, z]] of onRoad.entries()) {
      const distance = Math.hypot(x - flat[i][0], z - flat[i][1])
      moved += distance
      worst = Math.max(worst, distance)
    }
    console.log(
      `snapped: average ${(moved / onRoad.length).toFixed(1)} units, worst ${worst.toFixed(1)}`,
    )
  }

  // 5. Elevation, and the file.
  //
  // The anchor is the old line's height nearest the new line's first point:
  // one number a person has already sanity-checked by racing on it.
  let anchor = track.controlPoints[0][1]
  let anchorDistance = Infinity
  for (const [x, y, z] of track.controlPoints) {
    const d = Math.hypot(x - onRoad[0][0], z - onRoad[0][1])
    if (d < anchorDistance) { anchorDistance = d; anchor = y }
  }
  await writeLap(track, jsonPath, onRoad, surfaces, anchor, {
    dry,
    source: imagePath.split('/').pop(),
  })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
