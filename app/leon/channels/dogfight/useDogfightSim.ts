'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { RacerState } from '../race/types'
import {
  ALTITUDE_CEILING,
  ALTITUDE_FLOOR,
  COMBAT_BOX_RADIUS,
} from './theatre'

// CH 03's whole game, one file, same doctrine as the other simulations: the
// rules are the interesting part and they should be readable in one sitting.
//
// The mapping continues the house grammar. In the race, burn is speed; in the
// fight, burn is offence; here it is both — a pilot's throttle and their
// gunnery. Airframe (health) is the day's score, the same way the fighter's
// bar was. Nobody is ever out: a downed plane burns, spirals in, and rejoins
// the patrol fresh — the kill is the event, not the elimination, because a
// wall screen has no place to send a loser.

// --- Airframe ---------------------------------------------------------------

const MAX_HP = 120
/** The weakest airframe in the patrol, as a fraction of the strongest. */
const HP_FLOOR = 0.5
const HP_COMPRESSION = 0.5

// --- Flying -----------------------------------------------------------------

/** Tokens/min that maps to full throttle. Shared with the whole cabinet. */
const REFERENCE_BURN_RATE = 25_000
const MIN_SPEED = 6.5
const MAX_SPEED = 15
const SPEED_COMPRESSION = 0.5
/** Seconds for actual speed to converge. Aircraft have more inertia than karts. */
const SPEED_SMOOTHING = 2.2
/** Turn rates, radians per second. Pursuit pulls harder — that is the chase. */
const PATROL_TURN_RATE = 0.55
const PURSUIT_TURN_RATE = 1.05
/** How far a new patrol waypoint counts as reached. */
const WAYPOINT_RADIUS = 4
/** Vertical rate toward the assigned altitude, units/s. */
const CLIMB_RATE = 2.2

// --- Gunnery ----------------------------------------------------------------

/** Seconds between attack runs for an idle pilot, and at full burn. */
const IDLE_ATTACK_INTERVAL = 17
const MAX_ATTACK_INTERVAL = 5.5
const ATTACK_COMPRESSION = 0.5
/** A pursuit that has not killed in this long breaks off. */
const PURSUIT_MAX_S = 8
/** Guns fire inside this range and cone. */
const FIRE_RANGE = 11
const FIRE_CONE_RAD = 0.5
/** Seconds between bursts while the target is in the sight. */
const BURST_INTERVAL_MIN = 0.4
const BURST_INTERVAL_MAX = 0.7
const BURST_DAMAGE_MIN = 4
const BURST_DAMAGE_MAX = 8
const BURN_DAMAGE_BONUS = 0.5
/** The deadeye: rare, ruinous, and the reason an underdog can win the sky. */
const CRIT_CHANCE = 0.08
const CRIT_MULT_MIN = 2.6
const CRIT_MULT_MAX = 3.6

// --- Going down -------------------------------------------------------------

/** Descent rate of a stricken plane, units/s. */
const DIVE_RATE = 4.2
/** Roll rate of the death spiral, radians/s. */
const SPIRAL_ROLL_RATE = 3.4
/** Height at which the ground wins. */
const CRASH_ALTITUDE = 1.0
/** Seconds off the board before rejoining the patrol. */
const RESPAWN_S = 4.5

/** How long the camera stays with an event's subject. */
const STAR_HOLD_MS = 4200

export type PlaneMode = 'patrol' | 'pursuit' | 'down' | 'respawn'

export interface SimPlane {
  readonly key: string
  readonly name: string
  readonly color: string
  /** The paint shop's choices, carried over from the race unchanged. */
  readonly paint: string | null
  readonly livery: string | null
  readonly score: number
  readonly rank: number
  maxHp: number
  hp: number
  burnRate: number
  kills: number
  mode: PlaneMode
  modeT: number
  x: number
  y: number
  z: number
  /** Yaw; forward is (sin, 0, cos). */
  heading: number
  /** Visual only, derived from turning / diving. */
  bank: number
  pitch: number
  speed: number
  /** Assigned cruising altitude, by rank. */
  homeAltitude: number
  waypointX: number
  waypointZ: number
  waypointY: number
  targetKey: string | null
  attackCooldown: number
  burstCooldown: number
}

export interface TracerEvent {
  readonly id: number
  readonly fromX: number
  readonly fromY: number
  readonly fromZ: number
  readonly toX: number
  readonly toY: number
  readonly toZ: number
  readonly crit: boolean
  readonly at: number
}

export interface BlastEvent {
  readonly id: number
  readonly x: number
  readonly y: number
  readonly z: number
  /** 'hit' pops on the airframe, 'crash' blooms on the fields. */
  readonly kind: 'hit' | 'crash'
  readonly at: number
}

export interface DogfightEventLine {
  readonly id: number
  readonly text: string
  readonly tone: 'hit' | 'crit' | 'kill' | 'info'
  /** Wall-clock ms when it happened — the HUD's announcements are time-bound. */
  readonly at: number
}

export interface DogfightStar {
  readonly key: string
  readonly until: number
}

const EVENT_LOG_LENGTH = 5
const TRACER_KEEP_MS = 400
const BLAST_KEEP_MS = 900

let nextId = 1

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function compress(burnRate: number): number {
  return Math.pow(
    Math.min(1, Math.max(0, burnRate) / REFERENCE_BURN_RATE),
    SPEED_COMPRESSION,
  )
}

function targetSpeed(burnRate: number): number {
  return MIN_SPEED + (MAX_SPEED - MIN_SPEED) * compress(burnRate)
}

function attackInterval(burnRate: number): number {
  const drive = Math.pow(
    Math.min(1, Math.max(0, burnRate) / REFERENCE_BURN_RATE),
    ATTACK_COMPRESSION,
  )
  return IDLE_ATTACK_INTERVAL - (IDLE_ATTACK_INTERVAL - MAX_ATTACK_INTERVAL) * drive
}

/** Smallest signed angle from `from` to `to`. */
function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2)
  if (delta > Math.PI) delta -= Math.PI * 2
  if (delta < -Math.PI) delta += Math.PI * 2
  return delta
}

function randomWaypoint(): { x: number; z: number } {
  const angle = Math.random() * Math.PI * 2
  const radius = Math.sqrt(Math.random()) * COMBAT_BOX_RADIUS
  return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius }
}

function altitudeForRank(rank: number, fieldSize: number): number {
  // The leader flies top cover; the tail-ender is down in the weeds. Spread
  // the whole band regardless of how many are up.
  const fraction = fieldSize <= 1 ? 1 : 1 - (rank - 1) / (fieldSize - 1)
  return ALTITUDE_FLOOR + (ALTITUDE_CEILING - ALTITUDE_FLOOR) * fraction
}

function toSimPlane(
  racer: RacerState,
  fieldMaxScore: number,
  fieldSize: number,
): SimPlane {
  const fraction = fieldMaxScore > 0 ? Math.max(0, racer.score) / fieldMaxScore : 1
  const maxHp = Math.round(
    MAX_HP * (HP_FLOOR + (1 - HP_FLOOR) * Math.pow(fraction, HP_COMPRESSION)),
  )
  const spawn = randomWaypoint()
  const waypoint = randomWaypoint()
  const altitude = altitudeForRank(racer.rank, fieldSize)
  return {
    key: racer.key,
    name: racer.name,
    color: racer.color ?? '#00f0ff',
    paint: racer.paint,
    livery: racer.livery,
    score: racer.score,
    rank: racer.rank,
    maxHp,
    hp: maxHp,
    burnRate: racer.velocityTokensPerMin,
    kills: 0,
    mode: 'patrol',
    modeT: 0,
    x: spawn.x,
    y: altitude,
    z: spawn.z,
    heading: Math.random() * Math.PI * 2,
    bank: 0,
    pitch: 0,
    speed: MIN_SPEED,
    homeAltitude: altitude,
    waypointX: waypoint.x,
    waypointZ: waypoint.z,
    waypointY: altitude,
    targetKey: null,
    attackCooldown: randomBetween(3, 10),
    burstCooldown: 0,
  }
}

interface DogfightSim {
  readonly planes: React.RefObject<SimPlane[]>
  readonly tracers: React.RefObject<TracerEvent[]>
  readonly blasts: React.RefObject<BlastEvent[]>
  readonly events: React.RefObject<DogfightEventLine[]>
  readonly star: React.RefObject<DogfightStar | null>
  readonly step: (delta: number) => void
}

export function useDogfightSim(racers: ReadonlyArray<RacerState> | undefined): DogfightSim {
  const planes = useRef<SimPlane[]>([])
  const tracers = useRef<TracerEvent[]>([])
  const blasts = useRef<BlastEvent[]>([])
  const events = useRef<DogfightEventLine[]>([])
  const star = useRef<DogfightStar | null>(null)

  // Reconcile the patrol against the live roster: new pilots scramble, gone
  // pilots land, everyone's burn updates in place. Nothing teleports — an
  // existing plane keeps its position and its damage.
  useEffect(() => {
    if (!racers) return
    const fieldMax = racers.reduce((max, racer) => Math.max(max, racer.score), 0)
    const next: SimPlane[] = []
    for (const racer of racers) {
      const existing = planes.current.find((plane) => plane.key === racer.key)
      if (existing) {
        existing.burnRate = racer.velocityTokensPerMin
        existing.homeAltitude = altitudeForRank(racer.rank, racers.length)
        next.push(existing)
      } else {
        next.push(toSimPlane(racer, fieldMax, racers.length))
      }
    }
    planes.current = next
  }, [racers])

  const pushEvent = useCallback(
    (text: string, tone: DogfightEventLine['tone']): void => {
      events.current = [
        { id: nextId++, text, tone, at: Date.now() },
        ...events.current,
      ].slice(0, EVENT_LOG_LENGTH)
    },
    [],
  )

  const setStar = useCallback((key: string): void => {
    star.current = { key, until: Date.now() + STAR_HOLD_MS }
  }, [])

  const fireBurst = useCallback(
    (attacker: SimPlane, target: SimPlane): void => {
      const burnBonus = 1 + BURN_DAMAGE_BONUS * compress(attacker.burnRate)
      const isCrit = Math.random() < CRIT_CHANCE
      let damage = randomBetween(BURST_DAMAGE_MIN, BURST_DAMAGE_MAX) * burnBonus
      if (isCrit) damage *= randomBetween(CRIT_MULT_MIN, CRIT_MULT_MAX)
      target.hp = Math.max(0, target.hp - damage)

      const now = Date.now()
      tracers.current = [
        ...tracers.current.filter((tracer) => now - tracer.at < TRACER_KEEP_MS),
        {
          id: nextId++,
          fromX: attacker.x,
          fromY: attacker.y,
          fromZ: attacker.z,
          toX: target.x,
          toY: target.y,
          toZ: target.z,
          crit: isCrit,
          at: now,
        },
      ]
      blasts.current = [
        ...blasts.current.filter((blast) => now - blast.at < BLAST_KEEP_MS),
        { id: nextId++, x: target.x, y: target.y, z: target.z, kind: 'hit', at: now },
      ]

      if (isCrit) {
        pushEvent(
          `${attacker.name.toUpperCase()} — DEADEYE on ${target.name.toUpperCase()}`,
          'crit',
        )
      }

      if (target.hp <= 0 && target.mode !== 'down') {
        target.mode = 'down'
        target.modeT = 0
        attacker.kills += 1
        attacker.mode = 'patrol'
        attacker.modeT = 0
        attacker.targetKey = null
        attacker.attackCooldown = attackInterval(attacker.burnRate)
        pushEvent(
          `${attacker.name.toUpperCase()} downs ${target.name.toUpperCase()}`,
          'kill',
        )
        setStar(target.key)
      } else {
        setStar(attacker.key)
      }
    },
    [pushEvent, setStar],
  )

  const step = useCallback(
    (rawDelta: number): void => {
      const delta = Math.min(rawDelta, 0.1)
      const patrol = planes.current

      for (const plane of patrol) {
        plane.modeT += delta

        if (plane.mode === 'respawn') {
          if (plane.modeT >= RESPAWN_S) {
            const spawnAngle = Math.random() * Math.PI * 2
            plane.x = Math.cos(spawnAngle) * COMBAT_BOX_RADIUS
            plane.z = Math.sin(spawnAngle) * COMBAT_BOX_RADIUS
            plane.y = plane.homeAltitude
            plane.heading = spawnAngle + Math.PI // Pointing back into the box.
            plane.hp = plane.maxHp
            plane.pitch = 0
            plane.bank = 0
            plane.mode = 'patrol'
            plane.modeT = 0
            const waypoint = randomWaypoint()
            plane.waypointX = waypoint.x
            plane.waypointZ = waypoint.z
            plane.waypointY = plane.homeAltitude
          }
          continue
        }

        if (plane.mode === 'down') {
          // The spiral: nose down, rolling, engine dead but still moving.
          plane.pitch += (0.55 - plane.pitch) * Math.min(1, delta * 2)
          plane.bank += SPIRAL_ROLL_RATE * delta
          plane.heading += 0.9 * delta
          plane.y -= DIVE_RATE * delta
          plane.x += Math.sin(plane.heading) * plane.speed * 0.7 * delta
          plane.z += Math.cos(plane.heading) * plane.speed * 0.7 * delta
          if (plane.y <= CRASH_ALTITUDE) {
            blasts.current = [
              ...blasts.current,
              {
                id: nextId++,
                x: plane.x,
                y: CRASH_ALTITUDE,
                z: plane.z,
                kind: 'crash',
                at: Date.now(),
              },
            ]
            plane.mode = 'respawn'
            plane.modeT = 0
          }
          continue
        }

        // --- Powered flight ---
        const desired = targetSpeed(plane.burnRate)
        plane.speed += ((desired - plane.speed) / SPEED_SMOOTHING) * delta

        let steerX = plane.waypointX
        let steerZ = plane.waypointZ
        let steerY = plane.waypointY
        let turnRate = PATROL_TURN_RATE

        const target =
          plane.mode === 'pursuit' && plane.targetKey !== null
            ? (patrol.find(
                (other) => other.key === plane.targetKey && other.mode !== 'respawn',
              ) ?? null)
            : null

        if (plane.mode === 'pursuit') {
          if (!target || target.mode === 'down' || plane.modeT > PURSUIT_MAX_S) {
            plane.mode = 'patrol'
            plane.modeT = 0
            plane.targetKey = null
            plane.attackCooldown = attackInterval(plane.burnRate) * randomBetween(0.8, 1.3)
          } else {
            // Chase the point just behind the target's tail.
            steerX = target.x - Math.sin(target.heading) * 2
            steerZ = target.z - Math.cos(target.heading) * 2
            steerY = target.y
            turnRate = PURSUIT_TURN_RATE
          }
        }

        const bearing = Math.atan2(steerX - plane.x, steerZ - plane.z)
        const turn = angleDelta(plane.heading, bearing)
        const applied = Math.max(-turnRate, Math.min(turnRate, turn * 2)) * delta
        plane.heading += applied
        // The bank is the turn made visible — pure presentation.
        plane.bank += (-applied * 26 - plane.bank) * Math.min(1, delta * 4)

        const climb = Math.max(
          -CLIMB_RATE,
          Math.min(CLIMB_RATE, (steerY - plane.y) * 0.8),
        )
        plane.y += climb * delta
        plane.pitch += (-climb * 0.09 - plane.pitch) * Math.min(1, delta * 4)

        plane.x += Math.sin(plane.heading) * plane.speed * delta
        plane.z += Math.cos(plane.heading) * plane.speed * delta

        if (plane.mode === 'patrol') {
          const distance = Math.hypot(plane.waypointX - plane.x, plane.waypointZ - plane.z)
          if (distance < WAYPOINT_RADIUS) {
            const waypoint = randomWaypoint()
            plane.waypointX = waypoint.x
            plane.waypointZ = waypoint.z
            plane.waypointY = Math.max(
              ALTITUDE_FLOOR,
              Math.min(ALTITUDE_CEILING, plane.homeAltitude + randomBetween(-1.5, 1.5)),
            )
          }

          // Scramble an attack run: the rival one rank away, or failing that
          // whoever is nearest in the air.
          plane.attackCooldown -= delta
          if (plane.attackCooldown <= 0 && patrol.length > 1) {
            const airborne = patrol.filter(
              (other) => other.key !== plane.key && other.mode !== 'down' && other.mode !== 'respawn',
            )
            if (airborne.length > 0) {
              const rival = airborne.reduce((best, other) =>
                Math.abs(other.rank - plane.rank) < Math.abs(best.rank - plane.rank)
                  ? other
                  : best,
              )
              plane.mode = 'pursuit'
              plane.modeT = 0
              plane.targetKey = rival.key
              plane.burstCooldown = randomBetween(0.2, 0.5)
              pushEvent(
                `${plane.name.toUpperCase()} — tally-ho on ${rival.name.toUpperCase()}`,
                'info',
              )
              setStar(plane.key)
            } else {
              plane.attackCooldown = attackInterval(plane.burnRate)
            }
          }
        }

        // Guns, from the saddle.
        if (plane.mode === 'pursuit' && target && target.mode !== 'down') {
          const dx = target.x - plane.x
          const dz = target.z - plane.z
          const distance = Math.hypot(dx, dz, target.y - plane.y)
          const offAngle = Math.abs(angleDelta(plane.heading, Math.atan2(dx, dz)))
          if (distance < FIRE_RANGE && offAngle < FIRE_CONE_RAD) {
            plane.burstCooldown -= delta
            if (plane.burstCooldown <= 0) {
              plane.burstCooldown = randomBetween(BURST_INTERVAL_MIN, BURST_INTERVAL_MAX)
              fireBurst(plane, target)
            }
          }
        }
      }
    },
    [fireBurst, pushEvent, setStar],
  )

  return { planes, tracers, blasts, events, star, step }
}
