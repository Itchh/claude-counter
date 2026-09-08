import { v } from "convex/values"
import { mutation } from "./_generated/server"
import { isLiveryId, isPaintHex } from "../lib/livery"

// The paint shop's one write.
//
// Public and unauthenticated, like every other function here — this deck has
// no identity model, and adding one for a paint job would be the tail wagging
// the dog. What stands in for it is that the mutation cannot be used to write
// anything: both values are checked against lib/livery.ts, so the worst a
// stranger with the deployment URL can do is repaint someone's car in a colour
// the catalogue already offers. Widen the catalogue, not this check.

export const setLivery = mutation({
  args: {
    key: v.string(),
    paint: v.string(),
    livery: v.string(),
  },
  handler: async (ctx, args): Promise<null> => {
    if (!isPaintHex(args.paint)) {
      throw new Error(`Unknown paint: ${args.paint}`)
    }
    if (!isLiveryId(args.livery)) {
      throw new Error(`Unknown livery: ${args.livery}`)
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique()

    if (!user) {
      throw new Error(`No such driver: ${args.key}`)
    }

    await ctx.db.patch(user._id, { paint: args.paint, livery: args.livery })
    return null
  },
})
