// One spec per game, and the whole of a title flag's identity lives in it:
// what the cloth is printed with, what the wordmark is cut from, and what is
// thrown across it. The baker in flagTexture reads this and nothing else, so
// a new game's title is an entry here rather than a second canvas routine.
//
// The three are deliberately not one template recoloured. A racing logo, a
// fighting logo and a squadron badge were three different jobs in the period
// this is borrowing from, and the field painters keep that difference: a
// starting grid's checker, a hazard stripe, a painted sky.

/** How the cloth itself is printed, before anything is thrown at it. */
export type FieldKind = 'checker' | 'hazard' | 'sky'

/** What is scattered over the cloth around the wordmark. */
export type MarkKind = 'splash' | 'impact' | 'roundel'

export interface TitleSpec {
  readonly id: string
  /** Painted straight onto the cloth, so it warps with the ripple. */
  readonly wordmark: string
  /** Shown under the flag on an attract card. */
  readonly subtitle: string
  readonly field: FieldKind
  /** Two tones the field painter alternates between. */
  readonly fieldLight: string
  readonly fieldDark: string
  readonly mark: MarkKind
  readonly markPrimary: string
  readonly markSecondary: string
  /** Vertical gradient down the letterform, top to bottom. */
  readonly metal: ReadonlyArray<readonly [number, string]>
  /** Plate cut behind the letters. */
  readonly plate: string
  /** Italic lean. Racing leans hard, a squadron badge sits square. */
  readonly skew: number
  /** The game's key colour, used by the card's furniture. */
  readonly accent: string
  /** Sky behind the cloth, top to bottom. */
  readonly sky: ReadonlyArray<readonly [number, string]>
}

/**
 * The original, unchanged: a starting grid's checker, a logo airbrushed in
 * red chrome, and the green splash that has been on the cabinet's boot screen
 * since the first build.
 */
export const RACE_TITLE: TitleSpec = {
  id: 'race',
  wordmark: 'CLAUDE RACER',
  subtitle: 'TOKEN GRAND PRIX',
  field: 'checker',
  fieldLight: '#b9b9c1',
  fieldDark: '#6d6d78',
  mark: 'splash',
  markPrimary: '#5ad12e',
  markSecondary: '#2f8f16',
  metal: [
    [0, '#ff5a3c'],
    [0.42, '#d81c22'],
    [0.5, '#ffffff'],
    [0.58, '#c8121f'],
    [1, '#ff8a2b'],
  ],
  plate: '#1a0a08',
  skew: -0.16,
  accent: '#e02020',
  sky: [
    [0, '#0a1f8c'],
    [0.46, '#123ac4'],
    [0.62, '#1a5ae0'],
    [0.74, '#08122e'],
    [1, '#050a1c'],
  ],
}

/**
 * The fight's cloth is a ring apron, not a grid: heavy amber hazard stripes
 * running on the diagonal, the wordmark struck in gold rather than chrome,
 * and dark impacts thrown at it instead of paint.
 */
export const FIGHT_TITLE: TitleSpec = {
  id: 'fight',
  wordmark: 'CLAUDE FIGHTER',
  subtitle: 'IRON FIST',
  field: 'hazard',
  fieldLight: '#c48a16',
  fieldDark: '#2a2016',
  mark: 'impact',
  markPrimary: '#8e1410',
  markSecondary: '#3d0806',
  metal: [
    [0, '#ffe9a6'],
    [0.38, '#ffb020'],
    [0.5, '#ffffff'],
    [0.62, '#d98a06'],
    [1, '#8a4f04'],
  ],
  plate: '#140c04',
  skew: -0.05,
  accent: '#ffb020',
  sky: [
    [0, '#2a1004'],
    [0.44, '#6a2a08'],
    [0.6, '#a04410'],
    [0.74, '#1c0c04'],
    [1, '#0a0502'],
  ],
}

/**
 * The squadron badge sits square — no racing lean — on a painted sky rather
 * than a printed field, with roundels where the other two carry splashes.
 * Steel and navy, because it is a serial plate, not a logo.
 */
export const DOGFIGHT_TITLE: TitleSpec = {
  id: 'dogfight',
  wordmark: 'CLAUDE ACES',
  subtitle: 'ANGELS ONE-FIVE',
  field: 'sky',
  fieldLight: '#cfd9e4',
  fieldDark: '#5d7fa8',
  mark: 'roundel',
  markPrimary: '#1b3a8f',
  markSecondary: '#b3202a',
  metal: [
    [0, '#f2f6fb'],
    [0.4, '#9fb4cc'],
    [0.5, '#ffffff'],
    [0.6, '#3d5c8c'],
    [1, '#16264a'],
  ],
  plate: '#0a1020',
  skew: 0,
  accent: '#1b3a8f',
  sky: [
    [0, '#0d2d5e'],
    [0.42, '#2f6aa8'],
    [0.6, '#79a6cb'],
    [0.76, '#0e1e38'],
    [1, '#050a16'],
  ],
}

export const TITLE_SPECS: ReadonlyArray<TitleSpec> = [
  RACE_TITLE,
  FIGHT_TITLE,
  DOGFIGHT_TITLE,
]

/** CSS gradient string for a spec's sky, so the card and the canvas agree. */
export function skyGradient(spec: TitleSpec): string {
  const stops = spec.sky
    .map(([position, colour]) => `${colour} ${(position * 100).toFixed(0)}%`)
    .join(', ')
  return `linear-gradient(to bottom, ${stops})`
}
