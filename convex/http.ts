import { httpRouter } from "convex/server"
import { httpAction } from "./_generated/server"
import { internal } from "./_generated/api"

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
      tokensToday: body.tokensToday ?? 0,
      sessionCount: body.sessionCount ?? 0,
      lastSeen: new Date().toISOString(),
    })

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }),
})

export default http
