import * as THREE from 'three'
import { ROOM_ROWS, isSetupRow } from './roomMenu'
import { ROW_ICONS, ROW_ICON_SIZE, paintRowIcon } from './roomPages'

// The two pages the runtime hangs on the cabinet: the CRT's menu and the
// marquee over it. Both are painted on a 2D canvas at console resolution and
// sampled nearest, so a glyph is a block of texels rather than a smoothed
// letter — the same route the shelf's cartridge labels took.
//
// One register for both: amber phosphor on near-black. The cabinet's own
// chrome is red-and-white, but a lit screen in a dark room was always the
// one thing that glowed a different colour, and the inspiration board reads
// that way too.

export const PHOSPHOR = '#ff8c1a'
const PHOSPHOR_DIM = '#8a4a10'
const PHOSPHOR_BED = '#1a0c04'
const GLASS = '#070403'
const INK_ON_PHOSPHOR = '#140800'

/** The CRT page. Portrait, matching the cabinet's glass. */
export const SCREEN_PAGE = { width: 216, height: 256 } as const
/** The marquee page. Wide and short. */
export const MARQUEE_PAGE = { width: 256, height: 96 } as const

const SCREEN_FONT_SIZE = 18
const HEADER_FONT_SIZE = 22
const FOOTER_FONT_SIZE = 13
const MARQUEE_FONT_SIZE = 40
/** Where the row list starts and how tall each row is, in page pixels. */
export const ROW_TOP = 78
export const ROW_HEIGHT = 30
const ROW_INSET = 12
/** The gap between a row's label and the icon at its right edge. */
const ROW_ICON_GAP = 6
const RULE_Y = 50
const FOOTER_Y = SCREEN_PAGE.height - 22

/** The reading face, with the same fallback the rest of the cabinet uses. */
export const FACE = '"NeueBit", "MGS1 HUD", monospace'

/**
 * Loads the pixel face before the first paint. A page painted in the
 * fallback and never repainted would sit on the cabinet in Menlo forever;
 * the caller repaints once this resolves. Never rejects — a missing font is a
 * fallback face, not a blank screen.
 */
export async function waitForScreenFace(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return
  try {
    await Promise.all([
      document.fonts.load(`${SCREEN_FONT_SIZE}px "NeueBit"`),
      document.fonts.load(`${MARQUEE_FONT_SIZE}px "NeueBit"`),
    ])
  } catch (error) {
    console.error('Screen face did not load; painting in the fallback', error)
  }
}

export function makePage(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D is unavailable; the arcade screen cannot be painted')
  ctx.imageSmoothingEnabled = false
  return { canvas, ctx }
}

export function makePageTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export interface ScreenState {
  readonly cursor: number
  /** Whether the cursor block is lit this tick. */
  readonly blinkOn: boolean
  /** True once a row has been chosen: the list holds and the footer changes. */
  readonly launching: boolean
}

/** Thin scanlines over the glass: one dark line every third row. */
function paintScanlines(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.28)'
  for (let y = 0; y < height; y += 3) ctx.fillRect(0, y, width, 1)
}

export function paintScreen(ctx: CanvasRenderingContext2D, state: ScreenState): void {
  const { width, height } = SCREEN_PAGE
  ctx.fillStyle = GLASS
  ctx.fillRect(0, 0, width, height)

  // Header: the wordmark, and a rule under it.
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillStyle = PHOSPHOR
  ctx.font = `${HEADER_FONT_SIZE}px ${FACE}`
  ctx.fillText('CLAUDE ARCADE', ROW_INSET, 28)
  ctx.fillStyle = PHOSPHOR_DIM
  ctx.fillRect(ROW_INSET, RULE_Y, width - ROW_INSET * 2, 2)

  ctx.font = `${SCREEN_FONT_SIZE}px ${FACE}`
  ROOM_ROWS.forEach((row, index) => {
    const top = ROW_TOP + index * ROW_HEIGHT
    const isCursor = index === state.cursor
    const lit = isCursor && (state.blinkOn || state.launching)
    if (lit) {
      ctx.fillStyle = PHOSPHOR
      ctx.fillRect(ROW_INSET - 4, top, width - ROW_INSET * 2 + 8, ROW_HEIGHT - 4)
    }
    // What the row is printed in: ink on the lit block, phosphor under the
    // cursor at rest, dim phosphor elsewhere. The icon takes the same colour.
    const ink = lit ? INK_ON_PHOSPHOR : isCursor ? PHOSPHOR : PHOSPHOR_DIM
    ctx.fillStyle = ink
    const label = `${isCursor ? '▸ ' : '  '}${row.name.toUpperCase()}`
    const middle = top + (ROW_HEIGHT - 4) / 2
    // Game rows carry their icon at the right edge, in whatever the label is
    // printed in, and the label stops short of it.
    const icon = isSetupRow(row.id) ? null : ROW_ICONS[row.id]
    const labelWidth = icon === null ? width - ROW_INSET * 2 : width - ROW_INSET * 2 - ROW_ICON_SIZE - ROW_ICON_GAP
    ctx.fillText(label, ROW_INSET, middle, labelWidth)
    if (icon !== null) {
      paintRowIcon(ctx, icon, width - ROW_INSET - ROW_ICON_SIZE, Math.round(middle - ROW_ICON_SIZE / 2), ink)
    }
  })

  // Footer: the controls, or the launch line once one is chosen.
  ctx.fillStyle = PHOSPHOR_BED
  ctx.fillRect(0, FOOTER_Y - 12, width, 24)
  ctx.fillStyle = state.launching ? PHOSPHOR : PHOSPHOR_DIM
  ctx.font = `${FOOTER_FONT_SIZE}px ${FACE}`
  ctx.textAlign = 'center'
  ctx.fillText(state.launching ? 'LOADING…' : '↑↓ SELECT   ↵ START', width / 2, FOOTER_Y)

  paintScanlines(ctx, width, height)
}

export function paintMarquee(ctx: CanvasRenderingContext2D): void {
  const { width, height } = MARQUEE_PAGE
  ctx.fillStyle = GLASS
  ctx.fillRect(0, 0, width, height)

  // A checker border, two texels a square, top and bottom.
  const square = 6
  for (let x = 0; x < width; x += square) {
    for (const y of [0, height - square * 2]) {
      const odd = Math.floor(x / square) % 2 === 0
      ctx.fillStyle = odd ? PHOSPHOR : PHOSPHOR_DIM
      ctx.fillRect(x, y, square, square)
      ctx.fillStyle = odd ? PHOSPHOR_DIM : PHOSPHOR
      ctx.fillRect(x, y + square, square, square)
    }
  }

  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.font = `${MARQUEE_FONT_SIZE}px ${FACE}`
  // A hard drop under the letters, then the letters.
  ctx.fillStyle = PHOSPHOR_DIM
  ctx.fillText('CLAUDE ARCADE', width / 2 + 2, height / 2 + 2, width - 16)
  ctx.fillStyle = PHOSPHOR
  ctx.fillText('CLAUDE ARCADE', width / 2, height / 2, width - 16)
}

export interface PaintedPage {
  readonly texture: THREE.CanvasTexture
  readonly ctx: CanvasRenderingContext2D
}

export function makeScreenPage(): PaintedPage {
  const { canvas, ctx } = makePage(SCREEN_PAGE.width, SCREEN_PAGE.height)
  return { texture: makePageTexture(canvas), ctx }
}

export function makeMarqueePage(): PaintedPage {
  const { canvas, ctx } = makePage(MARQUEE_PAGE.width, MARQUEE_PAGE.height)
  return { texture: makePageTexture(canvas), ctx }
}

/** Which row a point on the glass is over, in page UV (0..1, v up). */
export function rowAtUv(uv: THREE.Vector2): number | null {
  const y = (1 - uv.y) * SCREEN_PAGE.height
  const index = Math.floor((y - ROW_TOP) / ROW_HEIGHT)
  if (y < ROW_TOP || index < 0 || index >= ROOM_ROWS.length) return null
  return index
}
