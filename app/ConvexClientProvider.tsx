"use client"

import { ConvexAuthProvider } from "@convex-dev/auth/react"
import { ConvexReactClient } from "convex/react"
import { type ReactNode } from "react"

// Convex Auth's provider rather than the plain one: it is what attaches the
// session token to every query and mutation, so `ctx.auth` on the server
// knows who is asking. Anonymous viewers are still fine — the wall screen
// reads everything it always did; only the writes ask who you are.
const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!)

export function ConvexClientProvider({
  children,
}: Readonly<{
  children: ReactNode
}>): React.ReactElement {
  return <ConvexAuthProvider client={convex}>{children}</ConvexAuthProvider>
}
