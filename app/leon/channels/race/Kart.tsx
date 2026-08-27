'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useLoader } from '@react-three/fiber'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import * as THREE from 'three'
import { createPs1Material, configurePs1Texture } from './Ps1Material'
import { carModelFor, normaliseCarGeometry, TINT_STRENGTH } from './cars'
import { PS1 } from '../../ps1/theme'

// One car on the grid: a loaded model, one texture page, one draw call.
//
// The wheels are part of the body mesh and part of the same texture page —
// look at the atlas and the tyre is up in the corner with the headlights. So
// they do not turn, and that is correct rather than a shortcut: separating
// them would mean four more draw calls and four more matrices per car, which
// is exactly the trade the era resolved the other way.
//
// Speed still has to read at this distance, so it is carried by ride height
// instead: a car under load sits down and shivers. The `speedBox` is written
// by the parent's frame loop and read here, so velocity never passes through
// React.

/** Ride height dips by this much at full speed, in track units. */
const SQUAT_DEPTH = 0.06
/** Amplitude and rate of the road-surface shiver, scaled by speed. */
const SHIVER_HEIGHT = 0.02
const SHIVER_HZ = 18
/** Speed at which squat and shiver are fully on. */
const SPEED_REFERENCE = 12

export interface SpeedBox {
  value: number
}

interface KartProps {
  /** Picks the model. Stable per driver, so a car is an identity. */
  readonly index: number
  readonly color: string
  /** Mutable box written by the parent's frame loop. Drives the ride height. */
  readonly speedBox: SpeedBox
  readonly isActive: boolean
}

export function Kart({ index, color, speedBox, isActive }: KartProps): React.ReactElement {
  const bodyRef = useRef<THREE.Group>(null)
  const model = carModelFor(index)

  // Both loaders cache by URL inside fiber, so eight racers sharing three
  // models load three times, not eight. Suspends on first use — Racer holds
  // the boundary.
  const loaded = useLoader(OBJLoader, model.objUrl)
  const texture = useLoader(THREE.TextureLoader, model.textureUrl)

  const geometry = useMemo(() => {
    const mesh = loaded.children.find(
      (child): child is THREE.Mesh => (child as THREE.Mesh).isMesh,
    )
    return mesh ? normaliseCarGeometry(mesh.geometry) : null
  }, [loaded])

  const material = useMemo(
    () =>
      createPs1Material({
        color,
        map: configurePs1Texture(texture),
        tint: TINT_STRENGTH,
        // A texture page already carries its own painted-in shading, so the
        // lighting model only has to keep the car from going flat. Lifting
        // ambient stops the unlit side crushing to black against the fog.
        ambient: 0.62,
      }),
    [color, texture],
  )

  const markerMaterial = useMemo(
    () => createPs1Material({ color: PS1.gold, emissive: 0.9 }),
    [],
  )

  // ShaderMaterials and cloned geometry are not reclaimed by three on their
  // own, and a driver dropping off the board would otherwise leak a compiled
  // program and a vertex buffer per car.
  useEffect(() => {
    return () => {
      material.dispose()
      markerMaterial.dispose()
      geometry?.dispose()
    }
  }, [material, markerMaterial, geometry])

  useFrame((state) => {
    if (!bodyRef.current) return
    const load = Math.min(1, speedBox.value / SPEED_REFERENCE)
    const shiver =
      Math.sin(state.clock.elapsedTime * SHIVER_HZ + index) * SHIVER_HEIGHT * load
    bodyRef.current.position.y = shiver - load * SQUAT_DEPTH
  })

  if (!geometry) return <group />

  return (
    <group>
      <group ref={bodyRef}>
        <mesh geometry={geometry} material={material} />
      </group>

      {isActive && (
        // The live marker. Emissive, so it survives the fog that everything
        // else fades into — it is the one thing on the car that has to be
        // readable from the establishing shot.
        <mesh material={markerMaterial} position={[0, 1.4, 0]}>
          <boxGeometry args={[0.22, 0.22, 0.22]} />
        </mesh>
      )}
    </group>
  )
}
