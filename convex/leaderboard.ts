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
      }))

    const totalTokens = sorted.reduce((s, e) => s + e.totalTokens, 0)

    return {
      leaderboard: sorted,
      totalTokens,
      updatedAt: metaRow?.value ?? new Date().toISOString(),
    }
  },
})

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
      })
    } else {
      await ctx.db.insert("entries", args)
    }

    const metaRow = await ctx.db
      .query("meta")
      .withIndex("by_key", (q) => q.eq("key", "updatedAt"))
      .unique()

    const now = new Date().toISOString()
    if (metaRow) {
      await ctx.db.patch(metaRow._id, { value: now })
    } else {
      await ctx.db.insert("meta", { key: "updatedAt", value: now })
    }
  },
})
