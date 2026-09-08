// Top-down analysis of a track's road surface.
//
// The sim has no idea where a road is: `circuit.ts` drives karts, cameras,
// lanes and the minimap from a single closed spline, and an imported model
// carries no such thing. This module reconstructs one — it rasterises the
// road-material triangles into a top-down occupancy grid, measures how far
// every road cell sits from the nearest edge, and reads the racing line off
// the ridge of that distance field.
//
// Working in a grid rather than on the mesh directly is what makes it robust
// to the state real models arrive in: 247 disconnected objects, overlapping
// shells, flipped winding and duplicated surfaces all rasterise to the same
// footprint, and a footprint is all the racing line needs.

/**
 * Cells across the longest axis. 1024 puts a 2.5km game-rip circuit at ~2.5
 * units per cell, which keeps its road several cells wide — below that the
 * thinning starts eating through the narrow sections and the lap breaks.
 */
export const GRID_RESOLUTION = 1024

/**
 * A top-down grid over the road's footprint.
 *
 * @typedef {object} Grid
 * @property {number} size        Cells per side.
 * @property {number} minX        World X of the grid's near corner.
 * @property {number} minZ        World Z of the grid's near corner.
 * @property {number} cell        World units per cell.
 * @property {Uint8Array} occupancy  1 where road, 0 elsewhere.
 * @property {Float32Array} height   Highest road surface Y in the cell.
 */

const index = (size, gx, gz) => gz * size + gx

/**
 * Rasterises world-space triangles into a top-down footprint.
 * `positions` is a flat XYZ array, `indices` its triangle list.
 */
export function rasteriseRoad(positions, indices) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] < minX) minX = positions[i]
    if (positions[i] > maxX) maxX = positions[i]
    if (positions[i + 2] < minZ) minZ = positions[i + 2]
    if (positions[i + 2] > maxZ) maxZ = positions[i + 2]
  }

  const size = GRID_RESOLUTION
  // One cell of padding so the boundary pass below always has empty cells to
  // measure against, even for a road that runs to the edge of its own bounds.
  const cell = Math.max(maxX - minX, maxZ - minZ) / (size - 4)
  const originX = minX - cell * 2
  const originZ = minZ - cell * 2

  const occupancy = new Uint8Array(size * size)
  const height = new Float32Array(size * size).fill(-Infinity)

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3
    const b = indices[t + 1] * 3
    const c = indices[t + 2] * 3
    fillTriangle(
      occupancy, height, size, originX, originZ, cell,
      positions[a], positions[a + 1], positions[a + 2],
      positions[b], positions[b + 1], positions[b + 2],
      positions[c], positions[c + 1], positions[c + 2],
    )
  }

  return { size, minX: originX, minZ: originZ, cell, occupancy, height }
}

/** Half-space rasteriser over the triangle's own cell bounds. */
function fillTriangle(occupancy, height, size, originX, originZ, cell,
  ax, ay, az, bx, by, bz, cx, cy, cz) {
  const gx0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - originX) / cell))
  const gx1 = Math.min(size - 1, Math.ceil((Math.max(ax, bx, cx) - originX) / cell))
  const gz0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - originZ) / cell))
  const gz1 = Math.min(size - 1, Math.ceil((Math.max(az, bz, cz) - originZ) / cell))

  const area = (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
  if (Math.abs(area) < 1e-12) return
  const inverseArea = 1 / area

  for (let gz = gz0; gz <= gz1; gz++) {
    const pz = originZ + (gz + 0.5) * cell
    for (let gx = gx0; gx <= gx1; gx++) {
      const px = originX + (gx + 0.5) * cell
      const w0 = ((bx - ax) * (pz - az) - (bz - az) * (px - ax)) * inverseArea
      const w1 = ((px - ax) * (cz - az) - (pz - az) * (cx - ax)) * inverseArea
      if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue

      const i = index(size, gx, gz)
      occupancy[i] = 1
      // Barycentric height, so a banked or climbing road keeps its Y.
      const y = ay + (cy - ay) * w0 + (by - ay) * w1
      if (y > height[i]) height[i] = y
    }
  }
}

/**
 * Chamfer distance transform: cells from the nearest empty cell, in cell
 * units. Two sequential passes with the 3-4 kernel, which is within ~2% of
 * true Euclidean distance and costs two linear sweeps rather than a queue.
 */
export function distanceTransform(grid) {
  const { size, occupancy } = grid
  const distance = new Float32Array(size * size)
  const FAR = size * 8

  for (let i = 0; i < distance.length; i++) distance[i] = occupancy[i] ? FAR : 0

  const relax = (i, j, weight) => {
    const candidate = distance[j] + weight
    if (candidate < distance[i]) distance[i] = candidate
  }

  for (let gz = 1; gz < size; gz++) {
    for (let gx = 1; gx < size - 1; gx++) {
      const i = index(size, gx, gz)
      if (distance[i] === 0) continue
      relax(i, index(size, gx - 1, gz), 1)
      relax(i, index(size, gx, gz - 1), 1)
      relax(i, index(size, gx - 1, gz - 1), 1.4142)
      relax(i, index(size, gx + 1, gz - 1), 1.4142)
    }
  }
  for (let gz = size - 2; gz >= 0; gz--) {
    for (let gx = size - 2; gx >= 1; gx--) {
      const i = index(size, gx, gz)
      if (distance[i] === 0) continue
      relax(i, index(size, gx + 1, gz), 1)
      relax(i, index(size, gx, gz + 1), 1)
      relax(i, index(size, gx + 1, gz + 1), 1.4142)
      relax(i, index(size, gx - 1, gz + 1), 1.4142)
    }
  }

  return distance
}

// --- Racing line ------------------------------------------------------------
//
// The first attempt at this swept the road in angular bins around its own
// centroid and took the widest cell in each — which works for an oval and
// fails completely on anything that doubles back, because a circuit with an
// infield has most of its road at the same bearing from the middle. The
// picture it produced was a scribble inside the infield.
//
// What follows is the honest version: thin the footprint to its medial axis,
// prune every dead end (which is what removes the pit lane and the run-off
// aprons without having to name them), and take the longest closed loop that
// survives. That loop *is* the circuit — it is the only part of the road you
// can drive round and end up where you started.

const NEIGHBOURS = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
]

const at = (map, size, gx, gz) =>
  gx < 0 || gz < 0 || gx >= size || gz >= size ? 0 : map[gz * size + gx]

function neighbourCount(map, size, gx, gz) {
  let total = 0
  for (const [dx, dz] of NEIGHBOURS) total += at(map, size, gx + dx, gz + dz)
  return total
}

/**
 * Zhang-Suen thinning: erodes the footprint to a one-cell-wide skeleton while
 * preserving its topology, so every loop in the road stays a loop and nothing
 * connected becomes disconnected.
 */
export function thinToSkeleton(occupancy, size) {
  const map = Uint8Array.from(occupancy)
  const doomed = []

  for (let pass = 0; pass < 400; pass++) {
    let changed = false

    for (const step of [0, 1]) {
      doomed.length = 0
      for (let gz = 1; gz < size - 1; gz++) {
        for (let gx = 1; gx < size - 1; gx++) {
          if (!map[gz * size + gx]) continue

          // p2..p9 clockwise from north, the paper's own numbering.
          const p = NEIGHBOURS.map(([dx, dz]) => at(map, size, gx + dx, gz + dz))
          const filled = p.reduce((a, b) => a + b, 0)
          if (filled < 2 || filled > 6) continue

          // Number of 0->1 transitions going round. Exactly one means the cell
          // is on a simple edge; more means removing it would break a link.
          let transitions = 0
          for (let i = 0; i < 8; i++) if (p[i] === 0 && p[(i + 1) % 8] === 1) transitions++
          if (transitions !== 1) continue

          const [north, northEast, east, southEast, south, southWest, west, northWest] = p
          void northEast; void southEast; void southWest; void northWest
          if (step === 0) {
            if (north && east && south) continue
            if (east && south && west) continue
          } else {
            if (north && east && west) continue
            if (north && south && west) continue
          }

          doomed.push(gz * size + gx)
        }
      }
      for (const i of doomed) map[i] = 0
      if (doomed.length > 0) changed = true
    }

    if (!changed) break
  }

  return map
}

/**
 * Repeatedly deletes cells with a single neighbour, which peels every branch
 * back to the cycles it hangs off. Pit lanes, service roads, garage entries
 * and the ragged fringes of a drift pad all disappear; a closed circuit is
 * untouched, because it has no ends to peel.
 */
export function pruneSpurs(skeleton, size) {
  const map = Uint8Array.from(skeleton)
  for (let pass = 0; pass < size * 2; pass++) {
    const doomed = []
    for (let gz = 1; gz < size - 1; gz++) {
      for (let gx = 1; gx < size - 1; gx++) {
        if (!map[gz * size + gx]) continue
        if (neighbourCount(map, size, gx, gz) <= 1) doomed.push(gz * size + gx)
      }
    }
    if (doomed.length === 0) break
    for (const i of doomed) map[i] = 0
  }
  return map
}

/**
 * The junction graph. Nodes are the places the skeleton branches; edges are
 * the runs of single-file cells between them. Reducing to this before hunting
 * for a cycle is what keeps the search tractable — a circuit is a handful of
 * junctions, not half a million pixels.
 */
function buildGraph(skeleton, size) {
  const isJunction = new Uint8Array(skeleton.length)
  for (let gz = 1; gz < size - 1; gz++) {
    for (let gx = 1; gx < size - 1; gx++) {
      const i = gz * size + gx
      if (skeleton[i] && neighbourCount(skeleton, size, gx, gz) >= 3) isJunction[i] = 1
    }
  }

  // Thinning leaves junctions as small clumps rather than single cells, so
  // adjacent junction cells are collapsed into one node.
  const nodeOf = new Int32Array(skeleton.length).fill(-1)
  const nodes = []
  for (let i = 0; i < isJunction.length; i++) {
    if (!isJunction[i] || nodeOf[i] !== -1) continue
    const id = nodes.length
    const cells = []
    const queue = [i]
    nodeOf[i] = id
    while (queue.length > 0) {
      const current = queue.pop()
      cells.push(current)
      const gx = current % size
      const gz = (current - gx) / size
      for (const [dx, dz] of NEIGHBOURS) {
        const j = (gz + dz) * size + (gx + dx)
        if (!isJunction[j] || nodeOf[j] !== -1) continue
        nodeOf[j] = id
        queue.push(j)
      }
    }
    nodes.push({ id, cells })
  }

  for (const node of nodes) node.cellSet = new Set(node.cells)

  const edges = []
  const walked = new Set()

  /**
   * Follows single-file cells away from a junction until another junction is
   * reached. The origin's own cells are barred for the first few steps: a
   * junction is a clump several cells across, so without that the walk turns
   * straight back into the clump it started from and every edge comes out
   * zero-length — which is what made the first version find no cycles at all.
   */
  const walkFrom = (nodeId, startCell) => {
    const origin = nodes[nodeId].cellSet
    const path = []
    const inPath = new Set()
    let current = startCell

    for (let guard = 0; guard < skeleton.length; guard++) {
      path.push(current)
      inPath.add(current)
      const gx = current % size
      const gz = (current - gx) / size
      const barOrigin = path.length < 4
      let next = -1

      for (const [dx, dz] of NEIGHBOURS) {
        const j = (gz + dz) * size + (gx + dx)
        if (!skeleton[j] || inPath.has(j)) continue
        if (barOrigin && origin.has(j)) continue
        if (nodeOf[j] !== -1) return { to: nodeOf[j], path }
        next = j
      }

      if (next === -1) return null
      current = next
    }
    return null
  }

  for (const node of nodes) {
    for (const cell of node.cells) {
      const gx = cell % size
      const gz = (cell - gx) / size
      for (const [dx, dz] of NEIGHBOURS) {
        const j = (gz + dz) * size + (gx + dx)
        if (!skeleton[j] || nodeOf[j] !== -1) continue
        const key = `${node.id}:${j}`
        if (walked.has(key)) continue
        walked.add(key)
        const result = walkFrom(node.id, j)
        if (!result || result.path.length === 0) continue
        for (const p of result.path) {
          walked.add(`${result.to}:${p}`)
          walked.add(`${node.id}:${p}`)
        }
        edges.push({ from: node.id, to: result.to, path: result.path })
      }
    }
  }

  return { nodes, edges, nodeOf }
}

/** Longest simple cycle through the junction graph, by cell count. */
function findLongestCycle(nodes, edges) {
  const adjacency = nodes.map(() => [])
  edges.forEach((edge, index) => {
    adjacency[edge.from].push({ index, to: edge.to })
    if (edge.to !== edge.from) adjacency[edge.to].push({ index, to: edge.from })
  })

  let best = null
  let bestLength = 0
  let budget = 400_000

  const search = (start, current, visitedNodes, usedEdges, length) => {
    if (budget-- <= 0) return
    for (const { index, to } of adjacency[current]) {
      if (usedEdges.has(index)) continue
      const edgeLength = edges[index].path.length
      if (to === start && usedEdges.size >= 1) {
        if (length + edgeLength > bestLength) {
          bestLength = length + edgeLength
          best = [...usedEdges, index]
        }
        continue
      }
      if (visitedNodes.has(to)) continue
      visitedNodes.add(to)
      usedEdges.add(index)
      search(start, to, visitedNodes, usedEdges, length + edgeLength)
      usedEdges.delete(index)
      visitedNodes.delete(to)
    }
  }

  for (const node of nodes) {
    search(node.id, node.id, new Set([node.id]), new Set(), 0)
    if (budget <= 0) break
  }

  return best === null ? null : { edgeIndices: best, length: bestLength }
}

/** Orders the chosen cycle's cells into one continuous ring. */
function assembleRing(cycle, edges, nodes, size) {
  const ordered = []
  const remaining = cycle.edgeIndices.map((index) => edges[index])
  let current = remaining[0].from
  let edge = remaining.shift()
  const append = (path, reversed) => {
    const cells = reversed ? [...path].reverse() : path
    for (const cell of cells) ordered.push(cell)
  }
  append(edge.path, edge.from !== current)
  current = edge.from === current ? edge.to : edge.from

  while (remaining.length > 0) {
    const nextIndex = remaining.findIndex((e) => e.from === current || e.to === current)
    if (nextIndex === -1) break
    const next = remaining.splice(nextIndex, 1)[0]
    append(next.path, next.to === current)
    // Bridge the junction clump itself, so the ring has no gap at a corner.
    const junction = nodes.find((n) => n.id === current)
    if (junction) ordered.push(junction.cells[0])
    current = next.from === current ? next.to : next.from
  }

  return ordered.map((cell) => {
    const gx = cell % size
    return [gx, (cell - gx) / size]
  })
}

/** Every cell of a skeleton that is a single unbranched loop, in order. */
function traceSimpleLoop(skeleton, size) {
  let start = -1
  for (let i = 0; i < skeleton.length; i++) if (skeleton[i]) { start = i; break }
  if (start === -1) return []

  const ring = []
  const seen = new Set()
  let current = start
  for (let guard = 0; guard < skeleton.length; guard++) {
    seen.add(current)
    const gx = current % size
    const gz = (current - gx) / size
    ring.push([gx, gz])
    let next = -1
    for (const [dx, dz] of NEIGHBOURS) {
      const j = (gz + dz) * size + (gx + dx)
      if (!skeleton[j] || seen.has(j)) continue
      next = j
      break
    }
    if (next === -1) break
    current = next
  }
  return ring
}

/**
 * Traces the racing line as a closed loop of world-space control points.
 *
 * Returns the points in driving order, the road's typical half width, and the
 * skeleton itself so the preview can show what the trace was reading.
 */
export { buildGraph, findLongestCycle }

/**
 * Deletes connected blobs smaller than `minimumCells`. Foliage cards and
 * roadside props rasterise as confetti around a rip's road, and every speck
 * the skeleton has to negotiate is another junction in the cycle search.
 */
export function despeckle(occupancy, size, minimumCells) {
  const map = Uint8Array.from(occupancy)
  const seen = new Uint8Array(map.length)
  const stack = []

  for (let start = 0; start < map.length; start++) {
    if (!map[start] || seen[start]) continue
    const component = []
    stack.length = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length > 0) {
      const current = stack.pop()
      component.push(current)
      const gx = current % size
      const gz = (current - gx) / size
      for (const [dx, dz] of NEIGHBOURS) {
        const nx = gx + dx
        const nz = gz + dz
        if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue
        const j = nz * size + nx
        if (!map[j] || seen[j]) continue
        seen[j] = 1
        stack.push(j)
      }
    }
    if (component.length < minimumCells) for (const i of component) map[i] = 0
  }
  return map
}

/**
 * Morphological close: grow the footprint by `radius`, then shrink it back.
 * Bridges the small breaks a rip's road arrives with — a chunk boundary, a
 * bridge deck modelled apart from its approaches, a manhole of missing
 * triangles — without moving the surface's edges anywhere else. A gap the
 * close cannot span is a genuine gap, and the trace is right to fail on it.
 */
export function closeGaps(occupancy, size, radius) {
  let map = Uint8Array.from(occupancy)
  const pass = (source, grow) => {
    const out = new Uint8Array(source.length)
    for (let gz = 0; gz < size; gz++) {
      for (let gx = 0; gx < size; gx++) {
        const i = gz * size + gx
        let hit = grow ? 0 : 1
        for (let dz = -1; dz <= 1 && (grow ? !hit : hit); dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = gx + dx
            const nz = gz + dz
            const inside = nx >= 0 && nz >= 0 && nx < size && nz < size
            const value = inside ? source[nz * size + nx] : 0
            if (grow && value) { hit = 1; break }
            if (!grow && !value) { hit = 0; break }
          }
        }
        out[i] = hit
      }
    }
    return out
  }
  for (let i = 0; i < radius; i++) map = pass(map, true)
  for (let i = 0; i < radius; i++) map = pass(map, false)
  return map
}

export function traceRacingLine(
  grid,
  distance,
  { controlPoints = 28, despeckleCells = 0, closeRadius = 0 } = {},
) {
  const { size, minX, minZ, cell } = grid

  let footprint = grid.occupancy
  if (despeckleCells > 0) footprint = despeckle(footprint, size, despeckleCells)
  if (closeRadius > 0) footprint = closeGaps(footprint, size, closeRadius)

  const skeleton = pruneSpurs(thinToSkeleton(footprint, size), size)
  const { nodes, edges } = buildGraph(skeleton, size)

  let ring
  if (nodes.length === 0) {
    ring = traceSimpleLoop(skeleton, size)
  } else {
    const cycle = findLongestCycle(nodes, edges)
    if (!cycle) throw new Error('No closed loop in the road: is this circuit actually a circuit?')
    ring = assembleRing(cycle, edges, nodes, size)
  }
  if (ring.length < controlPoints) {
    throw new Error(`Traced loop is only ${ring.length} cells long — too short to be a lap.`)
  }

  // Even spacing along the loop, then a circular smooth: the skeleton is a
  // staircase of whole cells, and a spline through raw staircase points
  // inherits every jag as a steering input.
  const sampled = []
  for (let n = 0; n < controlPoints; n++) {
    const window = Math.max(1, Math.round(ring.length / controlPoints / 4))
    const centre = Math.round((n / controlPoints) * ring.length)
    let sumX = 0, sumZ = 0
    for (let k = -window; k <= window; k++) {
      const [gx, gz] = ring[(centre + k + ring.length) % ring.length]
      sumX += gx; sumZ += gz
    }
    const span = window * 2 + 1
    const gx = sumX / span
    const gz = sumZ / span
    const nearest = Math.round(gz) * size + Math.round(gx)
    const height = Number.isFinite(grid.height[nearest]) ? grid.height[nearest] : 0
    sampled.push([minX + (gx + 0.5) * cell, height, minZ + (gz + 0.5) * cell])
  }

  // The road's typical half width, measured along the loop itself. Median
  // rather than mean: a pit apron or a widened drift pad drags a mean badly,
  // and this number is what sets how far the karts may spread sideways.
  const halfWidths = ring
    .map(([gx, gz]) => distance[gz * size + gx] * cell)
    .filter((value) => value > 0)
    .sort((a, b) => a - b)
  const medianHalfWidth = halfWidths[Math.floor(halfWidths.length / 2)] ?? cell

  return { points: sampled, medianHalfWidth, skeleton, ring }
}
