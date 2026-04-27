import { query, internalMutation } from "./_generated/server"
import { v } from "convex/values"
import { internal } from "./_generated/api"

const SNAPSHOT_INTERVAL_MS = 5 * 60_000

export const get = query({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect()
    const metaRow = await ctx.db
      .query("meta")
      .withIndex("by_key", (q) => q.eq("key", "updatedAt"))
      .unique()

    const sorted = users
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .map((user, i) => ({
        name: user.name,
        totalTokens: user.totalTokens,
        inputTokens: user.inputTokens,
        outputTokens: user.outputTokens,
        cacheTokens: user.cacheTokens,
        tokensToday: user.tokensToday,
        sessionCount: user.sessionCount,
        lastSeen: user.lastSeen,
        rank: i + 1,
        isOnline: Date.now() - new Date(user.lastSeen).getTime() < 90_000,
        color: user.color ?? null,
      }))

    const totalTokens = sorted.reduce((s, e) => s + e.totalTokens, 0)

    return {
      leaderboard: sorted,
      totalTokens,
      updatedAt: metaRow?.value ?? new Date().toISOString(),
    }
  },
})

export const upsertDevice = internalMutation({
  args: {
    userKey: v.string(),
    deviceId: v.string(),
    name: v.string(),
    color: v.optional(v.string()),
    totalTokens: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheTokens: v.number(),
    tokensToday: v.number(),
    sessionCount: v.number(),
    lastSeen: v.string(),
  },
  handler: async (ctx, args) => {
    const existingDevice = await ctx.db
      .query("devices")
      .withIndex("by_userKey_deviceId", (q) =>
        q.eq("userKey", args.userKey).eq("deviceId", args.deviceId),
      )
      .unique()

    const deviceFields = {
      userKey: args.userKey,
      deviceId: args.deviceId,
      totalTokens: args.totalTokens,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      cacheTokens: args.cacheTokens,
      tokensToday: args.tokensToday,
      sessionCount: args.sessionCount,
      lastSeen: args.lastSeen,
    }

    if (existingDevice) {
      await ctx.db.patch(existingDevice._id, deviceFields)
    } else {
      await ctx.db.insert("devices", deviceFields)
    }

    const allDevices = await ctx.db
      .query("devices")
      .withIndex("by_userKey", (q) => q.eq("userKey", args.userKey))
      .collect()

    const aggregate = allDevices.reduce(
      (acc, d) => ({
        totalTokens: acc.totalTokens + d.totalTokens,
        inputTokens: acc.inputTokens + d.inputTokens,
        outputTokens: acc.outputTokens + d.outputTokens,
        cacheTokens: acc.cacheTokens + d.cacheTokens,
        tokensToday: acc.tokensToday + d.tokensToday,
        sessionCount: acc.sessionCount + d.sessionCount,
        lastSeen:
          new Date(d.lastSeen).getTime() > new Date(acc.lastSeen).getTime()
            ? d.lastSeen
            : acc.lastSeen,
      }),
      {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        tokensToday: 0,
        sessionCount: 0,
        lastSeen: new Date(0).toISOString(),
      },
    )

    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_key", (q) => q.eq("key", args.userKey))
      .unique()

    if (existingUser) {
      await ctx.db.patch(existingUser._id, aggregate)
    } else {
      await ctx.db.insert("users", {
        key: args.userKey,
        name: args.name,
        ...(args.color !== undefined ? { color: args.color } : {}),
        ...aggregate,
      })
    }

    const now = Date.now()
    const latestSnapshot = await ctx.db
      .query("snapshots")
      .withIndex("by_key_timestamp", (q) => q.eq("key", args.userKey))
      .order("desc")
      .first()

    if (!latestSnapshot || now - latestSnapshot.timestamp >= SNAPSHOT_INTERVAL_MS) {
      const userNameForSnapshot = existingUser?.name ?? args.name
      const userColorForSnapshot = existingUser?.color ?? args.color
      await ctx.db.insert("snapshots", {
        key: args.userKey,
        name: userNameForSnapshot,
        totalTokens: aggregate.totalTokens,
        timestamp: now,
        ...(userColorForSnapshot !== undefined ? { color: userColorForSnapshot } : {}),
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

    const byUser = new Map<
      string,
      { key: string; name: string; color: string | null; points: Array<{ t: number; v: number }> }
    >()

    for (const snap of snapshots) {
      const userKey = snap.key
      let user = byUser.get(userKey)
      if (!user) {
        user = { key: userKey, name: snap.name, color: snap.color ?? null, points: [] }
        byUser.set(userKey, user)
      }
      user.points.push({ t: snap.timestamp, v: snap.totalTokens })
      if (snap.color) user.color = snap.color
    }

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

export const wipeLegacy = internalMutation({
  args: {},
  handler: async (ctx) => {
    const CHUNK = 1000
    const oldEntries = await ctx.db.query("entries").take(CHUNK)
    for (const row of oldEntries) {
      await ctx.db.delete(row._id)
    }
    const oldSnapshots = await ctx.db.query("snapshots").take(CHUNK)
    for (const row of oldSnapshots) {
      await ctx.db.delete(row._id)
    }
    return {
      deletedEntries: oldEntries.length,
      deletedSnapshots: oldSnapshots.length,
      done: oldEntries.length < CHUNK && oldSnapshots.length < CHUNK,
    }
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
