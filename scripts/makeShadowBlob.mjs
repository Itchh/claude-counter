// Draws the cars' ground shadow, the way the console drew one.
//
// The pack shipped `car_shadow.png` and it is a hard binary mask: alpha is
// either 0 or 255, and across the middle of the page it is 255 everywhere.
// Under a car that renders as a black slab with a stepped edge — a hole in
// the tarmac rather than a shadow.
//
// What replaced it was a 1-bit ordered dither, on the reasoning that the
// shader writes opaque fragments and the hardware faked softness with a
// crosshatch. That is true of the machine's *cut-outs* — foliage, fences,
// signage — and untrue of its car shadows. The console had semi-transparency
// in hardware (the 50%-of-source blend mode among them), and the era's racers
// spent it on exactly this: a translucent dark patch under the car, drawn as
// two or three flat steps of opacity, tight enough that it never reads as a
// second object lying on the road. The reference screenshot is unambiguous —
// the tarmac's own texture shows straight through the shadow.
//
// So this page is banded rather than dithered: three concentric ellipses at
// three fixed opacities, hard edges between them, and nothing in between for
// the sampler to smooth. The car material blends it (see Kart.tsx), which is
// what makes low opacity mean anything at all.
//
//   node scripts/makeShadowBlob.mjs
//
// Writes public/ps1/cars/shadow-stepped.png. Committed output; this only
// needs running again if the shape or the steps change.

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { crc32 } from 'node:zlib'

const WIDTH = 64
const HEIGHT = 128

/**
 * The three steps, outermost last: how far each band reaches as a fraction of
 * the ellipse, and how opaque it is.
 *
 * Kept low deliberately. A car shadow at this scale is doing one job — gluing
 * the car to the road — and every percent of opacity past what that needs is
 * a percent of tarmac texture thrown away. The darkest band sits under the
 * sills, where a real one is darkest, and even there the road's own texture
 * reads straight through it; the faintest is barely a stain. Tested against
 * the reference at both ends: a third of these values disappears from the
 * chase camera, and twice them is the black slab this replaced.
 */
const BANDS = [
  { reach: 0.58, alpha: 0.52 },
  { reach: 0.82, alpha: 0.34 },
  { reach: 1.0, alpha: 0.18 },
]

/**
 * The car is longer than it is wide and its shadow is not a perfect ellipse —
 * it is fuller under the body and tapers past the bumpers. Raising the power
 * on the long axis squares the middle off slightly.
 */
const LENGTH_POWER = 2.6
const WIDTH_POWER = 2.0

const pixels = Buffer.alloc(WIDTH * HEIGHT * 4)

for (let y = 0; y < HEIGHT; y++) {
  for (let x = 0; x < WIDTH; x++) {
    // Normalised to the page, -1..1 on each axis.
    const nx = (x + 0.5) / WIDTH * 2 - 1
    const ny = (y + 0.5) / HEIGHT * 2 - 1
    const distance = Math.pow(
      Math.pow(Math.abs(nx), WIDTH_POWER) + Math.pow(Math.abs(ny), LENGTH_POWER),
      1 / WIDTH_POWER,
    )

    // Which band the texel falls in. No interpolation and no dither: the
    // steps are the look, and a gradient here would be sampled into a smooth
    // blob by the first mip and stop reading as a console shadow at all.
    let alpha = 0
    for (const band of BANDS) {
      if (distance <= band.reach) {
        alpha = band.alpha
        break
      }
    }

    const offset = (y * WIDTH + x) * 4
    pixels[offset] = 0
    pixels[offset + 1] = 0
    pixels[offset + 2] = 0
    pixels[offset + 3] = Math.round(alpha * 255)
  }
}

// --- PNG encode (RGBA8, one filter byte per row, no filtering) -------------
const raw = Buffer.alloc(HEIGHT * (WIDTH * 4 + 1))
for (let y = 0; y < HEIGHT; y++) {
  raw[y * (WIDTH * 4 + 1)] = 0
  pixels.copy(raw, y * (WIDTH * 4 + 1) + 1, y * WIDTH * 4, (y + 1) * WIDTH * 4)
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([length, body, checksum])
}

const header = Buffer.alloc(13)
header.writeUInt32BE(WIDTH, 0)
header.writeUInt32BE(HEIGHT, 4)
header[8] = 8 // bit depth
header[9] = 6 // colour type: RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const output = 'public/ps1/cars/shadow-stepped.png'
writeFileSync(output, png)
const steps = new Set()
for (let i = 3; i < pixels.length; i += 4) steps.add(pixels[i])
console.log(`wrote ${output} — ${WIDTH}x${HEIGHT}, alpha steps: ${[...steps].sort((a, b) => a - b).join(', ')}`)
