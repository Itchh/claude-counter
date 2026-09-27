import { FIGHTER_COUNT } from '@/lib/livery'
import { stableBucket } from '@/lib/stableHash'
import manifest from './fighters.json'
import type { FighterAction } from './useFightSim'

// The roster. Seven fighters baked from downloaded sculpts — see
// scripts/bakeFighters.mjs — every one skinned onto the same skeleton and
// carrying the same clips, so the simulation fights one body and the reader
// supplies the person. Identity by silhouette and by page, exactly as the
// cars and the planes: seven of the same fighter in seven colours is a
// health bar with legs.
//
// What the bake measured lives in fighters.json beside this file: the
// clips, their lengths, the moment in each strike that the hand is
// furthest forward and how far forward that is. What it could not measure
// — which clip a simulation action plays, and how a strike is timed against
// the simulation's own hit frame — is written here.

export interface FighterClip {
  readonly duration: number
  /** Fraction of the clip at which the strike lands. Null for non-strikes. */
  readonly strikeAt: number | null
  /**
   * How far in front of the fighter's mark the striking limb gets on that
   * frame, in fighter units. Null for non-strikes. This is the number the
   * simulation tests the gap against: a fist that stops here does not hit
   * a body that is further away.
   */
  readonly reach: number | null
}

export interface FighterSpec {
  readonly slug: string
  /** The name, as the dojo prints it. */
  readonly name: string
  /** One line under the name. */
  readonly note: string
  readonly modelUrl: string
  readonly height: number
  /** Front to back, in the bind pose. Half of it is how deep a hit has to go. */
  readonly depth: number
  readonly triangles: number
  readonly clips: Readonly<Record<string, FighterClip>>
}

interface ManifestFighter {
  readonly slug: string
  readonly name: string
  readonly note: string
  readonly height: number
  readonly width: number
  readonly depth: number
  readonly triangles: number
  readonly clips: Readonly<Record<string, FighterClip>>
}

interface Manifest {
  readonly fighters: ReadonlyArray<ManifestFighter>
}

const BAKED: Manifest = manifest

function toFighter(baked: ManifestFighter): FighterSpec {
  return {
    slug: baked.slug,
    name: baked.name,
    note: baked.note,
    modelUrl: `/ps1/fighters/${baked.slug}.glb`,
    height: baked.height,
    depth: baked.depth,
    triangles: baked.triangles,
    clips: baked.clips,
  }
}

export const FIGHTERS: ReadonlyArray<FighterSpec> = BAKED.fighters.map(toFighter)

if (FIGHTERS.length !== FIGHTER_COUNT) {
  // The catalogue, the mutation's check and the dojo's cycle are all built
  // to FIGHTER_COUNT; a bake that adds a fighter has to update lib/livery.ts.
  throw new Error(`fighters.json has ${FIGHTERS.length} fighters; lib/livery.ts expects ${FIGHTER_COUNT}`)
}

/**
 * The fighter a person is drawn as: the one they chose in the dojo, or —
 * until they have — the one their key hashes to. Every surface that draws
 * a fighter goes through this, so a choice made in the window lands in the
 * ring on the same subscription tick.
 */
export function fighterOf(key: string, chosen: number | null | undefined): number {
  if (chosen !== null && chosen !== undefined && Number.isInteger(chosen) && chosen >= 0 && chosen < FIGHTERS.length) {
    return chosen
  }
  return stableBucket(key, FIGHTERS.length)
}

export function fighterFor(index: number): FighterSpec {
  return FIGHTERS[((index % FIGHTERS.length) + FIGHTERS.length) % FIGHTERS.length]
}

/**
 * Which clip an action plays, and how.
 *
 * `loop` clips run until the action changes; the rest play once and hold
 * their last frame — a fighter who has been knocked out stays down. A
 * strike is stretched or squeezed so its measured hit moment lands on the
 * simulation's own strike frame, which is what keeps the spark, the
 * hit-stop and the fist arriving together. `variants` are chosen between
 * when the action starts — by the simulation, which needs to know the reach
 * of the strike it is throwing, or by the renderer for a fighter whose
 * choices arrive over the wire without one — so a flurry is not the same
 * jab six times.
 *
 * `direction` is the sign of the playback: the library has a walk forward
 * and nothing backward, and a walk played in reverse is how the era's
 * fighters backed off too.
 */
export interface ClipChoice {
  readonly variants: ReadonlyArray<string>
  readonly loop: boolean
  /** Seconds into the action the simulation resolves the hit, if any. */
  readonly strikeAtSeconds: number | null
  readonly direction: 1 | -1
}

/**
 * How long a strike takes, and how far into it the hit is resolved. Owned
 * here rather than by the simulation because the clip table below is built
 * from them at load, and the simulation imports this file — a constant
 * that crossed back the other way would be read before it existed.
 *
 * Short, and it has to be: an animation longer than the cooldown feeding
 * it means the next attack is queued behind the last one finishing, and the
 * flurry the burn rate asked for comes out as a metronome. At 0.34 the
 * animation always clears before the fastest cooldown comes round.
 */
export const ACTION_DURATION_S = 0.26
export const STRIKE_MOMENT_S = ACTION_DURATION_S * 0.45
/** How long a flinch is given on screen. */
export const HIT_REACT_S = 0.22
/** The flinch clips are timed to the react window. */
const HIT_REACT_SECONDS = HIT_REACT_S
/** The jab clip runs longer than the action; no strike plays slower than this. */
const STRIKE_MIN_TIME_SCALE = 1

export const CLIP_FOR_ACTION: Readonly<Record<FighterAction, ClipChoice>> = {
  idle: { variants: ['Guard', 'Guard_Shift'], loop: true, strikeAtSeconds: null, direction: 1 },
  advance: { variants: ['Walk_Loop'], loop: true, strikeAtSeconds: null, direction: 1 },
  retreat: { variants: ['Walk_Loop'], loop: true, strikeAtSeconds: null, direction: -1 },
  punch: { variants: ['Punch_Jab', 'Punch_Cross'], loop: false, strikeAtSeconds: STRIKE_MOMENT_S, direction: 1 },
  kick: { variants: ['Kick', 'Kick_Round'], loop: false, strikeAtSeconds: STRIKE_MOMENT_S, direction: 1 },
  hit: { variants: ['Hit_Chest', 'Hit_Head', 'Hit_Stagger'], loop: false, strikeAtSeconds: null, direction: 1 },
  block: { variants: ['Block'], loop: false, strikeAtSeconds: null, direction: 1 },
  ko: { variants: ['Death01'], loop: false, strikeAtSeconds: null, direction: 1 },
  victory: { variants: ['Dance_Loop'], loop: true, strikeAtSeconds: null, direction: 1 },
}

/** The flinch for a hit that landed hard: the stagger, never the twitch. */
export const HEAVY_HIT_CLIP = 'Hit_Stagger'

/** A variant for an action, at random. */
export function pickClip(action: FighterAction): string {
  const variants = CLIP_FOR_ACTION[action].variants
  return variants[Math.floor(Math.random() * variants.length)] ?? variants[0]
}

/**
 * The speed a clip plays at for an action. A strike is timed to the hit
 * frame, and never slower than authored — the era's punches were quick or
 * they were nothing; a flinch is timed to the simulation's react window;
 * a retreat is the walk run backwards; everything else plays as authored.
 */
export function clipTimeScale(spec: FighterSpec, clipName: string, choice: ClipChoice): number {
  const clip = spec.clips[clipName]
  if (!clip) return choice.direction
  if (choice.strikeAtSeconds !== null && clip.strikeAt !== null) {
    return Math.max(STRIKE_MIN_TIME_SCALE, (clip.strikeAt * clip.duration) / choice.strikeAtSeconds)
  }
  if (clipName.startsWith('Hit_')) return clip.duration / HIT_REACT_SECONDS
  return choice.direction
}

/**
 * How far a strike reaches, in fighter units: the bake's measurement for
 * the clip, or the action's fallback for a clip it never measured.
 */
export function strikeReach(spec: FighterSpec, clipName: string | null, action: FighterAction): number {
  const measured = clipName !== null ? spec.clips[clipName]?.reach ?? null : null
  if (measured !== null) return measured
  return action === 'kick' ? FALLBACK_REACH_KICK : FALLBACK_REACH_PUNCH
}

/** What the rig's arm and leg reach to, roughly, when the bake has no number. */
const FALLBACK_REACH_PUNCH = 0.7
const FALLBACK_REACH_KICK = 0.8

/** Every fighter, warmed before the first card goes up. */
export function fighterModelUrls(): ReadonlyArray<string> {
  return FIGHTERS.map((fighter) => fighter.modelUrl)
}
