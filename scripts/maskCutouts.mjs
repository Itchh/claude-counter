#!/usr/bin/env node
//
// Gives a ripped circuit back the transparency its pages lost.
//
// A downloaded track's foliage is drawn the way every game's foliage is: flat
// cards carrying a leaf atlas, cut out against a background that was never
// meant to be seen. Bushido Peak ships ninety-nine pages and exactly four of
// them still carry an alpha channel — the rest were flattened onto their
// background colour somewhere between the game and the marketplace. So the
// trees arrive as slabs: a dark green rectangle with leaves painted on it,
// standing in the sky.
//
// Nothing downstream can rescue that. The renderer is told the material is
// opaque, and it is telling the truth — the transparency is not missing from
// the material, it is missing from the picture. The only place to put it back
// is the page itself, which is what this does.
//
// The heuristic is deliberately narrow, because the cost of a false positive
// is a hole in the road. A page qualifies only when its BORDER is one colour
// — a leaf atlas is always framed by its own background, a photograph of
// asphalt never is — and when that colour is a real share of the whole page
// but not most of it. Everything else is left alone.
//
// Usage:
//   node scripts/maskCutouts.mjs public/ps1/tracks/bushido-peak.glb [--dry]

import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import sharp from 'sharp'

/** Fraction of the border that must be the same colour for a key to exist. */
const BORDER_AGREEMENT = 0.45
/**
 * Per-channel distance, 0-255, within which a pixel counts as the key.
 *
 * Tight, and it has to be. A leaf atlas's background is a dark green and so
 * are the leaves' own shadows; at a generous tolerance the key swallowed most
 * of the foliage as well as the space around it.
 */
const KEY_TOLERANCE = 14
/**
 * How much of the page the flooded background must cover to be a background,
 * and how much it must not exceed before the page IS its background.
 */
const MIN_COVERAGE = 0.2
const MAX_COVERAGE = 0.88
/**
 * Fraction of a material's triangle area that must stand upright before its
 * page may be keyed.
 *
 * This is the test that separates a cut-out from a surface, and it took two
 * attempts to find. Flatness of the background does not do it: this rip's
 * foliage sits on a *noisy* olive while its road photographs are smooth, so
 * measuring the key colour's grain kept the tarmac and threw away the trees —
 * precisely backwards. What a cut-out actually is, is a card standing up: a
 * leaf atlas, a fence, a sign. Roads, pavements and grass banks lie down. The
 * geometry knows which it is, and the geometry cannot be fooled by paint.
 */
const MIN_UPRIGHT_AREA = 0.55
/** |normal.y| below which a triangle counts as standing up. */
const UPRIGHT_NORMAL_Y = 0.4

/** Alpha cutoff written onto the materials that gain a mask. */
const ALPHA_CUTOFF = 0.5

const key5 = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)

/**
 * Finds the page's background, if it has one, and returns the mask that
 * removes it.
 *
 * The background is found by flooding inwards from the edges rather than by
 * matching the key colour everywhere, which is the whole reason this is safe
 * to run over a hundred anonymous pages. A leaf's own shadow is the same dark
 * green as the space around the tree; matching on colour alone punched holes
 * straight through the canopy, while a flood stops at the first leaf it meets
 * and leaves everything enclosed by the artwork alone. It is a magic wand,
 * and a magic wand is what a person would reach for here.
 */
function findBackground(data, width, height, channels) {
  // Already transparent somewhere? Then the page kept its mask and is not ours.
  if (channels === 4) {
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 250) return null
    }
  }

  const border = new Map()
  let borderCount = 0
  const note = (x, y) => {
    const i = (y * width + x) * channels
    const k = key5(data[i], data[i + 1], data[i + 2])
    border.set(k, (border.get(k) ?? 0) + 1)
    borderCount += 1
  }
  for (let x = 0; x < width; x += 1) {
    note(x, 0)
    note(x, height - 1)
  }
  for (let y = 1; y < height - 1; y += 1) {
    note(0, y)
    note(width - 1, y)
  }

  let bestKey = -1
  let bestCount = 0
  for (const [k, count] of border) {
    if (count > bestCount) {
      bestKey = k
      bestCount = count
    }
  }
  if (bestKey < 0 || bestCount / borderCount < BORDER_AGREEMENT) return null

  const keyR = ((bestKey >> 10) & 31) << 3
  const keyG = ((bestKey >> 5) & 31) << 3
  const keyB = (bestKey & 31) << 3

  const isKey = (index) => {
    const p = index * channels
    return (
      Math.abs(data[p] - keyR) <= KEY_TOLERANCE &&
      Math.abs(data[p + 1] - keyG) <= KEY_TOLERANCE &&
      Math.abs(data[p + 2] - keyB) <= KEY_TOLERANCE
    )
  }

  const mask = new Uint8Array(width * height)
  const stack = []
  const push = (index) => {
    if (mask[index] || !isKey(index)) return
    mask[index] = 1
    stack.push(index)
  }
  for (let x = 0; x < width; x += 1) {
    push(x)
    push((height - 1) * width + x)
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width)
    push(y * width + width - 1)
  }

  let filled = stack.length
  while (stack.length > 0) {
    const index = stack.pop()
    const x = index % width
    const y = (index / width) | 0
    if (x > 0) { const j = index - 1; if (!mask[j] && isKey(j)) { mask[j] = 1; filled += 1; stack.push(j) } }
    if (x < width - 1) { const j = index + 1; if (!mask[j] && isKey(j)) { mask[j] = 1; filled += 1; stack.push(j) } }
    if (y > 0) { const j = index - width; if (!mask[j] && isKey(j)) { mask[j] = 1; filled += 1; stack.push(j) } }
    if (y < height - 1) { const j = index + width; if (!mask[j] && isKey(j)) { mask[j] = 1; filled += 1; stack.push(j) } }
  }

  const coverage = filled / (width * height)
  if (coverage < MIN_COVERAGE || coverage > MAX_COVERAGE) return null

  return { mask, coverage, colour: [keyR, keyG, keyB] }
}

/**
 * How much of each texture's geometry stands upright, by area.
 *
 * Measured per texture rather than per material because that is the thing
 * being rewritten: two materials sharing a leaf atlas should agree about
 * whether it is a cut-out.
 */
function measureUprightness(document) {
  const totals = new Map()

  // Walked from the nodes, not from the meshes, so each primitive is judged
  // in world space. Reading POSITION straight off the mesh measures the
  // normals in whatever local frame the exporter left — and a glTF ripped
  // from a Z-up tool carries that rotation on its root node, which would make
  // every road test as "upright" and hand the whole circuit to the keyer.
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    const matrix = node.getWorldMatrix()
    const toWorld = (p) => [
      matrix[0] * p[0] + matrix[4] * p[1] + matrix[8] * p[2] + matrix[12],
      matrix[1] * p[0] + matrix[5] * p[1] + matrix[9] * p[2] + matrix[13],
      matrix[2] * p[0] + matrix[6] * p[1] + matrix[10] * p[2] + matrix[14],
    ]
    for (const primitive of mesh.listPrimitives()) {
      const material = primitive.getMaterial()
      const texture = material?.getBaseColorTexture()
      if (!texture) continue

      const position = primitive.getAttribute('POSITION')
      const indices = primitive.getIndices()
      if (!position) continue
      // Triangles only, and whole ones: a count that is not a multiple of
      // three would otherwise read past the end of the accessor.
      const count = Math.floor((indices ? indices.getCount() : position.getCount()) / 3) * 3

      let upright = 0
      let total = 0
      const a = [0, 0, 0]
      const b = [0, 0, 0]
      const c = [0, 0, 0]
      for (let i = 0; i < count; i += 3) {
        position.getElement(indices ? indices.getScalar(i) : i, a)
        position.getElement(indices ? indices.getScalar(i + 1) : i + 1, b)
        position.getElement(indices ? indices.getScalar(i + 2) : i + 2, c)
        const wa = toWorld(a), wb = toWorld(b), wc = toWorld(c)
        const ux = wb[0] - wa[0], uy = wb[1] - wa[1], uz = wb[2] - wa[2]
        const wx = wc[0] - wa[0], wy = wc[1] - wa[1], wz = wc[2] - wa[2]
        const nx = uy * wz - uz * wy
        const ny = uz * wx - ux * wz
        const nz = ux * wy - uy * wx
        // The cross product's length is twice the triangle's area, so this
        // weights by area for free — one big road quad must not be outvoted
        // by a thousand slivers of fence.
        const area = Math.hypot(nx, ny, nz)
        if (area === 0) continue
        total += area
        if (Math.abs(ny) / area < UPRIGHT_NORMAL_Y) upright += area
      }

      const running = totals.get(texture) ?? { upright: 0, total: 0 }
      running.upright += upright
      running.total += total
      totals.set(texture, running)
    }
  }

  const fractions = new Map()
  for (const [texture, { upright, total }] of totals) {
    fractions.set(texture, total > 0 ? upright / total : 0)
  }
  return fractions
}

async function main() {
  const [path, ...flags] = process.argv.slice(2)
  if (!path) throw new Error('usage: node scripts/maskCutouts.mjs <track.glb> [--dry]')
  const dry = flags.includes('--dry')

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const document = await io.read(path)
  const textures = document.getRoot().listTextures()
  const materials = document.getRoot().listMaterials()

  const uprightByTexture = measureUprightness(document)

  let keyed = 0
  for (const [index, texture] of textures.entries()) {
    const image = texture.getImage()
    if (!image) continue

    // Only cards. See MIN_UPRIGHT_AREA — a page carried by geometry that
    // lies down is a road, a pavement or a bank, and the background it seems
    // to have is the surface itself.
    const upright = uprightByTexture.get(texture) ?? 0
    if (upright < MIN_UPRIGHT_AREA) continue

    const { data, info } = await sharp(Buffer.from(image))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })

    const found = findBackground(data, info.width, info.height, info.channels)
    if (!found) continue
    keyed += 1
    console.log(
      `  page ${index} (${info.width}x${info.height}) keyed on ` +
        `rgb(${found.colour.join(',')}) — ${Math.round(found.coverage * 100)}% of the page, ` +
        `${Math.round(upright * 100)}% upright`,
    )
    if (dry) continue

    // The key is cut, not feathered. A soft edge would need the renderer to
    // blend, and a cut-out is what the era's hardware did — the shader
    // discards below the cutoff and everything else stays exactly as painted.
    for (let i = 0; i < info.width * info.height; i += 1) {
      if (found.mask[i]) data[i * info.channels + 3] = 0
    }

    const rewritten = await sharp(data, {
      raw: { width: info.width, height: info.height, channels: info.channels },
    })
      .png({ palette: true, colours: 256, effort: 10 })
      .toBuffer()

    texture.setImage(rewritten).setMimeType('image/png')

    // The material has to say so too, or the renderer has no reason to look
    // at the alpha it now has.
    for (const material of materials) {
      if (material.getBaseColorTexture() === texture && material.getAlphaMode() === 'OPAQUE') {
        material.setAlphaMode('MASK').setAlphaCutoff(ALPHA_CUTOFF)
      }
    }
  }

  console.log(`${keyed} of ${textures.length} pages carried a background colour`)
  if (!dry) {
    await io.write(path, document)
    console.log(`wrote ${path}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
