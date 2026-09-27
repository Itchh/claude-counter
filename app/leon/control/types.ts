// The contract between a screen and its simulations for taking the wheel.
//
// A simulation never talks to the server. It reads one mutable link object
// every frame: who this screen is driving, what their hands are doing, and
// where the entities other screens are driving have got to. The link is
// mutated in place by the hooks in this folder, for the same reason the sims
// keep their state in refs — none of this may re-render React at frame rate.

export type ControlGame = 'race' | 'fight' | 'dogfight'
export type ControlMode = 'auto' | 'driven' | 'remote'

export interface ControlInput {
  /** 0..1. */
  throttle: number
  /** 0..1. */
  brake: number
  /** -1 left .. 1 right. */
  steer: number
  /** -1 dive .. 1 climb. */
  pitch: number
  boost: boolean
  fire: boolean
  block: boolean
  /** Edge-triggered: set on the press, cleared by whoever acts on it. */
  punch: boolean
  kick: boolean
}

export function createControlInput(): ControlInput {
  return {
    throttle: 0,
    brake: 0,
    steer: 0,
    pitch: 0,
    boost: false,
    fire: false,
    block: false,
    punch: false,
    kick: false,
  }
}

// Mirrors of the pose validators in convex/schema.ts. Written by hand rather
// than inferred, because the schema file imports the auth server library and
// has no business in a browser bundle.
export interface RacePose {
  readonly game: 'race'
  readonly t: number
  readonly lap: number
  readonly lateral: number
  readonly yaw: number
  readonly steer: number
  readonly speed: number
  readonly driftLoad: number
  readonly crashTimer: number
  readonly crashDuration: number
  readonly crashRolls: number
  readonly crashSpin: number
  readonly bumpCount: number
  readonly wallCount: number
  readonly crashCount: number
  readonly impactT: number
  readonly impactLateral: number
  readonly boosting: boolean
}

export interface FightPose {
  readonly game: 'fight'
  readonly x: number
  readonly action: string
  readonly actionT: number
  readonly hp: number
  readonly trail: number
}

export interface DogfightPose {
  readonly game: 'dogfight'
  readonly x: number
  readonly y: number
  readonly z: number
  readonly heading: number
  readonly pitch: number
  readonly bank: number
  readonly speed: number
  readonly mode: string
  readonly hp: number
  readonly kills: number
  readonly firing: boolean
}

export type AnyPose = RacePose | FightPose | DogfightPose

export interface RemoteEntity<P> {
  readonly holderName: string
  readonly pose: P | null
  readonly seq: number
  readonly sentAt: number
  readonly expiresAt: number
}

/** One sample of a driven lap, a tenth of a second apart. */
export interface GhostSample {
  readonly t: number
  readonly l: number
  readonly y: number
}

export interface NitroState {
  /** Seconds of boost left in the bank. The race sim drains it. */
  charge: number
  /** True on the frames the boost is actually burning. */
  lit: boolean
}

export interface DriveLink<P> {
  drivenKey: string | null
  readonly input: ControlInput
  remotes: ReadonlyMap<string, RemoteEntity<P>>
  readonly nitro: NitroState
  /** Race only: a driven lap just completed. */
  onLap: ((lapSeconds: number, samples: ReadonlyArray<GhostSample>) => void) | null
}

export function createDriveLink<P>(): DriveLink<P> {
  return {
    drivenKey: null,
    input: createControlInput(),
    remotes: new Map(),
    nitro: { charge: 0, lit: false },
    onLap: null,
  }
}

/**
 * How stale a lease may look before a screen stops believing it. Generous,
 * because it is compared against this machine's clock rather than the
 * server's, and a laptop can be a few seconds out.
 */
export const LEASE_GRACE_MS = 5_000

export function isRemoteLive<P>(remote: RemoteEntity<P> | undefined, now: number): remote is RemoteEntity<P> & { pose: P } {
  return remote !== undefined && remote.pose !== null && remote.expiresAt > now - LEASE_GRACE_MS
}
