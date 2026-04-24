import { query, internalMutation } from "./_generated/server"
import { v } from "convex/values"
import { internal } from "./_generated/api"

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

const MAX_POINTS_PER_USER = 150
const MAX_SNAPSHOT_FETCH = 10000

export const getTimeline = query({
  args: {
    rangeMs: v.number(),
  },
  handler: async (ctx, { rangeMs }) => {
    const now = Date.now()
    const since = now - rangeMs

    const minInterval = rangeMs / MAX_POINTS_PER_USER

    const snapshots = await ctx.db
      .query("snapshots")
      .withIndex("by_timestamp", (q) => q.gte("timestamp", since))
      .take(MAX_SNAPSHOT_FETCH)

    const entries = await ctx.db.query("entries").collect()
    const entryMeta = new Map<string, { name: string; color: string | null }>()
    for (const entry of entries) {
      entryMeta.set(entry.key, { name: entry.name, color: entry.color ?? null })
    }

    // Group by user key
    const byUser = new Map<string, { key: string; name: string; color: string | null; points: Array<{ t: number; v: number }> }>()

    for (const snap of snapshots) {
      const userKey = snap.key
      let user = byUser.get(userKey)
      if (!user) {
        const meta = entryMeta.get(userKey)
        user = {
          key: userKey,
          name: meta?.name ?? snap.name,
          color: meta?.color ?? null,
          points: [],
        }
        byUser.set(userKey, user)
      }
      user.points.push({ t: snap.timestamp, v: snap.totalTokens })
    }

    // Sort and downsample each user's points
    for (const user of byUser.values()) {
      user.points.sort((a, b) => a.t - b.t)

      if (user.points.length > MAX_POINTS_PER_USER) {
        const sampled: Array<{ t: number; v: number }> = [user.points[0]]
        let lastKept = user.points[0].t
        for (let i = 1; i < user.points.length - 1; i++) {
          if (user.points[i].t - lastKept >= minInterval) {
            sampled.push(user.points[i])
            lastKept = user.points[i].t
          }
        }
        sampled.push(user.points[user.points.length - 1])
        user.points = sampled
      }
    }

    return { since, now, users: Array.from(byUser.values()) }
  },
})

const SNAPSHOT_RETENTION_DAYS = 30
const GC_BATCH_SIZE = 200

export const pruneOldSnapshots = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - SNAPSHOT_RETENTION_DAYS * 24 * 60 * 60 * 1000

    const stale = await ctx.db
      .query("snapshots")
      .withIndex("by_timestamp", (q) => q.lt("timestamp", cutoff))
      .take(GC_BATCH_SIZE)

    for (const snap of stale) {
      await ctx.db.delete(snap._id)
    }

    if (stale.length === GC_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.leaderboard.pruneOldSnapshots, {})
    }

    return { deleted: stale.length }
  },
})
