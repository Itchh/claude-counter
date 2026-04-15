export interface DevEntry {
  name: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  tokensToday: number
  sessionCount: number
  lastSeen: string
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
}
