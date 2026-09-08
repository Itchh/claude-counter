'use client'

import { useEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useCircuit } from './CircuitContext'
import { speedFraction, type SimRacer } from './useRaceSim'

// The broadcast's sound, from the pack's own effects.
//
// Muted by default and armed only by the speaker chip in the HUD — an office
// screen that starts talking uninvited gets unplugged, and the browser would
// have blocked the autoplay anyway. The chip click is the user gesture that
// makes an AudioContext legal, which is why the engine is built lazily inside
// the first enable rather than on mount.
//
// The mix is a broadcast mix, not a simulation: every car runs an engine
// loop, but gain falls off with distance to the camera so you mostly hear the
// car the director is on, pitch rides the car's actual speed, and the events
// — horn on contact, starter motor when a driver comes back to work, the
// engine dying when they stop — are cut from the same simulation numbers
// everything else on this channel reads.

const SOUND_BASE = '/ps1/sounds'

/** The engine loops, dealt round-robin so neighbours never share a voice. */
const ENGINE_LOOPS = ['Car_Engine_Loop', 'Car2_Engine_Loop', 'Car_Engine_Loop_2'] as const
const STARTUPS = ['Car_Engine_Start_Up', 'Car2_Engine_Start_Up'] as const
const SHUTDOWNS = ['Car_Engine_Turning_Off', 'Car2_Engine_Turning_Off'] as const
const ACCELERATIONS = ['Car_Acceleration', 'Car_Acceleration_2'] as const
const HORN = 'Car_Horn'

/** Nobody's ears are the priority on a wall screen. */
const MASTER_GAIN = 0.5
/** Beyond this many track units from the camera, a car is silent. */
const AUDIBLE_RANGE = 70
/** Engine pitch range across the speed range. */
const RATE_IDLE = 0.55
const RATE_SPAN = 1.0
/** Seconds between horns from one car, however hard it is being hit. */
const HORN_COOLDOWN = 1.2
/** Burn-rate step up that reads as "flooring it", tokens/min. */
const ACCELERATION_JUMP = 12_000

interface Voice {
  readonly source: AudioBufferSourceNode
  readonly gain: GainNode
}

/**
 * Everything Web Audio, behind five methods, so the React component stays a
 * frame loop and an event diff. Plain class rather than hooks: an
 * AudioContext's lifetime is not a render lifetime.
 */
class AudioEngine {
  private readonly context: AudioContext
  private readonly master: GainNode
  private readonly buffers = new Map<string, AudioBuffer>()
  private readonly voices = new Map<string, Voice>()
  private readonly hornAt = new Map<string, number>()
  private disposed = false

  constructor() {
    this.context = new AudioContext()
    this.master = this.context.createGain()
    this.master.gain.value = MASTER_GAIN
    this.master.connect(this.context.destination)

    const names = [...ENGINE_LOOPS, ...STARTUPS, ...SHUTDOWNS, ...ACCELERATIONS, HORN]
    for (const name of names) void this.load(name)
  }

  private async load(name: string): Promise<AudioBuffer | null> {
    const existing = this.buffers.get(name)
    if (existing) return existing
    try {
      const response = await fetch(`${SOUND_BASE}/${name}.ogg`)
      const decoded = await this.context.decodeAudioData(await response.arrayBuffer())
      if (this.disposed) return null
      this.buffers.set(name, decoded)
      return decoded
    } catch (error) {
      // A missing sample mutes one effect, not the channel. Logged once per
      // name because the load is only attempted once per name.
      console.warn(`RaceAudio: could not load ${name}.ogg`, error)
      return null
    }
  }

  resume(): void {
    if (this.context.state === 'suspended') void this.context.resume()
  }

  suspend(): void {
    if (this.context.state === 'running') void this.context.suspend()
  }

  /** Keeps one engine loop per live racer, and retires voices for the departed. */
  syncVoices(racers: ReadonlyArray<SimRacer>): void {
    const alive = new Set(racers.map((racer) => racer.key))
    for (const [key, voice] of this.voices) {
      if (!alive.has(key)) {
        voice.source.stop()
        this.voices.delete(key)
      }
    }
    racers.forEach((racer, index) => {
      if (this.voices.has(racer.key)) return
      const buffer = this.buffers.get(ENGINE_LOOPS[index % ENGINE_LOOPS.length])
      if (!buffer) return
      const source = this.context.createBufferSource()
      source.buffer = buffer
      source.loop = true
      const gain = this.context.createGain()
      gain.gain.value = 0
      source.connect(gain)
      gain.connect(this.master)
      source.start()
      this.voices.set(racer.key, { source, gain })
    })
  }

  setVoice(key: string, gain: number, rate: number): void {
    const voice = this.voices.get(key)
    if (!voice) return
    // Smoothed by the node itself; a hard set every frame zipper-clicks.
    voice.gain.gain.setTargetAtTime(gain, this.context.currentTime, 0.08)
    voice.source.playbackRate.setTargetAtTime(rate, this.context.currentTime, 0.08)
  }

  /** One-shot, at a gain and a pitch. Fire and forget. */
  private shot(name: string, gain: number, rate: number): void {
    const buffer = this.buffers.get(name)
    if (!buffer) return
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = rate
    const node = this.context.createGain()
    node.gain.value = gain
    source.connect(node)
    node.connect(this.master)
    source.start()
  }

  horn(key: string, index: number, gain: number): void {
    const now = this.context.currentTime
    if (now - (this.hornAt.get(key) ?? -Infinity) < HORN_COOLDOWN) return
    this.hornAt.set(key, now)
    // Every car's horn sits at its own pitch, so a two-car shunt is a chord.
    this.shot(HORN, gain, 0.9 + (index % 5) * 0.07)
  }

  startup(index: number, gain: number): void {
    this.shot(STARTUPS[index % STARTUPS.length], gain, 1)
  }

  shutdown(index: number, gain: number): void {
    this.shot(SHUTDOWNS[index % SHUTDOWNS.length], gain, 1)
  }

  accelerate(index: number, gain: number): void {
    this.shot(ACCELERATIONS[index % ACCELERATIONS.length], gain, 1)
  }

  dispose(): void {
    this.disposed = true
    for (const voice of this.voices.values()) voice.source.stop()
    this.voices.clear()
    void this.context.close()
  }
}

interface RaceAudioProps {
  readonly racersRef: React.RefObject<SimRacer[]>
  /** True only while the channel is live AND the viewer has armed sound. */
  readonly enabled: boolean
}

export function RaceAudio({ racersRef, enabled }: RaceAudioProps): null {
  const circuit = useCircuit()
  const engine = useRef<AudioEngine | null>(null)
  const lastActive = useRef<Map<string, boolean>>(new Map())
  const lastBurn = useRef<Map<string, number>>(new Map())
  const lastBumps = useRef<Map<string, number>>(new Map())

  // Built on first enable — that enable came from a click, which is what
  // makes the context start un-suspended.
  useEffect(() => {
    if (enabled && !engine.current) engine.current = new AudioEngine()
    if (enabled) engine.current?.resume()
    else engine.current?.suspend()
  }, [enabled])

  useEffect(() => {
    return () => {
      engine.current?.dispose()
      engine.current = null
    }
  }, [])

  const position = useRef(new THREE.Vector3())
  const tangent = useRef(new THREE.Vector3())

  useFrame((state) => {
    const audio = engine.current
    if (!audio || !enabled) return
    const racers = racersRef.current ?? []
    audio.syncVoices(racers)

    for (let index = 0; index < racers.length; index++) {
      const racer = racers[index]
      circuit.sampleInto(racer.t, racer.lateral, position.current, tangent.current)
      const distance = position.current.distanceTo(state.camera.position)
      const proximity = Math.max(0, 1 - distance / AUDIBLE_RANGE)
      // Squared: linear falloff keeps the whole field murmuring at once, and
      // the broadcast wants the subject car in front of the mix.
      const closeness = proximity * proximity

      audio.setVoice(
        racer.key,
        closeness * 0.55,
        RATE_IDLE + speedFraction(racer.speed) * RATE_SPAN + (index % 4) * 0.04,
      )

      // --- events, by diffing the same counters the visuals use ------------
      const bumps = racer.bumpCount
      const seenBumps = lastBumps.current.get(racer.key)
      if (seenBumps !== undefined && bumps > seenBumps) {
        audio.horn(racer.key, index, Math.max(0.18, closeness))
      }
      lastBumps.current.set(racer.key, bumps)

      const wasActive = lastActive.current.get(racer.key)
      if (wasActive !== undefined && wasActive !== racer.isActive) {
        // A driver going quiet is an engine dying at the roadside; coming
        // back is a starter motor. Audible even off-camera — it is the single
        // most narrative sound the channel has.
        if (racer.isActive) audio.startup(index, Math.max(0.25, closeness))
        else audio.shutdown(index, Math.max(0.25, closeness))
      }
      lastActive.current.set(racer.key, racer.isActive)

      const burn = racer.velocityTokensPerMin
      const seenBurn = lastBurn.current.get(racer.key)
      if (seenBurn !== undefined && burn - seenBurn > ACCELERATION_JUMP) {
        audio.accelerate(index, Math.max(0.2, closeness))
      }
      lastBurn.current.set(racer.key, burn)
    }
  })

  return null
}
