import * as THREE from 'three'

// The title flag is one baked bitmap, exactly as the era did it: a checker
// field with the wordmark painted straight onto the cloth, so the logo warps
// with the ripple instead of floating in front of it as a separate sprite.

const TEXTURE_WIDTH = 1024
const TEXTURE_HEIGHT = 768
const CHECKER_COLUMNS = 10
const CHECKER_ROWS = 8
const CHECKER_LIGHT = '#b9b9c1'
const CHECKER_DARK = '#6d6d78'
const LOGO_SKEW = -0.16
const LOGO_TEXT = 'CLAUDE RACER'
const SPLASH_GREEN = '#5ad12e'
const SPLASH_GREEN_DEEP = '#2f8f16'

/** Deterministic value noise, so the cloth grains identically on every load. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0xffffffff
  }
}

function paintChecker(ctx: CanvasRenderingContext2D): void {
  const cellWidth = TEXTURE_WIDTH / CHECKER_COLUMNS
  const cellHeight = TEXTURE_HEIGHT / CHECKER_ROWS
  const random = seeded(0x5eed)

  for (let row = 0; row < CHECKER_ROWS; row += 1) {
    for (let column = 0; column < CHECKER_COLUMNS; column += 1) {
      ctx.fillStyle = (row + column) % 2 === 0 ? CHECKER_LIGHT : CHECKER_DARK
      ctx.fillRect(column * cellWidth, row * cellHeight, cellWidth + 1, cellHeight + 1)
    }
  }

  // Cloth grain: 15-bit colour could not hold a smooth gradient, so period
  // artists dithered. Scatter low-alpha blocks rather than blur.
  for (let i = 0; i < 5200; i += 1) {
    const x = Math.floor(random() * TEXTURE_WIDTH)
    const y = Math.floor(random() * TEXTURE_HEIGHT)
    ctx.fillStyle = random() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)'
    ctx.fillRect(x, y, 4, 4)
  }
}

function paintSplashes(ctx: CanvasRenderingContext2D): void {
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
    ctx.fillStyle = index % 2 === 0 ? SPLASH_GREEN : SPLASH_GREEN_DEEP
    ctx.fill()
    ctx.restore()
  })
}

function paintWordmark(ctx: CanvasRenderingContext2D, fontFamily: string): void {
  const centreX = TEXTURE_WIDTH / 2
  const centreY = 330

  ctx.save()
  ctx.translate(centreX, centreY)
  ctx.transform(1, 0, LOGO_SKEW, 1, 0, 0)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `112px ${fontFamily}`

  // Cast shadow first, then the dark plate, then the metal, then the glint —
  // the same four passes an arcade logo of the period was airbrushed in.
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.fillText(LOGO_TEXT, 8, 10)

  ctx.lineJoin = 'round'
  ctx.strokeStyle = '#1a0a08'
  ctx.lineWidth = 22
  ctx.strokeText(LOGO_TEXT, 0, 0)

  ctx.strokeStyle = '#f2f2f2'
  ctx.lineWidth = 9
  ctx.strokeText(LOGO_TEXT, 0, 0)

  const metal = ctx.createLinearGradient(0, -70, 0, 70)
  metal.addColorStop(0, '#ff5a3c')
  metal.addColorStop(0.42, '#d81c22')
  metal.addColorStop(0.5, '#ffffff')
  metal.addColorStop(0.58, '#c8121f')
  metal.addColorStop(1, '#ff8a2b')
  ctx.fillStyle = metal
  ctx.fillText(LOGO_TEXT, 0, 0)

  ctx.restore()

  ctx.save()
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  ctx.font = `26px ${fontFamily}`
  ctx.fillStyle = '#c8121f'
  ctx.fillText('TM', TEXTURE_WIDTH - 190, centreY + 52)
  ctx.restore()
}

/**
 * Bakes the title cloth. Call only in the browser, and only once the display
 * face has loaded — a canvas that draws before the font arrives silently bakes
 * the fallback and there is no second chance to repaint the texture.
 */
export function createFlagTexture(fontFamily: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = TEXTURE_WIDTH
  canvas.height = TEXTURE_HEIGHT
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('Title flag: 2D context unavailable')

  ctx.imageSmoothingEnabled = false
  paintChecker(ctx)
  paintSplashes(ctx)
  paintWordmark(ctx, fontFamily)

  const texture = new THREE.CanvasTexture(canvas)
  // Nearest sampling and no mips: the console had neither, and the crawl on
  // the checker edges as the cloth moves is the entire point.
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.anisotropy = 1
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
