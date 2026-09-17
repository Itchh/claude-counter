'use client'

import { useEffect, useState } from 'react'
import { NARROW_BREAKPOINT_PX } from './hudScale'

const NARROW_QUERY = `(max-width: ${NARROW_BREAKPOINT_PX - 1}px)`

/**
 * True below the cabinet's narrow breakpoint — the width at which floating a
 * window over the race stops making sense and the two stack instead.
 *
 * Starts false on both server and first client render, so hydration matches;
 * the real answer lands in an effect one frame later. The one frame of wide
 * layout on a phone is invisible behind the title screen.
 */
export function useNarrowViewport(): boolean {
  const [isNarrow, setIsNarrow] = useState(false)

  useEffect(() => {
    const query = window.matchMedia(NARROW_QUERY)
    const update = (): void => setIsNarrow(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return isNarrow
}
