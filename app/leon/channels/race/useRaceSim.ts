'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { CorridorSample } from './circuit'
import type { RacerState } from './types'

// The whole game. Deliberately one file, because the rules are the interesting
// part and they should be readable in one sitting.
//
// The core decision: position on track is *integrated from velocity*, never
// assigned from score. A kart's speed is its live burn rate, so it accelerates
// when someone starts working and coasts down when they stop. Nothing ever
// teleports, and nothing is faked — the only input is tokens per minute.

// Calibrated against a real day of bucket data on a ~215m circuit. The target
// is a 7-9s lap for someone working hard and ~20s for someone idling.
//
// It used to be 12-18s, which was the wrong read of the room. A screen on a
// wall is glanced at, and at a walking pace the glance shows a static picture
// of cars that happen to be arranged in an order — the race has to be visibly
// *happening* in the two seconds someone looks up. Fast enough to be exciting
// costs nothing in legibility here, because the position tower carries the
// order and the picture only has to carry the drama.
/** Tokens/min that maps to full speed. Above this, everyone looks the same. */
const REFERENCE_BURN_RATE = 25_000
/** Units per second at REFERENCE_BURN_RATE. */
const MAX_SPEED = 30
/**
 * Even an idle kart rolls. A stationary kart reads as a broken screen, and the
 * standings channel already states idleness plainly — here it just means slow.
 */
const IDLE_SPEED = 10
/**
 * Compression exponent. Burn rates are wildly long-tailed — one person mid
 * agent-run can out-token an idle team by 50x. A square root keeps the whole
 * field on screen while preserving the ordering, which is what a spectator
 * actually reads.
 */
const SPEED_COMPRESSION = 0.5
/** Seconds for actual speed to converge on target. Karts have inertia. */
const SPEED_SMOOTHING = 1.5
/**
 * Fraction of full speed above which a car is "flat out" and starts throwing
 * flame and rubber. Deliberately high: a boost effect that is always on is
 * wallpaper, and the whole job of the flame is to mark out the one driver
 * who is genuinely hammering it.
 */
export const BOOST_THRESHOLD = 0.76

// ---------------------------------------------------------------------------
// Cornering
//
// The cars used to run on rails at a fixed lane offset, which is why the
// corners read as nothing at all: a car that takes a hairpin at exactly the
// same distance from the kerb as it took the straight is not cornering, it is
// being conveyed. So lateral position is now its own little spring-mass
// system, pushed outwards by the corner and pulled back to the car's lane.
//
// None of this is a physics engine. It is one number — signed curvature —
// turned into a sideways shove and a yaw angle, which is the whole trick the
// era's games used and is entirely sufficient at 288 pixels tall.
// ---------------------------------------------------------------------------

/**
 * Grip constant. Slip is `|curvature| × speed² / GRIP`, so this is the lateral
 * acceleration a tyre holds before the back steps out. Tuned so the straights
 * are clean, the sweepers show a lean, and only the tight corners taken at
 * full burn actually break traction.
 */
const GRIP = 34
/** Sideways acceleration at full slip, in units/s². */
const SLIDE_ACCEL = 5.2
/** How hard a car is pulled back to its own lane, and how fast that settles. */
const LANE_SPRING = 5.5
const LANE_DAMPING = 3.2
/** Yaw angle at full slip, radians. ~26°: a drift, not a spin. */
const MAX_DRIFT_YAW = 0.46
/** How far the front wheels turn per unit of curvature demand, radians. */
const STEER_GAIN = 14
const MAX_STEER = 0.5
/** Seconds for the front wheels to reach the driver's chosen angle. */
const STEER_SMOOTHING = 0.14
/** Clearance kept from the kerb, so a sliding car never leaves the tarmac. */
const EDGE_MARGIN = 1.2

// ---------------------------------------------------------------------------
// The barrier
//
// The edge of the road used to be one number for the whole lap, and the whole
// lap is not one width. Where the real road pinched — a bridge, a gate, a
// hairpin whose apex the traced line clips — a car held to the nominal width
// was held somewhere there was no road, and it drove through the guardrail
// with nothing in the simulation to say otherwise. So the circuit measures
// the gap between the barriers (see barrierField.ts) and the simulation
// clamps into *that*, per point on the lap.
//
// A wall is not a collision solver either. A car that reaches the limit stops
// going sideways, loses some pace, and gets a bang — the same bumper-car
// vocabulary as a car-to-car hit, because to a spectator it is the same
// event.
// ---------------------------------------------------------------------------

/**
 * Sideways speed above which touching a wall counts as hitting it.
 *
 * A car leaning on the barrier through a long corner is not crashing, and
 * spraying sparks the whole way round would spend the effect entirely.
 */
const WALL_IMPACT_SPEED = 2.2
/** Fraction of its outward speed a car keeps, bounced back off a wall. */
const WALL_BOUNCE = 0.35
/** Pace a car drops to when it hits a wall, as a fraction of its target. */
const WALL_SPEED_FLOOR = 0.62
/** Yaw kick from a wall, radians. Half a shunt: the wall gives nothing back. */
const WALL_YAW = 0.26
/** Seconds before the same car can bang the wall again. */
const WALL_COOLDOWN = 0.5

// ---------------------------------------------------------------------------
// Contact
//
// Bumper cars, not a collision solver. Two cars overlapping exchange a
// sideways shove, both lose speed, and both spend a couple of seconds getting
// it back. The recovery is the part that matters dramatically — an instant
// bounce reads as a glitch, whereas a car that visibly gathers itself up and
// comes back reads as a moment in a race.
// ---------------------------------------------------------------------------

/** Contact box, in track units. Slightly larger than the 2.6-unit car. */
const CAR_LENGTH = 3.0
const CAR_WIDTH = 1.7
/** Sideways velocity imparted to each car by a hit. */
const BUMP_LATERAL = 6.5
/** Yaw kick, radians — the slew a shunt puts through the car. */
const BUMP_YAW = 0.5
/** Speed each car drops to on contact, as a fraction of its target. */
const BUMP_SPEED_FLOOR = 0.5
/** Seconds to climb back to full pace afterwards. */
const BUMP_RECOVERY = 1.9
/** Seconds a pair is ignored after a hit, so one shunt is not fifty. */
const BUMP_COOLDOWN = 0.8
/** Seconds the yaw slew takes to wash out. */
const BUMP_YAW_DECAY = 0.55
/**
 * How many completed laps a kart remembers. The HUD shows three, and keeping
 * a handful more costs nothing while leaving room for a "best lap" readout —
 * but an all-day screen must not accumulate an unbounded array per driver.
 */
const MAX_RECORDED_LAPS = 8

export interface SimRacer {
  key: string
  name: string
  color: string
  lane: number
  /** Normalised position around the lap, 0..1. */
  t: number
  lap: number
  /** Current metres/second. */
  speed: number
  targetSpeed: number
  score: number
  rank: number
  velocityTokensPerMin: number
  isActive: boolean
  /**
   * Sideways offset from the centreline, in track units. This is where the
   * car actually *is* — `lane` is only where it would like to be.
   */
  lateral: number
  lateralVelocity: number
  /** The lane the car is pulled back towards once the corner lets go. */
  homeLateral: number
  /** Extra heading, radians. Positive points the nose towards `UP × tangent`. */
  yaw: number
  /** Yaw still washing out from a shunt, radians. Folded into `yaw`. */
  bumpYaw: number
  /**
   * Front-wheel angle, radians, relative to the body. Steering into the
   * corner in grip, and *against* the body's drift angle in a slide — the
   * opposite lock that makes a drift read as driven rather than skidded.
   */
  steer: number
  /** How hard the car is sliding, 0..1. Drives the tyre smoke. */
  driftLoad: number
  /** Pace multiplier while recovering from a hit. Eases back to 1. */
  speedScale: number
  /** Seconds before this car can be hit again. */
  bumpCooldown: number
  /**
   * Increments once per contact. A counter rather than a flag because the
   * effects layer polls at frame rate and a flag it happened to miss would be
   * a hit with no bang.
   */
  bumpCount: number
  /**
   * Increments once per barrier strike. Counted separately from `bumpCount`
   * so the effects layer can tell a shunt from a scrape — they throw
   * different things off the car — while reading both the same way.
   */
  wallCount: number
  /** Seconds before this car can strike a wall again. */
  wallCooldown: number
  /**
   * Where the last impact happened, in track space: distance around the lap
   * and distance across it. The bang is drawn at the point of contact rather
   * than at the car's centre, which for a side-swipe is a metre and a half
   * away and reads, wrongly, as an explosion coming from inside the car.
   */
  impactT: number
  impactLateral: number
  /** Seconds since this kart last crossed the line. The running lap. */
  lapClock: number
  /** Seconds since it joined the grid. The running total. */
  totalClock: number
  /**
   * Completed lap times in seconds, oldest first. Recorded rather than
   * derived: the HUD's split list is the one readout that cannot be
   * reconstructed from a position, because it is a history.
   */
  lapTimes: number[]
}

/** Distance between karts on the starting grid, in game units. */
const GRID_SPACING_UNITS = 5

/**
 * A car's pace as a fraction of the fastest anyone goes, 0..1.
 *
 * Exported so the effects layer can decide what "flat out" means without
 * importing the speed constants and re-deriving it — there must be exactly
 * one definition of full chat, or the flame lights at a different moment
 * than the one the simulation thinks it does.
 */
export function speedFraction(speed: number): number {
  return Math.max(0, Math.min(1, speed / MAX_SPEED))
}

export function burnRateToSpeed(tokensPerMin: number): number {
  if (tokensPerMin <= 0) return IDLE_SPEED
  const normalised = Math.min(1, tokensPerMin / REFERENCE_BURN_RATE)
  return IDLE_SPEED + Math.pow(normalised, SPEED_COMPRESSION) * (MAX_SPEED - IDLE_SPEED)
}

interface UseRaceSimOptions {
  readonly racers: ReadonlyArray<RacerState> | undefined
  readonly trackLength: number
  /**
   * Signed curvature at a point on the lap. Supply the live circuit's own, or
   * leave it out and the field runs a flat track: no drift, no lean, cars
   * held on their lanes.
   *
   * Optional rather than required on purpose. The circuit is mid-way through
   * becoming swappable, and a hard dependency here would make the simulation
   * refuse to run against a track that has not been taught to measure itself
   * yet — a race that is merely undramatic beats a race that will not start.
   */
  readonly curvatureAt?: (t: number) => number
  /** Lane home positions. Falls back to a single lane down the centre. */
  readonly laneOffset?: (laneIndex: number) => number
  /** Distance from the centreline to the kerb. Bounds the slide. */
  readonly roadHalfWidth?: number
  /**
   * The measured gap between the barriers at a point on the lap, written into
   * the sample handed in. Optional for the same reason `curvatureAt` is: a
   * circuit that has not measured itself yet — the procedural oval, or a
   * model still loading — races on its nominal width, as everything did
   * before there was anything better to race on.
   */
  readonly corridorAt?: (t: number, out: CorridorSample) => void
}

export interface RaceSim {
  /** Live sim state. Mutated in place every frame — never render off this directly. */
  readonly racers: React.RefObject<SimRacer[]>
  /** Advance the simulation. Call from useFrame with the frame delta. */
  readonly step: (delta: number) => void
}

/**
 * Mutation-in-a-ref is deliberate: this updates every frame and must never
 * trigger a React render.
 */
export function useRaceSim({
  racers,
  trackLength,
  curvatureAt,
  laneOffset,
  roadHalfWidth = 7.4,
  corridorAt,
}: UseRaceSimOptions): RaceSim {
  const state = useRef<SimRacer[]>([])

  // The frame loop reads these through a ref rather than closing over them.
  // `step` is handed to useFrame once; rebuilding it because the circuit
  // changed identity would leave the scene calling last render's copy.
  const track = useRef({ curvatureAt, laneOffset, roadHalfWidth, corridorAt })
  track.current = { curvatureAt, laneOffset, roadHalfWidth, corridorAt }
  /** One sample, reused: this is read once per car per frame. */
  const corridor = useRef<CorridorSample>({ centre: 0, halfWidth: roadHalfWidth })

  useEffect(() => {
    if (!racers) return
    const existing = new Map(state.current.map((racer) => [racer.key, racer]))

    state.current = racers.map((racer, index) => {
      const previous = existing.get(racer.key)
      const targetSpeed = burnRateToSpeed(racer.velocityTokensPerMin)

      if (previous) {
        // Retarget only. Position and lap survive the update, which is what
        // stops a kart from jumping when the server re-ranks the grid — and
        // that now includes the sideways position, so a re-rank cannot
        // teleport a car across the road mid-corner either.
        previous.homeLateral = laneOffset?.(index) ?? 0
        previous.targetSpeed = targetSpeed
        previous.score = racer.score
        previous.rank = racer.rank
        previous.velocityTokensPerMin = racer.velocityTokensPerMin
        previous.isActive = racer.isActive
        previous.name = racer.name
        previous.color = racer.color ?? '#00f0ff'
        return previous
      }

      return {
        key: racer.key,
        name: racer.name,
        color: racer.color ?? '#00f0ff',
        lane: index,
        // Stagger the grid so a fresh join doesn't spawn inside someone. ~5m
        // apart, expressed against the live lap rather than baked in as a
        // fraction: on a 900m circuit a fixed 2.4% of a lap is 22m, and the
        // field arrives already strung out over a quarter of the track.
        t: ((index * GRID_SPACING_UNITS) / trackLength) % 1,
        lap: 0,
        speed: 0,
        targetSpeed,
        score: racer.score,
        rank: racer.rank,
        velocityTokensPerMin: racer.velocityTokensPerMin,
        isActive: racer.isActive,
        lateral: laneOffset?.(index) ?? 0,
        lateralVelocity: 0,
        homeLateral: laneOffset?.(index) ?? 0,
        yaw: 0,
        bumpYaw: 0,
        steer: 0,
        driftLoad: 0,
        speedScale: 1,
        bumpCooldown: 0,
        bumpCount: 0,
        wallCount: 0,
        wallCooldown: 0,
        impactT: 0,
        impactLateral: 0,
        lapClock: 0,
        totalClock: 0,
        lapTimes: [],
      }
    })
  }, [racers, laneOffset])

  const step = useCallback(
    (delta: number): void => {
      // Clamp: a backgrounded tab resumes with a huge delta, which would fling
      // every kart several laps forward in a single frame.
      const dt = Math.min(delta, 0.1)
      const field = state.current
      const {
        curvatureAt: curvature,
        roadHalfWidth: halfWidth,
        corridorAt: measureCorridor,
      } = track.current
      const nominalEdge = Math.max(0, halfWidth - EDGE_MARGIN)
      const sample = corridor.current

      for (const racer of field) {
        // --- where the road actually is -----------------------------------
        // Asked per car rather than per frame: the field is strung out over a
        // lap, and the car in the hairpin has a different road from the one
        // on the straight.
        if (measureCorridor) {
          measureCorridor(racer.t, sample)
        } else {
          sample.centre = 0
          sample.halfWidth = halfWidth
        }
        const roadCentre = sample.centre
        const edge = Math.max(0.2, Math.min(sample.halfWidth, halfWidth) - EDGE_MARGIN)
        // Lanes are squeezed into whatever width there is rather than held at
        // their nominal spacing. Eight cars abreast on a road that has
        // narrowed to a bridge is eight cars in the barrier; the same eight
        // proportionally closer together is a pack going through a gap.
        const laneScale = nominalEdge > 0 ? Math.min(1, edge / nominalEdge) : 0
        const home = roadCentre + racer.homeLateral * laneScale

        // --- pace, and getting it back after a shunt ---------------------
        const recovery = 1 - Math.exp(-dt / BUMP_RECOVERY)
        racer.speedScale += (1 - racer.speedScale) * recovery
        racer.bumpCooldown = Math.max(0, racer.bumpCooldown - dt)
        racer.wallCooldown = Math.max(0, racer.wallCooldown - dt)

        const blend = 1 - Math.exp(-dt / SPEED_SMOOTHING)
        racer.speed += (racer.targetSpeed * racer.speedScale - racer.speed) * blend

        racer.lapClock += dt
        racer.totalClock += dt

        // --- the corner ---------------------------------------------------
        // Slip is the classic one: lateral acceleration demanded by the
        // corner, over the grip available. Past 1 the tyre has given up, and
        // everything visible about a drift follows from that single number.
        const bend = curvature ? curvature(racer.t) : 0
        const demand = (bend * racer.speed * racer.speed) / GRIP
        const slip = Math.max(-1, Math.min(1, demand))
        racer.driftLoad = Math.abs(slip)

        // Thrown towards the outside of the bend — the opposite side from the
        // one the road turns towards, hence the minus.
        racer.lateralVelocity -= slip * SLIDE_ACCEL * dt
        // And pulled back to its own lane, damped so it settles rather than
        // weaving down the following straight.
        racer.lateralVelocity += (home - racer.lateral) * LANE_SPRING * dt
        racer.lateralVelocity -= racer.lateralVelocity * Math.min(1, LANE_DAMPING * dt)
        racer.lateral += racer.lateralVelocity * dt

        // The barrier. Measured off the model, so the limit is the rail that
        // is actually drawn there rather than a nominal width the road may
        // never have had.
        const offset = racer.lateral - roadCentre
        if (Math.abs(offset) > edge) {
          const side = Math.sign(offset)
          racer.lateral = roadCentre + side * edge
          const closing = racer.lateralVelocity * side
          if (closing > 0) {
            // Mostly killed, slightly returned. Fully reflected reads as a
            // pinball; fully killed reads as a car glued to the wall.
            racer.lateralVelocity = -racer.lateralVelocity * WALL_BOUNCE
            if (closing > WALL_IMPACT_SPEED && racer.wallCooldown === 0) {
              racer.speedScale = Math.min(racer.speedScale, WALL_SPEED_FLOOR)
              racer.bumpYaw -= side * WALL_YAW
              racer.wallCooldown = WALL_COOLDOWN
              racer.wallCount += 1
              racer.impactT = racer.t
              racer.impactLateral = racer.lateral
            }
          }
        }

        // Opposite lock. The nose points towards the inside of the corner
        // while the car travels towards the outside, which is the entire
        // visual signature of a drift.
        racer.bumpYaw -= racer.bumpYaw * Math.min(1, dt / BUMP_YAW_DECAY)
        racer.yaw = slip * MAX_DRIFT_YAW + racer.bumpYaw

        // The front wheels. Two terms, both from numbers already computed:
        // the corner asks for an angle (curvature times gain), and the drift
        // subtracts the body's own yaw — wheels point where the car is
        // *going*, so a sideways body shows counter-steer automatically.
        const steerTarget = Math.max(
          -MAX_STEER,
          Math.min(MAX_STEER, bend * STEER_GAIN - racer.yaw),
        )
        racer.steer += (steerTarget - racer.steer) * (1 - Math.exp(-dt / STEER_SMOOTHING))

        // --- distance along the lap ---------------------------------------
        const advanced = racer.t + (racer.speed * dt) / trackLength
        if (advanced >= 1) {
          racer.lap += Math.floor(advanced)
          // The line was crossed part-way through this frame, so the lap did
          // not take the whole of dt. Interpolating the crossing point keeps
          // the thousandths honest rather than quantised to the frame rate,
          // which is the entire reason the readout carries three of them.
          const overshoot = ((advanced - 1) * trackLength) / Math.max(racer.speed, 0.0001)
          racer.lapTimes.push(Math.max(0, racer.lapClock - overshoot))
          if (racer.lapTimes.length > MAX_RECORDED_LAPS) racer.lapTimes.shift()
          racer.lapClock = overshoot
        }
        racer.t = advanced % 1
      }

      resolveContacts(field, trackLength)
    },
    [trackLength],
  )

  return { racers: state, step }
}

/**
 * Bumper cars.
 *
 * Every pair is tested, which is O(n²) — with a grid of eight that is 28
 * comparisons a frame and not worth a broadphase. Contact is decided in track
 * space rather than world space: distance along the lap, and distance across
 * it. Two cars side by side in a hairpin are metres apart in world XZ but
 * inches apart on the road, and it is the road that decides whether they
 * touch.
 */
function resolveContacts(field: ReadonlyArray<SimRacer>, trackLength: number): void {
  for (let i = 0; i < field.length; i++) {
    for (let j = i + 1; j < field.length; j++) {
      const a = field[i]
      const b = field[j]
      if (a.bumpCooldown > 0 || b.bumpCooldown > 0) continue

      // Shortest way round: two cars either side of the start line are
      // touching, not a lap apart.
      let gap = (a.t - b.t) % 1
      if (gap > 0.5) gap -= 1
      else if (gap < -0.5) gap += 1
      const along = gap * trackLength
      if (Math.abs(along) >= CAR_LENGTH) continue

      const across = a.lateral - b.lateral
      if (Math.abs(across) >= CAR_WIDTH) continue

      // Which way to shove. Two cars in exactly the same place get an
      // arbitrary but stable direction rather than a NaN.
      const side = across === 0 ? (i % 2 === 0 ? 1 : -1) : Math.sign(across)
      a.lateralVelocity += side * BUMP_LATERAL
      b.lateralVelocity -= side * BUMP_LATERAL
      // Separate them immediately as well, or they spend the cooldown
      // overlapping and hit again the moment it expires.
      const overlap = (CAR_WIDTH - Math.abs(across)) / 2
      a.lateral += side * overlap
      b.lateral -= side * overlap

      a.bumpYaw += side * BUMP_YAW
      b.bumpYaw -= side * BUMP_YAW

      // Both lose the same pace. The car behind was the one doing the
      // hitting, but on a track this wide these are side-swipes rather than
      // rear-enders, and punishing only one of them reads as arbitrary to
      // anyone watching their own driver get shunted.
      a.speedScale = Math.min(a.speedScale, BUMP_SPEED_FLOOR)
      b.speedScale = Math.min(b.speedScale, BUMP_SPEED_FLOOR)
      a.bumpCooldown = BUMP_COOLDOWN
      b.bumpCooldown = BUMP_COOLDOWN
      a.bumpCount += 1
      b.bumpCount += 1

      // Where the panels actually met: half way between the two cars, both
      // around the lap and across it. Recorded on both, because both are
      // going to draw it and the bang has to come from one place — two cars
      // each flashing at their own centre is two crashes, not one.
      const contactT = (b.t + gap / 2 + 1) % 1
      const contactLateral = (a.lateral + b.lateral) / 2
      a.impactT = contactT
      b.impactT = contactT
      a.impactLateral = contactLateral
      b.impactLateral = contactLateral
    }
  }
}
