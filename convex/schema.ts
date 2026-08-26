import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"

export default defineSchema({
  users: defineTable({
    key: v.string(),
    name: v.string(),
    color: v.optional(v.string()),
    totalTokens: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheTokens: v.number(),
    tokensByModel: v.optional(v.record(v.string(), v.number())),
    tokensToday: v.number(),
    sessionCount: v.number(),
    lastSeen: v.string(),
  }).index("by_key", ["key"]),

  devices: defineTable({
    userKey: v.string(),
    deviceId: v.string(),
    totalTokens: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    cacheTokens: v.number(),
    tokensByModel: v.optional(v.record(v.string(), v.number())),
    tokensToday: v.number(),
    sessionCount: v.number(),
    lastSeen: v.string(),
  }).index("by_userKey_deviceId", ["userKey", "deviceId"])
    .index("by_userKey", ["userKey"]),

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

  events: defineTable({
    type: v.union(
      v.literal("milestone"),
      v.literal("new_leader"),
      v.literal("user_joined"),
    ),
    userKey: v.string(),
    name: v.string(),
    color: v.optional(v.string()),
    value: v.optional(v.number()),
    timestamp: v.number(),
  }).index("by_timestamp", ["timestamp"]),

  snapshots: defineTable({
    key: v.string(),
    name: v.string(),
    totalTokens: v.number(),
    timestamp: v.number(),
    color: v.optional(v.string()),
  }).index("by_timestamp", ["timestamp"])
    .index("by_key_timestamp", ["key", "timestamp"]),
})
