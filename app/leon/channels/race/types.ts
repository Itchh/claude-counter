// Shared shape between the Convex `getRace` query and the scene. Declared
// here rather than imported from convex/ so the 3D code has no backend
// dependency and can be driven by fixtures when tuning.

export interface RacerState {
  readonly key: string
  readonly name: string
  readonly color: string | null
  /** Paint-shop hex, null until the driver has opened the shop. */
  readonly paint: string | null
  /** Livery pattern id from lib/livery.ts, null until chosen. */
  readonly livery: string | null
  /** Chosen chassis index into CAR_MODELS, null until chosen. */
  readonly chassis: number | null
  /** The hangar's choices: airframe index into AIRFRAMES, paint, pattern. */
  readonly airframe: number | null
  readonly planePaint: string | null
  readonly planeLivery: string | null
  /** The dojo's choices: fighter index into FIGHTERS, gi paint, pattern. */
  readonly fighter: number | null
  readonly fightPaint: string | null
  readonly fightLivery: string | null
  readonly rank: number
  readonly score: number
  readonly rawTokens: number
  readonly multiplier: number
  readonly velocityTokensPerMin: number
  readonly isActive: boolean
  /**
   * Set only by lib/cpuRoster.ts on the bots it pads a field with. The
   * server never sends it; a real racer simply has no such field.
   */
  readonly isCpu?: boolean
}

export interface RaceSnapshot {
  readonly period: string
  readonly periodKey: string
  readonly racers: ReadonlyArray<RacerState>
  readonly updatedAt: number
  readonly totalScore: number
}
