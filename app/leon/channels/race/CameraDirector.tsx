'use client'

import { useCallback, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { sampleTrackInto, laneOffset, TRACK_CURVE } from './circuit'
import type { SimRacer } from './useRaceSim'

// A racing-game replay director. The rule borrowed from the era: cameras CUT,
// they never lerp between positions. Within a shot the camera moves smoothly;
// between shots it hard-cuts, which is what makes it read as broadcast rather
// than as a drifting orbit.
//
// The onboard shot is the one that sells speed. A high wide shot is legible
// but motionless — you read the circuit, not the pace. Dropping the camera to
// bumper height, close behind a specific kart, with the FOV widening as that
// kart accelerates, is how every racing game of the era conveyed velocity:
// peripheral geometry tearing past a near-static subject.

const CHASE_DISTANCE = 9
const CHASE_HEIGHT = 4.2
/** How fast the chase camera catches up. Deliberately laggy — it drifts wide. */
const CHASE_SMOOTHING = 2.6

// Onboard rig. Low and close, so kerbs and pillars whip through the frame
// edges. Height is a compromise: lower reads faster, but drop below roughly
// 1.8m and a rival in an adjacent lane swallows the near field, since the
// camera is then sitting at kart-body height inside a bunched pack.
const ONBOARD_DISTANCE = 4.4
const ONBOARD_HEIGHT = 1.95
const ONBOARD_LOOK_AHEAD = 9
/** Onboard tracks tightly — a laggy POV feels like a drone, not a driver. */
const ONBOARD_SMOOTHING = 9

const BASE_FOV = 68
const ONBOARD_FOV_MIN = 70
const ONBOARD_FOV_MAX = 96
/** Speed at which the onboard FOV reaches its widest. Matches MAX_SPEED. */
const FOV_REFERENCE_SPEED = 18
/** FOV eases rather than snapping, so an overtake surges instead of popping. */
const FOV_SMOOTHING = 3.5

export type ShotKind = 'chase' | 'onboard' | 'trackside' | 'high'

// Onboard appears in half the rotation: it is the shot people actually enjoy,
// and it is the only one that names a person. The others are punctuation.
const SHOT_ORDER: ReadonlyArray<ShotKind> = [
  'onboard',
  'chase',
  'onboard',
  'trackside',
  'onboard',
  'high',
]

/** Onboard shots are shorter — a POV outstays its welcome faster than a wide. */
const SHOT_DURATION_S: Readonly<Record<ShotKind, number>> = {
  onboard: 9,
  chase: 12,
  trackside: 7,
  high: 10,
}

export interface ActiveShot {
  readonly kind: ShotKind
  /** Null for shots that aren't about one person (high wide). */
  readonly racerKey: string | null
  readonly name: string | null
  readonly color: string | null
}

interface CameraDirectorProps {
  readonly racersRef: React.RefObject<SimRacer[]>
  /** Fires only on a cut, so this is safe to drive React state with. */
  readonly onShotChange: (shot: ActiveShot) => void
}

export function CameraDirector({
  racersRef,
  onShotChange,
}: CameraDirectorProps): null {
  const { camera } = useThree()
  const elapsed = useRef(0)
  const shotIndex = useRef(0)
  /** Which racer the next onboard shot belongs to. Advances every POV cut. */
  const povCursor = useRef(0)
  const reportedKey = useRef<string | null>(null)

  const scratch = useMemo(
    () => ({
      target: new THREE.Vector3(),
      tangent: new THREE.Vector3(),
      desired: new THREE.Vector3(),
      lookAt: new THREE.Vector3(),
    }),
    [],
  )

  const report = useCallback(
    (shot: ShotKind, racer: SimRacer | null): void => {
      const signature = `${shot}:${racer?.key ?? ''}`
      if (reportedKey.current === signature) return
      reportedKey.current = signature
      onShotChange({
        kind: shot,
        racerKey: racer?.key ?? null,
        name: racer?.name ?? null,
        color: racer?.color ?? null,
      })
    },
    [onShotChange],
  )

  useFrame((_, delta) => {
    const racers = racersRef.current
    if (!racers || racers.length === 0) return

    const shot = SHOT_ORDER[shotIndex.current]

    elapsed.current += delta
    if (elapsed.current >= SHOT_DURATION_S[shot]) {
      elapsed.current = 0
      shotIndex.current = (shotIndex.current + 1) % SHOT_ORDER.length
      // Advance the POV subject as we leave an onboard shot, so consecutive
      // POVs are different people rather than the same kart twice.
      if (shot === 'onboard') povCursor.current += 1
      // The cut: snap the camera to the new shot with no interpolation.
      camera.position.set(0, 0, 0)
      return
    }

    // Leader by track position — the thing a spectator's eye goes to, which is
    // not always the score leader.
    const leader = racers.reduce((best, racer) =>
      racer.lap + racer.t > best.lap + best.t ? racer : best,
    )

    // Onboard follows a rotating cursor so every player gets screen time,
    // including whoever is last. That is the whole social point of the channel.
    const subject =
      shot === 'onboard' ? racers[povCursor.current % racers.length] : leader

    report(shot, shot === 'high' ? null : subject)

    sampleTrackInto(subject.t, laneOffset(subject.lane), scratch.target, scratch.tangent)

    const perspective = camera instanceof THREE.PerspectiveCamera ? camera : null
    let targetFov = BASE_FOV

    if (shot === 'onboard') {
      scratch.desired
        .copy(scratch.target)
        .addScaledVector(scratch.tangent, -ONBOARD_DISTANCE)
        .setY(ONBOARD_HEIGHT)
      const blend = 1 - Math.exp(-delta * ONBOARD_SMOOTHING)
      camera.position.lerp(scratch.desired, blend)
      // Look well down the road rather than at the kart: the horizon rushing
      // toward you is the speed cue, the kart itself barely moves in frame.
      scratch.lookAt
        .copy(scratch.target)
        .addScaledVector(scratch.tangent, ONBOARD_LOOK_AHEAD)
        .setY(ONBOARD_HEIGHT * 0.75)

      const speedRatio = Math.min(1, Math.max(0, subject.speed / FOV_REFERENCE_SPEED))
      targetFov = ONBOARD_FOV_MIN + speedRatio * (ONBOARD_FOV_MAX - ONBOARD_FOV_MIN)
    } else if (shot === 'chase') {
      scratch.desired
        .copy(scratch.target)
        .addScaledVector(scratch.tangent, -CHASE_DISTANCE)
        .setY(CHASE_HEIGHT)
      const blend = 1 - Math.exp(-delta * CHASE_SMOOTHING)
      camera.position.lerp(scratch.desired, blend)
      scratch.lookAt.copy(scratch.target).addScaledVector(scratch.tangent, 6)
    } else if (shot === 'trackside') {
      // Fixed post ahead of the subject; they drive into and past the frame.
      const ahead = (subject.t + 0.06) % 1
      TRACK_CURVE.getPointAt(ahead, scratch.desired)
      scratch.desired.y = 2.6
      scratch.desired.multiplyScalar(1.28)
      camera.position.copy(scratch.desired)
      scratch.lookAt.copy(scratch.target)
    } else {
      // High wide: the whole circuit, so the room can read the shape of the day.
      camera.position.set(0, 62, 46)
      scratch.lookAt.set(0, 0, 0)
    }

    if (perspective) {
      const blend = 1 - Math.exp(-delta * FOV_SMOOTHING)
      const nextFov = perspective.fov + (targetFov - perspective.fov) * blend
      // Sub-tenth-degree changes aren't visible and rebuilding the projection
      // matrix every frame for them is pure waste.
      if (Math.abs(nextFov - perspective.fov) > 0.05) {
        perspective.fov = nextFov
        perspective.updateProjectionMatrix()
      }
    }

    camera.lookAt(scratch.lookAt)
  })

  return null
}
