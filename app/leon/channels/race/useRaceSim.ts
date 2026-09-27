'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { CorridorSample } from './circuit'
import type { RacerState } from './types'
import { NITRO_SPEED_MULTIPLIER } from '@/lib/nitro'
import {
  isRemoteLive,
  type ControlMode,
  type DriveLink,
  type GhostSample,
  type RacePose,
} from '../../control/types'
import { gearFor } from './gearbox'

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
/**
 * Units per second at REFERENCE_BURN_RATE. 38 before, 30 before that, and the
 * argument has not changed: the picture has to carry the drama because the
 * tower carries the order, and a circuit this size flatters pace. At 52 a lap
 * of Lone Peak is under a minute and the field arrives at a corner rather
 * than approaching it.
 *
 * Raising this alone would only produce a permanent slide — slip goes with
 * speed SQUARED — so it moves with GRIP, which is raised alongside it to keep
 * the break-traction point roughly where it was and a shade past it. The two
 * numbers are a pair; change one and the cars either run on rails or spend
 * the whole lap in the barrier.
 */
const MAX_SPEED = 52
/**
 * Even an idle kart rolls. A stationary kart reads as a broken screen, and the
 * standings channel already states idleness plainly — here it just means slow.
 * Lifted with MAX_SPEED so the back of the field still looks like it is
 * racing rather than being lapped by something from another game.
 */
const IDLE_SPEED = 19
/**
 * Compression exponent. Burn rates are wildly long-tailed — one person mid
 * agent-run can out-token an idle team by 50x. A square root keeps the whole
 * field on screen while preserving the ordering, which is what a spectator
 * actually reads.
 */
const SPEED_COMPRESSION = 0.5
/**
 * Seconds for actual speed to converge on target. Karts have inertia — but
 * less of it than they had: at 1.2 a car recovering from a shunt spent a
 * third of a straight visibly doing nothing, which at this pace reads as a
 * dropped frame rather than as weight.
 */
const SPEED_SMOOTHING = 0.9
/**
 * Fraction of full speed above which a car is "flat out" and starts throwing
 * flame and rubber. Deliberately high: a boost effect that is always on is
 * wallpaper, and the whole job of the flame is to mark out the one driver
 * who is genuinely hammering it.
 */
export const BOOST_THRESHOLD = 0.72

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
 * acceleration a tyre holds before the back steps out. Lowered from 34 in the
 * same pass that raised MAX_SPEED: together they move the break-traction
 * point from "only the hairpins at full burn" to "most corners taken with any
 * commitment", which is what makes the field look driven rather than
 * conveyed. The straights are still clean — slip needs curvature.
 */
const GRIP = 34
/**
 * Sideways acceleration at full slip, in units/s². Up with the pace: a slide
 * that takes as long to develop as it did at 38 units/s is a slide the car
 * has already driven out of by the time the eye finds it.
 */
const SLIDE_ACCEL = 7.4
/**
 * How hard a car is pulled back to its own lane, and how fast that settles.
 *
 * Both raised with the pace, and they have to move together: the spring is
 * what ends a drift, and a spring stiffened without its damper turns the
 * recovery into a weave down the following straight.
 */
const LANE_SPRING = 6.2
const LANE_DAMPING = 3.6
/** Yaw angle at full slip, radians. ~33°: a big drift, still short of a spin. */
const MAX_DRIFT_YAW = 0.75
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
const WALL_IMPACT_SPEED = 2.5
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
const BUMP_RECOVERY = 1.4
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

// ---------------------------------------------------------------------------
// Wrecks
//
// The step above a shunt. A hard enough hit — a wall taken at real sideways
// speed, or a shunt between two cars both at pace — sends the car over: it
// barrel-rolls, spins, hops off the road, lands, sits gathering itself, and
// only then comes back up to speed. The whole thing is one timer and three
// signed numbers; the renderer turns them into the tumble (see Racer.tsx),
// and the simulation's only jobs are deciding *when* it happens and holding
// the car slow while it does.
//
// The roll is always a whole number of revolutions on purpose: the car
// finishes the tumble the right way up, which reads as "flipped and righted
// itself" without the simulation ever having to model being upside down.
// ---------------------------------------------------------------------------

/** Sideways speed into a wall that puts the car over rather than off it. */
const CRASH_WALL_SPEED = 5.2
// --- Driving by hand ---------------------------------------------------------
//
// A driven car runs the same physics as the field: the corner still throws it
// wide, the barrier still bites, the pack still shunts it. What changes is
// where the intent comes from — the throttle sets the pace instead of the
// burn rate, and the wheel pushes the car across the road instead of the lane
// spring pulling it home.

/** Pace with the throttle fully released. Not zero: a stopped car is a wall. */
const DRIVEN_MIN_SPEED = 6
/** Seconds for a driven car to answer the throttle. Quicker than the field. */
const DRIVEN_SPEED_SMOOTHING = 0.45
/** ...and quicker still under braking, or the brake is a suggestion. */
const DRIVEN_BRAKE_SMOOTHING = 0.28
/** Sideways push per second of full lock, at full speed. */
const DRIVEN_STEER_ACCEL = 34
/** Lateral is positive towards UP × tangent — the driver's left. */
const STEER_SIGN = -1
/** Nose yaw from the wheel alone, before any slide. Presentation. */
const DRIVEN_STEER_YAW = 0.14
/** How quickly a car driven on another screen settles onto its reported pose. */
const REMOTE_SMOOTHING = 0.12
/** Seconds between samples of a driven lap, for the ghost. */
const GHOST_SAMPLE_S = 0.1

/** Combined pace of both cars, in flat-out-car units, that arms a shunt. */
const CRASH_BUMP_PACE = 0.9
/** Chance an armed shunt actually sends a given car over. */
const CRASH_BUMP_CHANCE = 0.35
/** How long a wreck lasts, start of the tumble to back under way. */
const CRASH_DURATION_MIN = 1.8
const CRASH_DURATION_MAX = 2.7
/** Pace floor while wrecked. Not zero: a dead-stopped car reads as a bug. */
const CRASH_SPEED_FLOOR = 0.07
/** Fraction of the wreck spent tumbling and settling; the rest is recovery. */
export const CRASH_TUMBLE_SHARE = 0.7
/**
 * Seconds the flip itself takes, from launch to landing. Matches the
 * explosion sheet's own length, so the fireball opens as the car leaves the
 * road and is smoke by the time it is back on it.
 */
export const FLIP_DURATION = 1.1
/** Seconds after a wreck before the same car can be sent over again. */
const CRASH_COOLDOWN = 11
/** Chance a wreck is a double roll rather than a single. */
const CRASH_DOUBLE_ROLL_CHANCE = 0.35
/**
 * Chance a wreck is the big one: the car snaps through a full flip on top
 * of its tumble and goes up. Well short of a coin toss on purpose — the
 * explosion is the loudest thing the channel can do, and a wreck that is
 * always an explosion stops being one. At four in ten the ordinary tumble
 * stays the ordinary outcome and the fireball stays an event.
 */
const CRASH_FLIP_CHANCE = 0.4

// ---------------------------------------------------------------------------
// Telling the effects layer
//
// The counters on each car (bumpCount, wallCount, crashCount) say *that*
// something happened to a car. They cannot say where two cars met without
// both cars carrying the same point, and cannot say which of two kinds of
// wreck a crash was without another field per kind. So alongside them the
// simulation now keeps a short ring of events — one entry per thing that
// went bang, with its kind and its place on the road — and the effects
// layer drains whatever has arrived since it last looked.
//
// A ring rather than a queue because nothing here allocates per frame: the
// entries exist from the start and are overwritten in place, and a reader
// that falls a whole ring behind simply misses the oldest, which on an
// all-day screen is the right failure.
// ---------------------------------------------------------------------------

export type SimFxKind = 'bump' | 'wall' | 'crash' | 'flip'

export interface SimFxEvent {
  kind: SimFxKind
  /** Where on the lap, and how far across it, the thing happened. */
  t: number
  lateral: number
  /** Which car it happened to; -1 for a contact shared between two. */
  racer: number
  /** Monotonic, so a reader can tell new entries from ones it has seen. */
  serial: number
}

export interface SimFxRing {
  readonly events: ReadonlyArray<SimFxEvent>
  /** Serial of the most recent event written, 0 before any. */
  serial: number
}

/** Events remembered. Sixteen cars could all hit the wall in one frame and fit. */
const FX_RING_SIZE = 32

function createFxRing(): SimFxRing {
  const events: SimFxEvent[] = []
  for (let index = 0; index < FX_RING_SIZE; index++) {
    events.push({ kind: 'bump', t: 0, lateral: 0, racer: -1, serial: 0 })
  }
  return { events, serial: 0 }
}

function pushFx(ring: SimFxRing, kind: SimFxKind, t: number, lateral: number, racer: number): void {
  ring.serial += 1
  // Written in place: the ring's entries are the only ones there will ever be.
  const slot = ring.events[ring.serial % FX_RING_SIZE]
  slot.kind = kind
  slot.t = t
  slot.lateral = lateral
  slot.racer = racer
  slot.serial = ring.serial
}

/**
 * Puts a car into a wreck, rolling towards `direction` (+1 is the positive
 * lateral side). No-op while one is already running or too recently over —
 * a car that flips on landing is a pinball, not a crash.
 *
 * Decides here, once, whether this is the wreck that goes up: the renderer
 * and the effects layer both read `crashFlip`, and the two have to agree.
 */
function beginCrash(racer: SimRacer, index: number, direction: number, fx: SimFxRing): void {
  if (racer.crashTimer > 0 || racer.crashCooldown > 0) return
  const side = direction === 0 ? 1 : Math.sign(direction)
  racer.crashDuration =
    CRASH_DURATION_MIN + Math.random() * (CRASH_DURATION_MAX - CRASH_DURATION_MIN)
  racer.crashTimer = racer.crashDuration
  racer.crashRolls = side * (Math.random() < CRASH_DOUBLE_ROLL_CHANCE ? 2 : 1)
  racer.crashSpin = side * (0.5 + Math.random() * 1.1)
  racer.crashFlip = Math.random() < CRASH_FLIP_CHANCE ? side : 0
  racer.crashCooldown = CRASH_COOLDOWN + racer.crashDuration
  racer.crashCount += 1
  racer.speedScale = CRASH_SPEED_FLOOR
  pushFx(fx, racer.crashFlip === 0 ? 'crash' : 'flip', racer.t, racer.lateral, index)
}

export interface SimRacer {
  key: string
  name: string
  color: string
  lane: number
  /** Who is deciding this car's motion this frame. Set by step. */
  mode: ControlMode
  /** Normalised position around the lap, 0..1. */
  t: number
  lap: number
  /** Current metres/second. */
  speed: number
  targetSpeed: number
  /** Which of the six gears the car is in, from its road speed. See gearbox.ts. */
  gear: number
  /** Engine speed as a fraction of the redline, 0..1. */
  rpm: number
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
   * Seconds left in the current wreck, 0 when the car is on its wheels.
   * The renderer derives the whole tumble from this and the three fields
   * below — the simulation never stores an orientation.
   */
  crashTimer: number
  /** How long this wreck was dealt, for progress. */
  crashDuration: number
  /** Signed whole revolutions the barrel roll turns through. */
  crashRolls: number
  /** Signed yaw the car picks up while tumbling, radians. */
  crashSpin: number
  /**
   * Which way the car flips, or 0 for a wreck that only tumbles. Signed like
   * `crashRolls`. When set, the renderer adds a snap roll and a second lift
   * over the first FLIP_DURATION seconds of the wreck, and the effects layer
   * lights the fireball. Not carried in a remote pose — a car driven on
   * another screen tumbles here without the flip.
   */
  crashFlip: number
  /** Increments once per wreck, for the effects layer. Same idea as bumpCount. */
  crashCount: number
  /** Seconds before this car can be wrecked again. */
  crashCooldown: number
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
  /**
   * The wheel. Absent on a screen nobody can drive from; present, the sim
   * reads it every frame for who is driving and where remote cars are.
   */
  readonly drive?: DriveLink<RacePose>
}

export interface RaceSim {
  /** Live sim state. Mutated in place every frame — never render off this directly. */
  readonly racers: React.RefObject<SimRacer[]>
  /** Advance the simulation. Call from useFrame with the frame delta. */
  readonly step: (delta: number) => void
  /** Bangs since the start, newest last around the ring. Read, never written, by effects. */
  readonly fx: React.RefObject<SimFxRing>
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
  drive,
}: UseRaceSimOptions): RaceSim {
  const state = useRef<SimRacer[]>([])
  const fx = useRef<SimFxRing>(createFxRing())
  const driveRef = useRef(drive)
  driveRef.current = drive
  /**
   * The driven lap so far, sampled for the ghost. Reset on the line and on
   * taking the wheel. `clean` is only true once the player has crossed the
   * line with the wheel in hand: a lap the AI started is not a record.
   */
  const ghost = useRef<{ samples: GhostSample[]; sinceSample: number; clean: boolean }>({
    samples: [],
    sinceSample: 0,
    clean: false,
  })

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
        mode: 'auto',
        // Stagger the grid so a fresh join doesn't spawn inside someone. ~5m
        // apart, expressed against the live lap rather than baked in as a
        // fraction: on a 900m circuit a fixed 2.4% of a lap is 22m, and the
        // field arrives already strung out over a quarter of the track.
        t: ((index * GRID_SPACING_UNITS) / trackLength) % 1,
        lap: 0,
        speed: 0,
        targetSpeed,
        gear: 1,
        rpm: 0,
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
        crashTimer: 0,
        crashDuration: 1,
        crashRolls: 0,
        crashSpin: 0,
        crashFlip: 0,
        crashCount: 0,
        crashCooldown: 0,
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

      const drive = driveRef.current
      const now = Date.now()

      const bangs = fx.current
      for (let index = 0; index < field.length; index++) {
        const racer = field[index]
        // --- who is driving -----------------------------------------------
        const remote = drive && drive.drivenKey !== racer.key ? drive.remotes.get(racer.key) : undefined
        if (isRemoteLive(remote, now)) {
          racer.mode = 'remote'
          racer.lapClock += dt
          racer.totalClock += dt
          applyRemotePose(racer, remote.pose, dt, trackLength)
          continue
        }
        const isDriven = drive !== undefined && drive.drivenKey === racer.key
        if (isDriven && racer.mode !== 'driven') {
          // Taking the wheel mid-lap: the clock already holds AI time, and any
          // samples left over belong to an earlier stint. Neither is a record.
          ghost.current.samples = []
          ghost.current.sinceSample = 0
          ghost.current.clean = false
        }
        racer.mode = isDriven ? 'driven' : 'auto'
        const input = isDriven ? drive.input : null

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
        racer.crashCooldown = Math.max(0, racer.crashCooldown - dt)

        // The wreck. While the car is tumbling and settling, the recovery
        // above is overruled and the pace held on the floor; once the
        // tumble's share of the timer has passed, the clamp lifts and the
        // ordinary recovery climbs the car back to speed — which is the
        // "gathers itself and rejoins" the whole sequence is for.
        let wrecked = false
        if (racer.crashTimer > 0) {
          racer.crashTimer = Math.max(0, racer.crashTimer - dt)
          const progress = 1 - racer.crashTimer / racer.crashDuration
          wrecked = progress < CRASH_TUMBLE_SHARE
          if (wrecked) racer.speedScale = Math.min(racer.speedScale, CRASH_SPEED_FLOOR)
        }

        let paceTarget = racer.targetSpeed
        let smoothing = SPEED_SMOOTHING
        if (input && drive) {
          // The nitro burns only while the key is down, the bank has charge,
          // and the car is on its wheels — a boosted wreck is a firework.
          const lit = input.boost && drive.nitro.charge > 0 && !wrecked
          if (lit) drive.nitro.charge = Math.max(0, drive.nitro.charge - dt)
          drive.nitro.lit = lit
          const throttle = Math.max(0, Math.min(1, input.throttle))
          const brake = Math.max(0, Math.min(1, input.brake))
          paceTarget =
            (DRIVEN_MIN_SPEED + throttle * (MAX_SPEED - DRIVEN_MIN_SPEED)) *
            (lit ? NITRO_SPEED_MULTIPLIER : 1) *
            (1 - brake * 0.85)
          smoothing = paceTarget < racer.speed ? DRIVEN_BRAKE_SMOOTHING : DRIVEN_SPEED_SMOOTHING
        }
        const blend = 1 - Math.exp(-dt / smoothing)
        racer.speed += (paceTarget * racer.speedScale - racer.speed) * blend

        // The box follows the road speed, so a car gathering itself after a
        // shunt is seen climbing back through the gears.
        const shifted = gearFor(speedFraction(racer.speed))
        racer.gear = shifted.gear
        racer.rpm = shifted.rpm

        racer.lapClock += dt
        racer.totalClock += dt

        // --- the corner ---------------------------------------------------
        // Slip is the classic one: lateral acceleration demanded by the
        // corner, over the grip available. Past 1 the tyre has given up, and
        // everything visible about a drift follows from that single number.
        const bend = curvature ? curvature(racer.t) : 0
        const demand = (bend * racer.speed * racer.speed) / GRIP
        // A tumbling car is not cornering. Its tyres are intermittently in
        // the air, so the slip machinery is switched off and its sideways
        // motion just damps out where the wreck threw it.
        const slip = wrecked ? 0 : Math.max(-1, Math.min(1, demand))
        racer.driftLoad = Math.abs(slip)

        // Thrown towards the outside of the bend — the opposite side from the
        // one the road turns towards, hence the minus.
        racer.lateralVelocity -= slip * SLIDE_ACCEL * dt
        // And pulled back to its own lane, damped so it settles rather than
        // weaving down the following straight — except mid-wreck, where the
        // car stays where it was thrown and just sheds what motion it has.
        if (!wrecked) {
          if (input) {
            // The wheel replaces the lane: nothing pulls a driven car home,
            // and the driver holds their line or loses it.
            const authority = Math.max(0.25, racer.speed / MAX_SPEED)
            racer.lateralVelocity += STEER_SIGN * input.steer * DRIVEN_STEER_ACCEL * authority * dt
          } else {
            racer.lateralVelocity += (home - racer.lateral) * LANE_SPRING * dt
          }
        }
        racer.lateralVelocity -=
          racer.lateralVelocity * Math.min(1, (wrecked ? LANE_DAMPING * 2 : LANE_DAMPING) * dt)
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
              // The bang is at the panel that met the rail, half a car out
              // from the centre the simulation tracks — not at the driver.
              pushFx(bangs, 'wall', racer.t, racer.lateral + side * (CAR_WIDTH / 2), index)
              // Hard enough into the rail and the car goes over it — rolling
              // back towards the road, because the rail is what launched it.
              if (closing > CRASH_WALL_SPEED) beginCrash(racer, index, -side, bangs)
            }
          }
        }

        // Opposite lock. The nose points towards the inside of the corner
        // while the car travels towards the outside, which is the entire
        // visual signature of a drift.
        racer.bumpYaw -= racer.bumpYaw * Math.min(1, dt / BUMP_YAW_DECAY)
        racer.yaw =
          slip * MAX_DRIFT_YAW + racer.bumpYaw + (input ? STEER_SIGN * input.steer * DRIVEN_STEER_YAW : 0)

        // The front wheels. Two terms, both from numbers already computed:
        // the corner asks for an angle (curvature times gain), and the drift
        // subtracts the body's own yaw — wheels point where the car is
        // *going*, so a sideways body shows counter-steer automatically.
        const steerTarget = wrecked
          ? 0
          : input
            ? Math.max(-MAX_STEER, Math.min(MAX_STEER, STEER_SIGN * input.steer * MAX_STEER - racer.yaw * 0.5))
            : Math.max(-MAX_STEER, Math.min(MAX_STEER, bend * STEER_GAIN - racer.yaw))
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
          const lapSeconds = Math.max(0, racer.lapClock - overshoot)
          racer.lapTimes.push(lapSeconds)
          if (racer.lapTimes.length > MAX_RECORDED_LAPS) racer.lapTimes.shift()
          racer.lapClock = overshoot
          if (input && drive) {
            // A lap driven line to line is a record, and the trace of it is a
            // ghost. The first crossing after taking the wheel only starts one.
            if (ghost.current.clean) drive.onLap?.(lapSeconds, ghost.current.samples)
            ghost.current.samples = []
            ghost.current.sinceSample = 0
            ghost.current.clean = true
          }
        }
        racer.t = advanced % 1

        if (input) {
          ghost.current.sinceSample += dt
          if (ghost.current.sinceSample >= GHOST_SAMPLE_S) {
            ghost.current.sinceSample = 0
            ghost.current.samples.push({ t: racer.t, l: racer.lateral, y: racer.yaw })
          }
        }
      }

      resolveContacts(field, trackLength, bangs)
    },
    [trackLength],
  )

  return { racers: state, step, fx }
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
function resolveContacts(field: ReadonlyArray<SimRacer>, trackLength: number, fx: SimFxRing): void {
  for (let i = 0; i < field.length; i++) {
    for (let j = i + 1; j < field.length; j++) {
      const a = field[i]
      const b = field[j]
      // A car driven on another screen is placed, not simulated, here. A
      // shove it never feels would be undone by its next pose anyway.
      if (a.mode === 'remote' || b.mode === 'remote') continue
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
      // One event for the pair, which is what makes it one bang on screen.
      pushFx(fx, 'bump', contactT, contactLateral, -1)

      // A shunt between two cars both carrying real pace can put one — or
      // on a bad day both — over. Each rolls away from the contact, and the
      // dice are thrown per car: two cars binned by every big hit would
      // empty the field, and a crash that never happens is wallpaper the
      // other way.
      if ((a.speed + b.speed) / MAX_SPEED > CRASH_BUMP_PACE) {
        if (Math.random() < CRASH_BUMP_CHANCE) beginCrash(a, i, side, fx)
        if (Math.random() < CRASH_BUMP_CHANCE) beginCrash(b, j, -side, fx)
      }
    }
  }
}

/**
 * Places a car another screen is driving.
 *
 * Dead reckoning between poses: the car keeps its reported speed along the
 * lap so it never stutters at the send rate, and the reported position pulls
 * the error out underneath. Everything the effects layer watches — the
 * counters, the wreck timers — is copied outright, so a crash on the driver's
 * screen bangs on this one too.
 */
function applyRemotePose(racer: SimRacer, pose: RacePose, dt: number, trackLength: number): void {
  const k = 1 - Math.exp(-dt / REMOTE_SMOOTHING)
  racer.speed += (pose.speed - racer.speed) * k
  racer.t = (racer.t + (racer.speed * dt) / trackLength) % 1
  let gap = (pose.t - racer.t) % 1
  if (gap > 0.5) gap -= 1
  else if (gap < -0.5) gap += 1
  racer.t = (racer.t + gap * k + 1) % 1
  // Same lap as reported, unless this car is just across the line the
  // report was just short of, or vice versa.
  const lapSkew = racer.t < pose.t - 0.5 ? 1 : racer.t > pose.t + 0.5 ? -1 : 0
  const lap = pose.lap + lapSkew
  if (lap > racer.lap) {
    racer.lapTimes.push(racer.lapClock)
    if (racer.lapTimes.length > MAX_RECORDED_LAPS) racer.lapTimes.shift()
    racer.lapClock = 0
  }
  racer.lap = lap
  racer.lateral += (pose.lateral - racer.lateral) * k
  racer.lateralVelocity = 0
  racer.yaw += (pose.yaw - racer.yaw) * k
  racer.steer += (pose.steer - racer.steer) * k
  racer.driftLoad += (pose.driftLoad - racer.driftLoad) * k
  racer.speedScale = 1
  racer.crashTimer = pose.crashTimer
  racer.crashDuration = pose.crashDuration
  racer.crashRolls = pose.crashRolls
  racer.crashSpin = pose.crashSpin
  // The pose does not carry the flip, so a remote wreck is always the plain
  // tumble here. Cleared rather than left over from a local crash.
  racer.crashFlip = 0
  racer.bumpCount = pose.bumpCount
  racer.wallCount = pose.wallCount
  racer.crashCount = pose.crashCount
  racer.impactT = pose.impactT
  racer.impactLateral = pose.impactLateral
}
