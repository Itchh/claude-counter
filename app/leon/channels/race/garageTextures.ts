import * as THREE from 'three'
import { GARAGE } from '../../ps1/theme'
import { configurePs1Texture } from './Ps1Material'

// The workshop's texture pages, painted at load rather than shipped.
//
// Four pages, each drawn the way the era's artists drew them: a handful of
// flat fills, a hard edge where two meet, and a scatter of dark blocks for
// grain instead of any noise filter. Every page is small — the console had
// one megabyte of VRAM for the whole frame — and every page is nearest-
// sampled, so a 64-pixel brick tile is a 64-pixel brick tile up close.
//
// Baked to canvas because a brick wall and a roller door are not assets this
// project owns and never will be: they exist for one window, and a page that
// can be redrawn from six constants is cheaper to carry than a PNG that
// cannot be retinted.

const BRICK_TILE = 64
const BRICK_ROWS = 4
const MORTAR = 3
const GRAIN_BLOCKS = 90

const DOOR_WIDTH = 64
const DOOR_HEIGHT = 256
const SLAT_HEIGHT = 16

const BANNER_WIDTH = 2048
const BANNER_HEIGHT = 160
const BANNER_PANEL_GAP = 24
const BANNER_TEXT_PX = 60

const SIGN_SIZE = 64

/** The sponsors along the wall. Invented, and in the studio's own register. */
export const SPONSORS: ReadonlyArray<string> = [
  'NEW GENRE',
  'SHINODA',
  'TOKEN OILS',
  'CACHE TYRES',
  'CONTEXT RACING',
]

/** Deterministic value noise, so the wall grains identically on every open. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0xffffffff
  }
}

function makeCanvas(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Garage: could not get a 2D context')
  return context
}

function toTexture(context: CanvasRenderingContext2D, repeat: boolean): THREE.Texture {
  const texture = new THREE.CanvasTexture(context.canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  if (repeat) {
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
  }
  return configurePs1Texture(texture)
}

/**
 * A brick tile: four courses, every other one offset by half a brick, the
 * mortar drawn as the background showing through. Tiles in both directions.
 */
export function makeBrickTexture(): THREE.Texture {
  const context = makeCanvas(BRICK_TILE, BRICK_TILE)
  context.fillStyle = GARAGE.mortar
  context.fillRect(0, 0, BRICK_TILE, BRICK_TILE)

  const courseHeight = BRICK_TILE / BRICK_ROWS
  const brickWidth = BRICK_TILE / 2
  const random = seeded(0xb71c)

  for (let row = 0; row < BRICK_ROWS; row++) {
    const offset = row % 2 === 0 ? 0 : brickWidth / 2
    for (let column = -1; column <= 2; column++) {
      const x = column * brickWidth + offset
      const y = row * courseHeight
      context.fillStyle = random() > 0.3 ? GARAGE.brick : GARAGE.brickDark
      context.fillRect(x + MORTAR / 2, y + MORTAR / 2, brickWidth - MORTAR, courseHeight - MORTAR)
    }
  }

  for (let i = 0; i < GRAIN_BLOCKS; i++) {
    context.fillStyle = random() > 0.5 ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.08)'
    context.fillRect(Math.floor(random() * BRICK_TILE), Math.floor(random() * BRICK_TILE), 2, 2)
  }

  return toTexture(context, true)
}

/**
 * The roller door: horizontal slats, each with a light edge along its top
 * and a dark one along its bottom. One column wide, and tiled sideways.
 */
export function makeRollerDoorTexture(): THREE.Texture {
  const context = makeCanvas(DOOR_WIDTH, DOOR_HEIGHT)
  context.fillStyle = GARAGE.slat
  context.fillRect(0, 0, DOOR_WIDTH, DOOR_HEIGHT)

  for (let y = 0; y < DOOR_HEIGHT; y += SLAT_HEIGHT) {
    context.fillStyle = GARAGE.slatEdge
    context.fillRect(0, y, DOOR_WIDTH, 2)
    context.fillStyle = '#000000'
    context.fillRect(0, y + SLAT_HEIGHT - 2, DOOR_WIDTH, 2)
  }

  return toTexture(context, true)
}

/**
 * The sponsor strip: white panels on a red rail, one name each, in the
 * kit's own faces. The strip is one page so the whole rail is a single
 * quad, which is how the source games did it — a banner was a texture, not
 * a row of objects.
 */
export function makeBannerTexture(): THREE.Texture {
  const context = makeCanvas(BANNER_WIDTH, BANNER_HEIGHT)
  context.fillStyle = GARAGE.ink
  context.fillRect(0, 0, BANNER_WIDTH, BANNER_HEIGHT)

  const panelWidth = BANNER_WIDTH / SPONSORS.length
  const inset = BANNER_PANEL_GAP / 2
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.font = `bold ${BANNER_TEXT_PX}px "MGS1 HUD", "NeueBit", ui-monospace, monospace`

  SPONSORS.forEach((name, index) => {
    const x = index * panelWidth
    context.fillStyle = '#ffffff'
    context.fillRect(x + inset, inset, panelWidth - BANNER_PANEL_GAP, BANNER_HEIGHT - BANNER_PANEL_GAP)
    // Alternate the ink so the rail reads as five sponsors, not one repeated.
    context.fillStyle = index % 2 === 0 ? GARAGE.ink : '#101014'
    context.fillText(name, x + panelWidth / 2, BANNER_HEIGHT / 2 + 4)
  })

  return toTexture(context, false)
}

/**
 * The wall sign: the lemon triangle every workshop has somewhere, with a
 * black exclamation cut into it. Drawn as a cut-out, so the brick shows
 * around the triangle.
 */
export function makeHazardSignTexture(): THREE.Texture {
  const context = makeCanvas(SIGN_SIZE, SIGN_SIZE)
  context.clearRect(0, 0, SIGN_SIZE, SIGN_SIZE)

  context.fillStyle = '#000000'
  context.beginPath()
  context.moveTo(SIGN_SIZE / 2, 2)
  context.lineTo(SIGN_SIZE - 2, SIGN_SIZE - 4)
  context.lineTo(2, SIGN_SIZE - 4)
  context.closePath()
  context.fill()

  context.fillStyle = GARAGE.lemon
  context.beginPath()
  context.moveTo(SIGN_SIZE / 2, 10)
  context.lineTo(SIGN_SIZE - 8, SIGN_SIZE - 8)
  context.lineTo(8, SIGN_SIZE - 8)
  context.closePath()
  context.fill()

  context.fillStyle = '#000000'
  context.fillRect(SIGN_SIZE / 2 - 3, 24, 6, 18)
  context.fillRect(SIGN_SIZE / 2 - 3, 46, 6, 6)

  return toTexture(context, false)
}
