import { v } from "convex/values"
import { internalMutation, internalQuery } from "./_generated/server"
import type { Id } from "./_generated/dataModel"
import {
  LOGIN_CODE_ALPHABET,
  LOGIN_CODE_LENGTH,
  LOGIN_CODE_TTL_MS,
} from "../lib/loginCode"

// Sign-in codes: minted for the reporter over HTTP, consumed by the auth
// provider. Both internal — nothing here is callable from a browser directly.

/**
 * Looks up the per-device link token for a (userKey, deviceId) pair.
 * Returns null when the device has not reported yet or has no token.
 * Used by the /link HTTP endpoint to verify callers.
 */
export const getDeviceLinkToken = internalQuery({
  args: { userKey: v.string(), deviceId: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const device = await ctx.db
      .query("devices")
      .withIndex("by_userKey_deviceId", (q) =>
        q.eq("userKey", args.userKey).eq("deviceId", args.deviceId),
      )
      .unique()
    return device?.linkToken ?? null
  },
})

function randomCode(): string {
  const bytes = new Uint8Array(LOGIN_CODE_LENGTH)
  crypto.getRandomValues(bytes)
  let code = ""
  for (const byte of bytes) code += LOGIN_CODE_ALPHABET[byte % LOGIN_CODE_ALPHABET.length]
  return code
}

/**
 * Mints a code for a driver, creating the driver if the reporter has not
 * reported yet — a person who installs and signs in within the same minute
 * should not be told they do not exist.
 */
export const createLoginCode = internalMutation({
  args: {
    userKey: v.string(),
    deviceId: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args): Promise<{ code: string; expiresAt: number }> => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_key", (q) => q.eq("key", args.userKey))
      .unique()

    // Create a user stub if the reporter hasn't sent its first report yet —
    // this lets setup (install + login in one step) work for brand-new users.
    // claudeAccountId is deliberately NOT set here: only /report may write it,
    // so that the auth path cannot be used to overwrite a user's account link.
    if (!existing) {
      await ctx.db.insert("users", {
        key: args.userKey,
        name: args.name,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        tokensToday: 0,
        sessionCount: 0,
        lastSeen: new Date(0).toISOString(),
      })
    }

    const code = randomCode()
    const expiresAt = Date.now() + LOGIN_CODE_TTL_MS
    await ctx.db.insert("loginCodes", {
      code,
      userKey: args.userKey,
      deviceId: args.deviceId,
      expiresAt,
    })
    return { code, expiresAt }
  },
})

/** Burns a code and returns the driver it was minted for, or null. */
export const consumeLoginCode = internalMutation({
  args: { code: v.string() },
  handler: async (ctx, args): Promise<Id<"users"> | null> => {
    const row = await ctx.db
      .query("loginCodes")
      .withIndex("by_code", (q) => q.eq("code", args.code))
      .unique()
    if (!row) return null
    if (row.consumedAt !== undefined || row.expiresAt < Date.now()) return null

    const user = await ctx.db
      .query("users")
      .withIndex("by_key", (q) => q.eq("key", row.userKey))
      .unique()
    if (!user) return null

    await ctx.db.patch(row._id, { consumedAt: Date.now() })
    await ctx.db.patch(user._id, { lastLoginAt: Date.now() })
    return user._id
  },
})

/** The reporter found a Claude account on the machine; remember it. */
export const attachClaudeAccount = internalMutation({
  args: { userKey: v.string(), claudeAccountId: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_key", (q) => q.eq("key", args.userKey))
      .unique()
    if (user && user.claudeAccountId !== args.claudeAccountId) {
      await ctx.db.patch(user._id, { claudeAccountId: args.claudeAccountId })
    }
    return null
  },
})

const PRUNE_BATCH = 200

export const pruneLoginCodes = internalMutation({
  args: {},
  handler: async (ctx): Promise<null> => {
    const stale = await ctx.db
      .query("loginCodes")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", Date.now()))
      .take(PRUNE_BATCH)
    for (const row of stale) await ctx.db.delete(row._id)
    return null
  },
})
