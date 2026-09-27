'use client'

import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'

// One guard for every channel's WebGL context.
//
// A lost context has two endings. The browser may hand it back — then the
// scene is rebuilt by remounting the Canvas. Or it may not: Chrome drops a
// context to make room for a newer one and never restores it, and a channel
// that waits politely for a restore that is not coming sits on its title
// card for the rest of the session with the previous game showing through.
// So the wait has a clock. If nothing has come back by `RESTORE_GRACE_MS`
// the Canvas is remounted anyway, which asks for a fresh context; a small
// number of tries, so a machine that genuinely has no GPU left does not
// spin asking for one.
//
// Nothing here loses the context on cleanup. Fiber's own root teardown
// force-loses it when the Canvas unmounts, and losing it a second time
// from a cleanup poisoned the GPU channel so badly that every canvas
// created afterwards failed to initialise and the tab hung in a native
// getContext call. One release, owned by fiber, is enough.

const RESTORE_GRACE_MS = 2500
const MAX_REMOUNTS = 3

interface ContextGuardProps {
  /** Names the channel in the console. */
  readonly label: string
  /** Remounts the Canvas. Called on restore, or when the wait runs out. */
  readonly onRestored: () => void
}

export function ContextGuard({ label, onRestored }: ContextGuardProps): null {
  const gl = useThree((state) => state.gl)
  const remounts = useRef(0)

  useEffect(() => {
    const canvas = gl.domElement
    let grace: number | null = null

    const handleLost = (event: Event): void => {
      // Without this the loss is final and the canvas stays black forever.
      event.preventDefault()
      console.warn(`${label} channel: WebGL context lost — waiting for restore.`)
      if (grace !== null) window.clearTimeout(grace)
      grace = window.setTimeout(() => {
        grace = null
        if (remounts.current >= MAX_REMOUNTS) {
          console.error(`${label} channel: WebGL context not restored after ${MAX_REMOUNTS} remounts; giving up.`)
          return
        }
        remounts.current += 1
        console.warn(`${label} channel: no restore in ${RESTORE_GRACE_MS}ms — remounting (${remounts.current}/${MAX_REMOUNTS}).`)
        onRestored()
      }, RESTORE_GRACE_MS)
    }
    const handleRestored = (): void => {
      if (grace !== null) window.clearTimeout(grace)
      grace = null
      console.warn(`${label} channel: WebGL context restored — rebuilding scene.`)
      onRestored()
    }

    canvas.addEventListener('webglcontextlost', handleLost)
    canvas.addEventListener('webglcontextrestored', handleRestored)
    return () => {
      if (grace !== null) window.clearTimeout(grace)
      canvas.removeEventListener('webglcontextlost', handleLost)
      canvas.removeEventListener('webglcontextrestored', handleRestored)
    }
  }, [gl, onRestored, label])

  return null
}
