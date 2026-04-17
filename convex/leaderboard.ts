import { query, internalMutation } from "./_generated/server"
import { v } from "convex/values"

export const get = query({
  args: {},
  handler: async (ctx) => {
    const entries = await ctx.db.query("entries").collect()
    const metaRow = await ctx.db
      .query("meta")
      .withIndex("by_key", (q) => q.eq("key", "updatedAt"))
      .unique()

    const sorted = entries
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .map((entry, i) => ({
        name: entry.name,
        totalTokens: entry.totalTokens,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        cacheTokens: entry.cacheTokens,
        tokensToday: entry.tokensToday,
        sessionCount: entry.sessionCount,
        lastSeen: entry.lastSeen,
        rank: i + 1,
        isOnline: Date.now() - new Date(entry.lastSeen).getTime() < 90_000,
        color: entry.color ?? null,
      }))

    const totalTokens = sorted.reduce((s, e) => s + e.totalTokens, 0)

    return {
      leaderboard: sorted,
      totalTokens,
      updatedAt: metaRow?.value ?? new Date().toISOString(),
    }
  },
})

const SNAPSHOT_INTERVAL_MS = 5 * 60_000

export const upsertEntry = internalMutation({
  args: {
    key: v.string(),
    name: v.string(),
    totalTokens: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheTokens: v.number(),
    tokensToday: v.number(),
    sessionCount: v.number(),
    lastSeen: v.string(),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("entries")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique()

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: args.name,
        totalTokens: args.totalTokens,
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        cacheTokens: args.cacheTokens,
        tokensToday: args.tokensToday,
        sessionCount: args.sessionCount,
        lastSeen: args.lastSeen,
        ...(args.color !== undefined ? { color: args.color } : {}),
      })
    } else {
      await ctx.db.insert("entries", {
        ...args,
        color: args.color ?? undefined,
      })
    }

    // Record a snapshot at most every 5 minutes per user
    const now = Date.now()
    const latestSnapshot = await ctx.db
      .query("snapshots")
      .withIndex("by_key_timestamp", (q) => q.eq("key", args.key))
      .order("desc")
      .first()

    if (!latestSnapshot || now - latestSnapshot.timestamp >= SNAPSHOT_INTERVAL_MS) {
      await ctx.db.insert("snapshots", {
        key: args.key,
        name: args.name,
        totalTokens: args.totalTokens,
        timestamp: now,
        color: args.color ?? undefined,
      })
    }

    const metaRow = await ctx.db
      .query("meta")
      .withIndex("by_key", (q) => q.eq("key", "updatedAt"))
      .unique()

    const nowIso = new Date().toISOString()
    if (metaRow) {
      await ctx.db.patch(metaRow._id, { value: nowIso })
    } else {
      await ctx.db.insert("meta", { key: "updatedAt", value: nowIso })
    }
  },
})

export const getTimeline = query({
  args: {
    rangeMs: v.number(),
  },
  handler: async (ctx, { rangeMs }) => {
    const since = Date.now() - rangeMs
    const snapshots = await ctx.db
      .query("snapshots")
      .withIndex("by_timestamp", (q) => q.gte("timestamp", since))
      .take(5000)

    // Group by user key
    const byUser = new Map<string, { key: string; name: string; color: string | null; points: Array<{ t: number; v: number }> }>()

    for (const snap of snapshots) {
      let user = byUser.get(snap.key)
      if (!user) {
        user = { key: snap.key, name: snap.name, color: snap.color ?? null, points: [] }
        byUser.set(snap.key, user)
      }
      user.points.push({ t: snap.timestamp, v: snap.totalTokens })
      if (snap.color) user.color = snap.color
    }

    // Sort points by time
    for (const user of byUser.values()) {
      user.points.sort((a, b) => a.t - b.t)
    }

    return Array.from(byUser.values())
  },
})
