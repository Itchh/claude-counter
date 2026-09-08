'use client'

import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { Circuit } from './circuit'

// The viewer's half of the camera. The director still runs the broadcast, but
// the moment someone touches the deck the broadcast yields: drag to look
// around whoever we are following, press a movement key to detach entirely and
// fly the circuit, click a car to latch onto it.
//
// All of this lives in a mutable object behind a ref rather than in React
// state. Pointer and key input arrive far faster than a render, and the camera
// reads it inside useFrame — putting any of it through setState would re-render
// the whole channel several times a second for no visible gain.

export type CameraMode =
  /** The director's own shot rotation. The resting state. */
  | 'auto'
  /** Locked to one car, orbited by the pointer. */
  | 'follow'
  /** Detached. The camera flies under keyboard control. */
  | 'free'

export interface CameraControlState {
  mode: CameraMode
  /** Car the viewer latched onto. Null = whoever the director was showing. */
  followKey: string | null
  /** Orbit offsets layered on top of the chase rig, in radians. */
  orbitYaw: number
  orbitPitch: number
  /** Metres from the followed car. */
  distance: number
  freePosition: THREE.Vector3
  freeYaw: number
  freePitch: number
  /** Movement keys currently held, lowercased. */
  keys: Set<string>
  /** Seconds since the last input. Manual modes time out back to the broadcast. */
  idle: number
  /** Set when free roam must seed itself from wherever the camera currently is. */
  needsFreeSeed: boolean
  /** Set when the mode changed and the rig should ease in rather than snap. */
  needsLatch: boolean
  isDragging: boolean
  /** Pixels travelled since pointerdown — separates a click from a drag. */
  pointerTravel: number
}

/** Radians of rotation per pixel dragged. Tuned against a 320x288 internal frame. */
const DRAG_SENSITIVITY = 0.005
/** Never let the rig go under the tarmac, or fully overhead — both read as broken. */
const PITCH_MIN = -0.2
const PITCH_MAX = 1.15
export const DISTANCE_MIN = 3.5
export const DISTANCE_MAX = 55
export const DEFAULT_FOLLOW_DISTANCE = 9.5
/** Wheel notches are coarse, so zoom multiplicatively rather than by metres. */
const ZOOM_STEP = 1.12
/** Below this the pointer was held still enough to count as a click on a car. */
export const CLICK_TRAVEL_PX = 6

// Flight speed is set against the circuit, not against a first-person game:
// the lap is roughly 215m across a 70m-wide site, so anything near 30 m/s puts
// the camera in empty scenery within two seconds of holding W.
const FREE_SPEED = 13
const FREE_BOOST = 2.5
/**
 * Keeps free roam near the circuit — it is a camera, not a walking sim.
 *
 * Measured against the circuit rather than fixed at 85 units, which was the
 * oval's own size: on a 450-unit mountain course that cage sat entirely
 * inside the infield, so flying anywhere pinned the camera against an
 * invisible wall in the middle of a hill.
 */
const FREE_RADIUS_FACTOR = 1.35
/** Clearance kept above whatever is underneath, in game units. */
const FREE_GROUND_CLEARANCE = 1.4
/** How high above the road the free camera may climb. */
const FREE_CEILING = 90
/**
 * Fallback cage when the circuit has no model to measure against — the
 * procedural oval, whose ground is a plane at y = 0.
 */
const FREE_HEIGHT_MIN = 1.2

/** Seconds of no input before each manual mode hands back to the director. */
export const FOLLOW_IDLE_RETURN_S = 20
export const FREE_IDLE_RETURN_S = 60

// WASD and QE only. The arrows belong to the cabinet — left/right change
// channel, up/down move the cursor — and a camera that stole them would break
// the one navigation rule the whole deck is built on.
const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e'])
/** Anything that hands control back to the broadcast. */
const RELEASE_KEYS = new Set(['escape', 'c'])

export function createCameraControlState(): CameraControlState {
  return {
    mode: 'auto',
    followKey: null,
    orbitYaw: 0,
    orbitPitch: 0.16,
    distance: DEFAULT_FOLLOW_DISTANCE,
    freePosition: new THREE.Vector3(),
    freeYaw: 0,
    freePitch: 0,
    keys: new Set<string>(),
    idle: 0,
    needsFreeSeed: false,
    needsLatch: false,
    isDragging: false,
    pointerTravel: 0,
  }
}

/** Back to the director, with the rig reset so the next latch starts square. */
export function releaseToAuto(state: CameraControlState): void {
  state.mode = 'auto'
  state.followKey = null
  state.orbitYaw = 0
  state.orbitPitch = 0.16
  state.distance = DEFAULT_FOLLOW_DISTANCE
  state.keys.clear()
  state.idle = 0
  state.needsLatch = false
}

/** Latch onto a specific car. The director then flies the camera into it. */
export function followRacer(state: CameraControlState, racerKey: string): void {
  state.mode = 'follow'
  state.followKey = racerKey
  state.orbitYaw = 0
  state.orbitPitch = 0.16
  state.distance = DEFAULT_FOLLOW_DISTANCE
  state.keys.clear()
  state.idle = 0
  state.needsLatch = true
}

/** Direction the free rig is currently facing, into `out`. */
export function freeForward(state: CameraControlState, out: THREE.Vector3): THREE.Vector3 {
  const cosPitch = Math.cos(state.freePitch)
  return out
    .set(
      -Math.sin(state.freeYaw) * cosPitch,
      Math.sin(state.freePitch),
      -Math.cos(state.freeYaw) * cosPitch,
    )
    .normalize()
}

const scratchForward = new THREE.Vector3()
const scratchRight = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

/** Advances the free-roam rig from the keys currently held. */
export function stepFreeRoam(
  state: CameraControlState,
  circuit: Circuit,
  delta: number,
): void {
  const { keys } = state
  const forwardInput = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0)
  const rightInput = (keys.has('d') ? 1 : 0) - (keys.has('a') ? 1 : 0)
  const upInput = (keys.has('e') ? 1 : 0) - (keys.has('q') ? 1 : 0)

  // The cage below runs whether or not a key is held: free roam is seeded
  // from wherever the broadcast left the camera, and that can be somewhere
  // the free rig is not allowed to be.
  if (forwardInput !== 0 || rightInput !== 0 || upInput !== 0) {
    const speed = FREE_SPEED * (keys.has('shift') ? FREE_BOOST : 1) * delta
    freeForward(state, scratchForward)
    scratchRight.crossVectors(scratchForward, UP).normalize()

    state.freePosition
      .addScaledVector(scratchForward, forwardInput * speed)
      .addScaledVector(scratchRight, rightInput * speed)
      .addScaledVector(UP, upInput * speed)
  }

  // Soft cage, around the lap rather than around the origin — an imported
  // circuit sits wherever its rip put it. Clamping the radius rather than
  // blocking movement means flying at the wall slides along it instead of
  // stopping dead.
  const cage = circuit.radius * FREE_RADIUS_FACTOR
  const fromCentre = Math.hypot(
    state.freePosition.x - circuit.centre.x,
    state.freePosition.z - circuit.centre.z,
  )
  if (fromCentre > cage) {
    const scale = cage / fromCentre
    state.freePosition.x = circuit.centre.x + (state.freePosition.x - circuit.centre.x) * scale
    state.freePosition.z = circuit.centre.z + (state.freePosition.z - circuit.centre.z) * scale
  }

  // Height is measured off whatever is actually underneath, not off sea
  // level. A mountain circuit's road can sit forty units above the origin or
  // thirty below it, so an absolute floor of 1.2 let the camera fly straight
  // into the hillside — and inside the terrain the world renders from behind
  // its own single-sided surfaces, which is the "no floor" picture.
  const ground = circuit.groundBelow(
    state.freePosition.x,
    state.freePosition.z,
    state.freePosition.y,
  )
  const floor = Number.isNaN(ground) ? FREE_HEIGHT_MIN : ground + FREE_GROUND_CLEARANCE
  // The ceiling is measured from the lap, not from whatever happens to be
  // underneath. Hanging it off the local ground meant flying out over a
  // valley dropped the ceiling by the depth of the valley and yanked the
  // camera down with it.
  const ceiling = circuit.centre.y + FREE_CEILING
  state.freePosition.y = THREE.MathUtils.clamp(
    state.freePosition.y,
    Math.min(floor, ceiling),
    Math.max(floor, ceiling),
  )
}

/**
 * Binds pointer, wheel and key input to the control state.
 *
 * Pointer and wheel listeners go on the canvas, so dragging the camera never
 * fights with the rest of the page. Keys have to go on the window — the canvas
 * is not focusable and nobody clicks a TV before pressing a key — but only the
 * handful of keys this camera claims are consumed, so the deck's own shortcuts
 * (channel numbers) still get through untouched.
 */
export function useCameraInput(
  stateRef: React.RefObject<CameraControlState>,
  enabled: boolean,
  onInteract?: () => void,
): void {
  const gl = useThree((three) => three.gl)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  // Held in a ref so a new callback identity never rebinds the listeners.
  const interactRef = useRef(onInteract)
  interactRef.current = onInteract

  useEffect(() => {
    const canvas = gl.domElement
    const state = stateRef.current
    if (!state) return

    const markInput = (): void => {
      state.idle = 0
      // Tells the deck a human is here, so it stops rotating channels.
      interactRef.current?.()
    }

    const handlePointerDown = (event: PointerEvent): void => {
      if (!enabledRef.current || event.button !== 0) return
      state.isDragging = true
      state.pointerTravel = 0
      markInput()
      canvas.setPointerCapture(event.pointerId)
      canvas.style.cursor = 'grabbing'
    }

    const handlePointerMove = (event: PointerEvent): void => {
      if (!enabledRef.current || !state.isDragging) return
      state.pointerTravel += Math.abs(event.movementX) + Math.abs(event.movementY)
      markInput()

      // A drag anywhere is a request to look around. In auto that means taking
      // over the director's current subject rather than jumping somewhere new:
      // the shot the viewer grabbed is the shot they wanted to steer.
      if (state.mode === 'auto' && state.pointerTravel > CLICK_TRAVEL_PX) {
        state.mode = 'follow'
        state.followKey = null
        state.needsLatch = true
      }

      const yawDelta = -event.movementX * DRAG_SENSITIVITY
      const pitchDelta = event.movementY * DRAG_SENSITIVITY

      if (state.mode === 'free') {
        state.freeYaw += yawDelta
        state.freePitch = THREE.MathUtils.clamp(
          state.freePitch - pitchDelta,
          -Math.PI / 2 + 0.05,
          Math.PI / 2 - 0.05,
        )
        return
      }

      state.orbitYaw += yawDelta
      state.orbitPitch = THREE.MathUtils.clamp(
        state.orbitPitch + pitchDelta,
        PITCH_MIN,
        PITCH_MAX,
      )
    }

    const endDrag = (event: PointerEvent): void => {
      if (!state.isDragging) return
      state.isDragging = false
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId)
      }
      canvas.style.cursor = state.mode === 'auto' ? '' : 'grab'
    }

    const handleWheel = (event: WheelEvent): void => {
      if (!enabledRef.current || state.mode === 'free') return
      event.preventDefault()
      markInput()
      if (state.mode === 'auto') {
        state.mode = 'follow'
        state.followKey = null
        state.needsLatch = true
      }
      const factor = event.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      state.distance = THREE.MathUtils.clamp(
        state.distance * factor,
        DISTANCE_MIN,
        DISTANCE_MAX,
      )
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!enabledRef.current || event.metaKey || event.ctrlKey || event.altKey) return
      const key = event.key.toLowerCase()

      if (RELEASE_KEYS.has(key)) {
        if (state.mode === 'auto') return
        event.preventDefault()
        releaseToAuto(state)
        canvas.style.cursor = ''
        return
      }

      if (key === 'shift') {
        state.keys.add('shift')
        return
      }
      if (!MOVE_KEYS.has(key)) return

      event.preventDefault()
      markInput()
      // The first movement key is what detaches the camera. It seeds itself
      // from wherever the shot happened to be, so the takeover is a step out of
      // the broadcast rather than a teleport.
      if (state.mode !== 'free') {
        state.mode = 'free'
        state.needsFreeSeed = true
      }
      state.keys.add(key)
    }

    const handleKeyUp = (event: KeyboardEvent): void => {
      state.keys.delete(event.key.toLowerCase())
    }

    /** A tab-out strands held keys down, so the camera would fly off forever. */
    const handleBlur = (): void => {
      state.keys.clear()
      state.isDragging = false
    }

    canvas.addEventListener('pointerdown', handlePointerDown)
    canvas.addEventListener('pointermove', handlePointerMove)
    canvas.addEventListener('pointerup', endDrag)
    canvas.addEventListener('pointercancel', endDrag)
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleBlur)

    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDown)
      canvas.removeEventListener('pointermove', handlePointerMove)
      canvas.removeEventListener('pointerup', endDrag)
      canvas.removeEventListener('pointercancel', endDrag)
      canvas.removeEventListener('wheel', handleWheel)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleBlur)
      canvas.style.cursor = ''
    }
  }, [gl, stateRef])
}
