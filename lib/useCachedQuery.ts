'use client'

import { useEffect, useState } from 'react'
import { useQuery, type OptionalRestArgsOrSkip } from 'convex/react'
import type { FunctionReference, FunctionReturnType } from 'convex/server'

// A Convex query with yesterday's answer ready while today's arrives.
//
// The cabinet's boards and rosters are attract mode: what matters is that
// something is on the screen the moment a window opens or a game loads, and
// a roster that is a few minutes stale is a roster, where a skeleton is not.
// The last result of each query is kept in localStorage and served until the
// live subscription replaces it — the same stale-while-revalidate a game
// console did by keeping the last save on the card.
//
// Never for anything that depends on who is signed in: `me` and `myStats`
// are the one person's, and a cached answer from the previous session would
// put somebody else's devices in the account window.

const CACHE_PREFIX = 'claude-counter:cache:'

function readCache<Value>(key: string): Value | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(CACHE_PREFIX + key)
    return raw === null ? null : (JSON.parse(raw) as Value)
  } catch (error) {
    console.warn(`Cached query ${key} could not be read`, error)
    return null
  }
}

function writeCache(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value))
  } catch (error) {
    // Private mode, or a full store: the live answer still shows, it just
    // will not be there next time.
    console.warn(`Cached query ${key} could not be saved`, error)
  }
}

/**
 * `useQuery`, returning the cached answer for `cacheKey` until the live one
 * lands. Undefined only when there is neither. A skipped query returns
 * undefined and touches nothing, the same as `useQuery` would.
 */
export function useCachedQuery<Query extends FunctionReference<'query'>>(
  cacheKey: string,
  query: Query,
  ...args: OptionalRestArgsOrSkip<Query>
): FunctionReturnType<Query> | undefined {
  const skipped = args[0] === 'skip'
  const live = useQuery(query, ...args)
  const [cached, setCached] = useState<FunctionReturnType<Query> | null>(() =>
    skipped ? null : readCache<FunctionReturnType<Query>>(cacheKey),
  )

  useEffect(() => {
    if (live === undefined || skipped) return
    writeCache(cacheKey, live)
    setCached(live)
  }, [live, skipped, cacheKey])

  if (live !== undefined) return live
  if (skipped || cached === null) return undefined
  return cached
}
