#!/usr/bin/env node
//
// Turns downloaded locations into stages the fight channel can hold a bout
// in: cut to the console's budget, stood at a common scale, and measured
// along the line the fighters actually move on.
//
// Same argument as every other bake here. A scanned temple arrives as a
// quarter of a million triangles and a page that would cover a wall; a
// modelled chamber arrives in centimetres with forty-five texture sets. The
// channel draws at 270 lines through a shader that snaps vertices to the
// framebuffer, and feeding it a dense mesh turns the wobble into noise. So
// the reduction is the look, not an optimisation.
//
// The one thing a stage has to answer that a track does not is where a
// fighter can stand. The bout is one-dimensional — two people on a line, the
// camera side-on — so the stage is measured along that line: the floor's
// height at every step, how far either way the ground stays clear of pillars
// and vases and walls, and whether the camera's own shot is unobstructed.
// The runtime reads those numbers rather than testing collisions, which is
// how the era did it too: the arena was a strip, and the strip was authored.
//
// Per stage, in this order:
//
//   1. Flatten to one coordinate space, merge, decimate to budget.
//   2. Scale to metres, then move and turn the whole model so the chosen
//      fight line lies along +x at z = 0 with the floor at y = 0, the
//      backdrop behind it (-z) and the camera's side (+z) open.
//   3. Fire rays along that line: down for the floor, sideways for anything
//      standing in the strip, and from the camera for anything in the shot.
//   4. Strip the PBR sets to colour pages and write the glb.
//
// `--survey 1` skips the write and prints a map of the placement instead:
// floor height and clearance on a grid around the line, so a stage's
// numbers below can be chosen by looking rather than guessed.
//
// Usage: node scripts/bakeStages.mjs --src <dir> [--only <slug>] [--survey 1 [--wide 1]] [--search 1]

import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { quantize } from '@gltf-transform/functions'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname, join as joinPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseArguments, findSources, flattenToWorld, transformAll, allPrimitives,
  boundsOf, countTriangles, decimate, reduceTextures, join, prune, rotationY,
  scaleTranslate, multiplyMatrices,
} from './bakeShared.mjs'

// --- The venues -------------------------------------------------------------

/**
 * One entry per source file.
 *
 * `scale` takes the model to metres. `origin` is the point, in the model's
 * own source units, that becomes the middle of the fight line; `yaw`
 * turns the model about that point so the line lies along +x — the survey
 * is how those two were found. `budget` is triangles; `page` the longest
 * edge of a texture page, with `pageFor` overriding it per material name
 * for a scan whose single page covers the whole venue.
 */
const STAGES = [
  {
    slug: 'kings-chamber',
    file: 'egypt_chamber_for_ar__vr_games.glb',
    scale: 0.01,
    origin: [-2400, 562, -300],
    yaw: Math.PI / 2,
    budget: 14000,
    page: 256,
  },
  {
    slug: 'moss-shrine',
    file: 'an_overgrown_japanese-style_location.glb',
    scale: 1,
    origin: [2, -6.9, -10],
    yaw: 0,
    budget: 14000,
    page: 256,
  },
  {
    slug: 'temple-of-winds',
    file: 'greek_temple_scan.glb',
    scale: 1,
    origin: [0.85, 0, 15.5],
    yaw: 0,
    budget: 12000,
    page: 1024,
  },
]

/** How far either side of centre the line is measured, in metres. */
const LINE_EXTENT = 9
/** Steps along the line, in metres. */
const LINE_STEP = 0.25
/** The fighters' own footprint either side of the line, in metres. */
const STRIP_HALF_DEPTH = 0.9
/** A fighter stands this tall; the strip is clear when nothing is in it. */
const FIGHTER_HEIGHT = 2.0
/** A step in the floor bigger than this is an obstacle, not ground. */
const FLOOR_STEP = 0.35
/**
 * How far the floor may drift from the centre's height before the line
 * ends. A slope passes the step test one sample at a time and still climbs
 * a hillside; a bout is fought on the flat.
 */
const FLOOR_DRIFT = 0.6
/** Height the floor rays are fired from. Above a fighter, below a ceiling. */
const RAY_HEIGHT = 2.8
/** The camera's rig, matching FightScene, so the shot can be checked. */
const CAMERA = { height: 1.45, distance: 4.4, lookHeight: 1.0 }

// --- Rays -------------------------------------------------------------------

/** Every triangle in the document as flat world-space positions. */
function gatherTriangles(document) {
  const triangles = []
  for (const primitive of allPrimitives(document)) {
    const positions = primitive.getAttribute('POSITION')?.getArray()
    const indices = primitive.getIndices()?.getArray()
    if (!positions || !indices) continue
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3
      triangles.push([
        positions[a], positions[a + 1], positions[a + 2],
        positions[b], positions[b + 1], positions[b + 2],
        positions[c], positions[c + 1], positions[c + 2],
      ])
    }
  }
  return triangles
}

/** Bin size of the index, in metres. */
const BIN = 2

/**
 * Triangles binned on the ground plane. Every ray this bake fires is either
 * vertical or runs along z at a fixed x, so a ray only ever has to visit the
 * column of bins under it — which is what makes searching a whole model for
 * the best line affordable.
 */
function indexTriangles(triangles) {
  const bins = new Map()
  const key = (bx, bz) => `${bx},${bz}`
  for (const t of triangles) {
    const minX = Math.floor(Math.min(t[0], t[3], t[6]) / BIN), maxX = Math.floor(Math.max(t[0], t[3], t[6]) / BIN)
    const minZ = Math.floor(Math.min(t[2], t[5], t[8]) / BIN), maxZ = Math.floor(Math.max(t[2], t[5], t[8]) / BIN)
    for (let bx = minX; bx <= maxX; bx++) {
      for (let bz = minZ; bz <= maxZ; bz++) {
        const k = key(bx, bz)
        let bin = bins.get(k)
        if (!bin) bins.set(k, (bin = []))
        bin.push(t)
      }
    }
  }
  return { bins, key }
}

/** The triangles a ray from `origin` along `direction` could touch. */
function candidates(index, origin, direction, maxDistance) {
  const [ox, , oz] = origin
  const [dx, , dz] = direction
  const reach = Number.isFinite(maxDistance) ? maxDistance : 60
  const endX = ox + dx * reach, endZ = oz + dz * reach
  const minX = Math.floor(Math.min(ox, endX) / BIN), maxX = Math.floor(Math.max(ox, endX) / BIN)
  const minZ = Math.floor(Math.min(oz, endZ) / BIN), maxZ = Math.floor(Math.max(oz, endZ) / BIN)
  const out = []
  for (let bx = minX; bx <= maxX; bx++) {
    for (let bz = minZ; bz <= maxZ; bz++) {
      const bin = index.bins.get(index.key(bx, bz))
      if (bin) out.push(bin)
    }
  }
  return out
}

/**
 * Möller–Trumbore over the bins a ray crosses. Returns every hit's distance
 * along the ray, sorted.
 */
function castRay(index, origin, direction, maxDistance = Infinity) {
  const hits = []
  const [ox, oy, oz] = origin
  const [dx, dy, dz] = direction
  for (const bin of candidates(index, origin, direction, maxDistance)) for (const t of bin) {
    const e1x = t[3] - t[0], e1y = t[4] - t[1], e1z = t[5] - t[2]
    const e2x = t[6] - t[0], e2y = t[7] - t[1], e2z = t[8] - t[2]
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x
    const det = e1x * px + e1y * py + e1z * pz
    if (Math.abs(det) < 1e-9) continue
    const inv = 1 / det
    const tx = ox - t[0], ty = oy - t[1], tz = oz - t[2]
    const u = (tx * px + ty * py + tz * pz) * inv
    if (u < 0 || u > 1) continue
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
    const v = (dx * qx + dy * qy + dz * qz) * inv
    if (v < 0 || u + v > 1) continue
    const distance = (e2x * qx + e2y * qy + e2z * qz) * inv
    if (distance > 1e-6 && distance <= maxDistance) hits.push(distance)
  }
  return hits.sort((a, b) => a - b)
}

/**
 * The search: every line the model could hold, scored. Four headings, a
 * two-metre grid of centres, and for each the same measurement the bake
 * makes — how far the strip stays clear and whether the camera can see
 * into it. Prints the best, in the model's own source units, ready to be
 * copied into STAGES above.
 */
function searchPlacements(triangles, spec, log) {
  const bounds = triangles.reduce((acc, t) => {
    for (const i of [0, 3, 6]) {
      acc.min[0] = Math.min(acc.min[0], t[i]); acc.max[0] = Math.max(acc.max[0], t[i])
      acc.min[1] = Math.min(acc.min[1], t[i + 1]); acc.max[1] = Math.max(acc.max[1], t[i + 1])
      acc.min[2] = Math.min(acc.min[2], t[i + 2]); acc.max[2] = Math.max(acc.max[2], t[i + 2])
    }
    return acc
  }, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] })
  const results = []
  const quiet = () => {}
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    // Rotating the model per candidate is the expensive part; rotate the
    // triangles once per heading and move the candidate centre instead.
    const c = Math.cos(yaw), sn = Math.sin(yaw)
    const turned = triangles.map((t) => {
      const out = new Array(9)
      for (const i of [0, 3, 6]) {
        out[i] = c * t[i] + sn * t[i + 2]
        out[i + 1] = t[i + 1]
        out[i + 2] = -sn * t[i] + c * t[i + 2]
      }
      return out
    })
    const index = indexTriangles(turned)
    const tb = turned.reduce((acc, t) => {
      for (const i of [0, 3, 6]) {
        acc.min[0] = Math.min(acc.min[0], t[i]); acc.max[0] = Math.max(acc.max[0], t[i])
        acc.min[2] = Math.min(acc.min[2], t[i + 2]); acc.max[2] = Math.max(acc.max[2], t[i + 2])
      }
      return acc
    }, { min: [Infinity, 0, Infinity], max: [-Infinity, 0, -Infinity] })
    for (let z = Math.ceil(tb.min[2]); z <= tb.max[2]; z += 2) {
      for (let x = Math.ceil(tb.min[0]); x <= tb.max[0]; x += 2) {
        // Floors are looked for from just above head height over the lowest
        // ground in the model; an upper storey is not a candidate.
        const floor = floorAt(index, x, z, bounds.min[1] + 6)
        if (Number.isNaN(floor)) continue
        const shifted = { index, x, z, floor }
        const measured = measureLineAt(shifted, quiet, 6)
        if (measured.extent.maxX - measured.extent.minX < 4) continue
        // A backdrop: something standing a few metres behind the line at
        // head height. A line with nothing behind it is a fight in a car
        // park, however clear the strip.
        const behind = castRay(index, [x, floor + 1.5, z], [0, 0, -1], 16)
        const backdrop = behind.length > 0 ? behind[0] : null
        results.push({ yaw, x, z, floor, extent: measured.extent, blocked: measured.cameraBlocked, clear: measured.clearSteps, backdrop })
      }
    }
  }
  const score = (r) => (r.extent.maxX - r.extent.minX) * (r.blocked === 0 ? 2 : 1) + (r.backdrop !== null && r.backdrop > 3 && r.backdrop < 14 ? 6 : 0)
  results.sort((a, b) => score(b) - score(a))
  log(`  search: ${results.length} candidate lines; best twenty (origin in source units, then yaw):`)
  for (const r of results.slice(0, 20)) {
    // Undo the heading and the scale to get back to the source's own space.
    const c = Math.cos(-r.yaw), sn = Math.sin(-r.yaw)
    const sx = (c * r.x + sn * r.z) / spec.scale, sz = (-sn * r.x + c * r.z) / spec.scale
    const sy = r.floor / spec.scale
    log(`    origin: [${sx.toFixed(1)}, ${sy.toFixed(1)}, ${sz.toFixed(1)}], yaw: ${(r.yaw / Math.PI).toFixed(2)}π  clear ${r.extent.minX}..${r.extent.maxX} (${(r.extent.maxX - r.extent.minX).toFixed(1)}m), camera blocked ${r.blocked}/${r.clear}, backdrop ${r.backdrop === null ? 'none' : r.backdrop.toFixed(1) + 'm'}`)
  }
}

/** Height of the first surface below `y` at (x, z), or NaN. */
function floorAt(index, x, z, fromY = RAY_HEIGHT) {
  const hits = castRay(index, [x, fromY, z], [0, -1, 0], fromY + 20)
  return hits.length === 0 ? Number.NaN : fromY - hits[0]
}

/** True when nothing crosses the strip at x between the floor and head height. */
function stripClear(index, x, floor, zOffset = 0) {
  for (const height of [0.35, 0.9, 1.5, FIGHTER_HEIGHT - 0.1]) {
    const hits = castRay(index, [x, floor + height, zOffset + STRIP_HALF_DEPTH + 0.6], [0, 0, -1], STRIP_HALF_DEPTH * 2 + 0.6)
    if (hits.length > 0) return false
  }
  return true
}

/** True when the camera at x can see the fighter at x. */
function shotClear(index, x, floor, zOffset = 0) {
  const from = [x, floor + CAMERA.height, zOffset + CAMERA.distance]
  const to = [x, floor + CAMERA.lookHeight, zOffset]
  const direction = to.map((value, axis) => value - from[axis])
  const length = Math.hypot(...direction)
  return castRay(index, from, direction.map((value) => value / length), length - 0.2).length === 0
}

// --- Measuring --------------------------------------------------------------

/**
 * Walks the line outwards from centre in both directions, recording the
 * floor and stopping at the first step it cannot stand on. The clear extent
 * is the contiguous run around the centre; the runtime holds every fighter
 * inside it.
 */
function measureLine(index, log) {
  const centreFloor = floorAt(index, 0, 0)
  if (Number.isNaN(centreFloor)) throw new Error('No floor under the centre of the line')
  return measureLineAt({ index, x: 0, z: 0, floor: centreFloor }, log, LINE_EXTENT)
}

function measureLineAt({ index, x: cx, z: cz, floor: centreFloor }, log, extentMetres) {
  const steps = Math.round(extentMetres / LINE_STEP)
  const floors = new Float32Array(steps * 2 + 1)
  const clear = new Array(steps * 2 + 1).fill(false)
  let minX = 0, maxX = 0
  let cameraBlocked = 0
  for (const direction of [-1, 1]) {
    let previous = centreFloor
    let open = true
    for (let step = 0; step <= steps; step++) {
      const x = direction * step * LINE_STEP
      const slot = steps + direction * step
      const floor = floorAt(index, cx + x, cz, previous + RAY_HEIGHT)
      const stepUp = Number.isNaN(floor) ? Infinity : Math.abs(floor - previous)
      floors[slot] = Number.isNaN(floor) ? previous : floor
      const drift = Math.abs(floors[slot] - centreFloor)
      if (open && stepUp <= FLOOR_STEP && drift <= FLOOR_DRIFT && stripClear(index, cx + x, floors[slot], cz)) {
        clear[slot] = true
        if (!shotClear(index, cx + x, floors[slot], cz)) cameraBlocked++
        if (direction < 0) minX = x
        else maxX = x
        previous = floors[slot]
      } else {
        open = false
      }
    }
  }
  // Half a step in from the last clear sample, so a fighter's own width
  // never reaches the thing that stopped the walk.
  const extent = { minX: Number((minX + 0.5).toFixed(2)), maxX: Number((maxX - 0.5).toFixed(2)) }
  const clearSteps = clear.filter(Boolean).length
  log(`  line: floor at centre ${centreFloor.toFixed(2)}, clear x ${extent.minX} .. ${extent.maxX}, camera blocked at ${cameraBlocked} of ${clearSteps} steps`)
  return { floors: Array.from(floors, (value) => Number((value - centreFloor).toFixed(3))), extent, step: LINE_STEP, centreFloor, clear, cameraBlocked, clearSteps }
}

/**
 * The survey: a map of the ground around the line, as the placement stands.
 * Rows are z (camera side at the top), columns x. A cell is the floor's
 * height relative to the line's centre, or a mark for what blocks it.
 */
function survey(index, log, wide) {
  const centreFloor = floorAt(index, 0, 0)
  if (wide) {
    // The whole neighbourhood at a metre a cell, heights as half-metre
    // steps: digits above the centre floor, letters below, '.' level.
    log(`  wide: rows z +20 .. -20, cols x -30 .. 30, one metre each; centre floor ${Number.isNaN(centreFloor) ? 'none' : centreFloor.toFixed(2)}`)
    for (let z = 20; z >= -20; z -= 1) {
      let row = ''
      for (let x = -30; x <= 30; x += 1) {
        const floor = floorAt(index, x, z, RAY_HEIGHT + 6)
        if (Number.isNaN(floor)) { row += ' '; continue }
        const relative = floor - (Number.isNaN(centreFloor) ? 0 : centreFloor)
        const steps = Math.round(relative / 0.5)
        row += Math.abs(relative) < 0.15 ? '.' : steps > 0 ? String(Math.min(9, steps)) : String.fromCharCode(96 + Math.min(9, -steps))
      }
      log(`  ${String(z).padStart(3)} |${row}|`)
    }
  }
  log(`  survey: centre floor y ${Number.isNaN(centreFloor) ? 'none' : centreFloor.toFixed(2)}  (rows z +7 .. -9, cols x -12 .. 12; . flat  - below  + above  # wall/obstacle  ' ' no floor)`)
  for (let z = 7; z >= -9; z -= 1) {
    let row = ''
    for (let x = -12; x <= 12; x += 0.5) {
      const floor = floorAt(index, x, z)
      if (Number.isNaN(floor)) { row += ' '; continue }
      const relative = floor - (Number.isNaN(centreFloor) ? 0 : centreFloor)
      if (relative > FLOOR_STEP) row += '#'
      else if (relative > 0.12) row += '+'
      else if (relative < -0.12) row += '-'
      else row += '.'
    }
    log(`  ${String(z).padStart(3)} |${row}|`)
  }
}

// --- The bake ---------------------------------------------------------------

async function bakeStage(io, sourcePath, spec, outputDir, options) {
  const log = (line) => console.log(line)
  log(`\n${spec.slug} — ${spec.file}`)
  const document = await io.read(sourcePath)
  const root = document.getRoot()
  log(`  source: ${Math.round(countTriangles(document)).toLocaleString()} triangles, ${root.listMeshes().length} meshes, ${root.listMaterials().length} materials, ${root.listTextures().length} textures`)

  // What the source material said about itself, before anything is merged:
  // the runtime rebuilds every surface and needs to know which were cut-outs.
  const materials = root.listMaterials().map((material) => ({
    name: material.getName(),
    alphaMode: material.getAlphaMode(),
    doubleSided: material.getDoubleSided(),
    textured: material.getBaseColorTexture() !== null,
  }))

  // 1. One space, one draw call per material, then the budget.
  await flattenToWorld(document)
  await document.transform(join({ keepNamed: false }))
  await decimate(document, spec.budget, log, { error: 0.6 })
  log(`  decimated: ${Math.round(countTriangles(document)).toLocaleString()} triangles`)

  // 2. Metres, then the fight line onto +x at the origin. A search runs in
  //    the source's own frame, scaled only, so what it prints is absolute.
  const [ox, oy, oz] = options.search ? [0, 0, 0] : spec.origin
  const s = spec.scale
  transformAll(document, multiplyMatrices(rotationY(options.search ? 0 : spec.yaw), scaleTranslate([s, s, s], [-ox * s, -oy * s, -oz * s])))
  let triangles = gatherTriangles(document)
  if (options.search) {
    searchPlacements(triangles, spec, log)
    return null
  }
  // The floor under the centre of the line becomes y = 0, whatever the
  // model's author thought the floor was at.
  const centreFloor = floorAt(indexTriangles(triangles), 0, 0)
  if (!Number.isNaN(centreFloor)) {
    transformAll(document, scaleTranslate([1, 1, 1], [0, -centreFloor, 0]))
    triangles = gatherTriangles(document)
  }
  const index = indexTriangles(triangles)

  if (options.survey) {
    survey(index, log, options.wide)
    return null
  }

  // 3. The line.
  const line = measureLine(index, log)
  const bounds = boundsOf(allPrimitives(document))

  // 4. Pages.
  await reduceTextures(document, {
    size: spec.page,
    sizeFor: spec.pageFor ? (texture) => spec.pageFor(texture) : null,
  })
  await document.transform(prune(), quantize({ quantizePosition: 14, quantizeNormal: 8, quantizeTexcoord: 12 }))

  const output = joinPath(outputDir, `${spec.slug}.glb`)
  const bytes = await io.writeBinary(document)
  await writeFile(output, bytes)
  const triangleCount = Math.round(countTriangles(document))
  log(`  wrote ${output} — ${(bytes.byteLength / 1024).toFixed(0)}KB, ${triangleCount} triangles, bounds x ${bounds.min[0].toFixed(1)}..${bounds.max[0].toFixed(1)} y ${bounds.min[1].toFixed(1)}..${bounds.max[1].toFixed(1)} z ${bounds.min[2].toFixed(1)}..${bounds.max[2].toFixed(1)}`)
  return {
    slug: spec.slug,
    triangles: triangleCount,
    bounds: { min: bounds.min.map((v) => Number(v.toFixed(2))), max: bounds.max.map((v) => Number(v.toFixed(2))) },
    line: { extent: line.extent, step: line.step, floors: line.floors },
    materials,
  }
}

// --- Main -------------------------------------------------------------------

async function main() {
  const args = parseArguments(process.argv)
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  if (!args.src) throw new Error('Usage: node scripts/bakeStages.mjs --src <dir> [--only <slug>] [--survey 1]')
  const files = await findSources(resolve(args.src))
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const outputDir = resolve(root, 'public/ps1/stages')
  await mkdir(outputDir, { recursive: true })
  const options = { survey: args.survey === '1', wide: args.wide === '1', search: args.search === '1' }

  const manifestPath = resolve(root, 'app/leon/channels/fight/stages.json')
  let manifest = { stages: [] }
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    // First bake.
  }

  for (const spec of STAGES) {
    if (args.only && args.only !== spec.slug) continue
    const source = files.get(spec.file)
    if (!source) throw new Error(`Missing source ${spec.file} under ${args.src}`)
    const baked = await bakeStage(io, source, spec, outputDir, options)
    if (baked) manifest.stages = [...manifest.stages.filter((entry) => entry.slug !== spec.slug), baked]
  }
  if (options.survey || options.search) return
  manifest.stages.sort((a, b) => STAGES.findIndex((s) => s.slug === a.slug) - STAGES.findIndex((s) => s.slug === b.slug))
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`\nmanifest: ${manifestPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
