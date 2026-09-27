'use client'

import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useCircuit } from './CircuitContext'
import type { GhostSample } from '../../control/types'
import type { SimRacer } from './useRaceSim'

// Your best lap, as a car you can see through.
//
// Not a model: a wire box the size of a kart, which is both how the era drew
// a ghost when it had no spare polygons and the clearest possible statement
// that this is a trace, not a rival. It replays from the moment you cross
// the line, so being ahead of it means being ahead of yourself.

const GHOST_SIZE: readonly [number, number, number] = [1.7, 0.85, 3.5]
const GHOST_LIFT = 0.55

interface GhostCarProps {
  readonly samples: ReadonlyArray<GhostSample>
  readonly racersRef: React.RefObject<SimRacer[]>
  /** The driven car's key; the ghost runs off its lap clock. */
  readonly drivenKey: string | null
}

/** The sample for a moment into the lap, interpolated between neighbours. */
function sampleAt(samples: ReadonlyArray<GhostSample>, seconds: number, intervalS: number): GhostSample | null {
  if (samples.length === 0) return null
  const position = seconds / intervalS
  const index = Math.floor(position)
  if (index >= samples.length - 1) return null
  const a = samples[index]
  const b = samples[index + 1]
  const mix = position - index
  let gap = b.t - a.t
  if (gap < -0.5) gap += 1
  return {
    t: (a.t + gap * mix + 1) % 1,
    l: a.l + (b.l - a.l) * mix,
    y: a.y + (b.y - a.y) * mix,
  }
}

const SAMPLE_INTERVAL_S = 0.1

export function GhostCar({ samples, racersRef, drivenKey }: GhostCarProps): React.ReactElement {
  const circuit = useCircuit()
  const group = useRef<THREE.Group>(null)
  const position = useMemo(() => new THREE.Vector3(), [])
  const tangent = useMemo(() => new THREE.Vector3(), [])
  const geometry = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(...GHOST_SIZE)), [])
  const material = useMemo(
    () => new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55 }),
    [],
  )

  useFrame(() => {
    const mesh = group.current
    if (!mesh) return
    const racer = drivenKey ? racersRef.current?.find((candidate) => candidate.key === drivenKey) : undefined
    const sample = racer ? sampleAt(samples, racer.lapClock, SAMPLE_INTERVAL_S) : null
    if (!racer || !sample) {
      mesh.visible = false
      return
    }
    mesh.visible = true
    circuit.sampleInto(sample.t, sample.l, position, tangent)
    mesh.position.set(position.x, position.y + GHOST_LIFT, position.z)
    mesh.rotation.set(0, Math.atan2(tangent.x, tangent.z) + sample.y, 0)
  })

  return (
    <group ref={group} visible={false}>
      <lineSegments geometry={geometry} material={material} />
    </group>
  )
}
