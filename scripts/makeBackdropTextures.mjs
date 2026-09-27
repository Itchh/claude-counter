#!/usr/bin/env node
//
// Cuts the backdrop pages out of the rips themselves.
//
// Both mountain rips ship exactly one material with no texture at all —
// `Merged_materials`, the chunk that carries the distant mountains *and*
// long stretches of the near valley floor. It is a quarter of every wide
// shot on those circuits. makeSurfaceTextures.mjs painted a procedural rock
// page for it, and that page was the wrong answer twice over: fractal noise
// has no silhouette, so up close it reads as a flat grey sheet with smears
// in it rather than as ground, and the invented palette agreed with nothing
// else on the circuit.
//
// The right page was in the file the whole time. A rip carries ninety-nine
// texture pages and several of them are the game's own mountainside — rock
// with conifer on it, moss on stone — authored by the people who authored
// the mountain the backdrop is a continuation of. This lifts one of those
// out of the GLB and mirror-tiles it into a page that repeats without a
// seam, because a chunk with no UVs is world-projected and will tile across
// hundreds of units (see uWorldUvScale in Ps1Material).
//
// Mirror-tiling rather than a clever seam-heal: it is exact, and the
// four-fold symmetry it leaves is invisible at the scale this projects at.
//
// Usage: node scripts/makeBackdropTextures.mjs

import sharp from 'sharp'
import { readFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = resolve(ROOT, 'public/ps1/textures')
const TRACK_DIR = resolve(ROOT, 'public/ps1/tracks')

/** Page size, and the era's own budget for a repeating surface page. */
const SIZE = 256
const PALETTE_SIZE = 256

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

/** The glTF JSON and binary payload of a .glb, without a full loader. */
async function readGlb(path) {
  const file = await readFile(path)
  if (file.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${path}: not a glb`)
  let offset = 12
  let json = null
  let binary = null
  while (offset < file.length) {
    const length = file.readUInt32LE(offset)
    const type = file.readUInt32LE(offset + 4)
    const chunk = file.subarray(offset + 8, offset + 8 + length)
    if (type === CHUNK_JSON) json = JSON.parse(chunk.toString('utf8'))
    if (type === CHUNK_BIN) binary = chunk
    offset += 8 + length
  }
  if (!json || !binary) throw new Error(`${path}: missing chunk`)
  return { json, binary }
}

/** One embedded image, as the encoded PNG bytes the rip stored. */
function imageBytes({ json, binary }, index) {
  const image = json.images?.[index]
  if (!image) throw new Error(`no image ${index}`)
  const view = json.bufferViews[image.bufferView]
  const start = view.byteOffset ?? 0
  return binary.subarray(start, start + view.byteLength)
}

/**
 * A seamless page built from a source that does not tile: one quadrant and
 * its three reflections.
 */
async function mirrorTile(bytes) {
  const half = SIZE / 2
  const quadrant = await sharp(bytes).resize(half, half, { fit: 'fill' }).removeAlpha().toBuffer()
  const flipped = await sharp(quadrant).flop().toBuffer()
  return sharp({ create: { width: SIZE, height: SIZE, channels: 3, background: '#000000' } })
    .composite([
      { input: quadrant, left: 0, top: 0 },
      { input: flipped, left: half, top: 0 },
      { input: await sharp(quadrant).flip().toBuffer(), left: 0, top: half },
      { input: await sharp(flipped).flip().toBuffer(), left: half, top: half },
    ])
    .png({ palette: true, colours: PALETTE_SIZE, effort: 10 })
    .toBuffer()
}

/**
 * Which page of which rip stands in for that rip's bare backdrop chunk.
 *
 * Chosen by eye off a contact sheet of all ninety-nine: in both cases the
 * one page that is a whole mountainside rather than a detail of something
 * built on it.
 */
const BACKDROPS = [
  // Grey granite with dark conifer growing out of it — Lone Peak's own
  // valley walls, and the material the backdrop range is made of.
  { track: 'lone-peak', image: 1, out: 'alpine-backdrop' },
  // Moss over wet stone, the green-grey of this circuit's forested slopes.
  // Chosen over the rip's other rock page, which carries a moss band across
  // its middle and tiled into stripes across the whole valley.
  { track: 'bushido-peak', image: 9, out: 'bushido-backdrop' },
]

await mkdir(OUT_DIR, { recursive: true })

for (const { track, image, out } of BACKDROPS) {
  const glb = await readGlb(resolve(TRACK_DIR, `${track}.glb`))
  const page = await mirrorTile(imageBytes(glb, image))
  const path = resolve(OUT_DIR, `${out}.png`)
  await sharp(page).toFile(path)
  console.log(`wrote ${path} (from ${track} image ${image})`)
}
