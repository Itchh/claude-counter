import { v } from "convex/values"
import { mutation } from "./_generated/server"
import { isAirframeIndex, isChassisIndex, isFighterIndex, isLiveryId, isPaintHex } from "../lib/livery"
import { requireUser } from "./me"

// The select screen's one write: chassis, paint and livery together.
//
// Yours alone. The driver is whoever is signed in — never a key handed up
// from the client — so the paint shop can only ever repaint the car of the
// person standing at it. The catalogue check stays: a signed-in stranger
// still cannot write anything the shop does not sell.

export const setLivery = mutation({
  args: {
    paint: v.string(),
    livery: v.string(),
    chassis: v.number(),
  },
  handler: async (ctx, args): Promise<null> => {
    if (!isPaintHex(args.paint)) {
      throw new Error(`Unknown paint: ${args.paint}`)
    }
    if (!isLiveryId(args.livery)) {
      throw new Error(`Unknown livery: ${args.livery}`)
    }
    if (!isChassisIndex(args.chassis)) {
      throw new Error(`Unknown chassis: ${args.chassis}`)
    }

    const user = await requireUser(ctx)
    await ctx.db.patch(user._id, { paint: args.paint, livery: args.livery, chassis: args.chassis })
    return null
  },
})

// The hangar's one write: airframe, paint and livery together, under the
// paint shop's rule — the record written is the signed-in person's own, and
// nothing outside lib/livery.ts is ever stored.

export const setPlaneLivery = mutation({
  args: {
    paint: v.string(),
    livery: v.string(),
    airframe: v.number(),
  },
  handler: async (ctx, args): Promise<null> => {
    if (!isPaintHex(args.paint)) {
      throw new Error(`Unknown paint: ${args.paint}`)
    }
    if (!isLiveryId(args.livery)) {
      throw new Error(`Unknown livery: ${args.livery}`)
    }
    if (!isAirframeIndex(args.airframe)) {
      throw new Error(`Unknown airframe: ${args.airframe}`)
    }

    const user = await requireUser(ctx)
    await ctx.db.patch(user._id, {
      planePaint: args.paint,
      planeLivery: args.livery,
      airframe: args.airframe,
    })
    return null
  },
})

// The dojo's one write: fighter, gi colour and pattern together, under the
// paint shop's rule — the record written is the signed-in person's own, and
// nothing outside lib/livery.ts is ever stored.

export const setFighterLivery = mutation({
  args: {
    paint: v.string(),
    livery: v.string(),
    fighter: v.number(),
  },
  handler: async (ctx, args): Promise<null> => {
    if (!isPaintHex(args.paint)) {
      throw new Error(`Unknown paint: ${args.paint}`)
    }
    if (!isLiveryId(args.livery)) {
      throw new Error(`Unknown livery: ${args.livery}`)
    }
    if (!isFighterIndex(args.fighter)) {
      throw new Error(`Unknown fighter: ${args.fighter}`)
    }

    const user = await requireUser(ctx)
    await ctx.db.patch(user._id, {
      fightPaint: args.paint,
      fightLivery: args.livery,
      fighter: args.fighter,
    })
    return null
  },
})
