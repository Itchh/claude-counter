// What every bake has in common, lifted out so the fighters and the stages
// do not each carry their own copy of the same twelve functions.
//
// Nothing in here decides anything. Scale, budget, page size and which
// surface is which are the bake's own judgement; this is the matrix
// arithmetic, the decimation pass and the page reduction that the judgement
// is applied through. See bakeTrack.mjs for the long argument about why a
// downloaded model has to be cut down to fit a 270-line picture — the short
// version is that the reduction is the look, not an optimisation.

import {
  dedup, flatten, join, weld, prune, resample, transformMesh,
  simplifyPrimitive, compactPrimitive,
} from '@gltf-transform/functions'
import { MeshoptSimplifier } from 'meshoptimizer'
import sharp from 'sharp'
import { readdir } from 'node:fs/promises'
import { join as joinPath } from 'node:path'

// --- Arguments --------------------------------------------------------------

export function parseArguments(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1]
  return args
}

/**
 * Finds every .glb under `sourceDir`, one folder down as well as at the top,
 * which is how a download tool leaves them. Returns name -> full path.
 */
export async function findSources(sourceDir) {
  const files = new Map()
  const entries = await readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.glb')) files.set(entry.name, joinPath(sourceDir, entry.name))
    if (entry.isDirectory()) {
      for (const inner of await readdir(joinPath(sourceDir, entry.name))) {
        if (inner.endsWith('.glb')) files.set(inner, joinPath(sourceDir, entry.name, inner))
      }
    }
  }
  return files
}

// --- Matrices ---------------------------------------------------------------

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

export function rotationY(angle) {
  const c = Math.cos(angle), s = Math.sin(angle)
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]
}

export function scaleTranslate(scale, [tx, ty, tz]) {
  return [scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, tx, ty, tz, 1]
}

/** Column-major 4x4 multiply, matching glTF's own matrix convention. */
export function multiplyMatrices(a, b) {
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
 * to identity, cloning any mesh that several nodes share first. Every
 * measurement below asks about distance, and gets the wrong answer while a
 * scale is parked on a node three levels up.
 */
export function bakeNodeTransforms(document) {
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

/** One coordinate space: resample, dedup, flatten, then bake what is left. */
export async function flattenToWorld(document) {
  await document.transform(resample(), dedup(), flatten())
  bakeNodeTransforms(document)
}

/** Applies `matrix` to every primitive of every mesh — transforms baked already. */
export function transformAll(document, matrix) {
  for (const mesh of document.getRoot().listMeshes()) transformMesh(mesh, matrix)
}

export function allPrimitives(document) {
  return document.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives())
}

export function boundsOf(primitives) {
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

export function countTriangles(document) {
  return allPrimitives(document)
    .reduce((total, primitive) => total + (primitive.getIndices()?.getCount() ?? 0) / 3, 0)
}

export function primitiveTriangles(primitive) {
  return (primitive.getIndices()?.getCount() ?? 0) / 3
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
 * primitive by the same proportion.
 *
 * Careful edge collapse first, which respects the texture's seams; an
 * untextured primitive that still overshoots gets the sloppy pass, which
 * ignores topology and simply hits the number. A textured one is left where
 * the careful pass stopped — sloppy welds across UV seams, and a torn atlas
 * is worse than a few hundred extra triangles.
 */
export async function decimate(document, budget, log, { error = 0.6, minimum = 8 } = {}) {
  await MeshoptSimplifier.ready
  await document.transform(weld())
  const before = countTriangles(document)
  if (before <= budget) return
  const ratio = budget / before
  for (const primitive of allPrimitives(document)) {
    const count = primitiveTriangles(primitive)
    if (count < 12) continue
    const target = Math.max(minimum, Math.round(count * ratio))
    // The careful pass stops early on a dense sculpt whose atlas seams it
    // refuses to cross; asking again with a looser error gets the rest of
    // the way without ever going sloppy on a textured surface.
    let tolerance = error
    for (let attempt = 0; attempt < 4; attempt++) {
      const now = primitiveTriangles(primitive)
      if (now <= target * 1.15) break
      simplifyPrimitive(primitive, {
        simplifier: MeshoptSimplifier,
        ratio: Math.max(target / now, minimum / now),
        error: tolerance,
        lockBorder: false,
      })
      compactPrimitive(primitive)
      tolerance *= 1.8
    }
    const after = primitiveTriangles(primitive)
    if (after > target * 1.25 && !primitive.getMaterial()?.getBaseColorTexture()) {
      decimateSloppy(primitive, target)
      compactPrimitive(primitive)
    }
    log(`  ${(primitive.getMaterial()?.getName() ?? '?').slice(0, 22).padEnd(22)} ${Math.round(count).toLocaleString().padStart(8)} -> ${Math.round(primitiveTriangles(primitive)).toLocaleString().padStart(6)}`)
  }
}

// --- Textures ---------------------------------------------------------------

/**
 * One console page from one modern one: downsampled by area averaging to
 * `size` on its longer edge, then quantised to an indexed palette. The
 * hard-edged look comes from the sampler at draw time, which is where the
 * console put it — reducing by nearest here would be speckle, not pixels.
 */
export async function bakePage(image, { size, palette = 256 }) {
  const pipeline = sharp(image)
  const { width = size, height = size } = await pipeline.metadata()
  const longest = Math.max(width, height)
  const scale = Math.min(1, size / longest)
  const { data, info } = await pipeline
    .resize({
      width: Math.max(8, Math.round(width * scale)),
      height: Math.max(8, Math.round(height * scale)),
      kernel: 'lanczos3',
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png({ palette: true, colours: palette, effort: 10 })
    .toBuffer()
}

/**
 * Strips every material to its base colour page and reduces that page.
 * Normal, roughness, occlusion and emissive maps describe how light behaves
 * on a surface; the console had a colour per vertex and a fog value, and
 * the runtime shader rebuilds the material from the page alone.
 */
export async function reduceTextures(document, { size, palette = 256, sizeFor = null }) {
  const root = document.getRoot()
  for (const material of root.listMaterials()) {
    material.setNormalTexture(null)
    material.setMetallicRoughnessTexture(null)
    material.setOcclusionTexture(null)
    material.setEmissiveTexture(null)
    for (const extension of material.listExtensions()) extension.dispose()
  }
  await document.transform(prune({ propertyTypes: undefined }))
  for (const texture of root.listTextures()) {
    const pageSize = sizeFor ? sizeFor(texture) : size
    const baked = await bakePage(texture.getImage(), { size: pageSize, palette })
    texture.setImage(baked).setMimeType('image/png')
  }
}

export { join, prune, weld }
