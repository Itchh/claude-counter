import { GAMES, type CabinetGame } from '../cabinet/games'

// What the arcade's screen lists: every game, then the one row that is not a
// game. The order is the order the cursor walks, and the row ids are what the
// scene reports back when one is chosen.

export const SETUP_ROW_ID = 'setup'

export type RoomRowId = CabinetGame | typeof SETUP_ROW_ID

export interface RoomRow {
  readonly id: RoomRowId
  readonly name: string
  readonly blurb: string
}

export const ROOM_ROWS: ReadonlyArray<RoomRow> = [
  ...GAMES.map((game) => ({ id: game.id, name: game.name, blurb: game.blurb })),
  {
    id: SETUP_ROW_ID,
    name: 'Connect your Claude',
    blurb: 'Install the reporter on your Mac and get on the board.',
  },
]

export function isSetupRow(id: RoomRowId): id is typeof SETUP_ROW_ID {
  return id === SETUP_ROW_ID
}

/** Wraps at both ends, the way a cabinet's menu did. */
export function stepRow(index: number, delta: number): number {
  return (index + delta + ROOM_ROWS.length) % ROOM_ROWS.length
}
