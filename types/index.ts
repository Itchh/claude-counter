export interface DevEntry {
  /**
   * The driver's own key, as registered by the reporter. Optional because a
   * deployed query can lag the source that declares it; callers fall back to
   * the lowercased name, which is what the reporter keys on anyway.
   */
  key?: string
  name: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  /** Raw Claude model id -> tokens. Collapsed to families at render time. */
  tokensByModel: Record<string, number>
  tokensToday: number
  sessionCount: number
  lastSeen: string
  color: string | null
  /** Paint-shop hex, null until the driver has opened the shop. */
  paint: string | null
  /** Livery pattern id from lib/livery.ts, null until chosen. */
  livery: string | null
  /**
   * Chosen chassis index, null until chosen. Optional for the same reason
   * `key` is: a deployed query can lag the source that declares it.
   */
  chassis?: number | null
}

export interface LeaderboardEntry extends DevEntry {
  rank: number
  isOnline: boolean
}

export interface LeaderboardStore {
  entries: Record<string, DevEntry>
  updatedAt: string
}

export interface LeaderboardResponse {
  leaderboard: ReadonlyArray<LeaderboardEntry>
  totalTokens: number
  updatedAt: string
}

export interface ReportBody {
  name: string
  secret: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  tokensByModel?: Record<string, number>
  tokensToday: number
  sessionCount: number
  color?: string
}

export type LeaderboardEventType =
  | 'milestone'
  | 'new_leader'
  | 'user_joined'
  | 'control_taken'
  | 'control_released'
  | 'hot_lap'

export interface LeaderboardEvent {
  id: string
  type: LeaderboardEventType
  name: string
  color: string | null
  value: number | null
  timestamp: number
}

export interface TimelineUser {
  key: string
  name: string
  color: string | null
  points: ReadonlyArray<{ t: number; v: number }>
}
