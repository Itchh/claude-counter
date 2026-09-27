#!/usr/bin/env node
//
// Turns a downloaded skybox — a cube with one cross-laid cubemap on it —
// into the dogfight's sky: the cube normalised to a unit half-extent so the
// runtime can scale it to whatever the camera's far plane allows, and its
// page cut to a handful of texels a face and a few dozen colours, which is
// what a console's sky ever was. The runtime hangs it on the camera and
// draws it first, unlit and unfogged, so the fog and the ground meet at
// whatever colour this page's horizon band carries — printed at the end so
// theatre.ts can be told.
//
// Usage: node scripts/bakeSkybox.mjs --src <path/to/skybox.glb>

import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname, join as joinPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArguments, flattenToWorld, transformAll, scaleTranslate, allPrimitives, boundsOf, reduceTextures } from './bakeShared.mjs'

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public/ps1/theatre')
const OUT_FILE = joinPath(OUT_DIR, 'skydays.glb')

/** Longest edge of the whole cross, in texels: four faces across. */
const PAGE = 512
/** Colours on the page. A sky bands; that is the point. */
const PALETTE = 48

async function main() {
  const args = parseArguments(process.argv)
  if (!args.src) throw new Error('Usage: node scripts/bakeSkybox.mjs --src <skybox.glb>')
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const document = await io.read(resolve(args.src))

  // The source lights its sky as an emissive page over a black base. The
  // runtime shader reads base colour only, so the page moves across before
  // the reducer strips every emissive map.
  for (const material of document.getRoot().listMaterials()) {
    const page = material.getEmissiveTexture()
    if (page && !material.getBaseColorTexture()) material.setBaseColorTexture(page)
    material.setBaseColorFactor([1, 1, 1, 1])
  }

  await flattenToWorld(document)
  const bounds = boundsOf(allPrimitives(document))
  const halfExtent = Math.max(...bounds.max.map((value, axis) => (value - bounds.min[axis]) / 2))
  const unit = 1 / halfExtent
  transformAll(document, scaleTranslate([unit, unit, unit], bounds.centre.map((value) => -value * unit)))
  const after = boundsOf(allPrimitives(document))
  console.log(`skybox: half-extents ${after.max.map((value, axis) => ((value - after.min[axis]) / 2).toFixed(3)).join(' x ')}`)

  await reduceTextures(document, { size: PAGE, palette: PALETTE })

  // The horizon: the seam between the walls' lower band and their sky. The
  // cross keeps its walls in the middle row, rotated so the horizon runs
  // vertically through each; a column of the +Z wall read at its centre
  // gives the band the fog should meet.
  const texture = document.getRoot().listTextures()[0]
  const { data, info } = await sharp(texture.getImage()).raw().toBuffer({ resolveWithObject: true })
  const sample = (u, v) => {
    const x = Math.round(u * (info.width - 1)), y = Math.round(v * (info.height - 1))
    const o = (y * info.width + x) * info.channels
    return `#${[data[o], data[o + 1], data[o + 2]].map((c) => c.toString(16).padStart(2, '0')).join('')}`
  }
  console.log(`  zenith ${sample(0.625, 0.5)}  horizon ${sample(0.375, 0.5)}  nadir ${sample(0.125, 0.5)}`)

  await mkdir(OUT_DIR, { recursive: true })
  const bytes = await io.writeBinary(document)
  await writeFile(OUT_FILE, bytes)
  console.log(`skybox: ${(bytes.byteLength / 1024).toFixed(0)}KB -> ${OUT_FILE}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
