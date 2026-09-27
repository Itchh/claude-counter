#!/usr/bin/env node
//
// Turns the downloaded bedroom diorama into the room the cabinet boots into:
// cut to the console's budget, its eighty-odd PBR pages reduced to a handful
// of palettised colour pages, and its arcade cabinet's licensed art blanked
// so the runtime can hang its own marquee and screen on it.
//
// Same argument as bakeStages: the source is 15k triangles under 38MB of
// 1024px textures, drawn through a shader that snaps vertices to a 320x240
// grid. Feeding it the dense model turns the wobble into noise and the
// download into a wait. The reduction is the look, not an optimisation.
//
// The room's two walls are the -x and -z sides; the arcade backs onto the
// open +z side. The wall mesh is really a closed box whose other faces are
// wound outward, so nothing is moved here — the runtime draws the walls
// double-sided, which closes the room and puts a wall behind the cabinet.
//
// Usage: node scripts/bakeBedroom.mjs --src <path/to/retro_bedroom_diorama.glb>

import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { quantize } from '@gltf-transform/functions'
import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname, join as joinPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseArguments, flattenToWorld, countTriangles, decimate, reduceTextures, prune,
} from './bakeShared.mjs'

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../public/ps1/room')
const OUT_FILE = joinPath(OUT_DIR, 'bedroom.glb')

/** Triangles for the whole room. */
const BUDGET = 12000
/** Longest edge of an ordinary page, in texels. */
const PAGE = 160
/** Pages that carry something readable at a glance keep more. */
const PAGE_FOR = {
  diorama_final_arcade_mat1: 256,
  diorama_final_paredes_piso_mat: 512,
  diorama_final_cuadrito_mat: 128,
  diorama_final_cama_mat: 256,
  diorama_final_escritorio_mat: 256,
  diorama_final_tv_mat1: 256,
}
/** Colours per page. Low enough to band, high enough to keep a poster. */
const PALETTE = 64

const ARCADE_MATERIAL = 'diorama_final_arcade_mat1'
/**
 * The cabinet's page, in UV space: where the licensed marquee and the
 * attract screen sit. Both are painted out to the cabinet's own black so the
 * runtime's quads have nothing showing round their edges.
 */
const ARCADE_BLANKS = [
  { name: 'marquee', u0: 0.735, v0: 0.055, u1: 0.955, v1: 0.145 },
  { name: 'screen', u0: 0.785, v0: 0.805, u1: 0.995, v1: 0.985 },
]
const CABINET_BLACK = { r: 8, g: 8, b: 10, alpha: 1 }

async function blankArcadeArt(document, log) {
  const material = document.getRoot().listMaterials().find((m) => m.getName() === ARCADE_MATERIAL)
  const texture = material?.getBaseColorTexture()
  if (!texture) throw new Error(`No base colour page on ${ARCADE_MATERIAL}`)
  const image = sharp(texture.getImage())
  const { width, height } = await image.metadata()
  const composites = ARCADE_BLANKS.map((blank) => {
    const left = Math.round(blank.u0 * width)
    const top = Math.round(blank.v0 * height)
    const w = Math.round((blank.u1 - blank.u0) * width)
    const h = Math.round((blank.v1 - blank.v0) * height)
    log(`  blank ${blank.name}: ${w}x${h} at ${left},${top}`)
    return {
      input: { create: { width: w, height: h, channels: 4, background: CABINET_BLACK } },
      left,
      top,
    }
  })
  const painted = await image.composite(composites).png().toBuffer()
  texture.setImage(painted).setMimeType('image/png')
}

async function main() {
  const args = parseArguments(process.argv)
  if (!args.src) throw new Error('Usage: node scripts/bakeBedroom.mjs --src <diorama.glb>')
  const log = (line) => console.log(line)

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const document = await io.read(resolve(args.src))
  log(`bedroom: ${Math.round(countTriangles(document)).toLocaleString()} triangles in`)

  await flattenToWorld(document)
  await blankArcadeArt(document, log)
  await decimate(document, BUDGET, log)
  await reduceTextures(document, {
    size: PAGE,
    palette: PALETTE,
    sizeFor: (texture) => {
      const owner = document
        .getRoot()
        .listMaterials()
        .find((material) => material.getBaseColorTexture() === texture)
      return PAGE_FOR[owner?.getName() ?? ''] ?? PAGE
    },
  })
  await document.transform(prune(), quantize())

  await mkdir(OUT_DIR, { recursive: true })
  const bytes = await io.writeBinary(document)
  await writeFile(OUT_FILE, bytes)
  log(`bedroom: ${Math.round(countTriangles(document)).toLocaleString()} triangles, ${(bytes.byteLength / 1024).toFixed(0)}KB -> ${OUT_FILE}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
