import { v } from "convex/values"
import { getAuthUserId } from "@convex-dev/auth/server"
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server"
import type { Doc } from "./_generated/dataModel"

// The signed-in driver, and what only they can see.

/** The caller's driver record, or null when nobody is signed in. */
export async function currentUser(ctx: QueryCtx | MutationCtx): Promise<Doc<"users"> | null> {
  const userId = await getAuthUserId(ctx)
  if (userId === null) return null
  return await ctx.db.get(userId)
}

/** The caller's driver record, or a refusal. */
export async function requireUser(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  const user = await currentUser(ctx)
  if (!user) throw new Error("Not authenticated")
  return user
}

const DEVICE_LABEL_MAX = 24
const STATS_WINDOW_MS = 24 * 60 * 60_000
const MAX_STAT_BUCKETS = 2000
const MAX_DEVICES = 32
const MAX_MY_LAPS = 10

export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx)
    if (!user) return null
    return {
      key: user.key,
      name: user.name,
      color: user.color ?? null,
      paint: user.paint ?? null,
      livery: user.livery ?? null,
      chassis: user.chassis ?? null,
      claudeAccountId: user.claudeAccountId ?? null,
      lastLoginAt: user.lastLoginAt ?? null,
      totalTokens: user.totalTokens,
      nitroCharge: user.nitroCharge ?? 0,
    }
  },
})

/** Everything the account window shows: devices, the last day, best laps. */
export const myStats = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx)
    if (!user) return null

    const devices = await ctx.db
      .query("devices")
      .withIndex("by_userKey", (q) => q.eq("userKey", user.key))
      .take(MAX_DEVICES)

    const since = Date.now() - STATS_WINDOW_MS
    const buckets = await ctx.db
      .query("buckets")
      .withIndex("by_userKey_bucketStart", (q) =>
        q.eq("userKey", user.key).gte("bucketStart", since),
      )
      .take(MAX_STAT_BUCKETS)

    // Two devices reporting the same five minutes are two rows; the chart
    // wants one point per bucket.
    const merged = new Map<number, number>()
    for (const bucket of buckets) {
      merged.set(bucket.bucketStart, (merged.get(bucket.bucketStart) ?? 0) + bucket.tokens)
    }
    const series = [...merged.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, tokens]) => ({ t, tokens }))

    // One best per track. The index orders a driver's laps by track, then
    // by time, so the first row after the previous track is the next
    // track's fastest: one indexed read per circuit, however many laps.
    const laps: Doc<"hotLaps">[] = []
    let previousTrack: string | null = null
    while (laps.length < MAX_MY_LAPS) {
      const after: string | null = previousTrack
      const mine = ctx.db.query("hotLaps")
      const best: Doc<"hotLaps"> | null =
        after === null
          ? await mine
              .withIndex("by_userKey_trackSlug_lapMs", (q) => q.eq("userKey", user.key))
              .first()
          : await mine
              .withIndex("by_userKey_trackSlug_lapMs", (q) =>
                q.eq("userKey", user.key).gt("trackSlug", after),
              )
              .first()
      if (!best) break
      laps.push(best)
      previousTrack = best.trackSlug
    }

    return {
      key: user.key,
      name: user.name,
      color: user.color ?? null,
      claudeAccountId: user.claudeAccountId ?? null,
      totalTokens: user.totalTokens,
      tokensToday: user.tokensToday,
      sessionCount: user.sessionCount,
      tokensByModel: user.tokensByModel ?? {},
      lastSeen: user.lastSeen,
      nitroCharge: user.nitroCharge ?? 0,
      devices: devices.map((device) => ({
        deviceId: device.deviceId,
        label: device.label ?? null,
        totalTokens: device.totalTokens,
        tokensToday: device.tokensToday,
        lastSeen: device.lastSeen,
      })),
      series,
      laps: laps.map((lap) => ({
        trackSlug: lap.trackSlug,
        lapMs: lap.lapMs,
        at: lap.at,
      })),
    }
  },
})

export const renameDevice = mutation({
  args: { deviceId: v.string(), label: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const user = await requireUser(ctx)
    const label = args.label.trim().slice(0, DEVICE_LABEL_MAX)
    const device = await ctx.db
      .query("devices")
      .withIndex("by_userKey_deviceId", (q) =>
        q.eq("userKey", user.key).eq("deviceId", args.deviceId),
      )
      .unique()
    if (!device) throw new Error("No such device")
    await ctx.db.patch(device._id, { label })
    return null
  },
})
