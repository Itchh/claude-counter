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
const KEY_TOLERANCE = 22
/**
 * Per-channel distance within which border texels are counted as one
 * background. Wider than the key itself: this only decides whether a page
 * HAS a background, and the dither spreads a flat colour further than the
 * flood should follow.
 */
const CLUSTER_TOLERANCE = 30
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

/** Degrees of hue either side of the background's, on a named page. */
const HUE_TOLERANCE = 18
/** Below this saturation a texel is grey or black, never background. */
const MIN_KEY_SATURATION = 0.35

function toHsv(r, g, b) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let h = 0
  if (delta > 0) {
    if (max === r) h = 60 * (((g - b) / delta) % 6)
    else if (max === g) h = 60 * ((b - r) / delta + 2)
    else h = 60 * ((r - g) / delta + 4)
    if (h < 0) h += 360
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max / 255 }
}

/**
 * Red as a share of green, at or above which a texel is a leaf, not backdrop.
 * Measured off Bushido Peak's bamboo pages: the backdrop runs 30,57,1 to
 * 76,118,4 (red at most six tenths of green); the leaves run 104,120,25 to
 * 169,167,27 (red near green). Red's share is the whole separation; blue
 * is only there to keep a grey out.
 */
const GREENKEY_RED_SHARE = 0.66
/** Blue as a share of green above which a texel is a leaf or grey-green, not chroma backdrop. */
const GREENKEY_BLUE_SHARE = 0.35
/** Green below which nothing is bright enough to be the backdrop. */
const GREENKEY_MIN_GREEN = 40

function findChromaGreen(data, width, height, channels) {
  const mask = new Uint8Array(width * height)
  let filled = 0
  for (let i = 0; i < width * height; i += 1) {
    const p = i * channels
    const g = data[p + 1]
    if (g >= GREENKEY_MIN_GREEN && data[p] < g * GREENKEY_RED_SHARE && data[p + 2] < g * GREENKEY_BLUE_SHARE) {
      mask[i] = 1
      filled += 1
    }
  }
  const coverage = filled / (width * height)
  if (coverage < MIN_COVERAGE || coverage > MAX_COVERAGE) {
    console.log(`    chroma green covered ${Math.round(coverage * 100)}% of the page — outside ${MIN_COVERAGE * 100}–${MAX_COVERAGE * 100}%`)
    return null
  }
  return { mask, coverage, colour: [0, 255, 0] }
}

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
function findBackground(data, width, height, channels, forced) {
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
  if (bestKey < 0) return null

  // The bake's palette step dithers, so a background that was one flat green
  // in the rip arrives here as a handful of neighbouring greens scattered
  // texel by texel — and no single 5-bit bucket holds more than a few percent
  // of the border. The agreement is therefore measured as a cluster: every
  // border texel within CLUSTER_TOLERANCE of the commonest bucket counts,
  // and the key colour is their mean rather than the bucket's centre.
  // Which bucket seeds the cluster matters on a dithered page: the commonest
  // single bucket can be a dark fleck of the artwork while the background's
  // greens are spread thin across a dozen neighbours. So every bucket the
  // border holds is tried as a seed and the widest cluster wins.
  const borderPixels = []
  for (let x = 0; x < width; x += 1) {
    borderPixels.push((0 * width + x) * channels, ((height - 1) * width + x) * channels)
  }
  for (let y = 1; y < height - 1; y += 1) {
    borderPixels.push((y * width) * channels, (y * width + width - 1) * channels)
  }
  const clusterAround = (r, g, b) => {
    let sumR = 0
    let sumG = 0
    let sumB = 0
    let count = 0
    for (const i of borderPixels) {
      if (
        Math.abs(data[i] - r) <= CLUSTER_TOLERANCE &&
        Math.abs(data[i + 1] - g) <= CLUSTER_TOLERANCE &&
        Math.abs(data[i + 2] - b) <= CLUSTER_TOLERANCE
      ) {
        sumR += data[i]
        sumG += data[i + 1]
        sumB += data[i + 2]
        count += 1
      }
    }
    return { count, sumR, sumG, sumB }
  }
  let seedR = ((bestKey >> 10) & 31) << 3
  let seedG = ((bestKey >> 5) & 31) << 3
  let seedB = (bestKey & 31) << 3
  let best = clusterAround(seedR, seedG, seedB)
  if (forced) {
    for (const [k] of [...border.entries()].sort((a, b) => b[1] - a[1]).slice(0, 48)) {
      const r = ((k >> 10) & 31) << 3
      const g = ((k >> 5) & 31) << 3
      const bl = (k & 31) << 3
      const candidate = clusterAround(r, g, bl)
      if (candidate.count > best.count) {
        best = candidate
        seedR = r
        seedG = g
        seedB = bl
      }
    }
  }
  const { count: clustered, sumR, sumG, sumB } = best
  // Unforced, the agreement is the strict one — one 5-bit bucket has to hold
  // the border — because on a dithered page the cluster test also passes
  // plaster walls and shop fronts, and a hole in a wall is worse than a slab
  // in a tree. Named pages skip the vote: a person has looked at them.
  const agreement = forced ? clustered / borderCount : bestCount / borderCount
  if (agreement < BORDER_AGREEMENT) {
    if (forced) console.log(`    border agreement ${Math.round(agreement * 100)}% around rgb(${seedR},${seedG},${seedB}) — below ${BORDER_AGREEMENT * 100}%`)
    return null
  }

  const keyR = Math.round(sumR / clustered)
  const keyG = Math.round(sumG / clustered)
  const keyB = Math.round(sumB / clustered)

  // Named pages key on hue rather than on colour. A rip's foliage backdrop
  // is often a vignette — the same green, darker towards the corners — and a
  // flood measured by colour distance stops a few texels in from the edge.
  // Hue survives the vignette; what changes is only brightness. Saturation
  // is checked too, so a grey fleck of bark or a black shadow inside the
  // canopy never reads as background.
  const seedHsv = toHsv(keyR, keyG, keyB)
  const hueKeyed = forced && seedHsv.s >= MIN_KEY_SATURATION
  const isKey = (index) => {
    const p = index * channels
    if (hueKeyed) {
      const hsv = toHsv(data[p], data[p + 1], data[p + 2])
      const hueGap = Math.min(Math.abs(hsv.h - seedHsv.h), 360 - Math.abs(hsv.h - seedHsv.h))
      return hsv.s >= MIN_KEY_SATURATION && hueGap <= HUE_TOLERANCE
    }
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
  if (coverage < MIN_COVERAGE || coverage > MAX_COVERAGE) {
    if (forced) console.log(`    flood covered ${Math.round(coverage * 100)}% of the page — outside ${MIN_COVERAGE * 100}–${MAX_COVERAGE * 100}%`)
    return null
  }

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
  if (!path) throw new Error('usage: node scripts/maskCutouts.mjs <track.glb> [--dry] [--only=material,material]')
  const dry = flags.includes('--dry')
  // `--only=a,b,c` names the materials whose pages are to be keyed, and
  // nothing else is touched. The auto vote stays for a fresh rip; this is
  // for the pages it cannot see through the dither, chosen off a contact
  // sheet by eye.
  const onlyFlag = flags.find((flag) => flag.startsWith('--only='))
  const only = onlyFlag ? new Set(onlyFlag.slice('--only='.length).split(',')) : null
  // `--greenkey=a,b` is for the one kind of page no flood can read: leaves
  // painted over a backdrop of the same hue. What separates them is not hue
  // but purity — the backdrop is a chroma green with almost no red in it,
  // the leaves are yellow-green with plenty — so every texel whose red is
  // under GREENKEY_RED_SHARE of its green is cut, flood or no flood.
  const greenFlag = flags.find((flag) => flag.startsWith('--greenkey='))
  const greenkey = greenFlag ? new Set(greenFlag.slice('--greenkey='.length).split(',')) : new Set()

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
    const owners = materials.filter((material) => material.getBaseColorTexture() === texture).map((material) => material.getName())
    const forced = only !== null && owners.some((name) => only.has(name))
    const greenKeyed = owners.some((name) => greenkey.has(name))
    if (only !== null && !forced && !greenKeyed) continue
    if (greenkey.size > 0 && only === null && !greenKeyed) continue
    if (!forced && !greenKeyed && upright < MIN_UPRIGHT_AREA) continue

    const { data, info } = await sharp(Buffer.from(image))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })

    const found = greenKeyed
      ? findChromaGreen(data, info.width, info.height, info.channels)
      : findBackground(data, info.width, info.height, info.channels, forced)
    if (!found && forced) console.log(`  page ${index} (${owners.join(', ')}) named but no background found`)
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
