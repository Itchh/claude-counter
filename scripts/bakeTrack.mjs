#!/usr/bin/env node
//
// Turns a bought or downloaded circuit into something the race channel can
// actually use.
//
// A marketplace track arrives as a modern asset: a third of a million
// triangles, 2K PBR texture sets, a couple of hundred separate objects, and a
// scale nobody agreed with us. The channel renders at 288 pixels tall through
// a shader that snaps vertices to the framebuffer grid — feed that a dense
// mesh and the wobble stops reading as hardware and starts reading as noise.
// So the reduction is not a performance measure. It is the look.
//
// Five things happen here, in this order, because each depends on the last:
//
//   1. Flatten and merge. 247 objects become one draw call per material.
//   2. Trace the racing line off the road surface, before anything moves it.
//   3. Normalise scale, so eight karts abreast fit any circuit's road.
//   4. Decimate to the polygon budget.
//   5. Strip the PBR set to a single base colour map, downsampled to the
//      texture-page sizes the hardware had and quantised to 15-bit colour.
//
// Usage: node scripts/bakeTrack.mjs --in <file.glb> --slug <name> [--road Asphalt]

import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import {
  dedup, flatten, join, weld, prune, resample, quantize, transformMesh,
  simplifyPrimitive, compactPrimitive,
} from '@gltf-transform/functions'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rasteriseRoad, distanceTransform, traceRacingLine } from './trackGrid.mjs'

// --- The budget -------------------------------------------------------------

/**
 * Triangles to keep per material, as a fraction of what arrived.
 *
 * A single global ratio is the wrong instrument. This model spends 190k of its
 * 314k triangles on `Metal` — barriers, fencing, tyre walls, gantries — which
 * at 288 pixels tall are a grey line whatever their density, while `Asphalt`
 * is only 19k and is the one surface the eye actually reads. Cutting both by
 * the same proportion would throw away the road to pay for the fences.
 *
 * Names are the source model's own. Anything unlisted takes `default`.
 */
const MATERIAL_RATIO = {
  // The road. Cut least: its silhouette is the circuit, and its markings are
  // the only thing telling a viewer which way the corner goes.
  Asphalt: 0.9,
  // Painted lines, skid marks and foliage are all standalone cards a handful
  // of triangles each, and an edge-collapse simplifier has nothing to take off
  // a quad. They are reduced by dropping whole pieces instead — see
  // MATERIAL_KEEP — and simplifying them first only shreds the ones that
  // survive.
  Decals: 1,
  Leafs_Mat: 1,
  // Structures. Still the big saving, but no longer a massacre: at a
  // twentieth of their original density the barriers were a grey line with no
  // posts in it, and the fencing had stopped being fencing.
  Metal: 0.22,
  Ground: 1,
  default: 0.5,
}

/**
 * Fraction of a material's separate pieces to keep. See cullComponents — this
 * is the instrument for geometry made of thousands of standalone cards, which
 * no edge-collapse simplifier can touch.
 */
const MATERIAL_KEEP = {
  // Two fifths of the trees. An eighth was the earlier machine's budget and
  // it showed — a wood you could see straight through to the sky.
  Leafs_Mat: 0.4,
  // Skid marks and painted lines. This is a drift circuit, and the skid marks
  // are most of what says so, so they get to stay.
  Decals: 0.4,
  default: 1,
}

/**
 * No primitive drops below this, whatever its ratio says.
 *
 * The terrain in this model is two enormous triangles; a global ratio took it
 * to zero, the primitive emptied, and prune quietly deleted the ground the
 * whole circuit sits on. A floor is cheaper than noticing that later.
 */
const MINIMUM_TRIANGLES = 24

/**
 * Longest edge of any texture page, in pixels.
 *
 * 512 rather than the 128 this started at. 128 is the earlier console's own
 * texture-page budget and it is faithful, but faithful to a machine whose
 * whole circuit was a fraction of this one's size: stretched over a 450-unit
 * world it puts a texel every few metres, and the asphalt, the grass and the
 * concrete all arrive as the same undifferentiated wash. Everything the source
 * model's textures actually say — the racing line, the kerb paint, the joins
 * in the tarmac — was being thrown away before it ever reached a pixel.
 */
const TEXTURE_SIZE = 512

/**
 * Per-material overrides, for surfaces whose UVs do not tile.
 *
 * A page size means nothing on its own; what matters is texels per metre of
 * world, and that depends entirely on how the surface was unwrapped. This
 * model's asphalt repeats its page some sixty times around the lap, so 512
 * pixels is an enormous amount of detail. Its terrain is the opposite — one
 * unbroken 0..1 unwrap stretched across nine hundred units, authored against a
 * 4K page — and at 512 that works out at one texel every two metres, which is
 * why the grass arrived as a flat green sheet with the model's own dirt
 * patches and worn ground nowhere to be seen.
 */
const MATERIAL_TEXTURE_SIZE = {
  Ground: 2048,
  default: TEXTURE_SIZE,
}

/**
 * Multiplier on a material's UVs, for the opposite problem.
 *
 * Sixty repeats of an asphalt page around the lap is detail the screen cannot
 * receive: at 448 lines a pixel thirty metres down the road covers hundreds of
 * texels, so mipmapping picks a level that has averaged all of them into one
 * grey and the tarmac reads as untextured. Stretching the page out until its
 * grain is a few metres across puts the frequency back inside what the picture
 * can actually resolve. The asphalt looks coarser than its author intended,
 * which at this resolution is the only way it looks like anything at all.
 */
const MATERIAL_UV_SCALE = {
  Asphalt: 0.14,
  default: 1,
}

/**
 * Colours per indexed page.
 *
 * Still indexed, not truecolour. Palettised textures are not a compromise
 * here — the later console leaned on them hard, addressing 4- and 8-bit pages
 * through a colour lookup table, and 256 entries is exactly what that gave
 * you. The result reads as period rather than as a photograph, and the file
 * stays a quarter of the size a full-colour page would be.
 */
const PALETTE_SIZE = 256
/**
 * Half the width of the road, in game units, after normalisation. Matches
 * ROAD_HALF_WIDTH in circuit.ts: every imported circuit is rescaled until its
 * road is this wide, which is what guarantees a full grid fits side by side
 * whatever the source model thought a metre was.
 */
const TARGET_ROAD_HALF_WIDTH = 7.4
/** Control points in the emitted spline. Enough for a hairpin, few enough to edit. */
const CONTROL_POINT_COUNT = 44

// --- Arguments --------------------------------------------------------------

function parseArguments(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1]
  if (!args.in || !args.slug) {
    throw new Error(
      'Usage: node scripts/bakeTrack.mjs --in <file.glb> --slug <name> ' +
        '[--road Asphalt|a,b,c|auto] [--preserve true] [--texsize 256]',
    )
  }
  return { road: 'Asphalt', ...args }
}

// --- Scene walking ----------------------------------------------------------

/**
 * World-space triangles for every primitive whose material passes `accept`.
 *
 * Walked by hand rather than trusting the merge step to have baked node
 * transforms: whether it did depends on which primitives were compatible, and
 * a racing line derived from half-transformed geometry is silently wrong.
 *
 * `upFacingOnly` drops any triangle steeper than ~50 degrees. It exists for
 * game rips, where the "road" materials are spatial chunks that also carry
 * their own barriers and signage — walls rasterise into the footprint as
 * lines, and the medial axis then threads the walls instead of the tarmac.
 */
function collectGeometry(document, accept, { upFacingOnly = false } = {}) {
  const positions = []
  const indices = []

  const visit = (node, parentMatrix) => {
    const matrix = multiplyMatrices(parentMatrix, node.getMatrix())
    const mesh = node.getMesh()
    if (mesh) {
      for (const primitive of mesh.listPrimitives()) {
        if (!accept(primitive.getMaterial()?.getName() ?? '')) continue
        const source = primitive.getAttribute('POSITION')?.getArray()
        if (!source) continue
        const base = positions.length / 3
        for (let i = 0; i < source.length; i += 3) {
          const [x, y, z] = transformPoint(matrix, source[i], source[i + 1], source[i + 2])
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

/**
 * Finds the road in a model whose material names mean nothing.
 *
 * A game rip is chunked spatially — `material_063_17` is a square of world,
 * not a substance — so the road is smeared across dozens of materials and no
 * name will ever select it. What survives the anonymisation is shape: a road
 * chunk's top-down footprint is a ribbon, with an enormous perimeter for its
 * area, where terrain is a blob and props are dots. Every material is
 * rasterised alone, scored for thinness, and the ribbons are taken together
 * as the road. The threshold is deliberately forgiving — a false chunk of
 * car park widens the footprint slightly, which the distance-transform trace
 * shrugs off, whereas a missing chunk cuts the loop and kills the lap.
 */
function detectRoadMaterials(document) {
  const names = document.getRoot().listMaterials().map((material) => material.getName())
  const chosen = []

  for (const name of names) {
    const { positions, indices } = collectGeometry(document, (n) => n === name, {
      upFacingOnly: true,
    })
    if (indices.length < 90) continue
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
    if (cells < 400) continue
    const thinness = edge / cells
    if (thinness >= 0.28) chosen.push({ name, cells, thinness })
  }

  console.log(`road (auto): ${chosen.length} ribbon materials of ${names.length}`)
  for (const entry of chosen) {
    console.log(`   ${entry.name.padEnd(20)} cells ${String(entry.cells).padStart(6)} thin ${entry.thinness.toFixed(2)}`)
  }
  return new Set(chosen.map((entry) => entry.name))
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** Column-major 4x4 multiply, matching glTF's own matrix convention. */
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

function transformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ]
}

/**
 * Longest edge any triangle may have, in game units, after normalisation.
 *
 * This is not a quality setting — it is what makes the fog work. Fog in the
 * PS1 shader is evaluated per vertex and interpolated across the face, exactly
 * as the hardware did it, so a triangle only samples the fog at its corners.
 * This model's terrain is *two* triangles spanning the entire circuit: all six
 * corners sit hundreds of units from any camera, all six come back fully
 * fogged, and the whole ground renders as flat sky colour right up to the
 * car's wheels. Nothing about the shader is wrong; the mesh simply has nowhere
 * to put the gradient.
 *
 * Which is why every PS1 game's ground was a grid. The subdivision below is
 * not a modern convenience bolted on — it is the authoring constraint that
 * per-vertex lighting imposed on anyone shipping for the hardware, applied
 * here for the same reason they applied it.
 */
/**
 * Longest edge a triangle may have, as a fraction of the circuit's own span.
 *
 * Relative rather than absolute, because the number it has to beat is the
 * length of the fog gradient, and the fog is itself scaled to the circuit
 * (see fogForSpan in the track registry). At 9% an edge spans a fifteenth of
 * the dissolve, which is below noticing; the terrain's original two triangles
 * spanned all of it twice over, which is why the ground came out a flat sheet
 * of sky colour.
 */
const MAX_EDGE_FRACTION = 0.14

/**
 * Ceiling on what subdivision may add to one primitive, as a multiple of what
 * it started with.
 *
 * The ground needs this and the foliage does not: one is a pair of triangles
 * covering the whole map, the other is eighteen thousand triangles of leaf
 * cards a few units across. Without a ceiling the same rule that rescues the
 * first quadruples the second on every pass — the run before this one turned
 * 50k triangles into 300k and a 5MB file.
 */
const TESSELLATION_GROWTH = 6

/**
 * Triangles a primitive may always reach, whatever its growth multiple says.
 *
 * A ceiling expressed purely as a multiple is meaningless for the case that
 * needs it most: six times two triangles is twelve, and twelve triangles
 * across a 460-unit terrain is no better than two. Small primitives get a flat
 * allowance instead.
 */
const TESSELLATION_FLOOR = 4_096

/**
 * Thins a primitive by throwing away whole connected pieces of it.
 *
 * Some geometry cannot be simplified and can only be *reduced*. This model's
 * foliage is seventy thousand triangles of individual leaf cards and its
 * decals are thirty thousand triangles of separate skid marks — every one a
 * two-triangle quad standing alone, and meshopt cannot take a two-triangle
 * quad below two triangles however generous the error budget. Asking it to
 * try is what produced the earlier run's fiction, where the numbers fell
 * because duplicate objects sharing local coordinates welded into each other.
 *
 * So the honest reduction is fewer trees and fewer skid marks, which is
 * exactly the edit a port to the hardware would have made. Components are kept
 * or dropped by a fixed stride rather than at random, so the same model always
 * bakes to the same circuit.
 */
function cullComponents(document, primitive, keepFraction) {
  const indexAccessor = primitive.getIndices()
  if (!indexAccessor || keepFraction >= 1) return 0

  const indices = indexAccessor.getArray()
  const parent = new Int32Array(primitive.getAttribute('POSITION').getCount())
  for (let i = 0; i < parent.length; i++) parent[i] = i

  const find = (start) => {
    let root = start
    while (parent[root] !== root) root = parent[root]
    // Path compression, walked as its own loop. Doing it inside the search
    // with a destructuring swap reassigns the cursor before the write lands,
    // so the link gets written to the wrong node and the forest quietly
    // stops being a forest.
    let cursor = start
    while (parent[cursor] !== root) {
      const next = parent[cursor]
      parent[cursor] = root
      cursor = next
    }
    return root
  }

  const union = (a, b) => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent[rootB] = rootA
  }

  for (let t = 0; t < indices.length; t += 3) {
    union(indices[t], indices[t + 1])
    union(indices[t], indices[t + 2])
  }

  // Ordered by the component's first appearance, so the stride cuts evenly
  // through the model rather than clearing one end of the circuit.
  const order = new Map()
  for (let t = 0; t < indices.length; t += 3) {
    const root = find(indices[t])
    if (!order.has(root)) order.set(root, order.size)
  }

  const stride = Math.max(1, Math.round(1 / keepFraction))
  const kept = []
  for (let t = 0; t < indices.length; t += 3) {
    if (order.get(find(indices[t])) % stride !== 0) continue
    kept.push(indices[t], indices[t + 1], indices[t + 2])
  }

  // A fresh accessor rather than a rewrite of the old one. Accessors are
  // shared property nodes in a glTF document — dedup will happily hand two
  // primitives the same one — so mutating in place edits geometry that was
  // never asked about.
  primitive.setIndices(
    document
      .createAccessor()
      .setArray(Uint32Array.from(kept))
      .setBuffer(document.getRoot().listBuffers()[0]),
  )
  return kept.length / 3
}

/**
 * Splits any triangle with an edge longer than `maxEdge` into four, until none
 * are left. Midpoints are shared between neighbouring triangles, so the mesh
 * stays welded and no cracks open along the seams.
 */
function tessellatePrimitive(document, primitive, maxEdge, maxTriangles) {
  const indexAccessor = primitive.getIndices()
  const positionAccessor = primitive.getAttribute('POSITION')
  if (!indexAccessor || !positionAccessor) return 0

  const semantics = primitive.listSemantics()
  const attributes = semantics.map((semantic) => {
    const accessor = primitive.getAttribute(semantic)
    return {
      semantic,
      accessor,
      stride: accessor.getElementSize(),
      values: Array.from(accessor.getArray()),
    }
  })
  const position = attributes.find((a) => a.semantic === 'POSITION')

  let indices = Array.from(indexAccessor.getArray())
  const midpoints = new Map()

  const midpointOf = (a, b) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`
    const existing = midpoints.get(key)
    if (existing !== undefined) return existing

    const created = position.values.length / position.stride
    for (const attribute of attributes) {
      const { stride, values } = attribute
      for (let c = 0; c < stride; c++) {
        values.push((values[a * stride + c] + values[b * stride + c]) / 2)
      }
      // A midpoint of two unit normals is not a unit normal, and an
      // unnormalised normal darkens the face it belongs to.
      if (attribute.semantic === 'NORMAL') {
        const base = created * stride
        const length = Math.hypot(values[base], values[base + 1], values[base + 2])
        if (length > 0) {
          values[base] /= length
          values[base + 1] /= length
          values[base + 2] /= length
        }
      }
    }
    midpoints.set(key, created)
    return created
  }

  const edgeLength = (a, b) => {
    const s = position.stride
    return Math.hypot(
      position.values[a * s] - position.values[b * s],
      position.values[a * s + 1] - position.values[b * s + 1],
      position.values[a * s + 2] - position.values[b * s + 2],
    )
  }

  // Bounded rather than recursive: a degenerate triangle whose longest edge
  // never shrinks would otherwise subdivide until memory ran out.
  for (let pass = 0; pass < 12; pass++) {
    const oversized = []
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]]
      if (Math.max(edgeLength(a, b), edgeLength(b, c), edgeLength(c, a)) > maxEdge) {
        oversized.push(t)
      }
    }
    if (oversized.length === 0) break

    // Decided for the pass as a whole, not triangle by triangle. Checking as
    // it goes lets each pass run up to the ceiling and then start again from
    // there on the next one, so the ceiling never actually holds.
    if (indices.length / 3 + oversized.length * 3 > maxTriangles) break

    const oversizedSet = new Set(oversized)
    const next = []
    for (let t = 0; t < indices.length; t += 3) {
      const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]]
      if (!oversizedSet.has(t)) {
        next.push(a, b, c)
        continue
      }
      const ab = midpointOf(a, b)
      const bc = midpointOf(b, c)
      const ca = midpointOf(c, a)
      next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca)
    }
    indices = next
  }

  // New accessors for the same reason cullComponents makes them: the ones
  // this primitive arrived with may be shared with another.
  const buffer = document.getRoot().listBuffers()[0]
  for (const attribute of attributes) {
    primitive.setAttribute(
      attribute.semantic,
      document
        .createAccessor()
        .setType(attribute.accessor.getType())
        .setArray(Float32Array.from(attribute.values))
        .setBuffer(buffer),
    )
  }
  primitive.setIndices(
    document.createAccessor().setArray(Uint32Array.from(indices)).setBuffer(buffer),
  )

  return indices.length / 3
}

/**
 * Topology-blind decimation, for untextured geometry only. See the call site.
 */
function decimateSloppy(document, primitive, targetTriangles) {
  const indices = primitive.getIndices()
  const positions = primitive.getAttribute('POSITION')
  if (!indices || !positions) return

  const [reduced] = MeshoptSimplifier.simplifySloppy(
    Uint32Array.from(indices.getArray()),
    Float32Array.from(positions.getArray()),
    3,
    // No locked vertices: nothing here is a seam with a neighbouring chunk.
    null,
    targetTriangles * 3,
    0.5,
  )

  indices.setArray(reduced)
}

/**
 * Writes every node's transform into the geometry it points at.
 *
 * The obvious tool for this — `clearNodeTransform` on each node in turn —
 * silently destroys a scene like this one. Its decals and its foliage are
 * *instanced*: one mesh referenced from a hundred nodes at a hundred different
 * places. Clearing the transform on each of those nodes applies each matrix to
 * the same shared vertex data in turn, so the geometry is transformed a
 * hundred times over and lands a million units from the circuit, or at NaN.
 * The first run of this pipeline did exactly that and lost every tree.
 *
 * So each node that shares a mesh gets its own copy first, and the transform
 * goes through `transformMesh`, which isolates vertex streams before touching
 * them. The scene gets bigger on disk for a moment; the merge step immediately
 * after puts it back.
 */
function bakeNodeTransforms(document) {
  const usage = new Map()
  for (const scene of document.getRoot().listScenes()) {
    scene.traverse((node) => {
      const mesh = node.getMesh()
      if (mesh) usage.set(mesh, (usage.get(mesh) ?? 0) + 1)
    })
  }

  for (const scene of document.getRoot().listScenes()) {
    scene.traverse((node) => {
      const mesh = node.getMesh()
      if (!mesh) return

      if ((usage.get(mesh) ?? 0) > 1) {
        const copy = document.createMesh(mesh.getName())
        // Primitives are cloned too, not just referenced: a cloned Mesh that
        // still points at the original Primitives shares the very vertex data
        // this whole exercise is about not sharing.
        for (const primitive of mesh.listPrimitives()) copy.addPrimitive(primitive.clone())
        node.setMesh(copy)
        usage.set(mesh, usage.get(mesh) - 1)
      }

      transformMesh(node.getMesh(), node.getWorldMatrix())
      node.setMatrix(IDENTITY)
    })
  }
}

// --- Textures ---------------------------------------------------------------

/**
 * Rewrites one texture page the way the console held it.
 *
 * Downsampling with a nearest kernel rather than a smooth one matters: a
 * lanczos reduction of an asphalt photograph produces a soft grey mush, which
 * is exactly what a hand-drawn 128px page never looked like. Nearest keeps the
 * grain as grain. The 15-bit quantise and the indexed palette then do what the
 * framebuffer and VRAM did — the banding is not a compromise, it is the
 * signature.
 */
async function bakeTexture(image, { saturation, brightness, size }) {
  const pipeline = sharp(image)
  const { width = size, height = size } = await pipeline.metadata()
  const longest = Math.max(width, height)
  const scale = Math.min(1, size / longest)

  const { data, info } = await pipeline
    .resize({
      width: Math.max(8, Math.round(width * scale)),
      height: Math.max(8, Math.round(height * scale)),
      kernel: 'nearest',
    })
    .modulate({ saturation, brightness })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  // The 5-bit channel crush that used to happen here is gone. It was the
  // earlier console's *output stage*, applied to its framebuffer, and doing it
  // to the source textures as well quantised the same picture twice — once in
  // the page and again on screen. The shader still does it when a circuit asks
  // for it (see uColorLevels); the pages themselves are left alone.
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png({ palette: true, colours: PALETTE_SIZE, effort: 10 })
    .toBuffer()
}

/**
 * Per-material texture treatment. Roads want their markings legible, foliage
 * wants to sit back, so they cannot share one setting.
 */
const TEXTURE_TREATMENT = {
  // Near-neutral, on purpose, and for the second time in this file's life.
  // The 20-30% lifts that used to sit here were compensation for a renderer
  // bug — the shader was writing linear values to an sRGB display, showing
  // every page a gamma darker than its file — and once the shader gained its
  // output transform the lifts became a second exposure on top of a correct
  // one. Brightness belongs to the sky and the registry now; the pages ship
  // as their authors made them.
  Asphalt: { saturation: 1.0, brightness: 1.08 },
  Ground: { saturation: 1.05, brightness: 1.05 },
  Decals: { saturation: 1.05, brightness: 1.08 },
  Leafs_Mat: { saturation: 1.0, brightness: 1.0 },
  default: { saturation: 1.0, brightness: 1.02 },
}

/**
 * Drops every map the PS1 shader cannot read, which is all of them but base
 * colour. Normal, metallic-roughness, occlusion and emissive maps are the
 * bulk of the file and describe a per-pixel lighting model the hardware never
 * had — keeping them would mean shipping megabytes to be ignored.
 */
async function reduceTextures(document, sizeOverride) {
  for (const material of document.getRoot().listMaterials()) {
    material.setNormalTexture(null)
    material.setMetallicRoughnessTexture(null)
    material.setOcclusionTexture(null)
    material.setEmissiveTexture(null)
  }

  await document.transform(prune({ propertyTypes: undefined }))

  for (const texture of document.getRoot().listTextures()) {
    const owner = texture.listParents().find((parent) => parent.propertyType === 'Material')
    const treatment = TEXTURE_TREATMENT[owner?.getName()] ?? TEXTURE_TREATMENT.default
    const name = owner?.getName()
    const baked = await bakeTexture(texture.getImage(), {
      ...treatment,
      size: sizeOverride ?? MATERIAL_TEXTURE_SIZE[name] ?? MATERIAL_TEXTURE_SIZE.default,
    })
    texture.setImage(baked).setMimeType('image/png')
  }
}

// --- Preview ----------------------------------------------------------------

/**
 * A top-down PNG of what was found: road footprint in grey, the pruned medial
 * axis in cyan, and the chosen racing line in red. The only honest way to check an automatic trace — a spline that
 * cuts a corner or picks up a pit lane is obvious in a picture and invisible
 * in a list of numbers.
 */
async function writePreview(grid, skeleton, points, path) {
  const { size } = grid
  const pixels = Buffer.alloc(size * size * 3)
  for (let i = 0; i < grid.occupancy.length; i++) {
    const road = grid.occupancy[i]
    pixels[i * 3] = road ? 96 : 22
    pixels[i * 3 + 1] = road ? 96 : 22
    pixels[i * 3 + 2] = road ? 118 : 30
    // The surviving medial axis, in cyan: what the trace had to choose from
    // after every dead end was peeled away.
    if (skeleton[i]) { pixels[i * 3] = 40; pixels[i * 3 + 1] = 220; pixels[i * 3 + 2] = 220 }
  }

  const toCell = ([x, , z]) => [
    Math.round((x - grid.minX) / grid.cell),
    Math.round((z - grid.minZ) / grid.cell),
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

/**
 * Distance from the recentred origin to the furthest vertex, on the ground
 * plane, in final game units. Vertical extent is ignored: fog is about how
 * far you can see across a landscape, and a floodlight pylon does not change
 * where the horizon is.
 */
function measureGroundRadius(document, scale, centre) {
  const distances = []
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const positions = primitive.getAttribute('POSITION')?.getArray()
      if (!positions) continue
      for (let i = 0; i < positions.length; i += 3) {
        const x = (positions[i] - centre[0]) * scale
        const z = (positions[i + 2] - centre[2]) * scale
        distances.push(Math.hypot(x, z))
      }
    }
  }
  distances.sort((a, b) => a - b)
  // 97th percentile rather than the maximum. The maximum belongs to whatever
  // single stray object sits furthest out — a game rip carries backdrop
  // mountains and bits of skybox several times further than anything the
  // camera will meet, and one of them measured a "world" four times the size
  // of the real one. Fog scaled to that never fogged anything at all. The
  // few percent of geometry past this radius simply sits inside full fog,
  // which is exactly where distant backdrop belongs.
  return distances[Math.floor(distances.length * 0.97)] ?? 0
}

// --- Main -------------------------------------------------------------------

async function main() {
  const args = parseArguments(process.argv)
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const outputGlb = resolve(root, `public/ps1/tracks/${args.slug}.glb`)
  // The model is a static asset; the traced numbers are source. They are
  // meant to be read, argued with and corrected by hand when the trace clips
  // a corner, which is not something to go looking for in `public`.
  const outputJson = resolve(root, `app/leon/channels/race/tracks/${args.slug}.track.json`)
  // Beside the traced numbers rather than in `public`: it is a working
  // drawing for whoever has to correct them, not an asset the app serves.
  const outputPreview = resolve(root, `app/leon/channels/race/tracks/${args.slug}.trace.png`)
  await mkdir(dirname(outputGlb), { recursive: true })
  await mkdir(dirname(outputJson), { recursive: true })

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const document = await io.read(resolve(args.in))
  const countTriangles = () =>
    document.getRoot().listMeshes()
      .flatMap((mesh) => mesh.listPrimitives())
      .reduce((total, primitive) => total + (primitive.getIndices()?.getCount() ?? 0) / 3, 0)

  const sourceTriangles = countTriangles()
  console.log(`source: ${Math.round(sourceTriangles).toLocaleString()} triangles, ` +
    `${document.getRoot().listMeshes().length} meshes, ` +
    `${document.getRoot().listMaterials().length} materials`)

  // 1. One draw call per material. `flatten` lifts transforms up the graph so
  // `join` is allowed to merge; without it almost nothing is compatible.
  await document.transform(resample(), dedup(), flatten())

  // Bake node transforms into the vertices before anything measures them.
  //
  // This model's terrain is a unit plane on a node scaled by 230, so in
  // accessor space its edges are one unit long and in the world they are 230.
  // Every step below asks a question about *distance* — how long is this edge,
  // how wide is the road, how far apart are these two triangles — and every
  // one of them gets the wrong answer while the scale is still sitting on a
  // node.
  bakeNodeTransforms(document)

  await document.transform(join({ keepNamed: false }))
  console.log(`merged: ${document.getRoot().listMeshes().length} meshes`)

  // 2. The racing line, traced before anything is moved or decimated — a
  // simplified road has ragged edges, and the distance field would follow them.
  let roadGeometry
  if (args.road === 'auto') {
    const roadMaterials = detectRoadMaterials(document)
    if (roadMaterials.size === 0) throw new Error('Auto road detection found no ribbon materials.')
    roadGeometry = collectGeometry(document, (name) => roadMaterials.has(name), {
      upFacingOnly: true,
    })
  } else {
    const wanted = new Set(args.road.split(','))
    roadGeometry = collectGeometry(document, (name) => wanted.has(name))
  }
  if (roadGeometry.indices.length === 0) {
    const names = document.getRoot().listMaterials().map((m) => m.getName())
    throw new Error(`No geometry with material "${args.road}". Materials present: ${names.join(', ')}`)
  }
  const grid = rasteriseRoad(roadGeometry.positions, roadGeometry.indices)
  const distance = distanceTransform(grid)
  let traced
  try {
    traced = traceRacingLine(grid, distance, {
      // A rip circuit is kilometres of switchbacks; 44 points straightens
      // its hairpins into chicanes. More points is not more smoothing work at
      // runtime — the spline is sampled the same either way.
      controlPoints: args.road === 'auto' ? 88 : CONTROL_POINT_COUNT,
      // Nothing for a clean marketplace footprint; load-bearing for a rip.
      // See despeckle and closeGaps for what each is forgiving.
      despeckleCells: args.road === 'auto' ? 60 : 0,
      closeRadius: args.road === 'auto' ? 6 : 0,
    })
  } catch (error) {
    // Failure with a picture beats failure with a stack trace: the preview of
    // the footprint the trace was given is the only way to see *why* no loop
    // was found — a gap in the tarmac, a missed chunk, a road that genuinely
    // does not close.
    await writePreview(grid, new Uint8Array(grid.occupancy.length), [], outputPreview)
    console.error(`trace failed — footprint written to ${outputPreview}`)
    throw error
  }
  const { points, medianHalfWidth, skeleton } = traced
  await writePreview(grid, skeleton, points, outputPreview)

  // 3. Normalise: scale until the road is as wide as the sim expects, and
  // recentre on the racing line so the circuit sits around the world origin
  // where the camera rig and the minimap both assume it is.
  const scale = TARGET_ROAD_HALF_WIDTH / medianHalfWidth
  const centre = points.reduce(
    (sum, [x, y, z]) => [sum[0] + x / points.length, sum[1] + y / points.length, sum[2] + z / points.length],
    [0, 0, 0],
  )
  const normalisedPoints = points.map(([x, y, z]) => [
    round((x - centre[0]) * scale),
    round((y - centre[1]) * scale),
    round((z - centre[2]) * scale),
  ])

  // Applied as a transform on a wrapper node rather than baked into every
  // vertex: identical result, and it keeps the accessors untouched so the
  // decimation below is working with the geometry the artist actually authored.
  const scene = document.getRoot().listScenes()[0]
  const wrapper = document.createNode('track-normalise')
    .setScale([scale, scale, scale])
    .setTranslation([-centre[0] * scale, -centre[1] * scale, -centre[2] * scale])
  for (const child of scene.listChildren()) wrapper.addChild(child)
  scene.addChild(wrapper)

  // 4. The budget, per material.
  //
  // Unless there is no budget to enforce. `--preserve` exists for game rips:
  // a track lifted out of a real PS2 game *is already* period geometry, cut
  // to a real console's budget by people who shipped it, and running an
  // automatic decimator over their work makes it strictly worse. Everything
  // else — the trace, the scale, the fog tessellation, the texture pages —
  // still applies; the only thing skipped is the part where we pretend to
  // know better than the original artists.
  const preserve = args.preserve === 'true'
  await MeshoptSimplifier.ready
  await document.transform(weld())
  if (!preserve) for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const name = primitive.getMaterial()?.getName() ?? 'default'
      const before = (primitive.getIndices()?.getCount() ?? 0) / 3
      if (before <= MINIMUM_TRIANGLES) continue

      const ratio = MATERIAL_RATIO[name] ?? MATERIAL_RATIO.default
      const target = Math.max(MINIMUM_TRIANGLES, Math.round(before * ratio))

      if (ratio < 1) {
        simplifyPrimitive(primitive, {
          simplifier: MeshoptSimplifier,
          ratio: Math.max(ratio, MINIMUM_TRIANGLES / before),
          // A generous error budget on purpose. meshopt stops early when the
          // next edge collapse would move a vertex further than `error` (as a
          // fraction of the mesh's own size); at the library default of 0.0001
          // this model refused to go below 45%, preferring detail to the
          // target. The detail is precisely what we are here to remove.
          error: 0.6,
          lockBorder: false,
        })
        compactPrimitive(primitive)

        // meshopt will not collapse an edge that joins two disconnected
        // pieces, and this scene's `Metal` is ~150 separate barriers and
        // gantries — so the careful pass floors out at 63% however generous
        // the error budget, because each barrier has already been reduced as
        // far as its own borders allow. The sloppy pass ignores topology
        // entirely and simply hits the number.
        //
        // It is only safe where a material carries no texture: sloppy welds
        // across UV seams, which on a textured surface tears the map apart.
        // `Metal` is a flat base colour, so there is nothing to tear.
        if (
          (primitive.getIndices()?.getCount() ?? 0) / 3 > target * 1.25 &&
          !primitive.getMaterial()?.getBaseColorTexture()
        ) {
          decimateSloppy(document, primitive, target)
          compactPrimitive(primitive)
        }
      }

      // And for geometry that is thousands of separate cards, the only
      // reduction available is fewer cards. See cullComponents.
      if (cullComponents(document, primitive, MATERIAL_KEEP[name] ?? MATERIAL_KEEP.default) > 0) {
        compactPrimitive(primitive)
      }

      const after = (primitive.getIndices()?.getCount() ?? 0) / 3
      console.log(`  ${name.padEnd(10)} ${Math.round(before).toLocaleString().padStart(8)} -> ` +
        `${Math.round(after).toLocaleString().padStart(7)}`)
    }
  }
  console.log(`decimated: ${Math.round(countTriangles()).toLocaleString()} triangles`)

  const bounds = normalisedPoints.reduce((box, [x, , z]) => ({
    minX: Math.min(box.minX, x), maxX: Math.max(box.maxX, x),
    minZ: Math.min(box.minZ, z), maxZ: Math.max(box.maxZ, z),
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity })

  // 5. Enough vertices to carry the fog. See MAX_EDGE_UNITS — this is what
  // stops the ground rendering as a flat sheet of sky colour.
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ)
  const maxEdgeInSourceUnits = (span * MAX_EDGE_FRACTION) / scale
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const name = primitive.getMaterial()?.getName() ?? 'default'
      const before = (primitive.getIndices()?.getCount() ?? 0) / 3
      const after = tessellatePrimitive(
        document,
        primitive,
        maxEdgeInSourceUnits,
        Math.max(TESSELLATION_FLOOR, before * TESSELLATION_GROWTH),
      )
      if (after > before) {
        console.log(`  ${name.padEnd(10)} ${Math.round(before).toLocaleString().padStart(8)} -> ` +
          `${Math.round(after).toLocaleString().padStart(7)} (subdivided for fog)`)
      }
    }
  }
  console.log(`tessellated: ${Math.round(countTriangles()).toLocaleString()} triangles`)

  // How far the model itself reaches, measured on the ground plane and in
  // final game units. This is the number the fog has to be set against.
  //
  // Not the circuit's span, which is what the first attempt used: a downloaded
  // track models the land immediately around its road and no further, so the
  // terrain here stops barely a third past the outside of the lap. Fog tuned
  // to the *lap* left the far edge of the world fully visible, ending against
  // the sky in a hard line — the exact failure the era used fog to prevent.
  const modelRadius = measureGroundRadius(document, scale, centre)

  // Measured before quantisation: that step rewrites positions as normalised
  // integers with the real scale moved onto a node, so reading the accessor
  // afterwards reports a circuit fifty thousand units across.

  // 6. Texture density. See MATERIAL_UV_SCALE.
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const name = primitive.getMaterial()?.getName() ?? 'default'
      const uvScale = MATERIAL_UV_SCALE[name] ?? MATERIAL_UV_SCALE.default
      if (uvScale === 1) continue

      const uv = primitive.getAttribute('TEXCOORD_0')
      if (!uv) continue
      const scaled = Float32Array.from(uv.getArray(), (value) => value * uvScale)
      primitive.setAttribute(
        'TEXCOORD_0',
        document
          .createAccessor()
          .setType('VEC2')
          .setArray(scaled)
          .setBuffer(document.getRoot().listBuffers()[0]),
      )
      console.log(`  ${name.padEnd(10)} UVs scaled x${uvScale}`)
    }
  }

  // 7. Texture pages.
  await reduceTextures(document, args.texsize ? Number(args.texsize) : undefined)

  // 8. Vertex precision.
  //
  // Positions get the full 16 bits, not the 14 that looked like free money.
  // The shader snaps every vertex to a 320x240 grid before it draws anything,
  // so the low bits of a *screen* position genuinely do not survive — but
  // depth is not snapped, and this circuit's terrain and its tarmac are
  // coplanar in the source. At 14 bits across a 900-unit model the rounding is
  // 55mm, which is far more than the gap between the road and the ground
  // underneath it: the two surfaces interleaved, and every camera move made
  // the whole track strobe between green and grey. 16 bits puts the rounding
  // at 14mm, and the surfaces are separated properly in the registry.
  await document.transform(
    prune(),
    dedup(),
    quantize({ quantizePosition: 16, quantizeNormal: 8, quantizeTexcoord: 12 }),
  )

  await writeFile(outputGlb, await io.writeBinary(document))



  await writeFile(outputJson, JSON.stringify({
    slug: args.slug,
    source: args.in.split('/').pop(),
    roadMaterial: args.road,
    // Everything below is editable by hand. The trace is a first draft.
    controlPoints: normalisedPoints,
    roadHalfWidth: TARGET_ROAD_HALF_WIDTH,
    bounds,
    /** Distance from the origin to the furthest geometry, on the XZ plane. */
    modelRadius: round(modelRadius),
    materials: document.getRoot().listMaterials().map((material) => material.getName()),
    baked: {
      triangles: Math.round(countTriangles()),
      sourceTriangles: Math.round(sourceTriangles),
      scaleApplied: round(scale),
      sourceRoadHalfWidth: round(medianHalfWidth),
    },
  }, null, 2) + '\n')

  console.log(`wrote ${outputGlb}`)
  console.log(`wrote ${outputJson}`)
  console.log(`wrote ${outputPreview}  <- check the traced line before trusting it`)
}

const round = (value) => Math.round(value * 1000) / 1000

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
