'use client'

import { useCallback, useEffect, useRef } from 'react'
import type { RacerState } from './types'

// The whole game. Deliberately one file, because the rules are the interesting
// part and they should be readable in one sitting.
//
// The core decision: position on track is *integrated from velocity*, never
// assigned from score. A kart's speed is its live burn rate, so it accelerates
// when someone starts working and coasts down when they stop. Nothing ever
// teleports, and nothing is faked — the only input is tokens per minute.

// Calibrated against a real day of bucket data on a ~215m circuit. The target
// is a 12-18s lap for someone working hard and ~45s for someone idling: fast
// enough that a passing glance shows movement, slow enough that overtakes are
// legible rather than a blur.
/** Tokens/min that maps to full speed. Above this, everyone looks the same. */
const REFERENCE_BURN_RATE = 25_000
/** Metres per second at REFERENCE_BURN_RATE. */
const MAX_SPEED = 18
/**
 * Even an idle kart rolls. A stationary kart reads as a broken screen, and the
 * standings channel already states idleness plainly — here it just means slow.
 */
const IDLE_SPEED = 4.5
/**
 * Compression exponent. Burn rates are wildly long-tailed — one person mid
 * agent-run can out-token an idle team by 50x. A square root keeps the whole
 * field on screen while preserving the ordering, which is what a spectator
 * actually reads.
 */
const SPEED_COMPRESSION = 0.5
/** Seconds for actual speed to converge on target. Karts have inertia. */
const SPEED_SMOOTHING = 2.4

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
}

export function burnRateToSpeed(tokensPerMin: number): number {
  if (tokensPerMin <= 0) return IDLE_SPEED
  const normalised = Math.min(1, tokensPerMin / REFERENCE_BURN_RATE)
  return IDLE_SPEED + Math.pow(normalised, SPEED_COMPRESSION) * (MAX_SPEED - IDLE_SPEED)
}

interface UseRaceSimOptions {
  readonly racers: ReadonlyArray<RacerState> | undefined
  readonly trackLength: number
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
export function useRaceSim({ racers, trackLength }: UseRaceSimOptions): RaceSim {
  const state = useRef<SimRacer[]>([])

  useEffect(() => {
    if (!racers) return
    const existing = new Map(state.current.map((racer) => [racer.key, racer]))

    state.current = racers.map((racer, index) => {
      const previous = existing.get(racer.key)
      const targetSpeed = burnRateToSpeed(racer.velocityTokensPerMin)

      if (previous) {
        // Retarget only. Position and lap survive the update, which is what
        // stops a kart from jumping when the server re-ranks the grid.
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
        // apart on a 215m lap: enough that the onboard camera has clear air
        // behind its subject, while the field still reads as a pack.
        t: (index * 0.024) % 1,
        lap: 0,
        speed: 0,
        targetSpeed,
        score: racer.score,
        rank: racer.rank,
        velocityTokensPerMin: racer.velocityTokensPerMin,
        isActive: racer.isActive,
      }
    })
  }, [racers])

  const step = useCallback(
    (delta: number): void => {
      // Clamp: a backgrounded tab resumes with a huge delta, which would fling
      // every kart several laps forward in a single frame.
      const dt = Math.min(delta, 0.1)
      for (const racer of state.current) {
        const blend = 1 - Math.exp(-dt / SPEED_SMOOTHING)
        racer.speed += (racer.targetSpeed - racer.speed) * blend

        const advanced = racer.t + (racer.speed * dt) / trackLength
        if (advanced >= 1) racer.lap += Math.floor(advanced)
        racer.t = advanced % 1
      }
    },
    [trackLength],
  )

  return { racers: state, step }
}
