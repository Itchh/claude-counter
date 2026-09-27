'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { RacerState } from '../race/types'
import { ringLine, stageForBout, type StageDefinition } from './stages'
import {
  ACTION_DURATION_S,
  fighterFor,
  fighterOf,
  HEAVY_HIT_CLIP,
  HIT_REACT_S,
  pickClip,
  STRIKE_MOMENT_S,
  strikeReach,
  type FighterSpec,
} from './fighters'
import { isRemoteLive, type ControlMode, type DriveLink, type FightPose } from '../../control/types'

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
//
// Everything spatial here is in fighter units — a body is 1.83 tall — on
// whatever stage the bout is held. The stage carries a scale, the scene
// applies it when it draws, and the stage's measured line is brought down
// to this scale for the clamps; see stages.ts. The one number that would
// otherwise drift between the two is the strike, which is why a hit is
// tested against the gap and not against a clock: a punch lands if the
// other body is inside the fist's measured reach on the frame the fist is
// out, and not otherwise.

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
/**
 * Seconds between attacks for someone entirely idle. Bouts still resolve.
 *
 * Down from 4.6. Nearly five seconds of two men looking at each other is a
 * still photograph with a health bar over it, and the shuffle was doing all
 * the work of pretending otherwise.
 */
const IDLE_ATTACK_INTERVAL = 1.0
/**
 * Seconds between attacks at full burn. A genuine flurry — barely longer
 * than the animation itself, so a fighter at full burn is throwing the next
 * strike as the last one lands. That is the whole point of the top of the
 * scale: it should look like someone is actually hammering.
 */
const MAX_ATTACK_INTERVAL = 0.3
/** Burn compression, as everywhere else in the cabinet. */
const ATTACK_COMPRESSION = 0.5
/** Damage rolled per landed hit, before multipliers. */
/**
 * Small, because the strikes are quick. At a strike a second and seven in
 * ten landing, two to five a hit walks a 200 bar down in seventy-odd
 * seconds — a round that goes the distance is a close one, not a slow one.
 */
const DAMAGE_MIN = 2
const DAMAGE_MAX = 5
/** How much full burn scales a hit. Live work punches harder, a little. */
const BURN_DAMAGE_BONUS = 0.5
/** Kicks over punches, when the machine is choosing. */
const PUNCH_CHANCE = 0.55

/** One in twelve, felt often enough to matter, rare enough to be an event. */
const CRIT_CHANCE = 0.085
const CRIT_MULT_MIN = 2.4
const CRIT_MULT_MAX = 3.4
/** Blocks keep a one-sided bout from reading as a beating with no defence. */
const BLOCK_CHANCE = 0.26
const BLOCK_DAMAGE_FACTOR = 0.2

// --- Clock ------------------------------------------------------------------

/** One round per bout, Tekken's own opening count. */
const ROUND_SECONDS = 90
/**
 * Phase lengths, seconds. Every one of them trimmed: the bout is the thing
 * worth watching, and the ceremony around it was eating twelve seconds of
 * every cycle. Still long enough to read the cards — they are four words.
 */
const INTRO_S = 2.6
const ROUND_CARD_S = 1.7
const KO_S = 2.2
const VICTORY_S = 3.4
/** The freeze on impact — the era's whole language of weight. */
const HIT_STOP_S = 0.1
const CRIT_HIT_STOP_S = 0.34

// --- Choreography -----------------------------------------------------------

/** Where the two fighters open, fighter units either side of centre. */
export const STANCE_X = 1.55
/**
 * How far a strike carries the attacker toward the opponent before the hit
 * frame, and how fast it has to move to get there by then. The step-in is
 * what makes a punch read as thrown rather than extended.
 */
const LUNGE_DISTANCE = 0.5
const LUNGE_SPEED = LUNGE_DISTANCE / STRIKE_MOMENT_S
/**
 * Closest two bodies get during a lunge. Under the standing minimum,
 * because a punch that lands is a body inside another's space for a frame.
 */
const LUNGE_MIN_GAP = 0.7
/** Closest the two may stand between exchanges. */
const MIN_GAP = 0.95
/**
 * The footwork. A fighter walks in to strike and walks out afterwards, at
 * the speed the walk clip was authored for; a retreat is a little slower
 * because it is the same clip run backwards and legs do not do that well.
 */
const WALK_SPEED = 2.6
const RETREAT_SPEED_FACTOR = 0.8
/**
 * How long a fighter backs off after a strike, and how often they bother.
 * The chance falls with burn: a fighter at full rate is hammering, and a
 * step out between every blow would turn the flurry into a waltz.
 */
const RETREAT_MIN_S = 0.18
const RETREAT_MAX_S = 0.4
const RETREAT_CHANCE = 0.55
const RETREAT_CHANCE_AT_FULL_BURN = 0.15
/** How often a fighter steps back when they see the other one coming. */
const EVADE_CHANCE = 0.3
const EVADE_S = 0.35
/** An approach that has not found its range by now gives up. */
const ADVANCE_MAX_S = 1.6
/**
 * The margin under the reach a fighter closes to before throwing. The
 * strike itself lunges the rest of the way; the margin is for the frame or
 * two the opponent has to move in the meantime.
 */
const ENGAGE_LUNGE_FRACTION = 0.8
/** Slack in the contact test: skin, glove, the era's generous hitboxes. */
const CONTACT_SLACK = 0.08
/** How far a hit pushes the defender, and a block. Over the react window. */
const KNOCKBACK_HIT = 0.35
const KNOCKBACK_BLOCK = 0.12
/** How much of the push arrives per react window's worth of time. Above 1: early. */
const KNOCKBACK_EASE = 2.5
/** The sway on a fighter standing still: small, the guard clip does the rest. */
const SWAY_PERIOD_S = 1.3
const SWAY_AMPLITUDE = 0.06
/** Fraction of the way home a standing fighter drifts per second. Slow. */
const HOME_PULL = 0.2

// --- Fighting by hand -------------------------------------------------------

/** Fighter units per second a driven fighter covers on the stick. */
const DRIVEN_MOVE_SPEED = 2.4
/**
 * How far inside the stage's measured line a fighter is held, in fighter
 * units — half a body, so a shoulder never reaches the pillar that ended
 * the measurement. The line itself comes from the stage; see stages.ts.
 */
const LINE_MARGIN = 0.45
/** A human attacks as fast as their burn allows, minus the AI's dither. */
const DRIVEN_COOLDOWN_FACTOR = 0.75
/** How quickly a remote fighter settles onto its reported spot. */
const REMOTE_SMOOTHING = 0.1

export type FighterAction =
  | 'idle'
  | 'advance'
  | 'retreat'
  | 'punch'
  | 'kick'
  | 'hit'
  | 'block'
  | 'ko'
  | 'victory'

/** The two strikes. */
type StrikeAction = 'punch' | 'kick'

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
  /** The dojo's choices: which sculpt, what colour gi, what pattern. */
  readonly fighter: number | null
  readonly fightPaint: string | null
  readonly fightLivery: string | null
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
  /**
   * The clip chosen for the current action, or null to let the renderer
   * choose. Chosen here for strikes, whose reach depends on it.
   */
  clip: string | null
  /** What the fighter is walking in to throw, and with which clip. Null when not walking in. */
  intent: StrikeAction | null
  intentClip: string | null
  /** Seconds left to keep backing off. */
  retreatFor: number
  /** Fighter units of push still to take from the last hit. */
  knockback: number
  attackCooldown: number
  /** Ring x, in fighter units. Left fighter negative, right positive. */
  x: number
  /** Which side this fighter fights from. -1 left, +1 right. */
  side: -1 | 1
  /** Who decides this fighter's moves this frame. Set by step. */
  mode: ControlMode
}

export type SparkKind = 'hit' | 'crit' | 'block'

export interface SparkEvent {
  readonly id: number
  readonly kind: SparkKind
  /** Ring position of the impact, in fighter units. */
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
  /** Where this bout is held. Rotates with the bout — see stages.ts. */
  stage: StageDefinition
}

interface FightSim {
  readonly state: React.RefObject<FightState>
  readonly sparks: React.RefObject<SparkEvent[]>
  readonly events: React.RefObject<FightEventLine[]>
  readonly wins: React.RefObject<Map<string, number>>
  readonly step: (delta: number) => void
}

const EVENT_LOG_LENGTH = 5
/** Sparks older than this are dropped from the list before a new one is added. */
const SPARK_KEEP_MS = 900
/** How long the crit flash burns, wall-clock. */
const CRIT_FLASH_MS = 420
/** Spark height for a punch and for a kick, in fighter units. */
const IMPACT_Y_PUNCH = 1.05
const IMPACT_Y_KICK = 1.35
/** Tab-switch catch-up arrives as one huge delta; clamp it. */
const MAX_STEP_S = 0.1
/** How fast the trail bar bleeds down, as a fraction of max hp per second. */
const TRAIL_DRAIN = 0.25

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

/** How often this fighter steps out after a strike, at their burn. */
function retreatChance(burnRate: number): number {
  const drive = Math.pow(Math.min(1, Math.max(0, burnRate) / REFERENCE_BURN_RATE), ATTACK_COMPRESSION)
  return RETREAT_CHANCE - (RETREAT_CHANCE - RETREAT_CHANCE_AT_FULL_BURN) * drive
}

function isStrike(action: FighterAction): action is StrikeAction {
  return action === 'punch' || action === 'kick'
}

/** The sculpt this fighter is drawn as — the one whose reach they have. */
function specOf(fighter: SimFighter): FighterSpec {
  return fighterFor(fighterOf(fighter.key, fighter.fighter))
}

/**
 * Puts a fighter into an action from the top. Strikes pick their clip here
 * so the reach test below knows which fist is out; everything else leaves
 * the pick to the renderer.
 */
function startAction(fighter: SimFighter, action: FighterAction, clip: string | null = null): void {
  fighter.action = action
  fighter.actionT = 0
  fighter.clip = clip ?? (isStrike(action) ? pickClip(action) : null)
  if (action !== 'advance') {
    fighter.intent = null
    fighter.intentClip = null
  }
}

/** The gap a strike closes from, before its own lunge: reach, body, margin. */
function engageGap(attacker: SimFighter, defender: SimFighter, strike: StrikeAction, clip: string): number {
  return (
    strikeReach(specOf(attacker), clip, strike) +
    specOf(defender).depth / 2 +
    LUNGE_DISTANCE * ENGAGE_LUNGE_FRACTION
  )
}

/** Whether the fist that is out reaches the other body, right now. */
function inReach(attacker: SimFighter, defender: SimFighter): boolean {
  if (!isStrike(attacker.action)) return false
  const gap = Math.abs(attacker.x - defender.x)
  return gap <= strikeReach(specOf(attacker), attacker.clip, attacker.action) + specOf(defender).depth / 2 + CONTACT_SLACK
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
    fighter: racer.fighter,
    fightPaint: racer.fightPaint,
    fightLivery: racer.fightLivery,
    score: racer.score,
    rank: racer.rank,
    maxHp,
    hp: maxHp,
    trail: 0,
    burnRate: racer.velocityTokensPerMin,
    action: 'idle',
    actionT: 0,
    clip: null,
    intent: null,
    intentClip: null,
    retreatFor: 0,
    knockback: 0,
    attackCooldown: randomBetween(0.6, 2.0),
    x: STANCE_X * side,
    side,
    mode: 'auto',
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
  preferredKey: string | null = null,
): [RacerState, RacerState] | null {
  if (racers.length < 2) return null
  // Somebody at the controls is on the next card, against the rival one
  // rank away — the same pairing the rotation would have given them.
  if (preferredKey !== null) {
    const index = racers.findIndex((racer) => racer.key === preferredKey)
    if (index >= 0) {
      const human = racers[index]
      const rival = racers[index + 1] ?? racers[index - 1]
      if (rival && rival.key !== human.key) {
        return index % 2 === 0 ? [human, rival] : [rival, human]
      }
    }
  }
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

export function useFightSim(
  racers: ReadonlyArray<RacerState> | undefined,
  drive?: DriveLink<FightPose>,
): FightSim {
  const driveRef = useRef(drive)
  driveRef.current = drive
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
    stage: stageForBout(0),
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
    const pair = pairForBout(racersRef.current, bout.current, driveRef.current?.drivenKey ?? null)
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
    // A new venue every bout: the card moves on, the rotation comes round.
    sim.stage = stageForBout(bout.current)
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
      // A fighter with somebody at the controls blocks when they are holding
      // block, and only then. The dice are for the machine.
      const blocked =
        defender.mode === 'auto' ? Math.random() < BLOCK_CHANCE : defender.action === 'block'
      const isCrit = !blocked && Math.random() < CRIT_CHANCE
      let damage = randomBetween(DAMAGE_MIN, DAMAGE_MAX) * burnBonus
      if (isCrit) damage *= randomBetween(CRIT_MULT_MIN, CRIT_MULT_MAX)
      if (blocked) damage *= BLOCK_DAMAGE_FACTOR

      defender.hp = Math.max(0, defender.hp - damage)
      defender.trail = Math.min(defender.maxHp, defender.trail + damage)
      // The flinch, and the push that goes with it. A critical staggers;
      // a block takes a step.
      startAction(defender, blocked ? 'block' : 'hit', !blocked && isCrit ? HEAVY_HIT_CLIP : null)
      defender.knockback = blocked ? KNOCKBACK_BLOCK : KNOCKBACK_HIT

      const impactX = (attacker.x + defender.x) / 2
      const impactY = attacker.action === 'kick' ? IMPACT_Y_KICK : IMPACT_Y_PUNCH
      sparks.current = [
        ...sparks.current.filter((spark) => Date.now() - spark.at < SPARK_KEEP_MS),
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
        sim.critFlashUntil = Date.now() + CRIT_FLASH_MS
        pushEvent(
          `${attacker.name.toUpperCase()} lands a CRITICAL — ${Math.round(damage)} damage`,
          'crit',
        )
      } else if (blocked) {
        pushEvent(`${defender.name.toUpperCase()} blocks`, 'info')
      }

      if (defender.hp <= 0) {
        startAction(defender, 'ko')
        defender.knockback = 0
        startAction(attacker, 'victory')
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
      const delta = Math.min(rawDelta, MAX_STEP_S)

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
      const line = ringLine(sim.stage)
      const fighting = sim.phase === 'fight'

      const drive = driveRef.current
      const now = Date.now()

      for (const fighter of fighters) {
        const opponent = fighter === left ? right : left
        // The way this fighter faces: the left fighter (side -1) stands at
        // negative x and advances toward +x, so forward is the side negated.
        const forward = -fighter.side

        // --- who is fighting ---
        const remote = drive && drive.drivenKey !== fighter.key ? drive.remotes.get(fighter.key) : undefined
        if (isRemoteLive(remote, now)) {
          fighter.mode = 'remote'
          const pose = remote.pose
          fighter.actionT += delta
          if (pose.action !== fighter.action) {
            fighter.action = pose.action as FighterAction
            fighter.actionT = pose.actionT
            fighter.clip = null
          }
          fighter.x += (pose.x - fighter.x) * Math.min(1, delta / REMOTE_SMOOTHING)
          fighter.hp = pose.hp
          fighter.trail = pose.trail
          continue
        }
        const isDriven = drive !== undefined && drive.drivenKey === fighter.key
        fighter.mode = isDriven ? 'driven' : 'auto'
        const input = isDriven ? drive.input : null

        // Advance whatever the fighter is doing.
        fighter.actionT += delta
        const done = isStrike(fighter.action)
          ? fighter.actionT >= ACTION_DURATION_S
          : fighter.action === 'hit'
            ? fighter.actionT >= HIT_REACT_S
            : fighter.action === 'block'
              // A held block holds; the machine's, and a block that took a
              // hit, come down with the react.
              ? fighter.actionT >= HIT_REACT_S && !(input?.block ?? false)
              : fighter.action === 'advance'
              ? fighter.actionT >= ADVANCE_MAX_S
              : fighter.action === 'retreat'
                ? fighter.actionT >= fighter.retreatFor
                : false
        if (done) {
          const wasStrike = isStrike(fighter.action)
          const gap = Math.abs(fighter.x - opponent.x)
          // Off a strike, the machine often backs out again — the exchange
          // is a step in, a blow, a step out — and always if it has ended
          // up inside the standing gap.
          if (wasStrike && !input && fighting && (gap < MIN_GAP || Math.random() < retreatChance(fighter.burnRate))) {
            startAction(fighter, 'retreat')
            fighter.retreatFor = randomBetween(RETREAT_MIN_S, RETREAT_MAX_S)
          } else {
            startAction(fighter, 'idle')
          }
        }

        // --- Footwork -------------------------------------------------------
        // Each action moves the feet its own way. KO'd fighters stay where
        // they fell; a fighter being hit is pushed, whoever is driving them.
        if (fighter.action !== 'ko') {
          let x = fighter.x
          if (fighter.action === 'hit' || fighter.action === 'block') {
            // Front-loaded, as a shove is: most of the push in the first
            // frames of the react, the rest trailing off inside it.
            const push = Math.min(fighter.knockback, fighter.knockback * Math.min(1, (delta / HIT_REACT_S) * KNOCKBACK_EASE))
            fighter.knockback -= push
            x -= forward * push
          } else if (isStrike(fighter.action)) {
            // The lunge: straight at the other body until the hit frame,
            // never closer than a fist's depth.
            if (fighter.actionT <= STRIKE_MOMENT_S) {
              const nearest = opponent.x - forward * LUNGE_MIN_GAP
              const stepped = x + forward * LUNGE_SPEED * delta
              x = forward > 0 ? Math.min(nearest, stepped) : Math.max(nearest, stepped)
            }
          } else if (input) {
            // The stick moves the feet in screen space — right is right,
            // whichever side you started on — and you cannot walk through
            // the other fighter.
            const wanted = x + input.steer * DRIVEN_MOVE_SPEED * delta
            const nearest = opponent.x - forward * MIN_GAP
            x = forward > 0 ? Math.min(nearest, wanted) : Math.max(nearest, wanted)
            // The clip follows the stick: in, out, or standing.
            const towards = input.steer * forward
            const walking = towards > 0 ? 'advance' : towards < 0 ? 'retreat' : 'idle'
            const footAction = fighter.action === 'idle' || fighter.action === 'advance' || fighter.action === 'retreat'
            if (footAction && fighter.action !== walking) {
              startAction(fighter, walking)
              fighter.retreatFor = Infinity
            }
          } else if (fighter.action === 'advance') {
            const nearest = opponent.x - forward * MIN_GAP
            const stepped = x + forward * WALK_SPEED * delta
            x = forward > 0 ? Math.min(nearest, stepped) : Math.max(nearest, stepped)
          } else if (fighter.action === 'retreat') {
            x -= forward * WALK_SPEED * RETREAT_SPEED_FACTOR * delta
          } else if (fighter.action === 'idle') {
            // Standing: a slight sway, so the two marks are never dead
            // still. Integrated as a velocity — the derivative of a sine —
            // so it does not snap the fighter back to wherever it began.
            const phase = (sim.phaseT / SWAY_PERIOD_S) * Math.PI * 2 + fighter.side
            x += Math.cos(phase) * SWAY_AMPLITUDE * ((Math.PI * 2) / SWAY_PERIOD_S) * delta
            // And a slow pull back to the opening mark, so a pair that has
            // been walked and knocked to one wall comes off it between
            // exchanges rather than finishing the round in the corner.
            x += (STANCE_X * fighter.side - x) * HOME_PULL * delta
          }
          // Nobody walks into the scenery. The stage's line is where the
          // floor was measured clear of pillars, vases and walls, and the
          // fighters stay on it whoever is moving them.
          fighter.x = Math.max(line.minX + LINE_MARGIN, Math.min(line.maxX - LINE_MARGIN, x))
        }

        // The trail bar bleeding down after a hit.
        fighter.trail = Math.max(0, fighter.trail - fighter.maxHp * TRAIL_DRAIN * delta)

        // --- Offence --------------------------------------------------------
        // Only mid-round, and never at a fighter who is already down.
        if (!fighting) continue
        if (input) {
          // The presses are consumed whether or not they land, so a mashed
          // button is not a queue of punches arriving later.
          const wantPunch = input.punch
          const wantKick = input.kick
          input.punch = false
          input.kick = false
          if (opponent.action === 'ko') continue
          fighter.attackCooldown -= delta
          const free =
            fighter.action === 'idle' ||
            fighter.action === 'advance' ||
            fighter.action === 'retreat' ||
            fighter.action === 'block'
          if (!free) continue
          if ((wantPunch || wantKick) && fighter.attackCooldown <= 0) {
            startAction(fighter, wantPunch ? 'punch' : 'kick')
            fighter.attackCooldown = attackInterval(fighter.burnRate) * DRIVEN_COOLDOWN_FACTOR
          } else if (input.block && fighter.action !== 'block') {
            startAction(fighter, 'block')
            fighter.knockback = 0
          } else if (!input.block && fighter.action === 'block') {
            startAction(fighter, 'idle')
          }
          continue
        }
        if (opponent.action === 'ko') continue

        // The machine. Walking in: throw the moment the range is right.
        if (fighter.action === 'advance' && fighter.intent !== null) {
          const clip = fighter.intentClip ?? pickClip(fighter.intent)
          const gap = Math.abs(fighter.x - opponent.x)
          if (gap <= engageGap(fighter, opponent, fighter.intent, clip)) {
            startAction(fighter, fighter.intent, clip)
          }
          continue
        }
        if (fighter.action !== 'idle') continue
        fighter.attackCooldown -= delta
        if (fighter.attackCooldown <= 0) {
          const intent: StrikeAction = Math.random() < PUNCH_CHANCE ? 'punch' : 'kick'
          const clip = pickClip(intent)
          fighter.attackCooldown = attackInterval(fighter.burnRate) * randomBetween(0.75, 1.35)
          const gap = Math.abs(fighter.x - opponent.x)
          if (gap <= engageGap(fighter, opponent, intent, clip)) {
            startAction(fighter, intent, clip)
          } else {
            // Out of range: walk in, with the strike in mind and its clip
            // already chosen, so the range being walked to is that strike's.
            startAction(fighter, 'advance')
            fighter.intent = intent
            fighter.intentClip = clip
            // The other fighter sees it coming, sometimes, and gives ground
            // — which is where the whiffs come from.
            if (opponent.mode === 'auto' && opponent.action === 'idle' && Math.random() < EVADE_CHANCE) {
              startAction(opponent, 'retreat')
              opponent.retreatFor = EVADE_S
            }
          }
          // The hit itself resolves at the strike frame, below.
        }
      }

      // Strike frames: an attack connects a fixed beat into its animation —
      // if the other body is there. A fist that stops short plays through
      // and does nothing, which is what a whiff is.
      if (fighting) {
        for (const fighter of fighters) {
          const opponent = fighter === left ? right : left
          if (
            isStrike(fighter.action) &&
            fighter.actionT - delta < STRIKE_MOMENT_S &&
            fighter.actionT >= STRIKE_MOMENT_S &&
            opponent.action !== 'ko' &&
            inReach(fighter, opponent)
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
          startAction(winner, 'victory')
          startAction(loser, 'ko')
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
