#!/usr/bin/env node
//
// Paints texture pages for the surfaces the source models shipped bare.
//
// Drift Yard's `Metal` — every barrier, fence and gantry on the circuit —
// is the one material left in the venue set with no texture of its own.
// Untextured it renders as one flat sheet of paint, which at PS2 fidelity
// reads as a missing asset, not as art direction. The machine this look
// imitates never shipped a bare surface either: it shipped small,
// hand-quantised tiling pages, which is exactly what this writes.
//
// The two mountain rips had the same gap and no longer take their page from
// here. A procedural page can imitate a manufactured surface — concrete is
// noise and a grid, and that is genuinely what concrete is — but it cannot
// imitate a mountainside, which is silhouette all the way down. Theirs are
// cut out of the rips' own texture sets instead; see
// scripts/makeBackdropTextures.mjs.
//
// Everything is procedural and seeded, so the same command always paints the
// same page: fractal value noise for the material's grain, panel seams on
// top of it, then the same 256-colour palettisation every other page in the
// pipeline gets.
// The pages tile, because the shader projects them across hundreds of world
// units — see uWorldUvScale in Ps1Material.
//
// Usage: node scripts/makeSurfaceTextures.mjs

import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = resolve(ROOT, 'public/ps1/textures')

/** Page size. The era's own budget for a repeating surface page. */
const SIZE = 256
const PALETTE_SIZE = 256

/** Deterministic lattice noise, wrapped so the page tiles. */
function makeNoise(seed) {
  const hash = (x, y) => {
    let h = (x * 374761393 + y * 668265263 + seed * 144665) | 0
    h = (h ^ (h >> 13)) * 1274126177
    return (((h ^ (h >> 16)) >>> 0) % 65536) / 65536
  }
  const smooth = (t) => t * t * (3 - 2 * t)
  return (x, y, period) => {
    const gx = Math.floor(x)
    const gy = Math.floor(y)
    const tx = smooth(x - gx)
    const ty = smooth(y - gy)
    const wrap = (v) => ((v % period) + period) % period
    const a = hash(wrap(gx), wrap(gy))
    const b = hash(wrap(gx + 1), wrap(gy))
    const c = hash(wrap(gx), wrap(gy + 1))
    const d = hash(wrap(gx + 1), wrap(gy + 1))
    return a + (b - a) * tx + (c + (d - c) * tx - (a + (b - a) * tx)) * ty
  }
}

/** Octaved noise in 0..1, tiling at the page edge. */
function fractal(noise, x, y, octaves, baseScale) {
  let value = 0
  let amplitude = 1
  let total = 0
  for (let octave = 0; octave < octaves; octave++) {
    const scale = baseScale * 2 ** octave
    value += noise((x / SIZE) * scale, (y / SIZE) * scale, scale) * amplitude
    total += amplitude
    amplitude *= 0.55
  }
  return value / total
}

const clamp255 = (value) => Math.max(0, Math.min(255, Math.round(value)))

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]

const mixRgb = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]

/**
 * Trackside concrete, for Drift Yard's untextured barriers and gantries.
 * Panel seams on a regular grid, pour-stain streaks, and a grime line low on
 * the page — the vocabulary every early-2000s circuit wall was painted in.
 */
function paintConcrete(pixels) {
  const noise = makeNoise(11)
  const base = hexToRgb('#d4d4d8')
  const dark = hexToRgb('#9b9ba4')
  const stain = hexToRgb('#b9b6ab')

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const grain = fractal(noise, x, y, 4, 6)
      // Vertical pour streaks: stretched noise, x-heavy.
      const streak = fractal(noise, x * 3, y * 0.3, 3, 8)
      let colour = mixRgb(base, dark, grain * 0.42)
      colour = mixRgb(colour, stain, Math.max(0, streak - 0.55) * 0.9)

      // Panel seams every 64px, one texel of shadow with a texel of
      // highlight under it — a cast join, not a drawn line.
      const seamX = x % 64
      const seamY = y % 64
      if (seamX === 0 || seamY === 0) colour = mixRgb(colour, dark, 0.75)
      if (seamX === 1 || seamY === 1) colour = mixRgb(colour, [255, 255, 255], 0.16)

      const i = (y * SIZE + x) * 4
      pixels[i] = clamp255(colour[0])
      pixels[i + 1] = clamp255(colour[1])
      pixels[i + 2] = clamp255(colour[2])
      pixels[i + 3] = 255
    }
  }
}

async function writePage(name, painter) {
  const pixels = Buffer.alloc(SIZE * SIZE * 4)
  painter(pixels)
  const path = resolve(OUT_DIR, `${name}.png`)
  await sharp(pixels, { raw: { width: SIZE, height: SIZE, channels: 4 } })
    .png({ palette: true, colours: PALETTE_SIZE, effort: 10 })
    .toFile(path)
  console.log(`wrote ${path}`)
}

await mkdir(OUT_DIR, { recursive: true })

await writePage('concrete', paintConcrete)
