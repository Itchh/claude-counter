import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
  entries: defineTable({
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
  }).index("by_key", ["key"]),

  meta: defineTable({
    key: v.string(),
    value: v.string(),
  }).index("by_key", ["key"]),

  snapshots: defineTable({
    key: v.string(),
    name: v.string(),
    totalTokens: v.number(),
    timestamp: v.number(),
    color: v.optional(v.string()),
  }).index("by_timestamp", ["timestamp"])
    .index("by_key_timestamp", ["key", "timestamp"]),
})
