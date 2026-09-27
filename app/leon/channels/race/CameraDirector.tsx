'use client'

import { useCallback, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useCircuit } from './CircuitContext'
import type { Circuit } from './circuit'
import {
  useCameraInput,
  stepFreeRoam,
  freeForward,
  releaseToAuto,
  FOLLOW_IDLE_RETURN_S,
  FREE_IDLE_RETURN_S,
  type CameraControlState,
} from './cameraControls'
import {
  resolveCameraCollision,
  resolveCameraOcclusion,
  createSightState,
} from './cameraCollision'
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
//
// The director owns the camera only while nobody is touching it. Drag, scroll,
// a movement key or a click on a car all take it over (see cameraControls),
// and the manual rigs live at the bottom of this file. Manual modes hand back
// to the broadcast after a spell of no input, because this runs on a wall.

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

/**
 * The establishing shot. Height as a fraction of the lap's radius, clamped so
 * a kart oval still gets a crane and a mountain circuit does not get a
 * satellite — and stood over the start line rather than over the middle of
 * the lap, because the start line is the one point guaranteed to be inside
 * the world. See the high-shot branch below for what the middle turned out
 * to be.
 */
const HIGH_SHOT_HEIGHT_FRACTION = 0.22
const HIGH_SHOT_MIN_HEIGHT = 45
const HIGH_SHOT_MAX_HEIGHT = 170
/** How far behind the start line the crane stands, as a fraction of height. */
const HIGH_SHOT_BACK = 0.8

const BASE_FOV = 68
const ONBOARD_FOV_MIN = 70
const ONBOARD_FOV_MAX = 96
/** Speed at which the onboard FOV reaches its widest. Matches MAX_SPEED. */
const FOV_REFERENCE_SPEED = 18
/** FOV eases rather than snapping, so an overtake surges instead of popping. */
const FOV_SMOOTHING = 3.5

// Trackside post. The lead is a fraction of a lap, so a long circuit gives the
// subject the same couple of seconds to arrive as a short one does.
const TRACKSIDE_LEAD = 0.02
/** Metres beyond the kerb. Close enough that cars fill the frame passing. */
const TRACKSIDE_OFFSET = 6
const TRACKSIDE_HEIGHT = 2.6

/** The viewer-driven orbit. Snappier than the chase — it answers the hand. */
const FOLLOW_SMOOTHING = 7
/** Eye height above the car the orbit pivots around, and where it looks. */
const FOLLOW_PIVOT_HEIGHT = 1.1
/** Seconds of flight when latching onto a car. Long enough to read as a move. */
const LATCH_DURATION_S = 1.15
/** How far ahead the pre-latch framing is assumed to be, for the look blend. */
const LATCH_LOOK_DISTANCE = 14

/**
 * Height above the road of the point every shot's sightline is tested to.
 * Roughly a driver's head: testing to the tarmac itself puts the line through
 * the road surface on any crest and pulls the camera in for no reason.
 *
 * Measured from the ground index under the car rather than from the car's
 * own y, which comes off a smoothed profile: on a rip the two can disagree by
 * a metre, and a pivot a metre under the tarmac sees nothing but tarmac.
 */
const SIGHT_PIVOT_HEIGHT = 1.4

/** Puts the sightline pivot over the car, on the surface actually drawn. */
function placeSightPivot(circuit: Circuit, target: THREE.Vector3, out: THREE.Vector3): void {
  const surface = circuit.groundAt(target.x, target.z, target.y)
  const base = Number.isNaN(surface) ? target.y : Math.max(target.y, surface)
  out.set(target.x, base + SIGHT_PIVOT_HEIGHT, target.z)
}

export type ShotKind = 'chase' | 'onboard' | 'trackside' | 'high' | 'follow' | 'free'

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
const SHOT_DURATION_S: Readonly<Record<string, number>> = {
  onboard: 9,
  chase: 12,
  trackside: 7,
  high: 10,
}

export interface ActiveShot {
  readonly kind: ShotKind
  /** Null for shots that aren't about one person (high wide, free roam). */
  readonly racerKey: string | null
  readonly name: string | null
  readonly color: string | null
}

interface CameraDirectorProps {
  readonly racersRef: React.RefObject<SimRacer[]>
  /** Viewer input state. Mutated outside React; read here every frame. */
  readonly controlsRef: React.RefObject<CameraControlState>
  /** False when the channel is off screen — input is ignored and time stops. */
  readonly enabled: boolean
  /** Fires only on a cut, so this is safe to drive React state with. */
  readonly onShotChange: (shot: ActiveShot) => void
  /** Told about camera input, so the deck defers its channel rotation. */
  readonly onInteract?: () => void
}

/** Standard ease-in-out. Slow leave, slow arrival: reads as a camera move. */
function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

export function CameraDirector({
  racersRef,
  controlsRef,
  enabled,
  onShotChange,
  onInteract,
}: CameraDirectorProps): null {
  const { camera } = useThree()
  const circuit = useCircuit()
  const elapsed = useRef(0)
  const shotIndex = useRef(0)
  /** Which racer the next onboard shot belongs to. Advances every POV cut. */
  const povCursor = useRef(0)
  const reportedKey = useRef<string | null>(null)
  /** Whoever the last shot was about, so a takeover inherits the subject. */
  const lastSubjectKey = useRef<string | null>(null)
  /** 1 = settled. Below 1 the camera is flying into a newly latched car. */
  const latch = useRef(1)
  /** Set on a cut: the next frame places the camera outright, without easing. */
  const cutting = useRef(true)
  /** How far the lens is currently allowed to stand off its subject. */
  const sight = useRef(createSightState())

  useCameraInput(controlsRef, enabled, onInteract)

  const scratch = useMemo(
    () => ({
      target: new THREE.Vector3(),
      tangent: new THREE.Vector3(),
      desired: new THREE.Vector3(),
      lookAt: new THREE.Vector3(),
      latchFrom: new THREE.Vector3(),
      latchLookFrom: new THREE.Vector3(),
      latchLookTo: new THREE.Vector3(),
      forward: new THREE.Vector3(),
      pivot: new THREE.Vector3(),
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
    const controls = controlsRef.current
    if (!racers || racers.length === 0 || !controls) return

    if (controls.mode !== 'auto') {
      controls.idle += delta
      const timeout =
        controls.mode === 'free' ? FREE_IDLE_RETURN_S : FOLLOW_IDLE_RETURN_S
      if (!controls.isDragging && controls.keys.size === 0 && controls.idle > timeout) {
        releaseToAuto(controls)
        // Coming back to the broadcast is a cut, like any other shot change.
        elapsed.current = 0
        cutting.current = true
      }
    }

    // Leader by track position — the thing a spectator's eye goes to, which is
    // not always the score leader.
    const leader = racers.reduce((best, racer) =>
      racer.lap + racer.t > best.lap + best.t ? racer : best,
    )

    if (controls.mode === 'free') {
      driveFreeRoam(camera, controls, circuit, scratch, delta)
      report('free', null)
      easeFov(camera, BASE_FOV, delta)
      return
    }

    if (controls.mode === 'follow') {
      const subject =
        racers.find((racer) => racer.key === controls.followKey) ??
        racers.find((racer) => racer.key === lastSubjectKey.current) ??
        leader
      lastSubjectKey.current = subject.key
      report('follow', subject)

      if (controls.needsLatch) {
        controls.needsLatch = false
        latch.current = 0
        scratch.latchFrom.copy(camera.position)
        camera.getWorldDirection(scratch.forward)
        scratch.latchLookFrom
          .copy(camera.position)
          .addScaledVector(scratch.forward, LATCH_LOOK_DISTANCE)
      }

      // Where the car *is*, not the lane it is aiming for. The renderer places
      // the kart at `lateral`; sampling the lane offset here framed the ideal
      // line instead, and in a drift or a lane change the car sat a couple of
      // metres off centre while the camera looked at empty road.
      circuit.sampleInto(subject.t, subject.lateral, scratch.target, scratch.tangent)
      // Camera sits on a sphere around the car: heading + PI puts it behind,
      // and the viewer's yaw/pitch swing it from there.
      const heading = Math.atan2(scratch.tangent.x, scratch.tangent.z) + Math.PI
      const orbitYaw = heading + controls.orbitYaw
      const horizontal = controls.distance * Math.cos(controls.orbitPitch)
      scratch.desired.set(
        scratch.target.x + Math.sin(orbitYaw) * horizontal,
        Math.max(
          scratch.target.y + 0.8,
          scratch.target.y +
            FOLLOW_PIVOT_HEIGHT +
            controls.distance * Math.sin(controls.orbitPitch),
        ),
        scratch.target.z + Math.cos(orbitYaw) * horizontal,
      )
      scratch.lookAt.copy(scratch.target).setY(scratch.target.y + FOLLOW_PIVOT_HEIGHT)

      if (latch.current < 1) {
        latch.current = Math.min(1, latch.current + delta / LATCH_DURATION_S)
        const eased = easeInOutCubic(latch.current)
        camera.position.lerpVectors(scratch.latchFrom, scratch.desired, eased)
        scratch.latchLookTo.copy(scratch.lookAt)
        scratch.lookAt.lerpVectors(scratch.latchLookFrom, scratch.latchLookTo, eased)
      } else {
        camera.position.lerp(scratch.desired, 1 - Math.exp(-delta * FOLLOW_SMOOTHING))
      }

      // Same speed-widened FOV as onboard, scaled back as the viewer pulls
      // out: at 40m a 96-degree lens is just distortion.
      const speedRatio = Math.min(1, Math.max(0, subject.speed / FOV_REFERENCE_SPEED))
      const proximity = Math.min(1, 12 / Math.max(1, controls.distance))
      easeFov(
        camera,
        ONBOARD_FOV_MIN + speedRatio * proximity * (ONBOARD_FOV_MAX - ONBOARD_FOV_MIN),
        delta,
      )
      // Only once the latch has landed: interrupting the flight-in with a
      // collision correction turns a camera move into a stutter, and the
      // arrival position is itself resolved, so the flight ends somewhere legal.
      if (latch.current >= 1) {
        resolveCameraCollision(circuit, camera.position, delta, {
          referenceY: scratch.lookAt.y,
        })
        // The orbit is the one rig the viewer aims themselves, and they will
        // happily swing it into a hillside or leave it outside a tunnel the
        // car has just entered. Same rule as the broadcast shots: the lens
        // comes in front of whatever the line crosses.
        placeSightPivot(circuit, scratch.target, scratch.pivot)
        resolveCameraOcclusion(
          circuit,
          scratch.pivot,
          camera.position,
          delta,
          sight.current,
        )
      }
      camera.lookAt(scratch.lookAt)
      return
    }

    const shot = SHOT_ORDER[shotIndex.current]

    elapsed.current += delta
    if (elapsed.current >= (SHOT_DURATION_S[shot] ?? 10)) {
      elapsed.current = 0
      shotIndex.current = (shotIndex.current + 1) % SHOT_ORDER.length
      // Advance the POV subject as we leave an onboard shot, so consecutive
      // POVs are different people rather than the same kart twice.
      if (shot === 'onboard') povCursor.current += 1
      // The cut: the next frame places the camera outright rather than easing
      // into the new shot.
      //
      // It used to park the camera at the world origin for this one frame to
      // defeat the easing, which on the flat oval was a frame of sky. On an
      // imported circuit the origin is inside the terrain, and the frame it
      // rendered from in there was the whole world seen from underneath with
      // its single-sided surfaces facing away — the missing-floor picture. A
      // flag does the same job and never puts the lens anywhere.
      cutting.current = true
      return
    }

    // Onboard follows a rotating cursor so every player gets screen time,
    // including whoever is last. That is the whole social point of the channel.
    const subject =
      shot === 'onboard' ? racers[povCursor.current % racers.length] : leader
    lastSubjectKey.current = subject.key

    report(shot, shot === 'high' ? null : subject)

    circuit.sampleInto(subject.t, subject.lateral, scratch.target, scratch.tangent)

    let targetFov = BASE_FOV

    // Every rig height below is measured from the road at the subject's own
    // position, never from y=0. The original oval was flat at sea level and
    // the two were the same number, so absolute heights went unnoticed right
    // up until the first mountain circuit — where "1.95 units up" put the
    // onboard camera a hundred units inside the hillside, filming the dark
    // side of the terrain.
    if (shot === 'onboard') {
      scratch.desired
        .copy(scratch.target)
        .addScaledVector(scratch.tangent, -ONBOARD_DISTANCE)
        .setY(scratch.target.y + ONBOARD_HEIGHT)
      const blend = cutting.current ? 1 : 1 - Math.exp(-delta * ONBOARD_SMOOTHING)
      camera.position.lerp(scratch.desired, blend)
      // Look well down the road rather than at the kart: the horizon rushing
      // toward you is the speed cue, the kart itself barely moves in frame.
      scratch.lookAt
        .copy(scratch.target)
        .addScaledVector(scratch.tangent, ONBOARD_LOOK_AHEAD)
        .setY(scratch.target.y + ONBOARD_HEIGHT * 0.75)

      const speedRatio = Math.min(1, Math.max(0, subject.speed / FOV_REFERENCE_SPEED))
      targetFov = ONBOARD_FOV_MIN + speedRatio * (ONBOARD_FOV_MAX - ONBOARD_FOV_MIN)
    } else if (shot === 'chase') {
      scratch.desired
        .copy(scratch.target)
        .addScaledVector(scratch.tangent, -CHASE_DISTANCE)
        .setY(scratch.target.y + CHASE_HEIGHT)
      const blend = cutting.current ? 1 : 1 - Math.exp(-delta * CHASE_SMOOTHING)
      camera.position.lerp(scratch.desired, blend)
      scratch.lookAt.copy(scratch.target).addScaledVector(scratch.tangent, 6)
    } else if (shot === 'trackside') {
      // Fixed post ahead of the subject; they drive into and past the frame.
      //
      // Placed by stepping sideways off the road, not by pushing the point
      // away from the world origin. The radial version worked only because
      // the original circuit was a roughly circular oval centred on nothing
      // else; on a real road course a point 130 units out gets flung 36 units
      // into a field, and the camera watches the race from a car park.
      const ahead = (subject.t + TRACKSIDE_LEAD) % 1
      const post = circuit.sample(ahead, circuit.halfWidth + TRACKSIDE_OFFSET)
      scratch.desired.copy(post.position).setY(post.position.y + TRACKSIDE_HEIGHT)
      camera.position.copy(scratch.desired)
      scratch.lookAt.copy(scratch.target)
    } else {
      // High wide: the establishing shot, so the room can read the shape of
      // the day.
      //
      // It used to hang over the middle of the lap at two thirds of the
      // lap's radius, on the theory that this kept it under a rip's painted
      // backdrop. It did not. A mountain circuit is a lap round a peak, so
      // the middle of the lap is the peak, and a camera 450 units above it
      // is above the rim of the scenery bowl — the ten seconds it spent
      // there were the world seen from outside, backdrop sheets facing away
      // and sky showing through the valley floor, on both mountain rips,
      // every rotation. The HUD kept the previous shot's name up, so it read
      // as an onboard camera that had fallen through the map.
      //
      // Now it is a crane over the start line: the one point on the circuit
      // that is certainly road, certainly inside the world, and certainly
      // under open sky — and it looks along the lap towards the middle, so
      // the circuit still unfolds in front of it. The sightline below then
      // does the rest: if the start straight runs under a bridge or a roof,
      // the crane comes down to just beneath it.
      circuit.sampleInto(0, 0, scratch.pivot, scratch.tangent)
      const craneHeight = Math.min(
        HIGH_SHOT_MAX_HEIGHT,
        Math.max(HIGH_SHOT_MIN_HEIGHT, circuit.radius * HIGH_SHOT_HEIGHT_FRACTION),
      )
      camera.position
        .copy(scratch.pivot)
        .addScaledVector(scratch.tangent, -craneHeight * HIGH_SHOT_BACK)
        .setY(scratch.pivot.y + craneHeight)
      scratch.lookAt.copy(circuit.centre).setY(circuit.centre.y)
      // The establishing shot has no subject, but the sightline still wants
      // a point on the road to be tested from: the start line itself.
      scratch.target.copy(scratch.pivot)
    }

    const cutFrame = cutting.current
    cutting.current = false

    // Trackside and the high wide place the camera outright rather than
    // easing towards it, so their correction has to land in the same frame —
    // and so does any shot's first frame after a cut: the eased lift climbs
    // at a rate tuned for a kerb passing under a moving rig, and a cut that
    // lands thirty units inside a hillside would spend a visible third of a
    // second underground before it surfaced. The reference height is the
    // subject's own, which is what picks the road rather than the valley
    // floor when the two are stacked.
    resolveCameraCollision(circuit, camera.position, delta, {
      instant: cutFrame || shot === 'trackside' || shot === 'high',
      referenceY: scratch.target.y + 1,
    })

    // Then the sightline, which is the rule that gets a shot through a
    // tunnel: whatever the rig asked for, the lens sits in front of the
    // first thing between it and the car. The high wide is tested from the
    // start line rather than from a car, which is what keeps its crane under
    // any roof the start straight happens to run beneath.
    placeSightPivot(circuit, scratch.target, scratch.pivot)
    resolveCameraOcclusion(
      circuit,
      scratch.pivot,
      camera.position,
      delta,
      sight.current,
      { instant: cutFrame || shot === 'high' },
    )

    easeFov(camera, targetFov, delta)
    camera.lookAt(scratch.lookAt)
  })

  return null
}

interface DirectorScratch {
  readonly forward: THREE.Vector3
  readonly lookAt: THREE.Vector3
}

/**
 * The detached rig. Position and orientation live entirely in the control
 * state, so the camera is written rather than eased — a flying camera that
 * lags its own input feels broken, not cinematic.
 */
function driveFreeRoam(
  camera: THREE.Camera,
  controls: CameraControlState,
  circuit: Circuit,
  scratch: DirectorScratch,
  delta: number,
): void {
  if (controls.needsFreeSeed) {
    controls.needsFreeSeed = false
    controls.freePosition.copy(camera.position)
    camera.getWorldDirection(scratch.forward)
    controls.freeYaw = Math.atan2(-scratch.forward.x, -scratch.forward.z)
    controls.freePitch = Math.asin(THREE.MathUtils.clamp(scratch.forward.y, -1, 1))
  }

  stepFreeRoam(controls, circuit, Math.min(delta, 0.1))
  camera.position.copy(controls.freePosition)
  freeForward(controls, scratch.forward)
  scratch.lookAt.copy(camera.position).add(scratch.forward)
  camera.lookAt(scratch.lookAt)
}

/** Eases the field of view, skipping changes too small to see. */
function easeFov(camera: THREE.Camera, targetFov: number, delta: number): void {
  if (!(camera instanceof THREE.PerspectiveCamera)) return
  const blend = 1 - Math.exp(-delta * FOV_SMOOTHING)
  const nextFov = camera.fov + (targetFov - camera.fov) * blend
  // Sub-tenth-degree changes aren't visible and rebuilding the projection
  // matrix every frame for them is pure waste.
  if (Math.abs(nextFov - camera.fov) > 0.05) {
    camera.fov = nextFov
    camera.updateProjectionMatrix()
  }
}
