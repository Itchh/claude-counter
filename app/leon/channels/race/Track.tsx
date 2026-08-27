'use client'

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { createPs1Material } from './Ps1Material'
import {
  buildKerbGeometry,
  buildRoadGeometry,
  sampleTrack,
  ROAD_HALF_WIDTH,
} from './circuit'
import { PS1 } from '../../ps1/theme'

// Road, kerbs, start line and trackside furniture. Segment counts are chosen
// to be low: the vertex-snapping shader turns dense geometry into visual noise,
// so a coarse mesh genuinely looks *more* correct here.

const ROAD_SEGMENTS = 140
const KERB_SEGMENTS = 70
const PILLAR_COUNT = 18

export function Track(): React.ReactElement {
  const geometries = useMemo(
    () => ({
      road: buildRoadGeometry(ROAD_SEGMENTS),
      // Kerbs sit just proud of the tarmac so they read as a rim rather than
      // as paint. Height clears the road plane to avoid z-fighting outright.
      kerbLeft: buildKerbGeometry(KERB_SEGMENTS, -1, 0.75, 0.09),
      kerbRight: buildKerbGeometry(KERB_SEGMENTS, 1, 0.75, 0.09),
    }),
    [],
  )

  const materials = useMemo(
    () => ({
      // The road has to out-read the void behind it or the karts float in
      // black. Lifted well above the ground plane's value, and fully ambient
      // because a flat surface gets no useful Gouraud variation anyway.
      road: createPs1Material({ color: '#5c5c8a', ambient: 1.0, side: THREE.DoubleSide }),
      kerb: createPs1Material({ color: PS1.hot, emissive: 0.35, side: THREE.DoubleSide }),
      // Kept clearly darker than the tarmac: the road must be the brightest
      // horizontal surface or the karts lose their stage.
      ground: createPs1Material({ color: '#101024', ambient: 1.0, side: THREE.DoubleSide }),
      pillar: createPs1Material({ color: PS1.cyan, emissive: 0.5 }),
      startLine: createPs1Material({ color: PS1.text, emissive: 0.6 }),
    }),
    [],
  )

  useEffect(() => {
    return () => {
      for (const geometry of Object.values(geometries)) geometry.dispose()
      for (const material of Object.values(materials)) material.dispose()
    }
  }, [geometries, materials])

  // Trackside pillars: the era's answer to a horizon. They give the vertex
  // wobble something vertical to be measured against.
  const pillars = useMemo(
    () =>
      Array.from({ length: PILLAR_COUNT }, (_, i) => {
        const t = i / PILLAR_COUNT
        const side = i % 2 === 0 ? 1 : -1
        const { position } = sampleTrack(t, (ROAD_HALF_WIDTH + 3.4) * side)
        return { key: `pillar-${i}`, position, height: 2.4 + (i % 3) * 0.8 }
      }),
    [],
  )

  const startFrame = useMemo(() => sampleTrack(0, 0), [])

  return (
    <group>
      <mesh geometry={geometries.road} material={materials.road} />
      <mesh geometry={geometries.kerbLeft} material={materials.kerb} />
      <mesh geometry={geometries.kerbRight} material={materials.kerb} />

      {/* Ground plane, just below the road so z-fighting is impossible while
          the drop still reads as a kerb height rather than a cliff. */}
      <mesh material={materials.ground} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.12, 0]}>
        <planeGeometry args={[400, 400]} />
      </mesh>

      {/* Start/finish line */}
      <mesh
        material={materials.startLine}
        position={[startFrame.position.x, 0.02, startFrame.position.z]}
        rotation={[-Math.PI / 2, 0, -Math.atan2(startFrame.tangent.x, startFrame.tangent.z)]}
      >
        <planeGeometry args={[ROAD_HALF_WIDTH * 2, 0.7]} />
      </mesh>

      {pillars.map((pillar) => (
        <mesh
          key={pillar.key}
          material={materials.pillar}
          position={[pillar.position.x, pillar.height / 2, pillar.position.z]}
        >
          <boxGeometry args={[0.35, pillar.height, 0.35]} />
        </mesh>
      ))}
    </group>
  )
}
