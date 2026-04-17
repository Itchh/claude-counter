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

    const name = body.name?.trim()
    if (!name) {
      return new Response(JSON.stringify({ error: "Name required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    await ctx.runMutation(internal.leaderboard.upsertEntry, {
      key: name.toLowerCase(),
      name,
      totalTokens: body.totalTokens ?? 0,
      inputTokens: body.inputTokens ?? 0,
      outputTokens: body.outputTokens ?? 0,
      cacheTokens: body.cacheTokens ?? 0,
      tokensToday: body.tokensToday ?? 0,
      sessionCount: body.sessionCount ?? 0,
      lastSeen: new Date().toISOString(),
      ...(typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color) ? { color: body.color } : {}),
    })

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }),
})

export default http
