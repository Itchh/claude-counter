// What a driver may paint their car, and the patterns they may paint on it.
//
// One catalogue, read by three places that must never disagree: the paint
// shop offers these, the Convex mutation refuses anything outside them, and
// the shader draws them by id. A pattern is a number on the GPU and a string
// everywhere else, so the id here is the contract between the two — never
// reorder the shader ids, only append.
//
// The palette is the deck's own signal colours rather than a paint chart. A
// driver's car has to be findable on a 288-line picture from across a room,
// which rules out anything that goes grey at that size.

export interface PaintOption {
  readonly id: string
  readonly name: string
  readonly hex: string
}

export const PAINTS: ReadonlyArray<PaintOption> = [
  { id: 'cyan', name: 'Cyan', hex: '#00f0ff' },
  { id: 'magenta', name: 'Magenta', hex: '#ff2d95' },
  { id: 'green', name: 'Green', hex: '#00ff88' },
  { id: 'gold', name: 'Gold', hex: '#ffb020' },
  { id: 'red', name: 'Red', hex: '#ff4d4d' },
  { id: 'violet', name: 'Violet', hex: '#9d7bff' },
  { id: 'blue', name: 'Race blue', hex: '#2b4dd8' },
  { id: 'bone', name: 'Bone', hex: '#d8d4c4' },
]

export interface LiveryOption {
  readonly id: string
  readonly name: string
  /**
   * The number the fragment shader switches on. Fixed for the life of the
   * pattern: a stored livery is this string, and the shader is the only thing
   * that knows what the number means.
   */
  readonly shaderId: number
  /** One line, shown under the pattern in the paint shop. */
  readonly note: string
}

export const LIVERIES: ReadonlyArray<LiveryOption> = [
  { id: 'plain', name: 'Plain', shaderId: 0, note: 'Bare paint' },
  { id: 'twin-stripe', name: 'Twin stripe', shaderId: 1, note: 'Two flank bands' },
  { id: 'bolt', name: 'Bolt', shaderId: 2, note: 'Chevron, nose down' },
  { id: 'check', name: 'Check', shaderId: 3, note: 'Chequer band' },
  { id: 'split', name: 'Split', shaderId: 4, note: 'Nose in the light tone' },
  { id: 'roundel', name: 'Roundel', shaderId: 5, note: 'Door plate and rules' },
  { id: 'pinstripe', name: 'Pinstripe', shaderId: 6, note: 'Two hairlines' },
  { id: 'blocks', name: 'Blocks', shaderId: 7, note: 'Staggered, rising' },
  { id: 'spine', name: 'Spine', shaderId: 8, note: 'Over the roof, nose to tail' },
]

export const DEFAULT_LIVERY_ID = 'plain'

export function isPaintHex(hex: string): boolean {
  return PAINTS.some((paint) => paint.hex === hex)
}

export function isLiveryId(id: string): boolean {
  return LIVERIES.some((livery) => livery.id === id)
}

/** The shader's number for a stored id. Unknown ids fall back to plain. */
export function liveryShaderId(id: string | null): number {
  if (id === null) return 0
  return LIVERIES.find((livery) => livery.id === id)?.shaderId ?? 0
}

export function liveryName(id: string | null): string {
  if (id === null) return 'Plain'
  return LIVERIES.find((livery) => livery.id === id)?.name ?? 'Plain'
}
