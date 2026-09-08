'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useLoader } from '@react-three/fiber'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import * as THREE from 'three'
import { createPs1Material, configurePs1Texture } from './Ps1Material'
import { normaliseCarGeometry, SHADOW_TEXTURE_URL } from './cars'
import { useCircuit } from './CircuitContext'

// The rest of the pack, parked trackside.
//
// Only as many cars race as there are drivers, so on a quiet day half the
// pack's models — and all of its special liveries — would never appear. They
// stand at the verge instead: the police car, the taxi, the mail van, the
// models the grid hasn't reached. Spectator furniture, the way every circuit
// of the era dressed its infield with vehicles that never moved.
//
// Static on purpose. They keep their baked wheels (a parked wheel does not
// turn), never simulate, and never re-render — five extra draw calls that
// cost the frame nothing.

interface ParkedSpot {
  readonly objUrl: string
  readonly textureUrl: string
  /** Normalised lap position of the parking spot. */
  readonly t: number
  /** Which verge, and how far beyond the kerb. Far enough out that the
      trackside cameras — which stand on the same verge — never spawn inside
      a parked roof. */
  readonly side: -1 | 1
  readonly margin: number
  /** Parked slightly askew, radians. Nothing human parks at exactly 0. */
  readonly skew: number
}

/**
 * Spots are fixed fractions of the lap, so they land sensibly on any circuit
 * the channel loads — spread out, never bunched at the start line.
 */
const SPOTS: ReadonlyArray<ParkedSpot> = [
  {
    objUrl: '/ps1/cars/car5_police.obj',
    textureUrl: '/ps1/cars/variants/car5_police.png',
    t: 0.13,
    side: 1,
    margin: 4.4,
    skew: 0.18,
  },
  {
    objUrl: '/ps1/cars/car5_taxi.obj',
    textureUrl: '/ps1/cars/variants/car5_taxi.png',
    t: 0.34,
    side: -1,
    margin: 3.8,
    skew: -0.4,
  },
  {
    objUrl: '/ps1/cars/car6.obj',
    textureUrl: '/ps1/cars/car6.png',
    t: 0.52,
    side: 1,
    margin: 4.8,
    skew: Math.PI + 0.25,
  },
  {
    objUrl: '/ps1/cars/car7.obj',
    textureUrl: '/ps1/cars/variants/car7_green.png',
    t: 0.71,
    side: -1,
    margin: 4.0,
    skew: 0.55,
  },
  {
    objUrl: '/ps1/cars/car8.obj',
    textureUrl: '/ps1/cars/variants/Car8_mail.png',
    t: 0.88,
    side: 1,
    margin: 4.6,
    skew: -0.15,
  },
]

// Larger than the car, because the blob fades inside its own page rather
// than filling it. Kept in step with SHADOW_WIDTH/SHADOW_LENGTH in Kart.tsx —
// a parked car with a visibly bigger shadow than a moving one reads as a
// different kind of object.
const SHADOW_PLANE = new THREE.PlaneGeometry(1.82, 2.98)

export function ParkedCars(): React.ReactElement {
  return (
    <>
      {SPOTS.map((spot) => (
        <ParkedCar key={spot.objUrl + spot.t} spot={spot} />
      ))}
    </>
  )
}

function ParkedCar({ spot }: { readonly spot: ParkedSpot }): React.ReactElement | null {
  const circuit = useCircuit()
  const loaded = useLoader(OBJLoader, spot.objUrl)
  const texture = useLoader(THREE.TextureLoader, spot.textureUrl)
  const shadowTexture = useLoader(THREE.TextureLoader, SHADOW_TEXTURE_URL)

  const geometry = useMemo(() => {
    const mesh = loaded.children.find(
      (child): child is THREE.Mesh => (child as THREE.Mesh).isMesh,
    )
    return mesh ? normaliseCarGeometry(mesh.geometry) : null
  }, [loaded])

  const material = useMemo(
    () =>
      createPs1Material({
        color: '#ffffff',
        map: configurePs1Texture(texture),
        tint: 0,
        ambient: 0.55,
      }),
    [texture],
  )

  const shadowMaterial = useMemo(() => {
    const created = createPs1Material({
      color: '#000000',
      map: configurePs1Texture(shadowTexture),
      // Blended low-opacity steps, same as the racing cars — see Kart.tsx.
      blend: true,
      alphaTest: 0.02,
    })
    created.polygonOffset = true
    created.polygonOffsetFactor = -2
    return created
  }, [shadowTexture])

  useEffect(() => {
    return () => {
      material.dispose()
      shadowMaterial.dispose()
      geometry?.dispose()
    }
  }, [material, shadowMaterial, geometry])

  // Computed once per circuit: parked means parked. The height is provisional
  // — the verge on a mountain circuit is not at road height — and is settled
  // by one raycast against the loaded world; see the frame hook below.
  const placement = useMemo(() => {
    const frame = circuit.sample(spot.t, spot.side * (circuit.halfWidth + spot.margin))
    const heading = Math.atan2(frame.tangent.x, frame.tangent.z) + spot.skew
    return { position: frame.position, heading }
  }, [circuit, spot])

  const groupRef = useRef<THREE.Group>(null)
  const grounded = useRef(false)
  const raycaster = useMemo(() => {
    const caster = new THREE.Raycaster()
    caster.ray.direction.set(0, -1, 0)
    return caster
  }, [])

  // Runs each frame until the ground answers once, then never again. It has
  // to be a retry loop rather than a mount effect because the track model
  // loads on its own schedule, and a ray cast before the tarmac exists
  // reports the car should stand at the bottom of the world.
  useFrame(({ scene }) => {
    const group = groupRef.current
    if (!group || grounded.current) return

    raycaster.ray.origin.set(placement.position.x, placement.position.y + 120, placement.position.z)
    const hits = raycaster.intersectObjects(scene.children, true)
    for (const hit of hits) {
      // The first hit that is not this car itself (a ray from overhead passes
      // straight through our own roof first).
      let ancestor: THREE.Object3D | null = hit.object
      let isSelf = false
      while (ancestor) {
        if (ancestor === group) {
          isSelf = true
          break
        }
        ancestor = ancestor.parent
      }
      if (isSelf) continue
      group.position.y = hit.point.y + 0.02
      grounded.current = true
      return
    }
  })

  if (!geometry) return null

  return (
    <group
      ref={groupRef}
      position={[placement.position.x, placement.position.y, placement.position.z]}
      rotation={[0, placement.heading, 0]}
    >
      <mesh geometry={geometry} material={material} />
      <mesh
        geometry={SHADOW_PLANE}
        material={shadowMaterial}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, 0.02, 0]}
      />
    </group>
  )
}
