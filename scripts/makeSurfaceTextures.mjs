#!/usr/bin/env node
//
// Paints texture pages for the surfaces the source models shipped bare.
//
// Three materials in the venue set have no texture at all: Drift Yard's
// `Metal` (every barrier, fence and gantry on the circuit) and both rips'
// `Merged_materials` (the backdrop mountains). Untextured they render as one
// flat sheet of paint — which at PS2 fidelity reads as a missing asset, not
// as art direction. The machine this look imitates never shipped a bare
// surface either: it shipped small, hand-quantised tiling pages, which is
// exactly what this writes.
//
// Everything is procedural and seeded, so the same command always paints the
// same pages: fractal value noise for the material's grain, a few deliberate
// features on top (panel seams in the concrete, strata in the rock), then
// the same 256-colour palettisation every other page in the pipeline gets.
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

/**
 * A rock page: banded strata under fractal grain, with crevice shadows where
 * the noise pinches. Parameterised by palette so one painter serves both
 * mountains — Lone Peak's cold alpine face and Bushido's warm sandstone.
 */
function paintRock(pixels, { seed, light, mid, dark, accent, accentAmount }) {
  const noise = makeNoise(seed)
  const lightRgb = hexToRgb(light)
  const midRgb = hexToRgb(mid)
  const darkRgb = hexToRgb(dark)
  const accentRgb = hexToRgb(accent)

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const grain = fractal(noise, x, y, 5, 4)
      // Strata: horizontal bands warped by the grain, the thing that makes a
      // cliff read as geology rather than static.
      const strata = Math.sin(((y / SIZE) * 9 + grain * 2.2) * Math.PI * 2) * 0.5 + 0.5
      // Crevices: the dark seams where the fine noise pinches low.
      const fine = fractal(noise, x + 128, y + 64, 4, 12)

      let colour = mixRgb(midRgb, lightRgb, strata * 0.55)
      colour = mixRgb(colour, darkRgb, grain * 0.5)
      if (fine < 0.34) colour = mixRgb(colour, darkRgb, 0.65)
      // The accent — scree on the alpine face, sun-bleached ledges on the
      // warm one — sits on the light side of the coarse noise only.
      if (grain > 0.62) colour = mixRgb(colour, accentRgb, accentAmount)

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
await writePage('alpine-rock', (pixels) =>
  paintRock(pixels, {
    seed: 23,
    light: '#c3d0de',
    mid: '#8fa2b8',
    dark: '#5d6c80',
    accent: '#e9eff5',
    accentAmount: 0.5,
  }),
)
await writePage('warm-rock', (pixels) =>
  paintRock(pixels, {
    seed: 37,
    light: '#cfa87c',
    mid: '#a67c55',
    dark: '#6e5138',
    accent: '#e3c99b',
    accentAmount: 0.42,
  }),
)
