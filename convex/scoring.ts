import { query, internalMutation } from "./_generated/server"
import { v } from "convex/values"
import { internal } from "./_generated/api"

// Everything game-facing derives from here. Tokens are the only real currency
// this app has, so score, velocity and rank are all functions of buckets.

const BUCKET_MS = 5 * 60_000
const BUCKET_RETENTION_MS = 48 * 60 * 60_000
const SESSION_RETENTION_MS = 48 * 60 * 60_000
const GC_BATCH_SIZE = 500

/**
 * The daily reset boundary. Fixed rather than per-user: a shared office screen
 * needs one authoritative "today", and the reporter's local-date `tokensToday`
 * is exactly the thing this replaces.
 */
const SCORING_TIME_ZONE = "Europe/London"

const MAX_BUCKETS_PER_REPORT = 400
const MAX_SESSIONS_PER_REPORT = 8
/** Guards against a machine with a badly wrong clock poisoning the day. */
const MAX_CLOCK_SKEW_MS = 10 * 60_000

export interface PeriodKeys {
  readonly day: string
  readonly week: string
  readonly month: string
}

/**
 * Calendar parts for an instant in SCORING_TIME_ZONE. Intl is the only way to
 * do this correctly without a date library — it handles BST transitions, which
 * a fixed UTC offset would get wrong for half the year.
 */
function zonedParts(at: number): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: SCORING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  const parts = formatter.formatToParts(new Date(at))
  const lookup = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0")
  return { year: lookup("year"), month: lookup("month"), day: lookup("day") }
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

/** ISO week, so a week rolls over on Monday rather than mid-week. */
function isoWeekKey(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day))
  const dayOfWeek = date.getUTCDay() === 0 ? 7 : date.getUTCDay()
  date.setUTCDate(date.getUTCDate() + 4 - dayOfWeek)
  const isoYear = date.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4))
  const firstDayOfWeek = firstThursday.getUTCDay() === 0 ? 7 : firstThursday.getUTCDay()
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 4 - firstDayOfWeek)
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000))
  return `${isoYear}-W${pad(week)}`
}

export function toPeriodKeys(at: number): PeriodKeys {
  const { year, month, day } = zonedParts(at)
  return {
    day: `${year}-${pad(month)}-${pad(day)}`,
    week: isoWeekKey(year, month, day),
    month: `${year}-${pad(month)}`,
  }
}

/**
 * Multiplier hook. Ships at 1.0 deliberately — session windows are being
 * collected now so the mechanic can be tuned against real history rather than
 * guessed at before the race even looks good. Wire the maths in here and every
 * score, leaderboard and period rolls up through it unchanged.
 */
export function computeMultiplier(
  _sessions: ReadonlyArray<{ startedAt: number; lastActivityAt: number }>,
  _now: number,
): number {
  return 1.0
}

interface IncomingBucket {
  bucketStart: number
  tokens: number
}

interface IncomingSession {
  startedAt: number
  lastActivityAt: number
}

/**
 * Idempotent per (userKey, deviceId, bucketStart). A reporter restart re-sends
 * overlapping buckets, and overwriting rather than adding is what stops that
 * from inflating anyone's score.
 */
export const applyReportDetail = internalMutation({
  args: {
    userKey: v.string(),
    deviceId: v.string(),
    name: v.string(),
    color: v.optional(v.string()),
    buckets: v.array(
      v.object({ bucketStart: v.number(), tokens: v.number() }),
    ),
    sessions: v.array(
      v.object({ startedAt: v.number(), lastActivityAt: v.number() }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const horizon = now + MAX_CLOCK_SKEW_MS
    const floor = now - BUCKET_RETENTION_MS

    const buckets: IncomingBucket[] = args.buckets
      .filter(
        (bucket) =>
          Number.isFinite(bucket.bucketStart) &&
          Number.isFinite(bucket.tokens) &&
          bucket.tokens > 0 &&
          bucket.bucketStart >= floor &&
          bucket.bucketStart <= horizon,
      )
      .slice(0, MAX_BUCKETS_PER_REPORT)

    for (const bucket of buckets) {
      // Normalise to the grid rather than trusting the client's arithmetic.
      const bucketStart = Math.floor(bucket.bucketStart / BUCKET_MS) * BUCKET_MS
      const existing = await ctx.db
        .query("buckets")
        .withIndex("by_userKey_deviceId_bucketStart", (q) =>
          q
            .eq("userKey", args.userKey)
            .eq("deviceId", args.deviceId)
            .eq("bucketStart", bucketStart),
        )
        .unique()

      if (existing) {
        if (existing.tokens !== bucket.tokens) {
          await ctx.db.patch(existing._id, { tokens: bucket.tokens })
        }
      } else {
        await ctx.db.insert("buckets", {
          userKey: args.userKey,
          deviceId: args.deviceId,
          bucketStart,
          tokens: bucket.tokens,
        })
      }
    }

    const sessions: IncomingSession[] = args.sessions
      .filter(
        (session) =>
          Number.isFinite(session.startedAt) &&
          Number.isFinite(session.lastActivityAt) &&
          session.lastActivityAt >= session.startedAt &&
          session.startedAt <= horizon &&
          session.lastActivityAt >= now - SESSION_RETENTION_MS,
      )
      .slice(0, MAX_SESSIONS_PER_REPORT)

    for (const session of sessions) {
      const existing = await ctx.db
        .query("sessions")
        .withIndex("by_userKey_deviceId_startedAt", (q) =>
          q
            .eq("userKey", args.userKey)
            .eq("deviceId", args.deviceId)
            .eq("startedAt", session.startedAt),
        )
        .unique()

      if (existing) {
        if (existing.lastActivityAt < session.lastActivityAt) {
          await ctx.db.patch(existing._id, { lastActivityAt: session.lastActivityAt })
        }
      } else {
        await ctx.db.insert("sessions", {
          userKey: args.userKey,
          deviceId: args.deviceId,
          startedAt: session.startedAt,
          lastActivityAt: session.lastActivityAt,
        })
      }
    }

    await ctx.runMutation(internal.scoring.recomputeUserScores, {
      userKey: args.userKey,
      name: args.name,
      ...(args.color !== undefined ? { color: args.color } : {}),
    })
  },
})

/** Earliest instant still inside the given period. */
function periodStart(period: "day" | "week" | "month", at: number): number {
  const { year, month, day } = zonedParts(at)
  if (period === "month") {
    return Date.UTC(year, month - 1, 1) - dstOffsetGuess(at)
  }
  if (period === "week") {
    const date = new Date(Date.UTC(year, month - 1, day))
    const dayOfWeek = date.getUTCDay() === 0 ? 7 : date.getUTCDay()
    date.setUTCDate(date.getUTCDate() - (dayOfWeek - 1))
    return date.getTime() - dstOffsetGuess(at)
  }
  return Date.UTC(year, month - 1, day) - dstOffsetGuess(at)
}

/**
 * Offset between UTC and SCORING_TIME_ZONE at a given instant, so a "midnight
 * London" boundary lands on the right UTC millisecond in both GMT and BST.
 */
function dstOffsetGuess(at: number): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: SCORING_TIME_ZONE,
    timeZoneName: "longOffset",
  })
  const name = formatter
    .formatToParts(new Date(at))
    .find((part) => part.type === "timeZoneName")?.value
  const match = name?.match(/GMT([+-])(\d{2}):(\d{2})/)
  if (!match) return 0
  const sign = match[1] === "-" ? -1 : 1
  return sign * (Number(match[2]) * 3_600_000 + Number(match[3]) * 60_000)
}

export const recomputeUserScores = internalMutation({
  args: {
    userKey: v.string(),
    name: v.string(),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now()
    const keys = toPeriodKeys(now)
    const periods: ReadonlyArray<"day" | "week" | "month"> = ["day", "week", "month"]

    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_userKey_startedAt", (q) => q.eq("userKey", args.userKey))
      .order("desc")
      .take(MAX_SESSIONS_PER_REPORT)

    const multiplier = computeMultiplier(sessions, now)

    for (const period of periods) {
      const since = periodStart(period, now)
      const rows = await ctx.db
        .query("buckets")
        .withIndex("by_userKey_bucketStart", (q) =>
          q.eq("userKey", args.userKey).gte("bucketStart", since),
        )
        .collect()

      const rawTokens = rows.reduce((sum, row) => sum + row.tokens, 0)
      const score = Math.round(rawTokens * multiplier)
      const periodKey = keys[period]

      const existing = await ctx.db
        .query("scores")
        .withIndex("by_userKey_period_periodKey", (q) =>
          q.eq("userKey", args.userKey).eq("period", period).eq("periodKey", periodKey),
        )
        .unique()

      const fields = {
        name: args.name,
        ...(args.color !== undefined ? { color: args.color } : {}),
        rawTokens,
        multiplier,
        score,
        updatedAt: now,
      }

      if (existing) {
        await ctx.db.patch(existing._id, fields)
      } else {
        await ctx.db.insert("scores", {
          userKey: args.userKey,
          period,
          periodKey,
          ...fields,
        })
      }
    }
  },
})

const MAX_RACERS = 8
/** Velocity is averaged over this trailing span, not a single bucket. */
const VELOCITY_WINDOW_MS = 30 * 60_000

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

/**
 * The single query the race channel subscribes to. Returns a ranked grid plus
 * the velocity each kart should be driven at.
 */
export const getRace = query({
  args: {
    period: v.optional(v.union(v.literal("day"), v.literal("week"), v.literal("month"))),
  },
  handler: async (ctx, args) => {
    const period = args.period ?? "day"
    const now = Date.now()
    const periodKey = toPeriodKeys(now)[period]

    const scoreRows = await ctx.db
      .query("scores")
      .withIndex("by_period_periodKey", (q) =>
        q.eq("period", period).eq("periodKey", periodKey),
      )
      .collect()

    const ranked = scoreRows
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RACERS)

    const since = now - VELOCITY_WINDOW_MS
    const racers: RacerState[] = []

    for (let i = 0; i < ranked.length; i++) {
      const row = ranked[i]
      const recent = await ctx.db
        .query("buckets")
        .withIndex("by_userKey_bucketStart", (q) =>
          q.eq("userKey", row.userKey).gte("bucketStart", since),
        )
        .collect()

      const recentTokens = recent.reduce((sum, bucket) => sum + bucket.tokens, 0)
      const velocityTokensPerMin = recentTokens / (VELOCITY_WINDOW_MS / 60_000)

      racers.push({
        key: row.userKey,
        name: row.name,
        color: row.color ?? null,
        rank: i + 1,
        score: row.score,
        rawTokens: row.rawTokens,
        multiplier: row.multiplier,
        velocityTokensPerMin,
        isActive: recentTokens > 0,
      })
    }

    return {
      period,
      periodKey,
      racers,
      updatedAt: now,
      totalScore: racers.reduce((sum, racer) => sum + racer.score, 0),
    }
  },
})

export const getScoreboard = query({
  args: {
    period: v.union(v.literal("day"), v.literal("week"), v.literal("month")),
  },
  handler: async (ctx, { period }) => {
    const periodKey = toPeriodKeys(Date.now())[period]
    const rows = await ctx.db
      .query("scores")
      .withIndex("by_period_periodKey", (q) =>
        q.eq("period", period).eq("periodKey", periodKey),
      )
      .collect()

    return {
      period,
      periodKey,
      entries: rows
        .sort((a, b) => b.score - a.score)
        .map((row, index) => ({
          key: row.userKey,
          name: row.name,
          color: row.color ?? null,
          score: row.score,
          rawTokens: row.rawTokens,
          multiplier: row.multiplier,
          rank: index + 1,
        })),
    }
  },
})

export const pruneOldBuckets = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - BUCKET_RETENTION_MS
    const stale = await ctx.db
      .query("buckets")
      .withIndex("by_bucketStart", (q) => q.lt("bucketStart", cutoff))
      .take(GC_BATCH_SIZE)

    for (const row of stale) {
      await ctx.db.delete(row._id)
    }

    if (stale.length === GC_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.scoring.pruneOldBuckets, {})
    }
    return { deleted: stale.length }
  },
})

export const pruneOldSessions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - SESSION_RETENTION_MS
    const stale = await ctx.db
      .query("sessions")
      .withIndex("by_startedAt", (q) => q.lt("startedAt", cutoff))
      .take(GC_BATCH_SIZE)

    for (const row of stale) {
      await ctx.db.delete(row._id)
    }

    if (stale.length === GC_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.scoring.pruneOldSessions, {})
    }
    return { deleted: stale.length }
  },
})
