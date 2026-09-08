'use client'

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { createPs1Material } from './Ps1Material'
import { useCircuit } from './CircuitContext'
import { TrackModel } from './TrackModel'
import type { TrackSurface } from './tracks/types'

// The circuit's surface, by whichever of the two routes the track takes.
//
// An imported track hands the whole job to TrackModel: its road, kerbs,
// barriers and ground are all in the model, and the spline exists only to
// drive the karts along them. Everything below this line is the other route —
// the procedural circuit, whose road is generated from the same spline the
// cars follow, so the two cannot disagree.
//
// Segment counts are chosen to be low: the vertex-snapping shader turns dense
// geometry into visual noise, so a coarse mesh genuinely looks *more* correct.

const ROAD_SEGMENTS = 140
const KERB_SEGMENTS = 70
const PILLAR_COUNT = 18
/** Enough that per-vertex fog has something to interpolate across. */
const GROUND_SEGMENTS = 40

export function Track(): React.ReactElement {
  const circuit = useCircuit()

  if (circuit.definition.model) {
    return <TrackModel definition={circuit.definition} />
  }
  return <ProceduralTrack />
}

function ProceduralTrack(): React.ReactElement {
  const circuit = useCircuit()
  const { surfaces } = circuit.definition

  const geometries = useMemo(
    () => ({
      road: circuit.buildRoadGeometry(ROAD_SEGMENTS),
      // Kerbs sit just proud of the tarmac so they read as a rim rather than
      // as paint. Height clears the road plane to avoid z-fighting outright.
      kerbLeft: circuit.buildKerbGeometry(KERB_SEGMENTS, -1, 0.75, 0.09),
      kerbRight: circuit.buildKerbGeometry(KERB_SEGMENTS, 1, 0.75, 0.09),
    }),
    [circuit],
  )

  // Colours come from the track definition rather than from constants here,
  // so one file holds the palette for every circuit the channel can run.
  const materials = useMemo(
    () => ({
      road: surfaceMaterial(surfaces.road),
      kerb: surfaceMaterial(surfaces.kerb),
      ground: surfaceMaterial(surfaces.ground),
      pillar: surfaceMaterial(surfaces.pillar),
      startLine: surfaceMaterial(surfaces.startLine),
    }),
    [surfaces],
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
        const side = i % 2 === 0 ? 1 : -1
        const { position } = circuit.sample(i / PILLAR_COUNT, (circuit.halfWidth + 3.4) * side)
        return { key: `pillar-${i}`, position, height: 2.4 + (i % 3) * 0.8 }
      }),
    [circuit],
  )

  const startFrame = useMemo(() => circuit.sample(0, 0), [circuit])

  return (
    <group>
      <mesh geometry={geometries.road} material={materials.road} />
      <mesh geometry={geometries.kerbLeft} material={materials.kerb} />
      <mesh geometry={geometries.kerbRight} material={materials.kerb} />

      {/* Ground plane, just below the road so z-fighting is impossible while
          the drop still reads as a kerb height rather than a cliff.

          Subdivided rather than a single quad: fog is a per-vertex value in
          this shader, so a four-corner plane samples it only at corners 280m
          out — all four fully fogged — and the whole infield renders flat fog
          colour right up to the camera's feet. The segments are what let the
          ground near the car actually be the ground's own colour. */}
      <mesh material={materials.ground} rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.12, 0]}>
        <planeGeometry args={[400, 400, GROUND_SEGMENTS, GROUND_SEGMENTS]} />
      </mesh>

      {/* Start/finish line */}
      <mesh
        material={materials.startLine}
        position={[startFrame.position.x, 0.02, startFrame.position.z]}
        rotation={[-Math.PI / 2, 0, -Math.atan2(startFrame.tangent.x, startFrame.tangent.z)]}
      >
        <planeGeometry args={[circuit.halfWidth * 2, 0.7]} />
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

function surfaceMaterial(surface: TrackSurface | undefined): THREE.ShaderMaterial {
  return createPs1Material({
    color: surface?.color ?? '#9a9ab5',
    ambient: surface?.ambient,
    emissive: surface?.emissive,
    side: surface?.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  })
}
