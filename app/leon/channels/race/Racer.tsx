'use client'

import { Suspense, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { Kart } from './Kart'
import { sampleTrackInto, laneOffset } from './circuit'
import type { SimRacer } from './useRaceSim'

// One kart on the track. Reads its position straight from the mutable sim
// state each frame rather than from props, so the simulation can run at frame
// rate without React re-rendering anything.

interface RacerProps {
  readonly index: number
  readonly racersRef: React.RefObject<SimRacer[]>
  /** Colour and active flag come from React; position and speed do not. */
  readonly color: string
  readonly isActive: boolean
  /** Drop a .glb here to replace the procedural kart. */
  readonly modelUrl?: string
}

export function Racer({
  index,
  racersRef,
  color,
  isActive,
  modelUrl,
}: RacerProps): React.ReactElement {
  const groupRef = useRef<THREE.Group>(null)
  const position = useMemo(() => new THREE.Vector3(), [])
  const tangent = useMemo(() => new THREE.Vector3(), [])
  // Wheel spin needs speed every frame, but re-rendering on every velocity
  // change would defeat the point of the sim living in a ref. A mutable box
  // bridges the two: the frame loop writes it, Kart's own frame loop reads it.
  const speedBox = useMemo<{ value: number }>(() => ({ value: 0 }), [])

  useFrame(() => {
    const racer = racersRef.current?.[index]
    if (!racer || !groupRef.current) return

    sampleTrackInto(racer.t, laneOffset(racer.lane), position, tangent)
    groupRef.current.position.copy(position)
    // Karts sit flat and face along the tangent; no banking, because the
    // hardware's flat-shaded geometry never sold roll convincingly anyway.
    groupRef.current.rotation.y = Math.atan2(tangent.x, tangent.z)

    speedBox.value = racer.speed
  })

  return (
    <group ref={groupRef}>
      {modelUrl ? (
        <Suspense fallback={<Kart index={index} color={color} speedBox={speedBox} isActive={isActive} />}>
          <GltfKart url={modelUrl} />
        </Suspense>
      ) : (
        <Kart index={index} color={color} speedBox={speedBox} isActive={isActive} />
      )}
    </group>
  )
}

function GltfKart({ url }: { url: string }): React.ReactElement {
  const { scene } = useGLTF(url)
  const cloned = useMemo(() => scene.clone(), [scene])
  return <primitive object={cloned} />
}
