import type { CabinetGame } from '../cabinet/games'
import { FACE, PHOSPHOR, type PaintedPage, makePage, makePageTexture } from './arcadeScreen'

// The rest of the room's printed matter: the vinyl banner over the cabinet,
// the poster on the wall, the little TV's podium, and the icons the CRT menu
// hangs off the end of each row. Same route as the screen — a 2D canvas at
// console resolution, sampled nearest — but each page keeps its own
// register, because a printed banner, a wall poster and a lit tube were
// never the same colour in the same room.
//
// Everything small is hand-authored as a bitmap: sixteen strings, one
// character a texel, so a kart is a kart at any distance and never a
// smoothed blob. Canvas paths are antialiased and cannot be told otherwise,
// so nothing here draws an arc.

/** One page: the texture the scene hangs and the context that repaints it. */
export type RoomPage = PaintedPage

/** A bitmap: one string a row, one character a texel. '.' is left unpainted. */
export type Bitmap = ReadonlyArray<string>

/** Which colour each bitmap character is printed in. */
export type BitmapPalette = Readonly<Record<string, string>>

const ICON_SIZE = 16

function assertBitmap(rows: Bitmap, size: number, name: string): Bitmap {
  if (rows.length !== size || rows.some((row) => row.length !== size)) {
    throw new Error(`Bitmap "${name}" is not ${size}×${size}`)
  }
  return rows
}

/** Prints a bitmap texel by texel. Characters missing from the palette are left unpainted. */
export function blitBitmap(
  ctx: CanvasRenderingContext2D,
  rows: Bitmap,
  x: number,
  y: number,
  palette: BitmapPalette,
): void {
  rows.forEach((row, rowIndex) => {
    for (let column = 0; column < row.length; column += 1) {
      const colour = palette[row[column]]
      if (colour === undefined) continue
      ctx.fillStyle = colour
      ctx.fillRect(x + column, y + rowIndex, 1, 1)
    }
  })
}

// ---------------------------------------------------------------------------
// Menu row icons: a kart from the side, a fist, a plane from above.

const KART_ICON = assertBitmap(
  [
    '................',
    '................',
    '......####......',
    '.....#....#.....',
    '.....#.##.#.....',
    '..######..###...',
    '.#..........##..',
    '.#............#.',
    '.##############.',
    '.#.###....###.#.',
    '.##.#.#..#.#.##.',
    '..#.#.#..#.#.#..',
    '...###....###...',
    '................',
    '................',
    '................',
  ],
  ICON_SIZE,
  'kart',
)

const FIST_ICON = assertBitmap(
  [
    '................',
    '................',
    '....########....',
    '...#........#...',
    '..#..#..#..#.#..',
    '..#..#..#..#..#.',
    '..#..#..#..#..#.',
    '..#..........##.',
    '..#..........#..',
    '..#..........#..',
    '...#........#...',
    '....#......#....',
    '.....#....#.....',
    '......####......',
    '................',
    '................',
  ],
  ICON_SIZE,
  'fist',
)

const PLANE_ICON = assertBitmap(
  [
    '.......##.......',
    '.......##.......',
    '......####......',
    '......####......',
    '.......##.......',
    '.......##.......',
    '.##############.',
    '################',
    '################',
    '.##############.',
    '.......##.......',
    '.......##.......',
    '.......##.......',
    '.....######.....',
    '....########....',
    '.......##.......',
  ],
  ICON_SIZE,
  'plane',
)

/** The icon each game row carries at its right edge. */
export const ROW_ICONS: Readonly<Record<CabinetGame, Bitmap>> = {
  race: KART_ICON,
  fight: FIST_ICON,
  dogfight: PLANE_ICON,
}

/** The side of a row icon, in page texels. */
export const ROW_ICON_SIZE = ICON_SIZE

/** Prints a row icon in one colour: phosphor at rest, ink when the row is lit. */
export function paintRowIcon(ctx: CanvasRenderingContext2D, icon: Bitmap, x: number, y: number, colour: string): void {
  blitBitmap(ctx, icon, x, y, { '#': colour })
}

// ---------------------------------------------------------------------------
// The banner. Printed vinyl, not a lit box: cream ground, a wrinkle where it
// was rolled, eyelets in the corners, and the wordmark in the codec gold the
// ranking board uses, inked once in black and offset.

/** The banner page. Wide and short, the shape of the frame over the cabinet. */
export const BANNER_PAGE = { width: 256, height: 64 } as const

const BANNER_FONT_SIZE = 34
const VINYL = '#efe6d2'
const VINYL_LIGHT = '#f7f0e0'
const VINYL_BORDER = '#2a2622'
const EYELET_RING = '#8a8a96'
const EYELET_HOLE = '#3a3a44'
const BANNER_GOLD = '#ffd24a'
const BANNER_GOLD_LOW = '#a06a00'
const INK = '#000000'
const BANNER_BORDER_INSET = 2
const EYELET_INSET = 6
/** Where the two wrinkle bands cross the top edge, and how far they lean. */
const WRINKLE_TOPS = [72, 84] as const
const WRINKLE_WIDTH = 4
const WRINKLE_LEAN = 0.6

/** A five-texel ring with a hollow centre. */
function paintEyelet(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.fillStyle = EYELET_RING
  ctx.fillRect(cx - 2, cy - 1, 5, 3)
  ctx.fillRect(cx - 1, cy - 2, 3, 5)
  ctx.fillStyle = EYELET_HOLE
  ctx.fillRect(cx, cy, 1, 1)
}

export function paintBanner(ctx: CanvasRenderingContext2D): void {
  const { width, height } = BANNER_PAGE
  ctx.fillStyle = VINYL
  ctx.fillRect(0, 0, width, height)

  // The wrinkle: two lighter bands leaning across the cloth, stepped a texel
  // a row so they stay hard.
  ctx.fillStyle = VINYL_LIGHT
  for (let y = 0; y < height; y += 1) {
    for (const top of WRINKLE_TOPS) {
      ctx.fillRect(Math.round(top + y * WRINKLE_LEAN), y, WRINKLE_WIDTH, 1)
    }
  }

  // A thin dark border, inset from the cut edge.
  ctx.fillStyle = VINYL_BORDER
  const inset = BANNER_BORDER_INSET
  ctx.fillRect(inset, inset, width - inset * 2, 1)
  ctx.fillRect(inset, height - inset - 1, width - inset * 2, 1)
  ctx.fillRect(inset, inset, 1, height - inset * 2)
  ctx.fillRect(width - inset - 1, inset, 1, height - inset * 2)

  for (const cx of [EYELET_INSET, width - EYELET_INSET - 1]) {
    for (const cy of [EYELET_INSET, height - EYELET_INSET - 1]) paintEyelet(ctx, cx, cy)
  }

  // The wordmark: black ink offset down and right, a shade a texel under,
  // then the gold.
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.font = `${BANNER_FONT_SIZE}px ${FACE}`
  const maxWidth = width - EYELET_INSET * 4
  const cx = width / 2
  const cy = height / 2
  ctx.fillStyle = INK
  ctx.fillText('CLAUDE ARCADE', cx + 2, cy + 2, maxWidth)
  ctx.fillStyle = BANNER_GOLD_LOW
  ctx.fillText('CLAUDE ARCADE', cx, cy + 1, maxWidth)
  ctx.fillStyle = BANNER_GOLD
  ctx.fillText('CLAUDE ARCADE', cx, cy, maxWidth)
}

export function makeBannerPage(): RoomPage {
  const { canvas, ctx } = makePage(BANNER_PAGE.width, BANNER_PAGE.height)
  return { texture: makePageTexture(canvas), ctx }
}

// ---------------------------------------------------------------------------
// The poster. A bedroom wall's set-up sheet: navy, a roundel, the three
// steps, a sticker, and a tack in each corner holding it up.

/** The poster page. Portrait, a sheet on the wall. */
export const POSTER_PAGE = { width: 192, height: 256 } as const

const POSTER_TITLE_FONT_SIZE = 16
const POSTER_FONT_SIZE = 14
const POSTER_LEADING = 18
const POSTER_INSET = 12
const POSTER_NAVY = '#141a33'
const POSTER_CREAM = '#efe6d2'
const POSTER_CREAM_DIM = '#9a937f'
const POSTER_GOLD = '#ffd24a'
const POSTER_TITLE_Y = 44
const POSTER_STEPS_TOP = 96
const POSTER_FOOTER_Y = POSTER_PAGE.height - 40
const ROUNDEL_INSET = 10
const TACK_INSET = 5
const TACK = '#c8322a'
const TACK_HIGH = '#f28a7a'
const STICKER = '#f4f4f8'
const STICKER_INK = '#1a1a22'
const STICKER_FONT_SIZE = 12
const STICKER_WIDTH = 48
const STICKER_HEIGHT = 18
const STICKER_INSET = 10

const POSTER_STEPS: ReadonlyArray<string> = [
  '1  SET YOUR GIT EMAIL',
  '2  RUN THE INSTALL',
  '3  SIGN IN — CODE ON SCREEN',
]
const POSTER_FOOTER = '↵  OPEN THE COMMANDS'

const ROUNDEL = assertBitmap(
  [
    '.....BBBBBB.....',
    '...BBBBBBBBBB...',
    '..BBBBBBBBBBBB..',
    '.BBBBBWWWWBBBBB.',
    '.BBBBWWWWWWBBBB.',
    'BBBBWWWRRWWWBBBB',
    'BBBBWWRRRRWWBBBB',
    'BBBBWWRRRRWWBBBB',
    'BBBBWWRRRRWWBBBB',
    'BBBBWWRRRRWWBBBB',
    'BBBBWWWRRWWWBBBB',
    '.BBBBWWWWWWBBBB.',
    '.BBBBBWWWWBBBBB.',
    '..BBBBBBBBBBBB..',
    '...BBBBBBBBBB...',
    '.....BBBBBB.....',
  ],
  ICON_SIZE,
  'roundel',
)
const ROUNDEL_PALETTE: BitmapPalette = { B: '#1b3a8f', W: '#f4f4f8', R: '#c8102e' }

/** A three-texel tack head with one bright texel where the light catches it. */
function paintTack(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = TACK
  ctx.fillRect(x, y, 3, 3)
  ctx.fillStyle = TACK_HIGH
  ctx.fillRect(x, y, 1, 1)
}

export function paintPoster(ctx: CanvasRenderingContext2D): void {
  const { width, height } = POSTER_PAGE
  ctx.fillStyle = POSTER_NAVY
  ctx.fillRect(0, 0, width, height)

  blitBitmap(ctx, ROUNDEL, ROUNDEL_INSET, ROUNDEL_INSET, ROUNDEL_PALETTE)

  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillStyle = POSTER_GOLD
  ctx.font = `${POSTER_TITLE_FONT_SIZE}px ${FACE}`
  ctx.fillText('CONNECT YOUR CLAUDE', width / 2, POSTER_TITLE_Y, width - POSTER_INSET * 2)

  ctx.textAlign = 'left'
  ctx.fillStyle = POSTER_CREAM
  ctx.font = `${POSTER_FONT_SIZE}px ${FACE}`
  POSTER_STEPS.forEach((step, index) => {
    ctx.fillText(step, POSTER_INSET, POSTER_STEPS_TOP + index * POSTER_LEADING, width - POSTER_INSET * 2)
  })

  ctx.fillStyle = POSTER_CREAM_DIM
  ctx.fillText(POSTER_FOOTER, POSTER_INSET, POSTER_FOOTER_Y, width - POSTER_INSET * 2)

  // The sticker: a hard-cornered white label, one texel of ink around it.
  const stickerX = width - STICKER_INSET - STICKER_WIDTH
  const stickerY = height - STICKER_INSET - STICKER_HEIGHT
  ctx.fillStyle = STICKER_INK
  ctx.fillRect(stickerX - 1, stickerY - 1, STICKER_WIDTH + 2, STICKER_HEIGHT + 2)
  ctx.fillStyle = STICKER
  ctx.fillRect(stickerX, stickerY, STICKER_WIDTH, STICKER_HEIGHT)
  ctx.fillStyle = STICKER_INK
  ctx.textAlign = 'center'
  ctx.font = `${STICKER_FONT_SIZE}px ${FACE}`
  ctx.fillText('macOS', stickerX + STICKER_WIDTH / 2, stickerY + STICKER_HEIGHT / 2, STICKER_WIDTH - 6)

  for (const x of [TACK_INSET, width - TACK_INSET - 3]) {
    for (const y of [TACK_INSET, height - TACK_INSET - 3]) paintTack(ctx, x, y)
  }
}

export function makePosterPage(): RoomPage {
  const { canvas, ctx } = makePage(POSTER_PAGE.width, POSTER_PAGE.height)
  return { texture: makePageTexture(canvas), ctx }
}

// ---------------------------------------------------------------------------
// The TV. A small tube showing the podium, repainted whenever the board
// moves, so every paint starts from a blank glass.

/** The TV page. Landscape, a portable's tube. */
export const TV_PAGE = { width: 128, height: 96 } as const

export interface TvRow {
  readonly name: string
  readonly score: string
  /** The driver's colour, for the chip beside the name. */
  readonly color: string
}

const TV_PODIUM_SIZE = 3
const TV_FONT_SIZE = 12
const TV_INSET = 8
const TV_HEADER_Y = 14
const TV_ROWS_TOP = 34
const TV_ROW_HEIGHT = 18
const TV_CHIP_SIZE = 6
const TV_GLASS = '#06080a'
const TV_SCANLINE = 'rgba(255, 255, 255, 0.035)'
const TV_SCANLINE_PITCH = 4
const TV_SCANLINE_HEIGHT = 2
const TV_DIM = '#8a4a10'
/** Room left of the score for the name, in texels. */
const TV_SCORE_RESERVE = 40

export function paintTv(ctx: CanvasRenderingContext2D, rows: ReadonlyArray<TvRow>): void {
  const { width, height } = TV_PAGE
  ctx.fillStyle = TV_GLASS
  ctx.fillRect(0, 0, width, height)

  ctx.textBaseline = 'middle'
  ctx.font = `${TV_FONT_SIZE}px ${FACE}`

  if (rows.length === 0) {
    ctx.textAlign = 'center'
    ctx.fillStyle = TV_DIM
    ctx.fillText('NO SIGNAL', width / 2, height / 2)
  } else {
    ctx.textAlign = 'left'
    ctx.fillStyle = PHOSPHOR
    ctx.fillText(`TOP ${TV_PODIUM_SIZE}`, TV_INSET, TV_HEADER_Y)
    ctx.fillStyle = TV_DIM
    ctx.fillRect(TV_INSET, TV_HEADER_Y + 9, width - TV_INSET * 2, 1)

    rows.slice(0, TV_PODIUM_SIZE).forEach((row, index) => {
      const cy = TV_ROWS_TOP + index * TV_ROW_HEIGHT
      const placeX = TV_INSET
      const chipX = placeX + 10
      const nameX = chipX + TV_CHIP_SIZE + 4

      ctx.textAlign = 'left'
      ctx.fillStyle = TV_DIM
      ctx.fillText(String(index + 1), placeX, cy)
      ctx.fillStyle = row.color
      ctx.fillRect(chipX, cy - TV_CHIP_SIZE / 2, TV_CHIP_SIZE, TV_CHIP_SIZE)
      ctx.fillStyle = PHOSPHOR
      ctx.fillText(row.name.toUpperCase(), nameX, cy, width - TV_INSET - nameX - TV_SCORE_RESERVE)
      ctx.textAlign = 'right'
      ctx.fillText(row.score, width - TV_INSET, cy, TV_SCORE_RESERVE - 4)
    })
  }

  // The stripe over the glass, last, so it sits on the picture.
  ctx.fillStyle = TV_SCANLINE
  for (let y = 0; y < height; y += TV_SCANLINE_PITCH) ctx.fillRect(0, y, width, TV_SCANLINE_HEIGHT)
}

export function makeTvPage(): RoomPage {
  const { canvas, ctx } = makePage(TV_PAGE.width, TV_PAGE.height)
  return { texture: makePageTexture(canvas), ctx }
}
