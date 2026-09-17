import * as THREE from 'three'
import { RACE_TITLE, type TitleSpec } from './titleSpecs'

// A title flag is one baked bitmap, exactly as the era did it: a printed
// field with the wordmark painted straight onto the cloth, so the logo warps
// with the ripple instead of floating in front of it as a separate sprite.
//
// The baker is generic over a TitleSpec because each game gets its own flag,
// and they are not one template recoloured — the field painters differ, the
// marks thrown over them differ, and only the four airbrush passes on the
// letterform are shared.

const TEXTURE_WIDTH = 1024
const TEXTURE_HEIGHT = 768
const CHECKER_COLUMNS = 10
const CHECKER_ROWS = 8
const HAZARD_BAND = 96
const CLOUD_BANDS = 7
const GRAIN_BLOCKS = 5200
const WORDMARK_CENTRE_Y = 330

/** Deterministic value noise, so the cloth grains identically on every load. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0xffffffff
  }
}

/**
 * Cloth grain. 15-bit colour could not hold a smooth gradient, so period
 * artists dithered — scatter low-alpha blocks rather than blur.
 */
function paintGrain(ctx: CanvasRenderingContext2D, seed: number): void {
  const random = seeded(seed)
  for (let i = 0; i < GRAIN_BLOCKS; i += 1) {
    const x = Math.floor(random() * TEXTURE_WIDTH)
    const y = Math.floor(random() * TEXTURE_HEIGHT)
    ctx.fillStyle = random() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)'
    ctx.fillRect(x, y, 4, 4)
  }
}

/** The starting grid: a flat checker, the way a race flag is sewn. */
function paintCheckerField(ctx: CanvasRenderingContext2D, spec: TitleSpec): void {
  const cellWidth = TEXTURE_WIDTH / CHECKER_COLUMNS
  const cellHeight = TEXTURE_HEIGHT / CHECKER_ROWS

  for (let row = 0; row < CHECKER_ROWS; row += 1) {
    for (let column = 0; column < CHECKER_COLUMNS; column += 1) {
      ctx.fillStyle = (row + column) % 2 === 0 ? spec.fieldLight : spec.fieldDark
      ctx.fillRect(column * cellWidth, row * cellHeight, cellWidth + 1, cellHeight + 1)
    }
  }
}

/**
 * The ring apron: heavy diagonal hazard stripes. Drawn as a rotated band fill
 * clipped to the cloth, so the diagonal runs true rather than stepping.
 */
function paintHazardField(ctx: CanvasRenderingContext2D, spec: TitleSpec): void {
  ctx.fillStyle = spec.fieldDark
  ctx.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT)

  ctx.save()
  ctx.translate(TEXTURE_WIDTH / 2, TEXTURE_HEIGHT / 2)
  ctx.rotate(-Math.PI / 4)
  ctx.fillStyle = spec.fieldLight
  // Overshoot the diagonal so the rotated bands still cover the corners.
  const reach = TEXTURE_WIDTH + TEXTURE_HEIGHT
  for (let offset = -reach; offset < reach; offset += HAZARD_BAND * 2) {
    ctx.fillRect(offset, -reach / 2, HAZARD_BAND, reach)
  }
  ctx.restore()

  // Scuffed canvas: the apron has been fought on.
  const random = seeded(0xfa11)
  for (let i = 0; i < 260; i += 1) {
    const x = random() * TEXTURE_WIDTH
    const y = random() * TEXTURE_HEIGHT
    ctx.fillStyle = 'rgba(0,0,0,0.16)'
    ctx.fillRect(x, y, 18 + random() * 40, 5 + random() * 8)
  }
}

/**
 * A painted sky rather than a printed field: banded cloud, dithered at every
 * seam because the hardware could not hold the gradient between them.
 */
function paintSkyField(ctx: CanvasRenderingContext2D, spec: TitleSpec): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, TEXTURE_HEIGHT)
  gradient.addColorStop(0, spec.fieldDark)
  gradient.addColorStop(1, spec.fieldLight)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, TEXTURE_WIDTH, TEXTURE_HEIGHT)

  const random = seeded(0xc10d)
  for (let band = 0; band < CLOUD_BANDS; band += 1) {
    const y = 60 + random() * (TEXTURE_HEIGHT - 160)
    const height = 26 + random() * 54
    const width = 180 + random() * 420
    const x = random() * TEXTURE_WIDTH - width / 2
    ctx.fillStyle = `rgba(255,255,255,${(0.10 + random() * 0.16).toFixed(3)})`
    // Blocked, not blurred — a cloud on this hardware was a stack of runs.
    const runs = 5
    for (let run = 0; run < runs; run += 1) {
      const inset = (run / runs) * width * 0.22
      ctx.fillRect(x + inset, y + (run * height) / runs, width - inset * 2, height / runs + 1)
    }
  }
}

/** Paint thrown across the grid — the racer's signature. */
function paintSplashes(ctx: CanvasRenderingContext2D, spec: TitleSpec): void {
  const random = seeded(0xbeef)
  // Clustered along the top edge of the wordmark and dripping past it, the way
  // an arcade logo of the period wore its splash.
  const centres: readonly (readonly [number, number])[] = [
    [262, 296],
    [356, 272],
    [470, 282],
    [592, 268],
    [700, 286],
    [790, 300],
    [318, 372],
    [686, 380],
  ]

  centres.forEach(([cx, cy], index) => {
    ctx.save()
    ctx.beginPath()
    const points = 9
    for (let i = 0; i <= points; i += 1) {
      const angle = (i / points) * Math.PI * 2
      const radius = 22 + random() * 40
      const x = cx + Math.cos(angle) * radius
      const y = cy + Math.sin(angle) * radius * 0.7
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.fillStyle = index % 2 === 0 ? spec.markPrimary : spec.markSecondary
    ctx.fill()
    ctx.restore()
  })
}

/**
 * Impacts rather than splashes: struck marks with a bruise around them,
 * angled as if something landed and carried on through.
 */
function paintImpacts(ctx: CanvasRenderingContext2D, spec: TitleSpec): void {
  const random = seeded(0x1f00)
  const centres: readonly (readonly [number, number])[] = [
    [242, 288],
    [398, 250],
    [560, 276],
    [716, 254],
    [812, 318],
    [330, 392],
    [660, 398],
  ]

  centres.forEach(([cx, cy], index) => {
    const lean = (index % 2 === 0 ? 1 : -1) * (0.25 + random() * 0.4)
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(lean)

    // The bruise first, then the strike sitting inside it.
    ctx.fillStyle = spec.markSecondary
    ctx.beginPath()
    ctx.ellipse(0, 0, 44 + random() * 26, 20 + random() * 12, 0, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = spec.markPrimary
    ctx.beginPath()
    ctx.ellipse(0, 0, 26 + random() * 16, 10 + random() * 7, 0, 0, Math.PI * 2)
    ctx.fill()

    // Spatter trailing off in the direction of travel.
    for (let i = 0; i < 7; i += 1) {
      const distance = 48 + random() * 70
      const size = 4 + random() * 9
      ctx.fillStyle = spec.markPrimary
      ctx.fillRect(distance, (random() - 0.5) * 34, size, size)
    }
    ctx.restore()
  })
}

/** Roundels: the squadron's own marking, stencilled onto the sky. */
function paintRoundels(ctx: CanvasRenderingContext2D, spec: TitleSpec): void {
  const placements: readonly (readonly [number, number, number])[] = [
    [186, 232, 58],
    [858, 250, 48],
    [286, 470, 40],
    [760, 486, 54],
  ]

  placements.forEach(([cx, cy, radius]) => {
    const rings: ReadonlyArray<readonly [number, string]> = [
      [1, '#f2f6fb'],
      [0.68, spec.markSecondary],
      [0.34, spec.markPrimary],
    ]
    rings.forEach(([scale, colour]) => {
      ctx.beginPath()
      ctx.arc(cx, cy, radius * scale, 0, Math.PI * 2)
      ctx.fillStyle = colour
      ctx.fill()
    })
  })
}

function paintField(ctx: CanvasRenderingContext2D, spec: TitleSpec): void {
  if (spec.field === 'checker') paintCheckerField(ctx, spec)
  else if (spec.field === 'hazard') paintHazardField(ctx, spec)
  else paintSkyField(ctx, spec)
}

function paintMarks(ctx: CanvasRenderingContext2D, spec: TitleSpec): void {
  if (spec.mark === 'splash') paintSplashes(ctx, spec)
  else if (spec.mark === 'impact') paintImpacts(ctx, spec)
  else paintRoundels(ctx, spec)
}

/**
 * Fits the wordmark to the cloth. The three names are different lengths and a
 * fixed size overflowed the longest of them off the edge of the flag, so the
 * face is measured and stepped down until it sits inside the safe width.
 */
function fitFont(ctx: CanvasRenderingContext2D, spec: TitleSpec, fontFamily: string): number {
  const maxWidth = TEXTURE_WIDTH - 180
  let size = 112
  while (size > 56) {
    ctx.font = `${size}px ${fontFamily}`
    if (ctx.measureText(spec.wordmark).width <= maxWidth) break
    size -= 4
  }
  return size
}

function paintWordmark(
  ctx: CanvasRenderingContext2D,
  spec: TitleSpec,
  fontFamily: string,
): void {
  const size = fitFont(ctx, spec, fontFamily)

  ctx.save()
  ctx.translate(TEXTURE_WIDTH / 2, WORDMARK_CENTRE_Y)
  ctx.transform(1, 0, spec.skew, 1, 0, 0)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `${size}px ${fontFamily}`

  // Cast shadow first, then the dark plate, then the metal, then the glint —
  // the same four passes an arcade logo of the period was airbrushed in.
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.fillText(spec.wordmark, 8, 10)

  ctx.lineJoin = 'round'
  ctx.strokeStyle = spec.plate
  ctx.lineWidth = 22
  ctx.strokeText(spec.wordmark, 0, 0)

  ctx.strokeStyle = '#f2f2f2'
  ctx.lineWidth = 9
  ctx.strokeText(spec.wordmark, 0, 0)

  const metal = ctx.createLinearGradient(0, -size * 0.62, 0, size * 0.62)
  spec.metal.forEach(([position, colour]) => metal.addColorStop(position, colour))
  ctx.fillStyle = metal
  ctx.fillText(spec.wordmark, 0, 0)

  ctx.restore()

  ctx.save()
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  ctx.font = `26px ${fontFamily}`
  ctx.fillStyle = spec.accent
  ctx.fillText('TM', TEXTURE_WIDTH - 190, WORDMARK_CENTRE_Y + 52)
  ctx.restore()
}

/**
 * Bakes a title cloth. Call only in the browser, and only once the display
 * face has loaded — a canvas that draws before the font arrives silently bakes
 * the fallback and there is no second chance to repaint the texture.
 *
 * `spec` defaults to the racer so the cabinet's boot gate, which has only ever
 * had one flag, keeps calling this with a font and nothing else.
 */
export function createFlagTexture(
  fontFamily: string,
  spec: TitleSpec = RACE_TITLE,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = TEXTURE_WIDTH
  canvas.height = TEXTURE_HEIGHT
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('Title flag: 2D context unavailable')

  ctx.imageSmoothingEnabled = false
  paintField(ctx, spec)
  paintGrain(ctx, 0x5eed)
  paintMarks(ctx, spec)
  paintWordmark(ctx, spec, fontFamily)

  const texture = new THREE.CanvasTexture(canvas)
  // Nearest sampling and no mips: the console had neither, and the crawl on
  // the field edges as the cloth moves is the entire point.
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.anisotropy = 1
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
