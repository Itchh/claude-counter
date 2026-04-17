export interface DevEntry {
  name: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  tokensToday: number
  sessionCount: number
  lastSeen: string
  color: string | null
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
  tokensToday: number
  sessionCount: number
  color?: string
}

export interface TimelineUser {
  key: string
  name: string
  color: string | null
  points: ReadonlyArray<{ t: number; v: number }>
}
