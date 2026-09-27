import * as THREE from 'three'
import { RACE_TITLE, type ShapeKind, type TitleSpec } from './titleSpecs'

// A title is one baked bitmap, exactly as the era did it: a printed surface
// with the wordmark painted straight onto it, so the logo warps with the cloth
// — or rocks with the panel — instead of floating in front as a separate
// sprite.
//
// The baker is generic over a TitleSpec because each game gets its own object,
// and they are not one template recoloured. The racer's flag, the fight's
// hanging banner and the squadron's riveted panel are three different bitmaps
// with three different outlines, and the shape decides the layout: how big
// the sheet is, where the wordmark sits, how wide it may run. What is shared
// is the treatment — the same grain, the same four airbrush passes on the
// letterform, the same nearest-sampled upload — so they read as one family.

/**
 * The sheet a shape is baked onto, in texels. The mesh in TitleCard is sized
 * from the same numbers so a texel is always square on screen and the pixel
 * crawl is the same density on every card.
 */
export interface ClothLayout {
  readonly width: number
  readonly height: number
  /** Where the wordmark block is centred. */
  readonly wordmarkCentre: readonly [number, number]
  /** Widest a wordmark line may run before the face steps down. */
  readonly wordmarkMaxWidth: number
  /** Break the wordmark into one line per word and stack them. */
  readonly stackWordmark: boolean
  /**
   * Where the TM stamp goes. Null tucks it under the right-hand end of the
   * last line; the flag pins it where it has always been.
   */
  readonly trademark: readonly [number, number] | null
}

const FLAG_LAYOUT: ClothLayout = {
  width: 1024,
  height: 768,
  wordmarkCentre: [512, 330],
  wordmarkMaxWidth: 1024 - 180,
  stackWordmark: false,
  trademark: [1024 - 190, 330 + 52],
}

/** Rail at the top, weighted hem at the bottom; the cloth hangs between. */
const BANNER_LAYOUT: ClothLayout = {
  width: 600,
  height: 800,
  wordmarkCentre: [300, 430],
  wordmarkMaxWidth: 600 - 110,
  stackWordmark: true,
  trademark: null,
}

/** A disc inscribed in a square sheet; the corners are baked transparent. */
const PANEL_LAYOUT: ClothLayout = {
  width: 768,
  height: 768,
  wordmarkCentre: [384, 384],
  wordmarkMaxWidth: 580,
  stackWordmark: false,
  trademark: null,
}

export const CLOTH_LAYOUTS: Readonly<Record<ShapeKind, ClothLayout>> = {
  flag: FLAG_LAYOUT,
  banner: BANNER_LAYOUT,
  panel: PANEL_LAYOUT,
}

const CHECKER_COLUMNS = 10
const CHECKER_ROWS = 8
const HAZARD_BAND = 96
const HAZARD_SCUFFS = 260
const GRAIN_DENSITY = 5200 / (1024 * 768)
const WORDMARK_MAX_SIZE = 112
const WORDMARK_MIN_SIZE = 56
const WORDMARK_LINE_HEIGHT = 1.18

// The rail and hem of a banner, in texels. Everything above the rail line
// and outside the rod is transparent, which is what lets it read as hung
// rather than as a second flag stood on end.
const BANNER_RAIL_HEIGHT = 84
const BANNER_ROD_TOP = 26
const BANNER_ROD_THICKNESS = 26
const BANNER_LOOPS = 5
const BANNER_LOOP_WIDTH = 46
const BANNER_HEM_HEIGHT = 52
const BANNER_ROD_DARK = '#2a2a30'
const BANNER_ROD_FACE = '#8e8e96'
const BANNER_ROD_HIGH = '#d8d8dc'
const BANNER_HEM = '#16100a'
const BANNER_STITCH = 'rgba(255,214,120,0.55)'

// The panel's metalwork. Rivet counts are round numbers because a fitter
// drilled them off a template, not a random table.
const PANEL_MARGIN = 10
const PANEL_RIM_WIDTH = 16
const PANEL_RIVETS = 40
const PANEL_RIVET_RADIUS = 7
const PANEL_RIVET_SPACING = 44
const PANEL_BRUSH_STROKES = 900
const PANEL_ROUNDEL_RADIUS = 292
const PANEL_PROP_SWEEPS = 3
const PANEL_RIVET_BODY = '#8d97a6'
const PANEL_RIVET_HIGH = '#e6ecf4'
const PANEL_RIVET_SHADOW = 'rgba(0,0,0,0.5)'
const PANEL_SEAM_DARK = 'rgba(0,0,0,0.42)'
const PANEL_SEAM_LIGHT = 'rgba(255,255,255,0.22)'
const ROUNDEL_WHITE = '#f2f6fb'

// The fist-crack: one crater where the punch landed and fractures running
// out of it, drawn as jagged polylines so nothing about it is smooth.
const CRACK_RAYS = 13
const CRACK_SEGMENTS = 6
const CRACK_REACH_MIN = 150
const CRACK_REACH_MAX = 330
const CRACK_JITTER = 24

/** Deterministic value noise, so the surface grains identically on every load. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return (): number => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0xffffffff
  }
}

/**
 * Surface grain. 15-bit colour could not hold a smooth gradient, so period
 * artists dithered — scatter low-alpha blocks rather than blur. Scaled to the
 * sheet so a small banner grains as densely as the big flag.
 */
function paintGrain(ctx: CanvasRenderingContext2D, layout: ClothLayout, seed: number): void {
  const random = seeded(seed)
  const blocks = Math.round(GRAIN_DENSITY * layout.width * layout.height)
  for (let i = 0; i < blocks; i += 1) {
    const x = Math.floor(random() * layout.width)
    const y = Math.floor(random() * layout.height)
    ctx.fillStyle = random() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)'
    ctx.fillRect(x, y, 4, 4)
  }
}

/** The starting grid: a flat checker, the way a race flag is sewn. */
function paintCheckerField(
  ctx: CanvasRenderingContext2D,
  spec: TitleSpec,
  layout: ClothLayout,
): void {
  const cellWidth = layout.width / CHECKER_COLUMNS
  const cellHeight = layout.height / CHECKER_ROWS

  for (let row = 0; row < CHECKER_ROWS; row += 1) {
    for (let column = 0; column < CHECKER_COLUMNS; column += 1) {
      ctx.fillStyle = (row + column) % 2 === 0 ? spec.fieldLight : spec.fieldDark
      ctx.fillRect(column * cellWidth, row * cellHeight, cellWidth + 1, cellHeight + 1)
    }
  }
}

/**
 * The ring apron: heavy diagonal hazard stripes. Drawn as a rotated band fill
 * over the sheet, so the diagonal runs true rather than stepping.
 */
function paintHazardField(
  ctx: CanvasRenderingContext2D,
  spec: TitleSpec,
  layout: ClothLayout,
): void {
  ctx.fillStyle = spec.fieldDark
  ctx.fillRect(0, 0, layout.width, layout.height)

  ctx.save()
  ctx.translate(layout.width / 2, layout.height / 2)
  ctx.rotate(-Math.PI / 4)
  ctx.fillStyle = spec.fieldLight
  // Overshoot the diagonal so the rotated bands still cover the corners.
  const reach = layout.width + layout.height
  for (let offset = -reach; offset < reach; offset += HAZARD_BAND * 2) {
    ctx.fillRect(offset, -reach / 2, HAZARD_BAND, reach)
  }
  ctx.restore()

  // Scuffed canvas: the apron has been fought on.
  const random = seeded(0xfa11)
  for (let i = 0; i < HAZARD_SCUFFS; i += 1) {
    const x = random() * layout.width
    const y = random() * layout.height
    ctx.fillStyle = 'rgba(0,0,0,0.16)'
    ctx.fillRect(x, y, 18 + random() * 40, 5 + random() * 8)
  }
}

/**
 * Painted aircraft skin: a flat coat over duralumin, brushed where the
 * fitters rubbed it back, with the light catching the grain in long
 * horizontal streaks. No cloud here — this is the side of the machine, not
 * the sky it flies in.
 */
function paintSkinField(
  ctx: CanvasRenderingContext2D,
  spec: TitleSpec,
  layout: ClothLayout,
): void {
  const coat = ctx.createLinearGradient(0, 0, layout.width, layout.height)
  coat.addColorStop(0, spec.fieldLight)
  coat.addColorStop(0.55, spec.fieldDark)
  coat.addColorStop(1, spec.fieldLight)
  ctx.fillStyle = coat
  ctx.fillRect(0, 0, layout.width, layout.height)

  const random = seeded(0xa1c0)
  for (let i = 0; i < PANEL_BRUSH_STROKES; i += 1) {
    const x = random() * layout.width
    const y = Math.floor(random() * layout.height)
    const length = 30 + random() * 160
    const lightness = random()
    ctx.fillStyle =
      lightness > 0.5
        ? `rgba(255,255,255,${(0.04 + (lightness - 0.5) * 0.16).toFixed(3)})`
        : `rgba(0,0,0,${(0.04 + (0.5 - lightness) * 0.18).toFixed(3)})`
    ctx.fillRect(x, y, length, 1 + Math.round(random()))
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
 * One jagged fracture line from the crater outwards: a random walk that
 * always gains distance, drawn twice — a wide dark gouge and a thin bright
 * lip inside it, so it reads as depth rather than as a scribble.
 */
function paintCrackRay(
  ctx: CanvasRenderingContext2D,
  spec: TitleSpec,
  random: () => number,
  cx: number,
  cy: number,
  angle: number,
): void {
  const reach = CRACK_REACH_MIN + random() * (CRACK_REACH_MAX - CRACK_REACH_MIN)
  const points: Array<readonly [number, number]> = [[cx, cy]]
  for (let segment = 1; segment <= CRACK_SEGMENTS; segment += 1) {
    const distance = (segment / CRACK_SEGMENTS) * reach
    const wobble = (random() - 0.5) * CRACK_JITTER * 2
    const x = cx + Math.cos(angle) * distance - Math.sin(angle) * wobble
    const y = cy + Math.sin(angle) * distance + Math.cos(angle) * wobble
    points.push([x, y])
  }

  const trace = (): void => {
    ctx.beginPath()
    points.forEach(([x, y], index) => {
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
  }

  ctx.lineCap = 'butt'
  ctx.lineJoin = 'miter'
  ctx.strokeStyle = spec.markSecondary
  ctx.lineWidth = 9
  trace()
  ctx.stroke()
  ctx.strokeStyle = spec.markPrimary
  ctx.lineWidth = 3
  trace()
  ctx.stroke()

  // A branch off the main line partway along, the way a real fracture forks.
  if (random() > 0.45) {
    const forkAt = points[2 + Math.floor(random() * 2)]
    const forkAngle = angle + (random() > 0.5 ? 1 : -1) * (0.4 + random() * 0.5)
    const forkReach = reach * (0.25 + random() * 0.25)
    ctx.strokeStyle = spec.markSecondary
    ctx.lineWidth = 5
    ctx.beginPath()
    ctx.moveTo(forkAt[0], forkAt[1])
    ctx.lineTo(forkAt[0] + Math.cos(forkAngle) * forkReach, forkAt[1] + Math.sin(forkAngle) * forkReach)
    ctx.stroke()
  }
}

/**
 * The fist-crack: a punch has landed on the banner right where the lockup
 * sits, and the surface has given. Crater in the middle, fractures radiating
 * out past the letters. Sits behind the wordmark and gets partly hidden by it,
 * which is the point — the strike is what the name is standing on.
 */
function paintImpact(ctx: CanvasRenderingContext2D, spec: TitleSpec, layout: ClothLayout): void {
  const random = seeded(0x1f00)
  const [cx, cy] = layout.wordmarkCentre

  // Bruise under everything: the cloth darkened where the force spread.
  ctx.fillStyle = spec.markSecondary
  ctx.beginPath()
  ctx.ellipse(cx, cy, 168, 128, 0, 0, Math.PI * 2)
  ctx.fill()

  for (let ray = 0; ray < CRACK_RAYS; ray += 1) {
    const angle = (ray / CRACK_RAYS) * Math.PI * 2 + (random() - 0.5) * 0.35
    paintCrackRay(ctx, spec, random, cx, cy, angle)
  }

  // The crater itself: an irregular hole punched clean through the print.
  ctx.beginPath()
  const points = 11
  for (let i = 0; i <= points; i += 1) {
    const angle = (i / points) * Math.PI * 2
    const radius = 58 + random() * 34
    const x = cx + Math.cos(angle) * radius
    const y = cy + Math.sin(angle) * radius * 0.8
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.fillStyle = spec.markPrimary
  ctx.fill()
  ctx.strokeStyle = spec.markSecondary
  ctx.lineWidth = 6
  ctx.stroke()

  // Grit thrown off the strike.
  for (let i = 0; i < 26; i += 1) {
    const angle = random() * Math.PI * 2
    const distance = 90 + random() * 160
    const size = 3 + random() * 7
    ctx.fillStyle = random() > 0.5 ? spec.markPrimary : spec.markSecondary
    ctx.fillRect(cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance, size, size)
  }
}

/**
 * The squadron roundel, stencilled dead centre behind the wordmark: three
 * flat rings, outer to inner, with the thin edge of overspray a stencil
 * leaves where the paint crept under the mask.
 */
function paintRoundel(ctx: CanvasRenderingContext2D, spec: TitleSpec, layout: ClothLayout): void {
  const [cx, cy] = layout.wordmarkCentre
  const rings: ReadonlyArray<readonly [number, string]> = [
    [1, spec.markPrimary],
    [0.66, ROUNDEL_WHITE],
    [0.33, spec.markSecondary],
  ]
  rings.forEach(([scale, colour]) => {
    ctx.beginPath()
    ctx.arc(cx, cy, PANEL_ROUNDEL_RADIUS * scale, 0, Math.PI * 2)
    ctx.fillStyle = colour
    ctx.fill()
  })
  // Overspray: a soft dark halo just outside the outer ring.
  ctx.beginPath()
  ctx.arc(cx, cy, PANEL_ROUNDEL_RADIUS + 4, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(0,0,0,0.18)'
  ctx.lineWidth = 8
  ctx.stroke()
}

function paintField(ctx: CanvasRenderingContext2D, spec: TitleSpec, layout: ClothLayout): void {
  if (spec.field === 'checker') paintCheckerField(ctx, spec, layout)
  else if (spec.field === 'hazard') paintHazardField(ctx, spec, layout)
  else paintSkinField(ctx, spec, layout)
}

function paintMarks(ctx: CanvasRenderingContext2D, spec: TitleSpec, layout: ClothLayout): void {
  if (spec.mark === 'splash') paintSplashes(ctx, spec)
  else if (spec.mark === 'impact') paintImpact(ctx, spec, layout)
  else paintRoundel(ctx, spec, layout)
}

/**
 * The rail a banner hangs from, and the hem that weights it. The rod is a
 * flat three-step steel, the loops are the cloth's own dark tone folded over
 * it, and the hem is a leather strip stitched across the bottom. Everything
 * above the rod between the loops stays transparent.
 */
function paintBannerRig(ctx: CanvasRenderingContext2D, spec: TitleSpec, layout: ClothLayout): void {
  // Rod, with finials at each end so it reads as a bar and not a stripe.
  const rodY = BANNER_ROD_TOP
  const rod = ctx.createLinearGradient(0, rodY, 0, rodY + BANNER_ROD_THICKNESS)
  rod.addColorStop(0, BANNER_ROD_HIGH)
  rod.addColorStop(0.4, BANNER_ROD_FACE)
  rod.addColorStop(1, BANNER_ROD_DARK)
  ctx.fillStyle = rod
  ctx.fillRect(0, rodY, layout.width, BANNER_ROD_THICKNESS)
  const finialRadius = BANNER_ROD_THICKNESS * 0.9
  const finialY = rodY + BANNER_ROD_THICKNESS / 2
  ;[finialRadius, layout.width - finialRadius].forEach((x) => {
    ctx.beginPath()
    ctx.arc(x, finialY, finialRadius, 0, Math.PI * 2)
    ctx.fillStyle = spec.accent
    ctx.fill()
    ctx.beginPath()
    ctx.arc(x - 4, finialY - 5, finialRadius * 0.35, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.fill()
  })

  // Loops of cloth over the rod, spaced evenly between the finials, hanging
  // down into the field.
  const loopMargin = finialRadius * 2 + 12
  const pitch = (layout.width - loopMargin * 2 - BANNER_LOOP_WIDTH) / (BANNER_LOOPS - 1)
  for (let loop = 0; loop < BANNER_LOOPS; loop += 1) {
    const x = loopMargin + loop * pitch
    ctx.fillStyle = spec.fieldDark
    ctx.fillRect(x, 0, BANNER_LOOP_WIDTH, BANNER_RAIL_HEIGHT + 6)
    // Fold shadow where the loop comes back over the rod.
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    ctx.fillRect(x, rodY + BANNER_ROD_THICKNESS, BANNER_LOOP_WIDTH, 6)
  }

  // Weighted hem.
  const hemY = layout.height - BANNER_HEM_HEIGHT
  ctx.fillStyle = BANNER_HEM
  ctx.fillRect(0, hemY, layout.width, BANNER_HEM_HEIGHT)
  ctx.fillStyle = 'rgba(255,255,255,0.08)'
  ctx.fillRect(0, hemY, layout.width, 3)
  ctx.strokeStyle = BANNER_STITCH
  ctx.lineWidth = 2
  ctx.setLineDash([10, 8])
  ctx.beginPath()
  ctx.moveTo(0, hemY + 14)
  ctx.lineTo(layout.width, hemY + 14)
  ctx.moveTo(0, layout.height - 12)
  ctx.lineTo(layout.width, layout.height - 12)
  ctx.stroke()
  ctx.setLineDash([])
}

/** One rivet: shadow under, domed body, a point of light on the dome. */
function paintRivet(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.beginPath()
  ctx.arc(x + 1, y + 2, PANEL_RIVET_RADIUS, 0, Math.PI * 2)
  ctx.fillStyle = PANEL_RIVET_SHADOW
  ctx.fill()
  ctx.beginPath()
  ctx.arc(x, y, PANEL_RIVET_RADIUS, 0, Math.PI * 2)
  ctx.fillStyle = PANEL_RIVET_BODY
  ctx.fill()
  ctx.beginPath()
  ctx.arc(x - 2, y - 2, PANEL_RIVET_RADIUS * 0.38, 0, Math.PI * 2)
  ctx.fillStyle = PANEL_RIVET_HIGH
  ctx.fill()
}

/** A seam between two plates: a dark line with the light catching one edge. */
function paintSeam(
  ctx: CanvasRenderingContext2D,
  from: readonly [number, number],
  to: readonly [number, number],
): void {
  ctx.lineWidth = 3
  ctx.strokeStyle = PANEL_SEAM_DARK
  ctx.beginPath()
  ctx.moveTo(from[0], from[1])
  ctx.lineTo(to[0], to[1])
  ctx.stroke()
  ctx.lineWidth = 1
  ctx.strokeStyle = PANEL_SEAM_LIGHT
  ctx.beginPath()
  ctx.moveTo(from[0] + 2, from[1] + 2)
  ctx.lineTo(to[0] + 2, to[1] + 2)
  ctx.stroke()

  // Rivets along the seam, offset to one side of it.
  const length = Math.hypot(to[0] - from[0], to[1] - from[1])
  const count = Math.floor(length / PANEL_RIVET_SPACING)
  const nx = (to[1] - from[1]) / length
  const ny = -(to[0] - from[0]) / length
  for (let i = 1; i < count; i += 1) {
    const t = i / count
    paintRivet(
      ctx,
      from[0] + (to[0] - from[0]) * t + nx * 14,
      from[1] + (to[1] - from[1]) * t + ny * 14,
    )
  }
}

/**
 * The propeller's sweep, smeared faintly across the paint: an idling blade is
 * not a blade but a translucent disc, and the eye catches it as a few soft
 * arcs. Drawn as annular sectors so they curve with the panel.
 */
function paintPropSweep(ctx: CanvasRenderingContext2D, layout: ClothLayout): void {
  const cx = layout.width / 2
  const cy = layout.height / 2
  const outer = layout.width / 2 - PANEL_MARGIN - PANEL_RIM_WIDTH
  for (let sweep = 0; sweep < PANEL_PROP_SWEEPS; sweep += 1) {
    const start = -Math.PI * 0.62 + sweep * ((Math.PI * 2) / PANEL_PROP_SWEEPS)
    const span = Math.PI * 0.34
    ctx.beginPath()
    ctx.arc(cx, cy, outer, start, start + span)
    ctx.arc(cx, cy, outer * 0.42, start + span, start, true)
    ctx.closePath()
    ctx.fillStyle = 'rgba(255,255,255,0.07)'
    ctx.fill()
    // The blade's leading edge, sharper than the smear behind it.
    ctx.beginPath()
    ctx.arc(cx, cy, outer * 0.86, start + span * 0.7, start + span)
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'
    ctx.lineWidth = 6
    ctx.stroke()
  }
}

/**
 * The panel's metalwork over the paint: rim bevel, the ring of rivets around
 * it, two seams where the plates meet. Painted after the roundel so the
 * roundel sits under the fixings, the way a stencil goes on after the
 * fitters have finished.
 */
function paintPanelRig(ctx: CanvasRenderingContext2D, layout: ClothLayout): void {
  const cx = layout.width / 2
  const cy = layout.height / 2
  const radius = layout.width / 2 - PANEL_MARGIN

  paintSeam(ctx, [cx - 150, cy - radius + 30], [cx - 150, cy + radius - 30])
  paintSeam(ctx, [cx - radius + 30, cy + 170], [cx + radius - 30, cy + 170])

  // Rim: dark bevel with a bright lip on the upper-left, where the light is.
  ctx.beginPath()
  ctx.arc(cx, cy, radius - PANEL_RIM_WIDTH / 2, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'
  ctx.lineWidth = PANEL_RIM_WIDTH
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(cx, cy, radius - 3, Math.PI * 0.85, Math.PI * 1.75)
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'
  ctx.lineWidth = 3
  ctx.stroke()

  const rivetRing = radius - PANEL_RIM_WIDTH - PANEL_RIVET_RADIUS - 8
  for (let i = 0; i < PANEL_RIVETS; i += 1) {
    const angle = (i / PANEL_RIVETS) * Math.PI * 2
    paintRivet(ctx, cx + Math.cos(angle) * rivetRing, cy + Math.sin(angle) * rivetRing)
  }
}

/**
 * Fits the wordmark to its sheet. The names are different lengths and a fixed
 * size overflowed the longest of them off the edge, so the face is measured
 * and stepped down until every line sits inside the safe width.
 */
function fitFont(
  ctx: CanvasRenderingContext2D,
  lines: readonly string[],
  maxWidth: number,
  fontFamily: string,
): number {
  let size = WORDMARK_MAX_SIZE
  while (size > WORDMARK_MIN_SIZE) {
    ctx.font = `${size}px ${fontFamily}`
    const widest = Math.max(...lines.map((line) => ctx.measureText(line).width))
    if (widest <= maxWidth) break
    size -= 4
  }
  return size
}

function paintWordmark(
  ctx: CanvasRenderingContext2D,
  spec: TitleSpec,
  layout: ClothLayout,
  fontFamily: string,
): void {
  const lines = layout.stackWordmark ? spec.wordmark.split(' ') : [spec.wordmark]
  const size = fitFont(ctx, lines, layout.wordmarkMaxWidth, fontFamily)
  const lineHeight = size * WORDMARK_LINE_HEIGHT
  const [centreX, centreY] = layout.wordmarkCentre
  const firstLineY = centreY - ((lines.length - 1) * lineHeight) / 2

  ctx.save()
  ctx.translate(centreX, centreY)
  ctx.transform(1, 0, spec.skew, 1, 0, 0)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `${size}px ${fontFamily}`

  // Cast shadow first, then the dark plate, then the metal, then the glint —
  // the same four passes an arcade logo of the period was airbrushed in.
  // Painted line by line so a stacked banner gets the full treatment on each.
  lines.forEach((line, index) => {
    const y = firstLineY - centreY + index * lineHeight

    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillText(line, 8, y + 10)

    ctx.lineJoin = 'round'
    ctx.strokeStyle = spec.plate
    ctx.lineWidth = 22
    ctx.strokeText(line, 0, y)

    ctx.strokeStyle = '#f2f2f2'
    ctx.lineWidth = 9
    ctx.strokeText(line, 0, y)

    const metal = ctx.createLinearGradient(0, y - size * 0.62, 0, y + size * 0.62)
    spec.metal.forEach(([position, colour]) => metal.addColorStop(position, colour))
    ctx.fillStyle = metal
    ctx.fillText(line, 0, y)
  })

  ctx.restore()

  const trademarkUnderLastLine = (): readonly [number, number] => {
    ctx.font = `${size}px ${fontFamily}`
    const lastWidth = ctx.measureText(lines[lines.length - 1]).width
    const lastY = firstLineY + (lines.length - 1) * lineHeight
    return [centreX + lastWidth / 2 + 10, lastY + size * 0.46]
  }
  const [trademarkX, trademarkY] = layout.trademark ?? trademarkUnderLastLine()

  ctx.save()
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  ctx.font = `26px ${fontFamily}`
  ctx.fillStyle = spec.accent
  ctx.fillText('TM', trademarkX, trademarkY)
  ctx.restore()
}

/** Clip everything that follows to the banner's cloth, between rail and hem. */
function clipBannerCloth(ctx: CanvasRenderingContext2D, layout: ClothLayout): void {
  ctx.beginPath()
  ctx.rect(0, BANNER_RAIL_HEIGHT, layout.width, layout.height - BANNER_RAIL_HEIGHT)
  ctx.clip()
}

/** Clip everything that follows to the panel's disc. */
function clipPanelDisc(ctx: CanvasRenderingContext2D, layout: ClothLayout): void {
  ctx.beginPath()
  ctx.arc(layout.width / 2, layout.height / 2, layout.width / 2 - PANEL_MARGIN, 0, Math.PI * 2)
  ctx.clip()
}

/**
 * Paints one shape, start to finish. The order is the same for all three —
 * surface, grain, marks, rig, wordmark — but what is clipped and what rig is
 * bolted on differs, and that is the whole of the difference between a flag,
 * a banner and a panel at the bitmap level.
 */
function paintShape(
  ctx: CanvasRenderingContext2D,
  spec: TitleSpec,
  layout: ClothLayout,
  fontFamily: string,
): void {
  ctx.clearRect(0, 0, layout.width, layout.height)

  if (spec.shape === 'flag') {
    paintField(ctx, spec, layout)
    paintGrain(ctx, layout, 0x5eed)
    paintMarks(ctx, spec, layout)
  } else if (spec.shape === 'banner') {
    ctx.save()
    clipBannerCloth(ctx, layout)
    paintField(ctx, spec, layout)
    paintGrain(ctx, layout, 0x5eed)
    paintMarks(ctx, spec, layout)
    ctx.restore()
    paintBannerRig(ctx, spec, layout)
  } else {
    ctx.save()
    clipPanelDisc(ctx, layout)
    paintField(ctx, spec, layout)
    paintGrain(ctx, layout, 0x5eed)
    paintMarks(ctx, spec, layout)
    paintPropSweep(ctx, layout)
    paintPanelRig(ctx, layout)
    ctx.restore()
  }

  paintWordmark(ctx, spec, layout, fontFamily)
}

/**
 * Bakes a title. Call only in the browser, and only once the display face has
 * loaded — a canvas that draws before the font arrives silently bakes the
 * fallback and there is no second chance to repaint the texture.
 *
 * `spec` defaults to the racer so the cabinet's boot gate, which has only ever
 * had one flag, keeps calling this with a font and nothing else.
 */
export function createFlagTexture(
  fontFamily: string,
  spec: TitleSpec = RACE_TITLE,
): THREE.CanvasTexture {
  const layout = CLOTH_LAYOUTS[spec.shape]
  const canvas = document.createElement('canvas')
  canvas.width = layout.width
  canvas.height = layout.height
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('Title flag: 2D context unavailable')

  ctx.imageSmoothingEnabled = false
  paintShape(ctx, spec, layout, fontFamily)

  const texture = new THREE.CanvasTexture(canvas)
  // Nearest sampling and no mips: the console had neither, and the crawl on
  // the field edges as the cloth moves is the entire point.
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.anisotropy = 1
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}
