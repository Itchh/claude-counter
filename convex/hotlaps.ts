import { v } from "convex/values"
import { mutation, query } from "./_generated/server"
import { ghostSampleValidator } from "./schema"
import { currentUser, requireUser } from "./me"

// Hot laps. The simulation's laps are the weather — they happen to everyone,
// all day, at the pace their tokens set. A hot lap is one somebody drove.

/** Ten a second for two minutes. Nothing on these circuits takes longer. */
const MAX_GHOST_SAMPLES = 1200
const BOARD_SIZE = 10
/** Below this a lap was not driven, it was a bug. */
const MIN_LAP_MS = 2_000
const MAX_LAP_MS = 10 * 60_000

export const recordHotLap = mutation({
  args: {
    trackSlug: v.string(),
    lapMs: v.number(),
    samples: v.array(ghostSampleValidator),
  },
  handler: async (ctx, args): Promise<{ isPersonalBest: boolean }> => {
    const user = await requireUser(ctx)
    if (!Number.isFinite(args.lapMs) || args.lapMs < MIN_LAP_MS || args.lapMs > MAX_LAP_MS) {
      throw new Error("Implausible lap")
    }
    // Only a lap driven under a live lease counts — the AI does not set records.
    const lease = await ctx.db
      .query("controls")
      .withIndex("by_game_racerKey", (q) => q.eq("game", "race").eq("racerKey", user.key))
      .unique()
    if (!lease || lease.expiresAt < Date.now()) throw new Error("Not driving")

    const lapMs = Math.round(args.lapMs)
    const now = Date.now()
    await ctx.db.insert("hotLaps", {
      userKey: user.key,
      name: user.name,
      ...(user.color ? { color: user.color } : {}),
      trackSlug: args.trackSlug,
      lapMs,
      at: now,
    })

    const ghost = await ctx.db
      .query("ghostLaps")
      .withIndex("by_userKey_trackSlug", (q) =>
        q.eq("userKey", user.key).eq("trackSlug", args.trackSlug),
      )
      .unique()
    const isPersonalBest = !ghost || lapMs < ghost.lapMs
    if (isPersonalBest) {
      const samples = args.samples.slice(0, MAX_GHOST_SAMPLES)
      if (ghost) {
        await ctx.db.replace(ghost._id, {
          userKey: user.key,
          trackSlug: args.trackSlug,
          lapMs,
          samples,
        })
      } else {
        await ctx.db.insert("ghostLaps", {
          userKey: user.key,
          trackSlug: args.trackSlug,
          lapMs,
          samples,
        })
      }
      await ctx.db.insert("events", {
        type: "hot_lap",
        userKey: user.key,
        name: user.name,
        ...(user.color ? { color: user.color } : {}),
        value: lapMs,
        timestamp: now,
      })
    }
    return { isPersonalBest }
  },
})

/** The fastest hand-driven laps on a circuit. */
export const board = query({
  args: { trackSlug: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("hotLaps")
      .withIndex("by_trackSlug_lapMs", (q) => q.eq("trackSlug", args.trackSlug))
      .take(BOARD_SIZE)
    return rows.map((row, index) => ({
      rank: index + 1,
      userKey: row.userKey,
      name: row.name,
      color: row.color ?? null,
      lapMs: row.lapMs,
      at: row.at,
    }))
  },
})

/** The signed-in driver's best trace on a circuit, to race against. */
export const myGhost = query({
  args: { trackSlug: v.string() },
  handler: async (ctx, args) => {
    const user = await currentUser(ctx)
    if (!user) return null
    const ghost = await ctx.db
      .query("ghostLaps")
      .withIndex("by_userKey_trackSlug", (q) =>
        q.eq("userKey", user.key).eq("trackSlug", args.trackSlug),
      )
      .unique()
    if (!ghost) return null
    return { lapMs: ghost.lapMs, samples: ghost.samples }
  },
})
