import { httpRouter } from "convex/server"
import { httpAction } from "./_generated/server"
import { internal } from "./_generated/api"

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

    await ctx.runMutation(internal.leaderboard.upsertDevice, {
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

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }),
})

export default http
