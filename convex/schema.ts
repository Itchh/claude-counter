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

  // Five-minute token buckets. These are what make velocity honest: a delta
  // between two lifetime totals only tells you an hourly average, whereas a
  // run of buckets tells you the shape of the hour.
  buckets: defineTable({
    userKey: v.string(),
    deviceId: v.string(),
    bucketStart: v.number(),
    tokens: v.number(),
  })
    // Per-device rows, because two machines reporting independently must not
    // clobber each other's counts for the same five minutes.
    .index("by_userKey_deviceId_bucketStart", ["userKey", "deviceId", "bucketStart"])
    .index("by_bucketStart", ["bucketStart"])
    .index("by_userKey_bucketStart", ["userKey", "bucketStart"]),

  scores: defineTable({
    userKey: v.string(),
    name: v.string(),
    color: v.optional(v.string()),
    period: v.union(v.literal("day"), v.literal("week"), v.literal("month")),
    /** Period boundary label resolved in Europe/London, e.g. "2026-08-27". */
    periodKey: v.string(),
    rawTokens: v.number(),
    multiplier: v.number(),
    score: v.number(),
    updatedAt: v.number(),
  })
    .index("by_period_periodKey", ["period", "periodKey"])
    .index("by_userKey_period_periodKey", ["userKey", "period", "periodKey"]),

  sessions: defineTable({
    userKey: v.string(),
    deviceId: v.string(),
    startedAt: v.number(),
    lastActivityAt: v.number(),
  })
    .index("by_userKey_deviceId_startedAt", ["userKey", "deviceId", "startedAt"])
    .index("by_userKey_startedAt", ["userKey", "startedAt"])
    .index("by_startedAt", ["startedAt"]),
})
