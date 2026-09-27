import * as THREE from 'three'

// Flipbooks: the era's explosions, sparks and smoke were a handful of frames
// on one page, stepped through in order and drawn as a billboard. These are
// painted here at texel size on a 2D canvas rather than downloaded, for the
// same reason every other page in the cabinet is baked: a photographed
// explosion scaled to sixty-four texels is a smear, and a drawn one at
// sixty-four texels is a drawing. Palette-limited, hard-edged, no blending
// inside a frame — the hardware had none.
//
// One sheet per kind, made once per page load and shared: every explosion in
// the dogfight and every crash on the circuit reads from the same texture.

export interface FlipbookSheet {
  readonly texture: THREE.CanvasTexture
  readonly frames: number
  readonly columns: number
  readonly rows: number
  /** Texels a frame is, square. */
  readonly frameSize: number
  /** Seconds the whole book plays for at its authored pace. */
  readonly duration: number
}

/** The fire palette, dark to hot. Five stops is all the era's fire had. */
const FIRE: ReadonlyArray<string> = ['#2a0a02', '#8a1c06', '#e8541a', '#ffb028', '#fff4b8']
/** The smoke palette, thick to thin. */
const SMOKE: ReadonlyArray<string> = ['#16161a', '#33333a', '#5a5a62', '#8a8a92']
/** Sparks: hot metal, two tones. */
const SPARK: ReadonlyArray<string> = ['#ffd24a', '#fff6d0']

function makeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('flipbook: no 2D context')
  ctx.imageSmoothingEnabled = false
  return { canvas, ctx }
}

function sheetTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * A deterministic hash for the scatter, so a frame paints the same every
 * page load: the same explosion every time is what a sprite is.
 */
function scatter(seed: number): number {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

/** Fills a texel-hard blob: a circle whose edge is decided per texel, no AA. */
function blob(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number, colour: string, seed: number, roughness: number): void {
  ctx.fillStyle = colour
  const r = Math.ceil(radius + roughness)
  for (let y = -r; y <= r; y += 1) {
    for (let x = -r; x <= r; x += 1) {
      const wobble = (scatter(seed + x * 7 + y * 13) - 0.5) * 2 * roughness
      if (Math.hypot(x, y) <= radius + wobble) ctx.fillRect(Math.round(cx + x), Math.round(cy + y), 1, 1)
    }
  }
}

let explosionSheet: FlipbookSheet | null = null

/**
 * The explosion: twelve frames, sixty-four texels. A flash, a fireball that
 * grows and cools through the fire palette, then a column of smoke that
 * thins and rises. The last frames are mostly smoke, which is what makes the
 * end of it read as an event that happened rather than a sprite that
 * stopped.
 */
export function getExplosionSheet(): FlipbookSheet {
  if (explosionSheet) return explosionSheet
  const frameSize = 64
  const frames = 12
  const columns = 4
  const rows = 3
  const { canvas, ctx } = makeCanvas(frameSize * columns, frameSize * rows)
  for (let frame = 0; frame < frames; frame += 1) {
    const ox = (frame % columns) * frameSize
    const oy = Math.floor(frame / columns) * frameSize
    const t = frame / (frames - 1)
    const cx = ox + frameSize / 2
    const baseY = oy + frameSize * 0.68
    // Smoke first, behind the fire: a column that climbs as the fire dies.
    if (frame >= 2) {
      const rise = (frame - 2) * 3.2
      const puffs = 3 + Math.min(4, frame - 2)
      for (let i = 0; i < puffs; i += 1) {
        const s = frame * 31 + i * 17
        const px = cx + (scatter(s) - 0.5) * (10 + frame * 1.4)
        const py = baseY - rise - i * 4.5 - scatter(s + 3) * 6
        const pr = 5 + scatter(s + 5) * 5 + Math.min(6, frame * 0.6)
        const tone = SMOKE[Math.min(SMOKE.length - 1, Math.floor(t * SMOKE.length))]
        blob(ctx, px, py, pr * (1 - t * 0.35), tone, s, 1.6)
      }
    }
    // The fireball: fast up, then it cools and shrinks into the smoke.
    if (frame <= 7) {
      const grow = frame <= 3 ? 8 + frame * 6 : 26 - (frame - 3) * 4
      const heat = Math.max(0, 1 - frame / 7)
      const layers: ReadonlyArray<readonly [number, number]> = [
        [1, 0],
        [0.72, 1],
        [0.48, 2],
        [0.26, 3],
        [0.12, 4],
      ]
      for (const [scale, stop] of layers) {
        const index = Math.min(FIRE.length - 1, Math.max(0, stop - Math.round((1 - heat) * 2)))
        blob(ctx, cx, baseY - frame * 1.2, grow * scale, FIRE[index], frame * 11 + stop * 5, 2.4)
      }
    }
    // Debris: a few hot texels thrown out on the early frames.
    if (frame >= 1 && frame <= 5) {
      for (let i = 0; i < 9; i += 1) {
        const s = frame * 53 + i * 19
        const angle = scatter(s) * Math.PI * 2
        const dist = 8 + frame * 5 + scatter(s + 1) * 6
        ctx.fillStyle = SPARK[i % 2]
        ctx.fillRect(Math.round(cx + Math.cos(angle) * dist), Math.round(baseY - 6 - Math.abs(Math.sin(angle)) * dist * 0.8 + frame * 1.5), 1, 1)
      }
    }
    // The flash, frame zero only: a white core the size of the first fire.
    if (frame === 0) blob(ctx, cx, baseY, 5, FIRE[4], 99, 1)
  }
  explosionSheet = { texture: sheetTexture(canvas), frames, columns, rows, frameSize, duration: 1.1 }
  return explosionSheet
}

let impactSheet: FlipbookSheet | null = null

/**
 * The impact: six frames, thirty-two texels. A burst of sparks and a puff,
 * for a car nudging a car or a wingtip catching a wall — the small hit
 * that is not a crash.
 */
export function getImpactSheet(): FlipbookSheet {
  if (impactSheet) return impactSheet
  const frameSize = 32
  const frames = 6
  const columns = 6
  const rows = 1
  const { canvas, ctx } = makeCanvas(frameSize * columns, frameSize * rows)
  for (let frame = 0; frame < frames; frame += 1) {
    const ox = frame * frameSize
    const cx = ox + frameSize / 2
    const cy = frameSize / 2
    const spread = 3 + frame * 3.2
    if (frame <= 1) blob(ctx, cx, cy, 4 - frame, FIRE[4], frame, 1)
    if (frame >= 1) blob(ctx, cx, cy - frame, 3 + frame * 0.6, SMOKE[Math.min(3, frame)], frame * 7, 1.2)
    for (let i = 0; i < 10; i += 1) {
      const s = frame * 41 + i * 23
      const angle = scatter(s) * Math.PI * 2
      const dist = spread * (0.5 + scatter(s + 1) * 0.5)
      ctx.fillStyle = frame < 4 ? SPARK[i % 2] : FIRE[2]
      const x = Math.round(cx + Math.cos(angle) * dist)
      const y = Math.round(cy + Math.sin(angle) * dist * 0.7 + frame * 0.8)
      ctx.fillRect(x, y, 1, 1)
      if (frame < 3) ctx.fillRect(x - Math.sign(Math.cos(angle)), y, 1, 1)
    }
  }
  impactSheet = { texture: sheetTexture(canvas), frames, columns, rows, frameSize, duration: 0.42 }
  return impactSheet
}

/**
 * One playing flipbook: a sprite whose page window steps through the sheet.
 * Cheap enough to pool — each is a Sprite with its own material so the
 * frame offset is per instance while the texture itself is shared.
 */
export class Flipbook {
  readonly sprite: THREE.Sprite
  private readonly material: THREE.SpriteMaterial
  private readonly sheet: FlipbookSheet
  private elapsed = 0
  private playing = false

  constructor(sheet: FlipbookSheet, worldSize: number) {
    this.sheet = sheet
    // Each instance clones the texture object (not the image) so its
    // offset/repeat window is its own.
    const texture = sheet.texture.clone()
    texture.needsUpdate = true
    texture.repeat.set(1 / sheet.columns, 1 / sheet.rows)
    this.material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false })
    this.sprite = new THREE.Sprite(this.material)
    this.sprite.scale.setScalar(worldSize)
    this.sprite.visible = false
  }

  /** Starts the book from its first frame at `position`. */
  play(position: THREE.Vector3): void {
    this.sprite.position.copy(position)
    this.elapsed = 0
    this.playing = true
    this.sprite.visible = true
    this.showFrame(0)
  }

  get isPlaying(): boolean {
    return this.playing
  }

  /** Advances by `delta` seconds; hides itself when the last frame has shown. */
  update(delta: number): void {
    if (!this.playing) return
    this.elapsed += delta
    const frame = Math.floor((this.elapsed / this.sheet.duration) * this.sheet.frames)
    if (frame >= this.sheet.frames) {
      this.playing = false
      this.sprite.visible = false
      return
    }
    this.showFrame(frame)
  }

  private showFrame(frame: number): void {
    const map = this.material.map
    if (!map) return
    const column = frame % this.sheet.columns
    // Sheets are painted top-down; texture v runs bottom-up.
    const row = this.sheet.rows - 1 - Math.floor(frame / this.sheet.columns)
    map.offset.set(column / this.sheet.columns, row / this.sheet.rows)
  }

  dispose(): void {
    this.material.map?.dispose()
    this.material.dispose()
  }
}
