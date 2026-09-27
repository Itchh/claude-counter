import { v } from "convex/values"
import { internalMutation, mutation, query } from "./_generated/server"
import { gameValidator, poseValidator } from "./schema"
import { requireUser } from "./me"
import { settleNitro } from "../lib/nitro"

// Taking the wheel.
//
// Every screen runs its own simulation, so a car driven by hand on one of
// them is invisible to the rest unless the driver's screen becomes the
// authority for that car. That is what a lease is: a short-lived claim on
// one entity, renewed by heartbeat, under which the holder publishes where
// the entity is and everyone else draws it there. Let the heartbeat lapse —
// close the tab, lose the wifi — and the lease dies, the pose stops, and the
// car is the simulation's again. Owner only: it is your usage, your car.

/** How long a lease lives without a heartbeat. */
export const LEASE_TTL_MS = 6_000
const MAX_CONTROLS = 64

export const takeControl = mutation({
  args: { game: gameValidator },
  handler: async (ctx, args): Promise<{ nitroCharge: number; expiresAt: number }> => {
    const user = await requireUser(ctx)
    const now = Date.now()
    const expiresAt = now + LEASE_TTL_MS

    const existing = await ctx.db
      .query("controls")
      .withIndex("by_game_racerKey", (q) => q.eq("game", args.game).eq("racerKey", user.key))
      .unique()

    // The nitro bank settles the moment you take the wheel: everything
    // burned since the last settlement becomes boost.
    const nitroCharge = settleNitro(
      user.nitroCharge ?? 0,
      user.totalTokens,
      user.nitroAccountedTokens ?? user.totalTokens,
    )
    await ctx.db.patch(user._id, { nitroCharge, nitroAccountedTokens: user.totalTokens })

    if (existing) {
      // Your own stale lease from a tab that died, or a second tab of yours.
      // Either way it is yours; refresh rather than refuse.
      await ctx.db.patch(existing._id, { expiresAt, takenAt: now })
      return { nitroCharge, expiresAt }
    }

    await ctx.db.insert("controls", {
      game: args.game,
      racerKey: user.key,
      holderUserId: user._id,
      holderName: user.name,
      takenAt: now,
      expiresAt,
    })
    await ctx.db.insert("events", {
      type: "control_taken",
      userKey: user.key,
      name: user.name,
      ...(user.color ? { color: user.color } : {}),
      timestamp: now,
    })
    return { nitroCharge, expiresAt }
  },
})

export const heartbeat = mutation({
  args: { game: gameValidator, nitroCharge: v.optional(v.number()) },
  handler: async (ctx, args): Promise<boolean> => {
    const user = await requireUser(ctx)
    const lease = await ctx.db
      .query("controls")
      .withIndex("by_game_racerKey", (q) => q.eq("game", args.game).eq("racerKey", user.key))
      .unique()
    if (!lease) return false
    await ctx.db.patch(lease._id, { expiresAt: Date.now() + LEASE_TTL_MS })
    if (args.nitroCharge !== undefined) {
      await ctx.db.patch(user._id, { nitroCharge: Math.max(0, args.nitroCharge) })
    }
    return true
  },
})

export const release = mutation({
  args: { game: gameValidator, nitroCharge: v.optional(v.number()) },
  handler: async (ctx, args): Promise<null> => {
    const user = await requireUser(ctx)
    const lease = await ctx.db
      .query("controls")
      .withIndex("by_game_racerKey", (q) => q.eq("game", args.game).eq("racerKey", user.key))
      .unique()
    if (args.nitroCharge !== undefined) {
      await ctx.db.patch(user._id, { nitroCharge: Math.max(0, args.nitroCharge) })
    }
    if (!lease) return null
    await ctx.db.delete(lease._id)
    const pose = await ctx.db
      .query("poses")
      .withIndex("by_game_racerKey", (q) => q.eq("game", args.game).eq("racerKey", user.key))
      .unique()
    if (pose) await ctx.db.delete(pose._id)
    await ctx.db.insert("events", {
      type: "control_released",
      userKey: user.key,
      name: user.name,
      ...(user.color ? { color: user.color } : {}),
      timestamp: Date.now(),
    })
    return null
  },
})

/** Where the holder has the entity. Refused without a live lease. */
export const publishPose = mutation({
  args: { pose: poseValidator },
  handler: async (ctx, args): Promise<null> => {
    const user = await requireUser(ctx)
    const game = args.pose.game
    const lease = await ctx.db
      .query("controls")
      .withIndex("by_game_racerKey", (q) => q.eq("game", game).eq("racerKey", user.key))
      .unique()
    const now = Date.now()
    if (!lease || lease.expiresAt < now) throw new Error("No live lease")

    const existing = await ctx.db
      .query("poses")
      .withIndex("by_game_racerKey", (q) => q.eq("game", game).eq("racerKey", user.key))
      .unique()
    if (existing) {
      await ctx.db.patch(existing._id, { seq: existing.seq + 1, sentAt: now, pose: args.pose })
    } else {
      await ctx.db.insert("poses", { game, racerKey: user.key, seq: 1, sentAt: now, pose: args.pose })
    }
    return null
  },
})

/** Every live lease for a game. Clients also treat a lapsed one as dead. */
export const activeControls = query({
  args: { game: gameValidator },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("controls")
      .withIndex("by_game_racerKey", (q) => q.eq("game", args.game))
      .take(MAX_CONTROLS)
    return rows.map((row) => ({
      racerKey: row.racerKey,
      holderName: row.holderName,
      takenAt: row.takenAt,
      expiresAt: row.expiresAt,
    }))
  },
})

export const poses = query({
  args: { game: gameValidator },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("poses")
      .withIndex("by_game_racerKey", (q) => q.eq("game", args.game))
      .take(MAX_CONTROLS)
    return rows.map((row) => ({
      racerKey: row.racerKey,
      seq: row.seq,
      sentAt: row.sentAt,
      pose: row.pose,
    }))
  },
})

const SWEEP_BATCH = 100

/** Buries leases nobody is heartbeating, and the poses under them. */
export const sweepExpired = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const dead = await ctx.db
      .query("controls")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", Date.now()))
      .take(SWEEP_BATCH)
    for (const lease of dead) {
      await ctx.db.delete(lease._id)
      const pose = await ctx.db
        .query("poses")
        .withIndex("by_game_racerKey", (q) =>
          q.eq("game", lease.game).eq("racerKey", lease.racerKey),
        )
        .unique()
      if (pose) await ctx.db.delete(pose._id)
    }
    return null
  },
})
