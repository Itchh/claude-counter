'use client'

import { useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'

export interface Me {
  readonly key: string
  readonly name: string
  readonly color: string | null
  readonly paint: string | null
  readonly livery: string | null
  readonly chassis: number | null
  readonly claudeAccountId: string | null
  readonly lastLoginAt: number | null
  readonly totalTokens: number
  readonly nitroCharge: number
}

/** Who is signed in on this screen. Null when nobody; undefined while asking. */
export function useMe(): Me | null | undefined {
  return useQuery(api.me.me)
}
