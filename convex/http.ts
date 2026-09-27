import { httpRouter } from "convex/server"
import { httpAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { auth } from "./auth"

const MAX_MODEL_KEYS = 64
const MAX_MODEL_KEY_LENGTH = 128

function parseTokensByModel(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const cleaned: Record<string, number> = {}
  let count = 0
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_MODEL_KEYS) break
    if (!model || model.length > MAX_MODEL_KEY_LENGTH) continue
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue
    cleaned[model] = value
    count++
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined
}

const MAX_BUCKETS = 400
const MAX_SESSIONS = 8

interface ParsedBucket {
  bucketStart: number
  tokens: number
}

interface ParsedSession {
  startedAt: number
  lastActivityAt: number
}

// Reporters older than v4 send neither of these. Anything that isn't the exact
// expected shape is treated as absent rather than allowed to reach a validator.
function parseBuckets(raw: unknown): ParsedBucket[] {
  if (!Array.isArray(raw)) return []
  const cleaned: ParsedBucket[] = []
  for (const item of raw) {
    if (cleaned.length >= MAX_BUCKETS) break
    if (typeof item !== "object" || item === null) continue
    const { bucketStart, tokens } = item as Record<string, unknown>
    if (typeof bucketStart !== "number" || !Number.isFinite(bucketStart)) continue
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) continue
    cleaned.push({ bucketStart, tokens })
  }
  return cleaned
}

function parseSessions(raw: unknown): ParsedSession[] {
  if (!Array.isArray(raw)) return []
  const cleaned: ParsedSession[] = []
  for (const item of raw) {
    if (cleaned.length >= MAX_SESSIONS) break
    if (typeof item !== "object" || item === null) continue
    const { startedAt, lastActivityAt } = item as Record<string, unknown>
    if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) continue
    if (typeof lastActivityAt !== "number" || !Number.isFinite(lastActivityAt)) continue
    if (lastActivityAt < startedAt) continue
    cleaned.push({ startedAt, lastActivityAt })
  }
  return cleaned
}

const http = httpRouter()

// Convex Auth's JWKS and OpenID discovery. No OAuth routes: the only sign-in
// is the device link, which never leaves this deployment.
auth.addHttpRoutes(http)

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * The reporter asking for a sign-in code on its owner's behalf.
 *
 * Authentication priority:
 * 1. Per-device linkToken (issued by /report on first registration). Only the
 *    machine that registered the device ever receives this token, so it proves
 *    the caller owns the device without relying on the shared team secret.
 * 2. Shared secret fallback — accepted only when the device has no linkToken
 *    yet (i.e. it has not completed its first report). This covers the
 *    "install and sign in immediately" setup flow. Once a device has reported
 *    and received a linkToken, the shared secret is no longer accepted for it.
 */
http.route({
  path: "/link",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json()
    const json = (payload: unknown, status: number): Response =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      })

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : ""
    const name = typeof body.name === "string" ? body.name.trim() : ""
    if (!EMAIL_REGEX.test(email)) return json({ error: "A valid email is required" }, 400)
    if (!deviceId) return json({ error: "Device ID is required" }, 400)
    if (!name) return json({ error: "Display name is required" }, 400)

    // Check whether a per-device token exists for this (email, deviceId).
    const storedLinkToken = await ctx.runQuery(internal.deviceLink.getDeviceLinkToken, {
      userKey: email,
      deviceId,
    })

    if (storedLinkToken !== null) {
      // Device has reported at least once: require the per-device token.
      const suppliedToken = typeof body.linkToken === "string" ? body.linkToken.trim() : ""
      if (!suppliedToken || suppliedToken !== storedLinkToken) {
        return json({ error: "Unauthorized" }, 401)
      }
    } else {
      // Device has never reported: fall back to the shared secret for initial
      // setup. Once the first /report completes, this path is no longer used.
      const secret = process.env.LEADERBOARD_SECRET
      if (!secret || body.secret !== secret) return json({ error: "Unauthorized" }, 401)
    }

    const { code, expiresAt } = await ctx.runMutation(internal.deviceLink.createLoginCode, {
      userKey: email,
      deviceId,
      name,
    })

    // Where the browser should go. SITE_URL is set on the deployment by the
    // Convex Auth initialiser; without it the code still works typed in.
    const siteUrl = (process.env.SITE_URL ?? "").replace(/\/$/, "")
    const url = siteUrl ? `${siteUrl}/login?code=${code}` : null
    return json({ code, url, expiresAt }, 200)
  }),
})

http.route({
  path: "/report",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json()

    const secret = process.env.LEADERBOARD_SECRET
    if (!secret || body.secret !== secret) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }

    const name = typeof body.name === "string" ? body.name.trim() : ""
    const email = typeof body.email === "string" ? body.email.trim() : ""
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : ""

    if (!name) {
      return new Response(
        JSON.stringify({ error: "Display name is required in the report body" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }
    if (!email) {
      return new Response(
        JSON.stringify({
          error:
            "Email is required in the report body. Re-run `bun setup.ts` to upgrade your reporter.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }
    if (!deviceId) {
      return new Response(
        JSON.stringify({
          error:
            "Device ID is required in the report body. Re-run `bun setup.ts` to upgrade your reporter.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    // Reporters older than v3 don't send tokensByModel at all; treat anything
    // that isn't a plain map of finite positive numbers as absent rather than
    // letting a malformed payload reach the mutation validator.
    const tokensByModel = parseTokensByModel(body.tokensByModel)

    const color =
      typeof body.color === "string" && /^#[0-9a-fA-F]{6}$/.test(body.color)
        ? body.color
        : undefined

    const { linkToken } = await ctx.runMutation(internal.leaderboard.upsertDevice, {
      userKey: email.toLowerCase(),
      deviceId,
      name,
      ...(color !== undefined ? { color } : {}),
      totalTokens: body.totalTokens ?? 0,
      inputTokens: body.inputTokens ?? 0,
      outputTokens: body.outputTokens ?? 0,
      cacheTokens: body.cacheTokens ?? 0,
      ...(tokensByModel !== undefined ? { tokensByModel } : {}),
      tokensToday: body.tokensToday ?? 0,
      sessionCount: body.sessionCount ?? 0,
      lastSeen: new Date().toISOString(),
    })

    // v5 reporters know which Claude account is signed in on the machine.
    if (typeof body.claudeAccountId === "string" && body.claudeAccountId.trim()) {
      await ctx.runMutation(internal.deviceLink.attachClaudeAccount, {
        userKey: email.toLowerCase(),
        claudeAccountId: body.claudeAccountId.trim(),
      })
    }

    // v4 detail. Absent for older reporters, which keep working exactly as
    // before — they simply generate no bucket data and race at a flat pace.
    const buckets = parseBuckets(body.buckets)
    const sessions = parseSessions(body.sessions)
    if (buckets.length > 0 || sessions.length > 0) {
      await ctx.runMutation(internal.scoring.applyReportDetail, {
        userKey: email.toLowerCase(),
        deviceId,
        name,
        ...(color !== undefined ? { color } : {}),
        buckets,
        sessions,
      })
    }

    // Return the per-device linkToken so the reporter can save it and use it
    // for future /link calls instead of the shared team secret.
    return new Response(JSON.stringify({ ok: true, linkToken }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }),
})

export default http
