import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"
import { authTables } from "@convex-dev/auth/server"

/** The three cartridges a person can take the controls of. */
export const gameValidator = v.union(
  v.literal("race"),
  v.literal("fight"),
  v.literal("dogfight"),
)

// What a possessed entity publishes, ten times a second, so every other
// screen can draw it where its driver has it rather than where its own
// simulation would have put it. One shape per game; the discriminant is the
// game itself.
export const racePoseValidator = v.object({
  game: v.literal("race"),
  t: v.number(),
  lap: v.number(),
  lateral: v.number(),
  yaw: v.number(),
  steer: v.number(),
  speed: v.number(),
  driftLoad: v.number(),
  crashTimer: v.number(),
  crashDuration: v.number(),
  crashRolls: v.number(),
  crashSpin: v.number(),
  bumpCount: v.number(),
  wallCount: v.number(),
  crashCount: v.number(),
  impactT: v.number(),
  impactLateral: v.number(),
  boosting: v.boolean(),
})

export const fightPoseValidator = v.object({
  game: v.literal("fight"),
  x: v.number(),
  action: v.string(),
  actionT: v.number(),
  hp: v.number(),
  trail: v.number(),
})

export const dogfightPoseValidator = v.object({
  game: v.literal("dogfight"),
  x: v.number(),
  y: v.number(),
  z: v.number(),
  heading: v.number(),
  pitch: v.number(),
  bank: v.number(),
  speed: v.number(),
  mode: v.string(),
  hp: v.number(),
  kills: v.number(),
  firing: v.boolean(),
})

export const poseValidator = v.union(racePoseValidator, fightPoseValidator, dogfightPoseValidator)

/** One sample of a recorded lap: where the car was, a tenth of a second apart. */
export const ghostSampleValidator = v.object({
  t: v.number(),
  l: v.number(),
  y: v.number(),
})

export default defineSchema({
  // Convex Auth's own tables (sessions, refresh tokens, verifiers). Its
  // `users` table is overridden just below: the driver record IS the auth
  // user, so a session's subject is a row that already carries the tokens.
  ...authTables,

  users: defineTable({
    key: v.string(),
    name: v.string(),
    color: v.optional(v.string()),
    // The Claude account the reporter found on the machine, when it found
    // one. Informational: the key stays the email so nothing migrates.
    claudeAccountId: v.optional(v.string()),
    lastLoginAt: v.optional(v.number()),
    // The nitro bank. Seconds of boost banked, and the lifetime total the
    // bank was last settled against — tokens burned since then are owed.
    nitroCharge: v.optional(v.number()),
    nitroAccountedTokens: v.optional(v.number()),
    // The paint shop's two choices. Separate from `color`, which the reporter
    // owns and only ever writes once — these belong to whoever is standing at
    // the screen, and either may be absent for a driver who has never opened
    // it. Validated against lib/livery.ts before they are written.
    paint: v.optional(v.string()),
    livery: v.optional(v.string()),
    // The third choice: which of the pack's chassis they drive. Absent until
    // chosen, in which case every surface falls back to hashing the key —
    // see chassisOf in cars.ts.
    chassis: v.optional(v.number()),
    // The hangar's three choices, for the dogfight. Kept apart from the
    // car's: a pilot's squadron markings are not their racing livery, and a
    // respray in one window must not repaint the other. Same validation.
    airframe: v.optional(v.number()),
    planePaint: v.optional(v.string()),
    planeLivery: v.optional(v.string()),
    // The dojo's three choices, for the fight. Their own for the same
    // reason the plane's are: a gi is not a paint job on a car.
    fighter: v.optional(v.number()),
    fightPaint: v.optional(v.string()),
    fightLivery: v.optional(v.string()),
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
    /** A name the owner gave it from their account window. */
    label: v.optional(v.string()),
    /**
     * Per-device credential for the /link endpoint. Generated on first report
     * and returned to the reporter so that subsequent sign-in requests prove
     * device identity without relying on the shared team secret.
     */
    linkToken: v.optional(v.string()),
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
      v.literal("control_taken"),
      v.literal("control_released"),
      v.literal("hot_lap"),
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

  // One-time sign-in codes minted by the reporter on a person's own machine.
  // The reporter already proves who is at that keyboard; the code carries the
  // proof to a browser.
  loginCodes: defineTable({
    code: v.string(),
    userKey: v.string(),
    deviceId: v.string(),
    expiresAt: v.number(),
    consumedAt: v.optional(v.number()),
  })
    .index("by_code", ["code"])
    .index("by_expiresAt", ["expiresAt"]),

  // Who has the wheel. One row per possessed entity, refreshed by heartbeat
  // and dead once `expiresAt` passes — a closed laptop hands the car back.
  controls: defineTable({
    game: gameValidator,
    racerKey: v.string(),
    holderUserId: v.id("users"),
    holderName: v.string(),
    takenAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_game_racerKey", ["game", "racerKey"])
    .index("by_expiresAt", ["expiresAt"]),

  // Where a possessed entity is. High churn, so kept off `users` and off
  // `controls` — this row is rewritten ten times a second.
  poses: defineTable({
    game: gameValidator,
    racerKey: v.string(),
    seq: v.number(),
    sentAt: v.number(),
    pose: poseValidator,
  }).index("by_game_racerKey", ["game", "racerKey"]),

  // Laps driven by hand. The AI's laps are the weather; these are the record.
  hotLaps: defineTable({
    userKey: v.string(),
    name: v.string(),
    color: v.optional(v.string()),
    trackSlug: v.string(),
    lapMs: v.number(),
    at: v.number(),
  })
    .index("by_trackSlug_lapMs", ["trackSlug", "lapMs"])
    // lapMs last so a driver's best on each track is the first row of that
    // track's range — the account window steps track to track reading one.
    .index("by_userKey_trackSlug_lapMs", ["userKey", "trackSlug", "lapMs"]),

  // A driver's best hand-driven lap on each circuit, as a trace to race
  // against. One per driver per circuit; a faster lap replaces it.
  ghostLaps: defineTable({
    userKey: v.string(),
    trackSlug: v.string(),
    lapMs: v.number(),
    samples: v.array(ghostSampleValidator),
  }).index("by_userKey_trackSlug", ["userKey", "trackSlug"]),
})
