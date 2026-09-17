'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { RacerState } from '../race/types'

// CH 02's whole game, one file, same doctrine as the race sim: the rules are
// the interesting part and they should be readable in one sitting.
//
// The core decision mirrors the race's. There, position is integrated from
// velocity; here, damage is integrated from burn. A fighter's health is their
// standing (score, earned over the day) and their offence is their liveness
// (tokens per minute, right now) — so a bout is the day's ranking put under
// pressure by the present moment. Criticals are the one dishonest number in
// the building, and deliberately so: a fight where the richer bar always wins
// is a chart with fists. Roughly one hit in twelve lands at triple damage,
// which is enough to let an underdog steal a round without making the score
// meaningless.

// --- Health -----------------------------------------------------------------

/** Health points at the very top of the pair. Everyone else is a fraction. */
const MAX_HP = 200
/**
 * The floor: the weaker fighter of a pair never starts below this fraction of
 * the stronger one's bar. Scores are long-tailed; a literal mapping gives one
 * fighter a sliver and the bout is over before the card fades.
 */
const HP_FLOOR = 0.45
/** Same square-root compression the kart speeds use, same reason. */
const HP_COMPRESSION = 0.5

// --- Offence ----------------------------------------------------------------

/** Tokens/min that maps to full attack speed. Shared with the race. */
const REFERENCE_BURN_RATE = 25_000
/** Seconds between attacks for someone entirely idle. Bouts still resolve. */
const IDLE_ATTACK_INTERVAL = 4.6
/** Seconds between attacks at full burn. A genuine flurry. */
const MAX_ATTACK_INTERVAL = 1.0
/** Burn compression, as everywhere else in the cabinet. */
const ATTACK_COMPRESSION = 0.5
/** Damage rolled per landed hit, before multipliers. */
const DAMAGE_MIN = 5
const DAMAGE_MAX = 11
/** How much full burn scales a hit. Live work punches harder, a little. */
const BURN_DAMAGE_BONUS = 0.5

/** One in twelve, felt often enough to matter, rare enough to be an event. */
const CRIT_CHANCE = 0.085
const CRIT_MULT_MIN = 2.4
const CRIT_MULT_MAX = 3.4
/** Blocks keep a one-sided bout from reading as a beating with no defence. */
const BLOCK_CHANCE = 0.26
const BLOCK_DAMAGE_FACTOR = 0.2

// --- Clock ------------------------------------------------------------------

/** One round per bout, Tekken's own opening count. */
const ROUND_SECONDS = 60
/** Phase lengths, seconds. */
const INTRO_S = 3.2
const ROUND_CARD_S = 2.2
const KO_S = 2.6
const VICTORY_S = 4.2
/** The freeze on impact — the era's whole language of weight. */
const HIT_STOP_S = 0.1
const CRIT_HIT_STOP_S = 0.34

// --- Choreography -----------------------------------------------------------

/** Where the two fighters stand, world units either side of centre. */
export const STANCE_X = 1.55
/** How far an attack lunges toward the opponent. */
const LUNGE_DISTANCE = 0.62
const ACTION_DURATION_S = 0.46
const HIT_REACT_S = 0.42
/** Seconds of shuffle drift, for the footsies between exchanges. */
const SHUFFLE_PERIOD_S = 2.6
const SHUFFLE_AMPLITUDE = 0.16

export type FighterAction =
  | 'idle'
  | 'punch'
  | 'kick'
  | 'hit'
  | 'block'
  | 'ko'
  | 'victory'

export type FightPhase =
  | 'waiting'
  | 'intro'
  | 'round-card'
  | 'fight'
  | 'ko'
  | 'victory'

export interface SimFighter {
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
  /** The red chunk trailing the bar after damage, in hp. Decays. */
  trail: number
  burnRate: number
  action: FighterAction
  /** Seconds into the current action. */
  actionT: number
  attackCooldown: number
  /** World x. Left fighter negative, right positive. */
  x: number
  /** Which side this fighter fights from. -1 left, +1 right. */
  side: -1 | 1
}

export type SparkKind = 'hit' | 'crit' | 'block'

export interface SparkEvent {
  readonly id: number
  readonly kind: SparkKind
  /** World position of the impact. */
  readonly x: number
  readonly y: number
  /** Wall-clock ms when it fired, for fade-out. */
  readonly at: number
}

export interface FightEventLine {
  readonly id: number
  readonly text: string
  readonly tone: 'hit' | 'crit' | 'ko' | 'info'
}

export interface FightState {
  phase: FightPhase
  /** Seconds into the current phase. */
  phaseT: number
  /** Round clock, seconds remaining. Only runs during 'fight'. */
  clock: number
  fighters: [SimFighter, SimFighter] | null
  /** Winner key once decided. */
  winnerKey: string | null
  /** Rank-pair label for the bout after this one. */
  nextPair: string | null
  /** Wall-clock ms after which a crit flash has fully faded. */
  critFlashUntil: number
  /** Remaining hit-stop, seconds. The world freezes while it drains. */
  hitStop: number
  stageNumber: number
}

interface FightSim {
  readonly state: React.RefObject<FightState>
  readonly sparks: React.RefObject<SparkEvent[]>
  readonly events: React.RefObject<FightEventLine[]>
  readonly wins: React.RefObject<Map<string, number>>
  readonly step: (delta: number) => void
}

const EVENT_LOG_LENGTH = 5

let nextId = 1

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function attackInterval(burnRate: number): number {
  const drive = Math.pow(
    Math.min(1, Math.max(0, burnRate) / REFERENCE_BURN_RATE),
    ATTACK_COMPRESSION,
  )
  return IDLE_ATTACK_INTERVAL - (IDLE_ATTACK_INTERVAL - MAX_ATTACK_INTERVAL) * drive
}

function toSimFighter(racer: RacerState, side: -1 | 1, pairMaxScore: number): SimFighter {
  const fraction = pairMaxScore > 0 ? Math.max(0, racer.score) / pairMaxScore : 1
  const compressed = Math.pow(fraction, HP_COMPRESSION)
  const maxHp = Math.round(MAX_HP * (HP_FLOOR + (1 - HP_FLOOR) * compressed))
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
    trail: 0,
    burnRate: racer.velocityTokensPerMin,
    action: 'idle',
    actionT: 0,
    attackCooldown: randomBetween(0.6, 2.0),
    x: STANCE_X * side,
    side,
  }
}

/**
 * Rivals pairing: adjacent ranks, so every bout is close on paper — 1 v 2,
 * 3 v 4, and so on, rotating one pair per bout. An odd fighter out at the
 * bottom sits the rotation's last bout against the leader, which is the
 * classic arcade indignity and also the only pairing left.
 */
function pairForBout(
  racers: ReadonlyArray<RacerState>,
  bout: number,
): [RacerState, RacerState] | null {
  if (racers.length < 2) return null
  const pairCount = Math.ceil(racers.length / 2)
  const index = bout % pairCount
  const a = racers[index * 2]
  const b = racers[index * 2 + 1] ?? racers[0]
  if (a.key === b.key) return null
  return [a, b]
}

function pairLabel(pair: [RacerState, RacerState] | null): string | null {
  return pair ? `${pair[0].name} vs ${pair[1].name}` : null
}

export function useFightSim(racers: ReadonlyArray<RacerState> | undefined): FightSim {
  const state = useRef<FightState>({
    phase: 'waiting',
    phaseT: 0,
    clock: ROUND_SECONDS,
    fighters: null,
    winnerKey: null,
    nextPair: null,
    critFlashUntil: 0,
    hitStop: 0,
    stageNumber: 1,
  })
  const sparks = useRef<SparkEvent[]>([])
  const events = useRef<FightEventLine[]>([])
  const wins = useRef<Map<string, number>>(new Map())
  const bout = useRef(0)
  const racersRef = useRef<ReadonlyArray<RacerState>>([])

  // Fresh roster arrives reactively; the bout in progress keeps its cast and
  // only the burn rates update live — a fighter's offence is the present
  // moment, but their health was set when the card went up.
  useEffect(() => {
    racersRef.current = racers ?? []
    const current = state.current.fighters
    if (!current) return
    for (const fighter of current) {
      const fresh = racersRef.current.find((racer) => racer.key === fighter.key)
      if (fresh) fighter.burnRate = fresh.velocityTokensPerMin
    }
  }, [racers])

  const pushEvent = useCallback((text: string, tone: FightEventLine['tone']): void => {
    events.current = [{ id: nextId++, text, tone }, ...events.current].slice(
      0,
      EVENT_LOG_LENGTH,
    )
  }, [])

  const beginBout = useCallback((): void => {
    const sim = state.current
    const pair = pairForBout(racersRef.current, bout.current)
    if (!pair) {
      sim.phase = 'waiting'
      sim.fighters = null
      sim.nextPair = null
      return
    }
    const pairMax = Math.max(pair[0].score, pair[1].score)
    sim.fighters = [toSimFighter(pair[0], -1, pairMax), toSimFighter(pair[1], 1, pairMax)]
    sim.phase = 'intro'
    sim.phaseT = 0
    sim.clock = ROUND_SECONDS
    sim.winnerKey = null
    sim.stageNumber = bout.current + 1
    sim.nextPair = pairLabel(pairForBout(racersRef.current, bout.current + 1))
  }, [])

  const resolveHit = useCallback(
    (attacker: SimFighter, defender: SimFighter): void => {
      const sim = state.current
      const burnBonus =
        1 +
        BURN_DAMAGE_BONUS *
          Math.pow(
            Math.min(1, attacker.burnRate / REFERENCE_BURN_RATE),
            ATTACK_COMPRESSION,
          )
      const blocked = Math.random() < BLOCK_CHANCE
      const isCrit = !blocked && Math.random() < CRIT_CHANCE
      let damage = randomBetween(DAMAGE_MIN, DAMAGE_MAX) * burnBonus
      if (isCrit) damage *= randomBetween(CRIT_MULT_MIN, CRIT_MULT_MAX)
      if (blocked) damage *= BLOCK_DAMAGE_FACTOR

      defender.hp = Math.max(0, defender.hp - damage)
      defender.trail = Math.min(defender.maxHp, defender.trail + damage)
      defender.action = blocked ? 'block' : 'hit'
      defender.actionT = 0

      const impactX = (attacker.x + defender.x) / 2
      const impactY = attacker.action === 'kick' ? 1.35 : 1.05
      sparks.current = [
        ...sparks.current.filter((spark) => Date.now() - spark.at < 900),
        {
          id: nextId++,
          kind: blocked ? 'block' : isCrit ? 'crit' : 'hit',
          x: impactX,
          y: impactY,
          at: Date.now(),
        },
      ]

      sim.hitStop = isCrit ? CRIT_HIT_STOP_S : HIT_STOP_S
      if (isCrit) {
        sim.critFlashUntil = Date.now() + 420
        pushEvent(
          `${attacker.name.toUpperCase()} lands a CRITICAL — ${Math.round(damage)} damage`,
          'crit',
        )
      } else if (blocked) {
        pushEvent(`${defender.name.toUpperCase()} blocks`, 'info')
      }

      if (defender.hp <= 0) {
        defender.action = 'ko'
        defender.actionT = 0
        attacker.action = 'victory'
        attacker.actionT = 0
        sim.phase = 'ko'
        sim.phaseT = 0
        sim.winnerKey = attacker.key
        wins.current.set(attacker.key, (wins.current.get(attacker.key) ?? 0) + 1)
        pushEvent(`K.O. — ${attacker.name.toUpperCase()} WINS`, 'ko')
      }
    },
    [pushEvent],
  )

  const step = useCallback(
    (rawDelta: number): void => {
      const sim = state.current
      // Tab-switch catch-up arrives as one huge delta; clamp it so a bout
      // does not resolve in a single invisible frame.
      const delta = Math.min(rawDelta, 0.1)

      if (sim.hitStop > 0) {
        sim.hitStop -= delta
        return
      }

      sim.phaseT += delta

      switch (sim.phase) {
        case 'waiting': {
          if (racersRef.current.length >= 2 && sim.phaseT > 1) beginBout()
          return
        }
        case 'intro': {
          if (sim.phaseT >= INTRO_S) {
            sim.phase = 'round-card'
            sim.phaseT = 0
          }
          return
        }
        case 'round-card': {
          if (sim.phaseT >= ROUND_CARD_S) {
            sim.phase = 'fight'
            sim.phaseT = 0
          }
          return
        }
        case 'ko': {
          if (sim.phaseT >= KO_S) {
            sim.phase = 'victory'
            sim.phaseT = 0
          }
          break
        }
        case 'victory': {
          if (sim.phaseT >= VICTORY_S) {
            bout.current += 1
            beginBout()
          }
          break
        }
        case 'fight': {
          sim.clock = Math.max(0, sim.clock - delta)
          break
        }
      }

      const fighters = sim.fighters
      if (!fighters) return
      const [left, right] = fighters

      for (const fighter of fighters) {
        const opponent = fighter === left ? right : left

        // Advance whatever the fighter is doing.
        fighter.actionT += delta
        const done =
          fighter.action === 'punch' || fighter.action === 'kick'
            ? fighter.actionT >= ACTION_DURATION_S
            : fighter.action === 'hit' || fighter.action === 'block'
              ? fighter.actionT >= HIT_REACT_S
              : false
        if (done) {
          fighter.action = 'idle'
          fighter.actionT = 0
        }

        // Footwork: a slow shuffle around the stance mark, plus a lunge for
        // the duration of an attack. KO'd fighters stay where they fell.
        if (fighter.action !== 'ko') {
          const shuffle =
            Math.sin((sim.phaseT / SHUFFLE_PERIOD_S) * Math.PI * 2 + fighter.side) *
            SHUFFLE_AMPLITUDE
          let target = (STANCE_X + shuffle) * fighter.side
          if (fighter.action === 'punch' || fighter.action === 'kick') {
            const lungePhase = Math.sin(
              Math.min(1, fighter.actionT / ACTION_DURATION_S) * Math.PI,
            )
            target -= LUNGE_DISTANCE * lungePhase * fighter.side
          }
          fighter.x += (target - fighter.x) * Math.min(1, delta * 8)
        }

        // The trail bar bleeding down after a hit.
        fighter.trail = Math.max(0, fighter.trail - fighter.maxHp * 0.25 * delta)

        // Offence, only mid-round and only from a neutral stance.
        if (sim.phase !== 'fight') continue
        if (fighter.action !== 'idle' || opponent.action === 'ko') continue
        fighter.attackCooldown -= delta
        if (fighter.attackCooldown <= 0) {
          fighter.action = Math.random() < 0.55 ? 'punch' : 'kick'
          fighter.actionT = 0
          fighter.attackCooldown =
            attackInterval(fighter.burnRate) * randomBetween(0.75, 1.35)
          // The hit itself resolves at the strike frame, below.
        }
      }

      // Strike frames: an attack connects a fixed beat into its animation.
      if (sim.phase === 'fight') {
        for (const fighter of fighters) {
          const opponent = fighter === left ? right : left
          const striking = fighter.action === 'punch' || fighter.action === 'kick'
          const strikeMoment = ACTION_DURATION_S * 0.45
          if (
            striking &&
            fighter.actionT - delta < strikeMoment &&
            fighter.actionT >= strikeMoment &&
            opponent.action !== 'ko'
          ) {
            resolveHit(fighter, opponent)
          }
        }

        // Time over: the fuller bar takes it, by fraction remaining.
        if (sim.clock <= 0 && sim.phase === 'fight') {
          const leftFrac = left.hp / left.maxHp
          const rightFrac = right.hp / right.maxHp
          const winner = leftFrac >= rightFrac ? left : right
          const loser = winner === left ? right : left
          winner.action = 'victory'
          winner.actionT = 0
          loser.action = 'ko'
          loser.actionT = 0
          sim.phase = 'ko'
          sim.phaseT = 0
          sim.winnerKey = winner.key
          wins.current.set(winner.key, (wins.current.get(winner.key) ?? 0) + 1)
          pushEvent(`TIME OVER — ${winner.name.toUpperCase()} WINS`, 'ko')
        }
      }
    },
    [beginBout, resolveHit, pushEvent],
  )

  return { state, sparks, events, wins, step }
}
