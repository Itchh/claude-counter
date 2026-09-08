'use client'

import * as THREE from 'three'
import type { Circuit } from './circuit'

// Keeping the camera in the world.
//
// Every rig in the director places the camera by arithmetic — so many metres
// behind the car, so many metres up, so far around an orbit — which is exactly
// right on a flat oval and quietly wrong on a mountain circuit. Nine metres
// behind a car climbing out of a hairpin is nine metres *into the hillside it
// just came round*, and once the camera is inside the terrain the picture does
// not go black: the surfaces it is now behind are single-sided, so they vanish
// and the viewer sees the town from underneath, with no floor and half the
// world missing. That frame is the bug this file exists to prevent.
//
// The correction is the one a camera operator makes without thinking: stand
// up when the ground is above your feet. It reads the same ground index the
// cars stand on (see groundField.ts), so the camera can never disagree with
// what is drawn — and it costs a grid lookup rather than a raycast, which is
// what an earlier version of this file cost and why the race froze.
//
// There is deliberately no occlusion test. Pulling the camera in front of
// whatever comes between it and the car wants a general ray through the
// model, and a general ray is the expensive question the index does not
// answer — while the case that actually ruined shots, the rig sinking into
// the hillside behind a climbing car, is a floor problem and this fixes it.

/** Metres of air kept under the lens. */
const GROUND_CLEARANCE = 0.9
/** How far the camera may be lifted in one frame, in metres per second. */
const LIFT_RATE = 90

/**
 * Lifts the camera clear of the ground beneath it. Mutates `position`.
 *
 * `floorHint` is the height the shot believes it is working at — the car, or
 * the point the rig is looking at. On a circuit with a bridge over it, that
 * is what decides which of the two surfaces under the lens is the one it
 * should be standing on.
 */
export function resolveCameraCollision(
  circuit: Circuit,
  position: THREE.Vector3,
  delta: number,
  { instant = false }: { readonly instant?: boolean } = {},
): void {
  if (!circuit.hasGround()) return

  // The floor *under the lens*, not the surface nearest some height the shot
  // assumed. Asking for the nearest surface to the car's height put the
  // camera inside hillsides it was supposed to be lifted out of: with a bank
  // twenty units above the lens and a valley twenty-five below, the valley is
  // nearer, so the clamp saw nothing wrong.
  const ground = circuit.groundBelow(position.x, position.z, position.y)
  if (Number.isNaN(ground)) return
  const floor = ground + GROUND_CLEARANCE
  if (position.y >= floor) return

  // Eased rather than snapped, where easing is possible: a camera that
  // teleports to head height the instant a kerb passes under it reads as a
  // glitch, where one that rises reads as the operator lifting the rig.
  //
  // Easing only works for a rig that carries its position from frame to
  // frame — the chase and onboard shots lerp, so a partial lift accumulates.
  // The trackside post and the high wide are *placed* absolutely every frame,
  // which threw the correction away and left them permanently a frame's worth
  // of lift above a floor they were metres below. Those pass `instant`.
  position.y = instant
    ? floor
    : Math.min(floor, position.y + LIFT_RATE * Math.max(delta, 0.0001))
}
