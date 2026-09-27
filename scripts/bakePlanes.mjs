#!/usr/bin/env node
//
// Turns downloaded aircraft — and the hillside they fly over — into what the
// dogfight channel can actually use.
//
// The same argument as bakeTrack.mjs, for the same reason. A Sketchfab plane
// arrives as a modern asset: a photogrammetry scan of 185k triangles, a
// 2K photo page, a node tree with the scale parked three levels up and the
// nose pointing wherever the scanner happened to stand. The channel draws at
// 270 lines through a shader that snaps vertices to the framebuffer, and a
// dense mesh through that stops reading as hardware and starts reading as
// noise. So the reduction is the look, not an optimisation.
//
// Per airframe, in this order, because each step depends on the last:
//
//   1. Flatten the node tree and bake every transform into the vertices.
//   2. Find the airscrew, by node name, and give it its own material so the
//      merge in step 4 cannot fuse it into the cowling.
//   3. Find the nose and turn the whole aircraft to fly down +z, level; then
//      scale it to the squadron's common length and sit it on its own
//      centreline. Every airframe in the catalogue is the same length on
//      screen — the sim flies one plane, the reader supplies the type.
//   4. One draw call per material, then decimate to the polygon budget.
//   5. Lift the airscrew out under a node at its hub, so the renderer can
//      spin it about its own axis with one rotation per frame.
//   6. Strip the PBR set to a single base colour page, downsampled to a
//      console page and quantised to an indexed palette — and, on the one
//      page that needs it, painted over first.
//
// Everything the renderer needs to know that is not geometry — where the hub
// is, how wide the disc, how long the wings — is written to airframes.json
// beside the catalogue, so the runtime reads numbers rather than measuring
// models.
//
// Usage: node scripts/bakePlanes.mjs [--src <dir of .glb files>] [--only <slug>]

import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import {
  dedup, flatten, join, weld, prune, resample, quantize, transformMesh,
  simplifyPrimitive, compactPrimitive,
} from '@gltf-transform/functions'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { resolve, dirname, join as joinPath } from 'node:path'
import { fileURLToPath } from 'node:url'

// --- The squadron -----------------------------------------------------------

/**
 * Nose-to-tail length every airframe is scaled to, in world units. Matches
 * the fuselage slab the procedural plane had, so the combat box, the fog and
 * the camera rig all keep their measurements.
 */
const TARGET_LENGTH = 2.2

/**
 * Longest edge of an airframe's colour page. Twice the cars' 128: a plane is
 * seen from further away than a car but its markings — roundels, codes, a
 * star on the fin — are the whole of its identity and have to survive.
 */
const PAGE_SIZE = 256
const PALETTE_SIZE = 256

/**
 * One entry per source file. `prop` names the nodes that make up the
 * airscrew (matched against the node's own name and inherited by its
 * children); `hub` names the part whose centre is the spin axis. `nose`
 * says how to find the front: `prop` measures from the airframe's centre to
 * the hub, `tailfin` — for a scan whose airscrew is fused into the cowling —
 * measures from the highest point on the airframe, which on a tail-dragger
 * is the fin, back through the centre.
 */
const AIRFRAMES = [
  {
    slug: 'spitfire',
    file: 'spitfire__ww2_plane.glb',
    prop: /^propeller/,
    hub: /^propeller cone/,
    nose: 'prop',
    budget: 700,
  },
  {
    slug: 'corsair',
    file: 'f4u-1a_corsair.glb',
    prop: /^(Prop_Blade_\d|PropTip)$/,
    hub: /^PropTip$/,
    nose: 'prop',
    budget: 2000,
  },
  {
    slug: 'zero',
    file: 'japanese_ww2_plane.glb',
    prop: /^Object_(7|8|9)$/,
    hub: /^Object_(7|8|9)$/,
    nose: 'prop',
    budget: 2000,
    // The page carries two anime figures beside the hinomaru; they are
    // painted over in the fuselage green before the page is reduced. The
    // box is in the source page's own pixels.
    paintOver: { texture: 0, box: [400, 118, 100, 124], colour: [66, 151, 102] },
  },
  {
    slug: 'camel',
    file: 'sopwith.glb',
    prop: /^(Plane\.012|Cylinder\.018)$/,
    hub: /^Cylinder\.018$/,
    nose: 'prop',
    budget: 2600,
  },
  {
    slug: 'yak',
    file: 'yakovlev_yak11m_-_soviet_ww2_plane.glb',
    prop: null,
    hub: null,
    nose: 'tailfin',
    budget: 2400,
  },
]

// --- The theatre ------------------------------------------------------------

const TERRAIN = {
  slug: 'edale',
  file: 'broadlee_bank_landslide_edale_uk.glb',
  /** The scan's own skirt, an untextured strip around two edges. */
  drop: /^AdornmentsMaterial$/,
  /**
   * World units the tile spans on its longer side. The fog closes at 95 and
   * the wide shot orbits at 34, so a 240 tile mirrored three by three puts
   * terrain under every pixel the camera can reach.
   */
  tile: 240,
  /**
   * Height of the tallest point above the lowest, in world units, after
   * squashing. The scan is a Peak District hillside with 400m of relief in
   * 1.6km; at the tile's scale that is sixty units of hill, and the patrol
   * flies at seven. Four units keeps the ground rolling and the patrol clear
   * of it.
   */
  relief: 4,
  /** Where the lowest point sits. Peaks land at relief + floor. */
  floor: -2,
  page: 512,
}

// --- Arguments --------------------------------------------------------------

function parseArguments(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1]
  return args
}

// --- Matrices ---------------------------------------------------------------

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function rotationY(angle) {
  const c = Math.cos(angle), s = Math.sin(angle)
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]
}

function rotationX(angle) {
  const c = Math.cos(angle), s = Math.sin(angle)
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]
}

function scaleTranslate(scale, [tx, ty, tz]) {
  return [scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, tx, ty, tz, 1]
}

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

// --- Scene walking ----------------------------------------------------------

/**
 * Bakes every node's world transform into its vertices and resets the node
 * to identity, cloning any mesh that several nodes share first. Lifted from
 * bakeTrack.mjs for the same reason it exists there: every measurement below
 * asks about distance, and gets the wrong answer while a scale is parked on
 * a node.
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
        for (const primitive of mesh.listPrimitives()) copy.addPrimitive(primitive.clone())
        node.setMesh(copy)
        usage.set(mesh, usage.get(mesh) - 1)
      }
      transformMesh(node.getMesh(), node.getWorldMatrix())
      node.setMatrix(IDENTITY)
    })
  }
}

/** Every node with a mesh, with the ancestry that names it. */
function listMeshNodes(document) {
  const found = []
  const visit = (node, lineage) => {
    const names = [...lineage, node.getName()]
    if (node.getMesh()) found.push({ node, names })
    for (const child of node.listChildren()) visit(child, names)
  }
  for (const scene of document.getRoot().listScenes()) {
    for (const node of scene.listChildren()) visit(node, [])
  }
  return found
}

/** Applies `matrix` to every primitive of every mesh — transforms baked already. */
function transformAll(document, matrix) {
  for (const mesh of document.getRoot().listMeshes()) transformMesh(mesh, matrix)
}

function boundsOf(primitives) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const primitive of primitives) {
    const positions = primitive.getAttribute('POSITION')?.getArray()
    if (!positions) continue
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], positions[i + axis])
        max[axis] = Math.max(max[axis], positions[i + axis])
      }
    }
  }
  return { min, max, centre: min.map((value, axis) => (value + max[axis]) / 2) }
}

function centroidOf(primitives, accept = () => true) {
  const sum = [0, 0, 0]
  let count = 0
  for (const primitive of primitives) {
    const positions = primitive.getAttribute('POSITION')?.getArray()
    if (!positions) continue
    for (let i = 0; i < positions.length; i += 3) {
      if (!accept(positions[i], positions[i + 1], positions[i + 2])) continue
      sum[0] += positions[i]
      sum[1] += positions[i + 1]
      sum[2] += positions[i + 2]
      count++
    }
  }
  return count === 0 ? null : sum.map((value) => value / count)
}

function countTriangles(document) {
  return document.getRoot().listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
    .reduce((total, primitive) => total + (primitive.getIndices()?.getCount() ?? 0) / 3, 0)
}

// --- Decimation -------------------------------------------------------------

function decimateSloppy(primitive, targetTriangles) {
  const indices = primitive.getIndices()
  const positions = primitive.getAttribute('POSITION')
  if (!indices || !positions) return
  const [reduced] = MeshoptSimplifier.simplifySloppy(
    Uint32Array.from(indices.getArray()),
    Float32Array.from(positions.getArray()),
    3,
    null,
    targetTriangles * 3,
    0.5,
  )
  indices.setArray(reduced)
}

/**
 * Brings the whole document down to `budget` triangles, cutting every
 * primitive by the same proportion so the airscrew keeps its share.
 *
 * Careful edge collapse first, which respects the texture's seams; an
 * untextured primitive that still overshoots gets the sloppy pass, which
 * ignores topology and simply hits the number. A textured one is left where
 * the careful pass stopped — sloppy welds across UV seams and a photographed
 * roundel torn in half is worse than a few hundred extra triangles.
 */
async function decimate(document, budget, log) {
  await MeshoptSimplifier.ready
  await document.transform(weld())
  const before = countTriangles(document)
  if (before <= budget) return
  const ratio = budget / before
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const count = (primitive.getIndices()?.getCount() ?? 0) / 3
      if (count < 12) continue
      const target = Math.max(8, Math.round(count * ratio))
      simplifyPrimitive(primitive, {
        simplifier: MeshoptSimplifier,
        ratio: Math.max(ratio, 8 / count),
        error: 0.6,
        lockBorder: false,
      })
      compactPrimitive(primitive)
      const after = (primitive.getIndices()?.getCount() ?? 0) / 3
      if (after > target * 1.25 && !primitive.getMaterial()?.getBaseColorTexture()) {
        decimateSloppy(primitive, target)
        compactPrimitive(primitive)
      }
      log(`  ${(primitive.getMaterial()?.getName() ?? '?').padEnd(18)} ${Math.round(count).toLocaleString().padStart(8)} -> ${Math.round((primitive.getIndices()?.getCount() ?? 0) / 3).toLocaleString().padStart(6)}`)
    }
  }
}

// --- Textures ---------------------------------------------------------------

async function bakePage(image, { size, paintOver }) {
  let source = image
  if (paintOver) {
    // Its own pass, finished to a buffer before the resize below. sharp runs
    // its operations in a fixed order whatever order they are called in —
    // resize before composite — so a box measured in the source page's
    // pixels, composited in the same pipeline, would land on the reduced
    // page instead and miss.
    const [left, top, boxWidth, boxHeight] = paintOver.box
    const [r, g, b] = paintOver.colour
    source = await sharp(image).composite([{
      input: { create: { width: boxWidth, height: boxHeight, channels: 4, background: { r, g, b, alpha: 1 } } },
      left,
      top,
    }]).png().toBuffer()
  }
  const pipeline = sharp(source)
  const { width = size, height = size } = await pipeline.metadata()
  const longest = Math.max(width, height)
  const scale = Math.min(1, size / longest)
  const { data, info } = await pipeline
    .resize({
      width: Math.max(8, Math.round(width * scale)),
      height: Math.max(8, Math.round(height * scale)),
      // Area averaging rather than nearest: a photographed page reduced
      // eight times by picking one texel in sixty-four is speckle, not a
      // smaller picture. The hard-edged look comes from the sampler at
      // draw time, which is where the console put it.
      kernel: 'lanczos3',
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png({ palette: true, colours: PALETTE_SIZE, effort: 10 })
    .toBuffer()
}

async function reduceTextures(document, { size, paintOver }) {
  const root = document.getRoot()
  const sourceTextures = root.listTextures()
  for (const material of root.listMaterials()) {
    material.setNormalTexture(null)
    material.setMetallicRoughnessTexture(null)
    material.setOcclusionTexture(null)
    material.setEmissiveTexture(null)
    // The extensions' own maps — clearcoat, specular — go with them.
    for (const extension of material.listExtensions()) extension.dispose()
  }
  await document.transform(prune({ propertyTypes: undefined }))
  for (const texture of root.listTextures()) {
    const sourceIndex = sourceTextures.indexOf(texture)
    const baked = await bakePage(texture.getImage(), {
      size,
      paintOver: paintOver && paintOver.texture === sourceIndex ? paintOver : null,
    })
    texture.setImage(baked).setMimeType('image/png')
  }
}

// --- Airframes --------------------------------------------------------------

async function bakeAirframe(io, sourceDir, spec, outputDir) {
  const log = (line) => console.log(line)
  log(`\n${spec.slug} — ${spec.file}`)
  const document = await io.read(joinPath(sourceDir, spec.file))
  const root = document.getRoot()
  log(`  source: ${Math.round(countTriangles(document)).toLocaleString()} triangles, ${root.listMeshes().length} meshes, ${root.listMaterials().length} materials`)

  // The airscrew is named by its ancestry — "propeller cone" is an empty
  // node whose child carries the mesh — and flatten below disposes exactly
  // those empty ancestors. So the lineage is read first and the node objects
  // themselves, which flatten keeps, are what is matched afterwards.
  const meshNodes = listMeshNodes(document)

  // 1. One coordinate space.
  await document.transform(resample(), dedup(), flatten())
  bakeNodeTransforms(document)

  // 2. The airscrew, by name. Its own material so the merge keeps it apart
  //    from a cowling that happens to share the page.
  const isProp = ({ names }) => spec.prop !== null && names.some((name) => spec.prop.test(name))
  const isHub = ({ names }) => spec.hub !== null && names.some((name) => spec.hub.test(name))
  const propNodes = meshNodes.filter(isProp)
  const hubNodes = meshNodes.filter(isHub)
  const propMaterials = new Map()
  for (const { node } of propNodes) {
    for (const primitive of node.getMesh().listPrimitives()) {
      const source = primitive.getMaterial()
      const key = source?.getName() ?? ''
      if (!propMaterials.has(key)) {
        const copy = source ? source.clone().setName(`propeller:${key}`) : document.createMaterial('propeller')
        propMaterials.set(key, copy)
      }
      primitive.setMaterial(propMaterials.get(key))
    }
  }
  const propPrimitives = propNodes.flatMap(({ node }) => node.getMesh().listPrimitives())
  const bodyPrimitives = meshNodes.filter((entry) => !isProp(entry)).flatMap(({ node }) => node.getMesh().listPrimitives())
  log(`  airscrew: ${propNodes.length} nodes, ${Math.round(propPrimitives.reduce((sum, p) => sum + (p.getIndices()?.getCount() ?? 0) / 3, 0))} triangles`)

  // 3. Which way is forward, and level.
  let noseVector
  const bodyCentroid = centroidOf(bodyPrimitives)
  if (spec.nose === 'prop') {
    const hub = boundsOf(hubNodes.flatMap(({ node }) => node.getMesh().listPrimitives())).centre
    noseVector = hub.map((value, axis) => value - bodyCentroid[axis])
  } else {
    const { max } = boundsOf(bodyPrimitives)
    const finTop = centroidOf(bodyPrimitives, (_x, y) => y > max[1] * 0.92)
    noseVector = bodyCentroid.map((value, axis) => value - finTop[axis])
    // Measured on the ground plane only: the fin is above the centreline,
    // and reading its height as pitch would nose the whole aircraft down.
    noseVector[1] = 0
  }
  const yaw = Math.atan2(noseVector[0], noseVector[2])
  const horizontal = Math.hypot(noseVector[0], noseVector[2])
  const pitch = Math.atan2(noseVector[1], horizontal)
  // Yaw the nose onto +z, then pitch it level. Column-major: the second
  // rotation is applied after the first.
  transformAll(document, multiplyMatrices(rotationX(pitch), rotationY(-yaw)))

  // Length from the airframe alone, so a long airscrew boss does not make a
  // short aircraft. Then centred on the fuselage, nose to tail.
  const body = boundsOf(bodyPrimitives)
  const length = body.max[2] - body.min[2]
  const scale = TARGET_LENGTH / length
  const whole = boundsOf([...bodyPrimitives, ...propPrimitives])
  transformAll(document, scaleTranslate(
    [scale, scale, scale],
    [-whole.centre[0] * scale, -body.centre[1] * scale, -body.centre[2] * scale],
  ))

  // 4. One draw call per material, then the budget.
  await document.transform(join({ keepNamed: false }))
  await decimate(document, spec.budget, log)
  log(`  decimated: ${Math.round(countTriangles(document)).toLocaleString()} triangles`)

  // 5. The airscrew under its own node, at its hub.
  const scene = root.listScenes()[0]
  const propMaterialSet = new Set(propMaterials.values())
  const propMeshes = root.listMeshes().filter((mesh) =>
    mesh.listPrimitives().some((primitive) => propMaterialSet.has(primitive.getMaterial())),
  )
  const airframe = { slug: spec.slug, length: TARGET_LENGTH, span: 0, height: 0, hub: [0, 0, 0], propRadius: 0, hasProp: false, triangles: 0 }
  const measured = boundsOf(root.listMeshes().flatMap((mesh) => mesh.listPrimitives()))
  airframe.span = measured.max[0] - measured.min[0]
  airframe.height = measured.max[1] - measured.min[1]

  if (propMeshes.length > 0) {
    const propPrims = propMeshes.flatMap((mesh) => mesh.listPrimitives())
    const hubPrims = spec.hub === spec.prop ? propPrims : propPrims
    const hubBounds = boundsOf(hubPrims)
    // The hub's x/y are the spin axis; its z is the blade plane, so the
    // disc the renderer draws lands on the blades.
    const hub = [hubBounds.centre[0], hubBounds.centre[1], hubBounds.centre[2]]
    const blades = boundsOf(propPrims)
    airframe.propRadius = Math.max(
      blades.max[0] - hub[0], hub[0] - blades.min[0],
      blades.max[1] - hub[1], hub[1] - blades.min[1],
    )
    airframe.hub = hub
    airframe.hasProp = true
    for (const mesh of propMeshes) transformMesh(mesh, scaleTranslate([1, 1, 1], [-hub[0], -hub[1], -hub[2]]))
    // Detach from wherever flatten left them, then re-hang under one node.
    for (const node of root.listNodes()) {
      if (propMeshes.includes(node.getMesh())) node.dispose()
    }
    const propNode = document.createNode('propeller').setTranslation(hub)
    for (const mesh of propMeshes) propNode.addChild(document.createNode(mesh.getName()).setMesh(mesh))
    scene.addChild(propNode)
  } else {
    // A fused airscrew: the renderer builds one at the nose. The hub sits at
    // the front of the airframe on its centreline, the disc at the era's
    // usual third of the span.
    const noseZ = measured.max[2]
    const noseY = centroidOf(root.listMeshes().flatMap((mesh) => mesh.listPrimitives()), (_x, _y, z) => z > noseZ - TARGET_LENGTH * 0.06)
    airframe.hub = [0, noseY ? noseY[1] : 0, noseZ]
    airframe.propRadius = airframe.span * 0.16
  }

  // 6. Pages.
  await reduceTextures(document, { size: PAGE_SIZE, paintOver: spec.paintOver ?? null })
  await document.transform(prune(), quantize({ quantizePosition: 14, quantizeNormal: 8, quantizeTexcoord: 12 }))

  airframe.triangles = Math.round(countTriangles(document))
  const output = joinPath(outputDir, `${spec.slug}.glb`)
  const bytes = await io.writeBinary(document)
  await writeFile(output, bytes)
  log(`  wrote ${output} — ${(bytes.byteLength / 1024).toFixed(0)}KB, ${airframe.triangles} triangles, span ${airframe.span.toFixed(2)}, hub ${airframe.hub.map((v) => v.toFixed(2)).join(',')}, disc r ${airframe.propRadius.toFixed(2)}`)
  return airframe
}

// --- Terrain ----------------------------------------------------------------

async function bakeTerrain(io, sourceDir, outputDir) {
  console.log(`\n${TERRAIN.slug} — ${TERRAIN.file}`)
  const document = await io.read(joinPath(sourceDir, TERRAIN.file))
  const root = document.getRoot()
  await document.transform(resample(), dedup(), flatten())
  bakeNodeTransforms(document)

  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (TERRAIN.drop.test(primitive.getMaterial()?.getName() ?? '')) {
        primitive.dispose()
      }
    }
    if (mesh.listPrimitives().length === 0) mesh.dispose()
  }
  await document.transform(prune())

  const primitives = root.listMeshes().flatMap((mesh) => mesh.listPrimitives())
  const bounds = boundsOf(primitives)
  const span = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2])
  const relief = bounds.max[1] - bounds.min[1]
  const scaleXZ = TERRAIN.tile / span
  const scaleY = TERRAIN.relief / relief
  transformAll(document, scaleTranslate(
    [scaleXZ, scaleY, scaleXZ],
    [-bounds.centre[0] * scaleXZ, -bounds.min[1] * scaleY + TERRAIN.floor, -bounds.centre[2] * scaleXZ],
  ))
  const after = boundsOf(primitives)

  await reduceTextures(document, { size: TERRAIN.page, paintOver: null })
  await document.transform(join({ keepNamed: false }), prune(), quantize({ quantizePosition: 14 }))

  const output = joinPath(outputDir, `${TERRAIN.slug}.glb`)
  const bytes = await io.writeBinary(document)
  await writeFile(output, bytes)
  console.log(`  wrote ${output} — ${(bytes.byteLength / 1024).toFixed(0)}KB, ${Math.round(countTriangles(document))} triangles, tile ${(after.max[0] - after.min[0]).toFixed(1)} x ${(after.max[2] - after.min[2]).toFixed(1)}, y ${after.min[1].toFixed(2)}..${after.max[1].toFixed(2)}`)
  return {
    slug: TERRAIN.slug,
    width: after.max[0] - after.min[0],
    depth: after.max[2] - after.min[2],
    floor: after.min[1],
    peak: after.max[1],
  }
}

// --- Main -------------------------------------------------------------------

async function main() {
  const args = parseArguments(process.argv)
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const sourceDir = args.src ? resolve(args.src) : null
  if (!sourceDir) throw new Error('Usage: node scripts/bakePlanes.mjs --src <dir> [--only <slug>]')

  // The source files may sit one folder down each, as a download tool leaves
  // them; both layouts are walked.
  const entries = await readdir(sourceDir, { withFileTypes: true })
  const files = new Map()
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.glb')) files.set(entry.name, joinPath(sourceDir, entry.name))
    if (entry.isDirectory()) {
      for (const inner of await readdir(joinPath(sourceDir, entry.name))) {
        if (inner.endsWith('.glb')) files.set(inner, joinPath(sourceDir, entry.name, inner))
      }
    }
  }
  const locate = (file) => {
    const path = files.get(file)
    if (!path) throw new Error(`Missing source ${file} under ${sourceDir}`)
    return dirname(path)
  }

  const planesDir = resolve(root, 'public/ps1/planes')
  const theatreDir = resolve(root, 'public/ps1/theatre')
  await mkdir(planesDir, { recursive: true })
  await mkdir(theatreDir, { recursive: true })
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)

  const manifestPath = resolve(root, 'app/leon/channels/dogfight/airframes.json')
  let manifest = { airframes: [], terrain: null }
  try {
    manifest = JSON.parse(await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'))
  } catch {
    // First bake.
  }

  for (const spec of AIRFRAMES) {
    if (args.only && args.only !== spec.slug) continue
    const airframe = await bakeAirframe(io, locate(spec.file), spec, planesDir)
    manifest.airframes = [...manifest.airframes.filter((entry) => entry.slug !== spec.slug), airframe]
  }
  if (!args.only || args.only === TERRAIN.slug) {
    manifest.terrain = await bakeTerrain(io, locate(TERRAIN.file), theatreDir)
  }
  manifest.airframes.sort((a, b) => AIRFRAMES.findIndex((s) => s.slug === a.slug) - AIRFRAMES.findIndex((s) => s.slug === b.slug))
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`\nmanifest: ${manifestPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
