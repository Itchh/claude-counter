// The horizon band behind the title flag: a low-resolution painted cloud
// strip, upscaled with nearest sampling. The console had no volumetrics and no
// sky dome — it had one bitmap, drawn small and stretched, and the chunky
// pixels at the horizon are the honest signature of that.

const BAND_WIDTH = 256
const BAND_HEIGHT = 96
const OCTAVES = 4
const CLOUD_THRESHOLD = 0.45

function seeded(seed: number): () => number {
  let state = seed >>> 0
  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0xffffffff
  }
}

/** Value noise on an integer lattice, smoothed and tiled horizontally. */
function makeLattice(size: number, random: () => number): readonly number[] {
  return Array.from({ length: size * size }, () => random())
}

function sampleLattice(
  lattice: readonly number[],
  size: number,
  x: number,
  y: number,
): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const wrap = (value: number): number => ((value % size) + size) % size
  const at = (ix: number, iy: number): number => lattice[wrap(iy) * size + wrap(ix)]
  const top = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx
  const bottom = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx
  return top * (1 - sy) + bottom * sy
}

/**
 * Bakes the cloud strip once and hands back a data URL, so it can be dropped
 * straight into a CSS background without a network request.
 */
export function createCloudBandDataUrl(): string {
  const canvas = document.createElement('canvas')
  canvas.width = BAND_WIDTH
  canvas.height = BAND_HEIGHT
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('Title sky: 2D context unavailable')

  const lattice = makeLattice(64, seeded(0xc10d))
  const image = ctx.createImageData(BAND_WIDTH, BAND_HEIGHT)

  for (let y = 0; y < BAND_HEIGHT; y += 1) {
    for (let x = 0; x < BAND_WIDTH; x += 1) {
      let amplitude = 0.5
      let frequency = 1 / 24
      let value = 0
      for (let octave = 0; octave < OCTAVES; octave += 1) {
        value += sampleLattice(lattice, 64, x * frequency, y * frequency) * amplitude
        amplitude *= 0.5
        frequency *= 2.1
      }

      // Clouds gather at the bottom of the band and thin towards the zenith,
      // which is what sells a flat strip as distance.
      const height = y / BAND_HEIGHT
      const density = value * (0.35 + height * 1.15) - CLOUD_THRESHOLD
      const alpha = Math.max(0, Math.min(1, density * 3.4))
      // Quantise to five steps: banding, on purpose.
      const stepped = Math.round(alpha * 4) / 4
      const shade = 176 + Math.round(stepped * 74)
      const index = (y * BAND_WIDTH + x) * 4
      image.data[index] = shade
      image.data[index + 1] = shade + 4
      image.data[index + 2] = 255
      image.data[index + 3] = Math.round(stepped * 255)
    }
  }

  ctx.putImageData(image, 0, 0)
  return canvas.toDataURL('image/png')
}
