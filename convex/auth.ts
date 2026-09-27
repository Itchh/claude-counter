import { convexAuth } from "@convex-dev/auth/server"
import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials"
import { internal } from "./_generated/api"
import type { DataModel, Id } from "./_generated/dataModel"
import { normaliseLoginCode } from "../lib/loginCode"

// One way in, and it is the reporter.
//
// The reporter already runs on a person's own Mac with the shared secret and
// can read the Claude account signed in there, so it is the only thing in the
// building that can vouch for who is at a keyboard. `bun login` asks the
// server for a one-time code on that person's behalf; the browser hands the
// code back here and gets a session. No OAuth app, no email service, nothing
// for a teammate to register.

const NINETY_DAYS_MS = 90 * 24 * 60 * 60_000

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    ConvexCredentials<DataModel>({
      id: "device-link",
      authorize: async (credentials, ctx) => {
        const raw = typeof credentials.code === "string" ? credentials.code : ""
        const code = normaliseLoginCode(raw)
        if (!code) return null
        const userId: Id<"users"> | null = await ctx.runMutation(
          internal.deviceLink.consumeLoginCode,
          { code },
        )
        return userId ? { userId } : null
      },
    }),
  ],
  session: {
    totalDurationMs: NINETY_DAYS_MS,
    inactiveDurationMs: NINETY_DAYS_MS,
  },
})
