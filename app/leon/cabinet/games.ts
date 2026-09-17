// The library: every game the cabinet can run, in one list. The shelf draws
// a cartridge per entry, the menu names the current one, and the G key walks
// this array — adding a game is one entry here plus its channel.

export type CabinetGame = 'race' | 'fight' | 'dogfight'

/** What the screen can be showing: a game, or the shelf they live on. */
export type CabinetScreen = CabinetGame | 'shelf'

export interface GameInfo {
  readonly id: CabinetGame
  readonly name: string
  readonly blurb: string
  /** Cartridge shell colour on the shelf. */
  readonly shell: string
  /** Label sticker's band colour — the game's own key colour. */
  readonly accent: string
}

export const GAMES: ReadonlyArray<GameInfo> = [
  {
    id: 'race',
    name: 'Token Grand Prix',
    blurb: 'Karts driven by live burn rate. Laps accumulate all day.',
    shell: '#8a8a96',
    accent: '#e02020',
  },
  {
    id: 'fight',
    name: 'Iron Fist',
    blurb: 'Rival ranks trade blows. Health from score, offence from live burn.',
    shell: '#5a5a68',
    accent: '#ffb020',
  },
  {
    id: 'dogfight',
    name: 'Angels One-Five',
    blurb: 'The squadron over Kent. Airframe from score, gunnery from burn.',
    shell: '#6a7a8a',
    accent: '#1b3a8f',
  },
]

export function isCabinetGame(value: string | null): value is CabinetGame {
  return GAMES.some((game) => game.id === value)
}

export function isCabinetScreen(value: string | null): value is CabinetScreen {
  return value === 'shelf' || isCabinetGame(value)
}

export function gameInfo(id: CabinetGame): GameInfo {
  const found = GAMES.find((game) => game.id === id)
  if (!found) throw new Error(`Unknown game "${id}"`)
  return found
}

/** The next game along the shelf, for the G key's quick flick. */
export function nextGame(current: CabinetScreen): CabinetGame {
  const index = GAMES.findIndex((game) => game.id === current)
  return GAMES[(index + 1) % GAMES.length].id
}
