'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@/convex/_generated/api'
import type { Me } from './useMe'
import { useControlInput } from './useControlInput'
import {
  createDriveLink,
  type AnyPose,
  type ControlGame,
  type DriveLink,
  type RemoteEntity,
} from './types'

// One hook per game screen: the lease, the heartbeat, the pose feed out and
// the pose feed in. Everything the simulation reads is on `link`, which never
// changes identity; the React state here is only for the HUD.

/** Heartbeats every 2s against a 6s lease: two may be lost before it lapses. */
const HEARTBEAT_MS = 2_000
/** Ten poses a second. Enough for a lerp on the far end to look like motion. */
const PUBLISH_INTERVAL_MS = 100

export interface DriveHandle<P extends AnyPose> {
  /** Read by the simulation every frame. Stable identity. */
  readonly link: DriveLink<P>
  readonly driving: boolean
  /** Between the click and the server saying yes. */
  readonly taking: boolean
  readonly error: string | null
  readonly take: () => Promise<void>
  readonly release: () => Promise<void>
  /** Called from the frame loop: gamepad poll, and the throttled pose send. */
  readonly tick: (delta: number, pose: () => P | null) => void
}

export function useDrive<P extends AnyPose>(game: ControlGame, me: Me | null | undefined): DriveHandle<P> {
  const link = useRef<DriveLink<P>>(createDriveLink<P>()).current
  const [driving, setDriving] = useState(false)
  const [taking, setTaking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const takeControl = useMutation(api.control.takeControl)
  const heartbeat = useMutation(api.control.heartbeat)
  const releaseControl = useMutation(api.control.release)
  const publishPose = useMutation(api.control.publishPose)

  const { input, poll } = useControlInput(game, driving)
  // The link's input is the one the keyboard writes to.
  const linkWithInput = useMemo(() => Object.assign(link, { input }), [link, input])

  // Other screens' drivers. Own car excluded: this screen is its authority.
  const controls = useQuery(api.control.activeControls, { game })
  const poses = useQuery(api.control.poses, { game })
  useEffect(() => {
    const next = new Map<string, RemoteEntity<P>>()
    for (const control of controls ?? []) {
      if (me && control.racerKey === me.key) continue
      const pose = poses?.find((row) => row.racerKey === control.racerKey) ?? null
      next.set(control.racerKey, {
        holderName: control.holderName,
        pose: (pose?.pose as P | undefined) ?? null,
        seq: pose?.seq ?? 0,
        sentAt: pose?.sentAt ?? 0,
        expiresAt: control.expiresAt,
      })
    }
    linkWithInput.remotes = next
  }, [controls, poses, me, linkWithInput])

  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const stopHeartbeat = useCallback((): void => {
    if (heartbeatTimer.current !== null) clearInterval(heartbeatTimer.current)
    heartbeatTimer.current = null
  }, [])

  const release = useCallback(async (): Promise<void> => {
    stopHeartbeat()
    if (linkWithInput.drivenKey === null) return
    linkWithInput.drivenKey = null
    linkWithInput.nitro.lit = false
    setDriving(false)
    try {
      await releaseControl({ game, nitroCharge: linkWithInput.nitro.charge })
    } catch (cause) {
      // The lease lapses on its own in a few seconds; nothing to do but say so.
      console.error('Could not release control', cause)
    }
  }, [game, releaseControl, stopHeartbeat, linkWithInput])

  const take = useCallback(async (): Promise<void> => {
    if (!me || taking || linkWithInput.drivenKey !== null) return
    setTaking(true)
    setError(null)
    try {
      const result = await takeControl({ game })
      linkWithInput.drivenKey = me.key
      linkWithInput.nitro.charge = result.nitroCharge
      linkWithInput.nitro.lit = false
      setDriving(true)
      stopHeartbeat()
      heartbeatTimer.current = setInterval(() => {
        void heartbeat({ game, nitroCharge: linkWithInput.nitro.charge }).then((alive) => {
          // The server has forgotten us — a sweep, or a sign-out elsewhere.
          if (!alive) void release()
        }).catch((cause: unknown) => {
          console.error('Heartbeat failed', cause)
        })
      }, HEARTBEAT_MS)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not take control')
    } finally {
      setTaking(false)
    }
  }, [me, taking, game, takeControl, heartbeat, release, stopHeartbeat, linkWithInput])

  // Signing out, hiding the tab, or leaving the page all hand the car back.
  useEffect(() => {
    if (!driving) return
    if (!me) {
      void release()
      return
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') void release()
    }
    const onUnload = (): void => {
      void release()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onUnload)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onUnload)
    }
  }, [driving, me, release])

  useEffect(() => () => {
    stopHeartbeat()
  }, [stopHeartbeat])

  // Escape hands back. Capture phase, and only while driving, so the cabinet
  // and the camera keep their own Escape the rest of the time.
  useEffect(() => {
    if (!driving) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      void release()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [driving, release])

  const lastPublishAt = useRef(0)
  const inFlight = useRef(false)
  const tick = useCallback(
    (delta: number, pose: () => P | null): void => {
      poll(delta)
      if (linkWithInput.drivenKey === null) return
      const now = performance.now()
      if (inFlight.current || now - lastPublishAt.current < PUBLISH_INTERVAL_MS) return
      const snapshot = pose()
      if (!snapshot) return
      lastPublishAt.current = now
      inFlight.current = true
      publishPose({ pose: snapshot })
        .catch((cause: unknown) => {
          // A refused pose means the lease is gone under us.
          console.error('Pose refused', cause)
          void release()
        })
        .finally(() => {
          inFlight.current = false
        })
    },
    [poll, publishPose, release, linkWithInput],
  )

  return { link: linkWithInput, driving, taking, error, take, release, tick }
}
