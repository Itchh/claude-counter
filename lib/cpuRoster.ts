import type { RacerState } from '@/app/leon/channels/race/types'
import { PS1 } from '@/app/leon/ps1/theme'

// The house field. When the roster is thin — a quiet morning, a team of two,
// a demo with nobody signed in — the games pad it with CPU pilots so there is
// always something to watch. They exist only in the browser: never written to
// Convex, never drivable, never on the leaderboard. Every surface tells them
// apart by key, so a bot's identity survives a round trip through any sim.

export const CPU_KEY_PREFIX = 'cpu:'

export function isCpuKey(key: string): boolean {
  return key.startsWith(CPU_KEY_PREFIX)
}

/** Arcade callsigns, in the order the bots are dealt. */
const CPU_CALLSIGNS: ReadonlyArray<string> = ['VIPER', 'GHOST', 'RAPTOR', 'NOMAD', 'SABRE', 'ECHO', 'DELTA', 'HAWK']

/** One PS1 palette colour per bot, cycling if the field is ever that deep. */
const CPU_COLORS: ReadonlyArray<string> = [PS1.cyan, PS1.hot, PS1.green, PS1.gold, PS1.red, PS1.textDim]

/**
 * How a bot's pace is dealt, as a fraction of the field's reference.
 *
 * Each bot gets its own step so the pack is spread rather than a train, and
 * the top of the spread sits at the reference rather than above it: a bot
 * can lead a lap on the track, but it does not out-burn the humans' middle.
 */
const CPU_PACE_SPREAD: ReadonlyArray<number> = [0.85, 0.65, 1.0, 0.55, 0.75, 0.9, 0.6, 0.8]

/**
 * The burn rate the sims read as mid pace, in tokens per minute. Both the
 * race and the dogfight normalise against a reference of 25,000/min and
 * compress by square root, so a quarter of it lands the bots at half throttle.
 */
const DEFAULT_CPU_VELOCITY = 6_250
/** The floor under a real field's median, so idle humans do not park the bots. */
const MIN_REFERENCE_VELOCITY = 2_500

/** A day's score for a bot when there is nobody real to scale against. */
const DEFAULT_CPU_SCORE = 2_000_000
/**
 * Bots score under the real leader, as a fraction of their top score. The
 * dogfight reads score as airframe health relative to the field's best, so
 * this is also what keeps a bot beatable.
 */
const CPU_SCORE_FRACTION = 0.45
const MIN_REFERENCE_SCORE = 250_000

function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function makeCpuRacer(ordinal: number, rank: number, referenceVelocity: number, referenceScore: number): RacerState {
  const slot = ordinal - 1
  const pace = CPU_PACE_SPREAD[slot % CPU_PACE_SPREAD.length]
  const score = Math.round(referenceScore * pace)
  return {
    key: `${CPU_KEY_PREFIX}${ordinal}`,
    name: CPU_CALLSIGNS[slot % CPU_CALLSIGNS.length],
    color: CPU_COLORS[slot % CPU_COLORS.length],
    // No shop, hangar or dojo choices: the *Of(key, null) helpers hash the
    // key into a chassis, airframe and fighter, so each bot looks its own.
    paint: null,
    livery: null,
    chassis: null,
    airframe: null,
    planePaint: null,
    planeLivery: null,
    fighter: null,
    fightPaint: null,
    fightLivery: null,
    rank,
    score,
    rawTokens: score,
    multiplier: 1,
    velocityTokensPerMin: Math.round(referenceVelocity * pace),
    isActive: true,
    isCpu: true,
  }
}

/**
 * Pads `racers` with deterministic CPU bots up to `minimum` entries. Returns
 * the same array when nothing is needed. Never removes or reorders real
 * racers: bots are appended, ranked after the last real entry.
 *
 * Pace is dealt relative to the real field when there is one — the median
 * burn and a fraction of the top score — and from fixed mid-pace defaults
 * when there is not, so a bot is neither trivial nor dominant either way.
 */
export function fillRoster(racers: ReadonlyArray<RacerState>, minimum: number): ReadonlyArray<RacerState> {
  const shortfall = minimum - racers.length
  if (shortfall <= 0) return racers

  const humans = racers.filter((racer) => !isCpuKey(racer.key))
  const referenceVelocity =
    humans.length > 0
      ? Math.max(MIN_REFERENCE_VELOCITY, median(humans.map((racer) => racer.velocityTokensPerMin)))
      : DEFAULT_CPU_VELOCITY
  const referenceScore =
    humans.length > 0
      ? Math.max(MIN_REFERENCE_SCORE, Math.max(...humans.map((racer) => racer.score)) * CPU_SCORE_FRACTION)
      : DEFAULT_CPU_SCORE

  const bots = Array.from({ length: shortfall }, (_, index) =>
    makeCpuRacer(index + 1, racers.length + index + 1, referenceVelocity, referenceScore),
  )
  return [...racers, ...bots]
}
