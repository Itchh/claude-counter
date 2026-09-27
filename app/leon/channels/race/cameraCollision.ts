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
 * `referenceY` is the height the shot believes it is working at — the car,
 * or the point the rig is looking at. It only matters in the rescue path
 * below: on a circuit with a bridge over it, it is what decides which of
 * the stacked surfaces is the one the shot should be standing on.
 */
export function resolveCameraCollision(
  circuit: Circuit,
  position: THREE.Vector3,
  delta: number,
  {
    instant = false,
    referenceY,
  }: { readonly instant?: boolean; readonly referenceY?: number } = {},
): void {
  if (!circuit.hasGround()) return

  // The floor *under the lens*, not the surface nearest some height the shot
  // assumed. Asking for the nearest surface to the car's height put the
  // camera inside hillsides it was supposed to be lifted out of: with a bank
  // twenty units above the lens and a valley twenty-five below, the valley is
  // nearer, so the clamp saw nothing wrong.
  const ground = circuit.groundBelow(position.x, position.z, position.y)
  if (Number.isNaN(ground)) {
    // Nothing under the lens at all: the camera is beneath the world — the
    // exact frame this file's preamble describes, where every single-sided
    // surface faces away and the viewer gets a screen of painted sky. This
    // used to be the silent give-up path, which is why that frame still
    // appeared "sometimes": a cut behind a car on a steep crest could land
    // the rig under the terrain skirt, where there is no floor to find
    // downwards. The rescue asks the other question — the surface nearest
    // the height the *shot* is working at — and stands the camera on it
    // outright. A one-frame pop beats seconds of empty sky.
    const hint = referenceY ?? position.y
    const surface = circuit.groundAt(position.x, position.z, hint)
    if (Number.isNaN(surface)) return
    position.y = Math.max(position.y, surface + GROUND_CLEARANCE)
    return
  }
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

// Keeping the world out of the lens.
//
// The paragraph above says there is deliberately no occlusion test, and that
// the case which ruined shots was a floor problem. A tunnel is the case that
// disproved it. A car nine metres ahead of the camera goes into the hill; the
// rig, placed by arithmetic, stays nine metres behind and is therefore *in*
// the hill, above the tunnel roof and behind its portal. Neither surface is a
// floor, so the lift leaves the camera exactly where it is, and because a
// ripped circuit is single sheets of geometry facing the way the original
// game expected a player to stand, the rock does not even read as rock: the
// frame becomes the dam and the valley seen from inside the mountain, which
// is the picture in the bug report.
//
// So the general ray exists now — see triangleGrid.ts — and this is the rule
// a third-person camera has had since the genre began: the lens may never be
// further from its subject than the first thing standing between them. A car
// entering a tunnel pulls the camera in tight behind it and the shot goes
// through with it; coming out the other side, the camera falls back.
//
// Tightening happens the same frame, because a camera that eases into a
// portal is a camera that spends that ease inside the wall. Letting go is
// paced, because snapping back to nine metres the instant a gap appears is
// the classic third-person yo-yo.

/** Metres of clearance kept between the lens and whatever it is pulled past. */
const SIGHT_PADDING = 0.7
/** Closest the camera may be pulled to its subject before it stops giving way. */
const MIN_SIGHT_DISTANCE = 1.9
/** How fast the camera is allowed back out once the view clears, in m/s. */
const RELEASE_RATE = 14

/**
 * How far the lens is currently allowed to sit from its subject. Carried
 * across frames so the release can be paced; one per camera, not per shot.
 */
export interface SightState {
  distance: number
}

/** A sightline that starts out unconstrained. */
export function createSightState(): SightState {
  return { distance: Infinity }
}

/**
 * Pulls the camera in front of anything standing between it and `pivot`.
 * Mutates `position`.
 *
 * `pivot` is the point the shot is really about — the car, at roughly head
 * height — rather than wherever the shot happens to be looking. The onboard
 * rig looks nine metres down the road, and testing the line to *that* would
 * answer a question about the horizon while the camera sat in a tunnel wall.
 *
 * `instant` skips the paced release, for the frame a cut lands on.
 */
export function resolveCameraOcclusion(
  circuit: Circuit,
  pivot: THREE.Vector3,
  position: THREE.Vector3,
  delta: number,
  state: SightState,
  { instant = false }: { readonly instant?: boolean } = {},
): void {
  const offsetX = position.x - pivot.x
  const offsetY = position.y - pivot.y
  const offsetZ = position.z - pivot.z
  const distance = Math.hypot(offsetX, offsetY, offsetZ)
  if (distance < MIN_SIGHT_DISTANCE) return

  const dirX = offsetX / distance
  const dirY = offsetY / distance
  const dirZ = offsetZ / distance

  const hit = circuit.sightDistance(
    pivot.x,
    pivot.y,
    pivot.z,
    dirX,
    dirY,
    dirZ,
    distance,
  )
  // A hit inside the first couple of metres is the pivot itself being
  // slightly buried, not an occluder: the car stands on a smoothed height
  // profile, and on a bumpy rip the real tarmac can sit above that profile
  // by more than the pivot's own lift, so the ray's first triangle is the
  // road under the car. Honouring that pinned every onboard shot to the
  // bumper. A wall genuinely that close to the car is the tunnel-mouth case,
  // and it is caught a frame later, once the car is a car's length inside.
  //
  // Otherwise: nothing in the way and nothing held back from an earlier
  // frame means the rig is where it asked to be, one ray and no writes.
  const blocked = Number.isFinite(hit) && hit > MIN_SIGHT_DISTANCE
  const allowed = blocked
    ? Math.min(distance, Math.max(MIN_SIGHT_DISTANCE, hit - SIGHT_PADDING))
    : distance
  if (allowed >= distance && state.distance >= distance) {
    state.distance = distance
    return
  }

  state.distance =
    instant || allowed < state.distance
      ? allowed
      : Math.min(allowed, state.distance + RELEASE_RATE * Math.max(delta, 0.0001))

  position.set(
    pivot.x + dirX * state.distance,
    pivot.y + dirY * state.distance,
    pivot.z + dirZ * state.distance,
  )
}
