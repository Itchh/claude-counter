// Shared shape between the Convex `getRace` query and the scene. Declared
// here rather than imported from convex/ so the 3D code has no backend
// dependency and can be driven by fixtures when tuning.

export interface RacerState {
  readonly key: string
  readonly name: string
  readonly color: string | null
  readonly rank: number
  readonly score: number
  readonly rawTokens: number
  readonly multiplier: number
  readonly velocityTokensPerMin: number
  readonly isActive: boolean
}

export interface RaceSnapshot {
  readonly period: string
  readonly periodKey: string
  readonly racers: ReadonlyArray<RacerState>
  readonly updatedAt: number
  readonly totalScore: number
}
