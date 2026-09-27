'use client'

import { useEffect, useMemo } from 'react'
import { useGLTF, useTexture } from '@react-three/drei'
import * as THREE from 'three'
import { GARAGE } from '../../ps1/theme'
import { configurePs1Texture, createPs1Material } from './Ps1Material'
import {
  SCENERY_MODELS,
  SCENERY_PROPS,
  applyPs1Materials,
  normaliseProp,
} from './sceneryCatalogue'
import {
  makeBannerTexture,
  makeBrickTexture,
  makeHazardSignTexture,
  makeRollerDoorTexture,
} from './garageTextures'

// The workshop behind the car on the select screen.
//
// A brick wall with a roller door in it, a sponsor rail along the top, a
// pavement and a stretch of concrete for the car to stand on, and two props
// from the trackside packs so the place looks used. The same shader as the
// circuit, the same fog uniforms, the same 15-bit crush — the car in front of
// it is the car from the track, and a backdrop drawn in a different register
// would make it look like a cut-out.
//
// Nothing here is a model. Walls and doors are planes and boxes with painted
// pages, which is exactly what they were in the source games, and the whole
// room is under thirty triangles before the props.

/** Where the wall stands, behind the turntable's origin. */
const WALL_Z = -2.6
const WALL_WIDTH = 18
const WALL_HEIGHT = 3.8
/** Bricks per world unit: a 0.5m tile, so a course is a little over 12cm. */
const BRICK_UV_SCALE = 2

const DOOR_WIDTH = 3.2
const DOOR_HEIGHT = 2.4
const DOOR_DEPTH = 2.2
/** The rolled door: a drum across the top of the opening. */
const DRUM_SIZE = 0.42

const BANNER_WIDTH = 12
const BANNER_HEIGHT = 0.8
const BANNER_Y = 3.05
/** A hair in front of the wall, so the rail never fights the bricks. */
const SURFACE_LIFT = 0.04

const SIGN_SIZE = 0.5
const SIGN_POSITION: readonly [number, number] = [3.1, 1.75]

const PAVEMENT_DEPTH = 1.0
const PAVEMENT_HEIGHT = 0.12
const FLOOR_WIDTH = 26
const FLOOR_DEPTH = 16
/** Concrete tiles per world unit. */
const FLOOR_UV_SCALE = 0.5
const CONCRETE_URL = '/ps1/textures/concrete.png'

/** Lifts the wall out of the side-lit lighting model, which leaves a face
 * pointing at the camera nearly black. */
const WALL_AMBIENT = 0.62
const RECESS_COLOR = '#0e0e12'

interface PropPlacement {
  readonly node: string
  readonly position: readonly [number, number, number]
  readonly rotationY: number
}

/** Two props from the trackside catalogue, stood where a workshop keeps them. */
const PROPS: ReadonlyArray<PropPlacement> = [
  { node: 'BarrelOil', position: [2.35, 0, -1.95], rotationY: 0.4 },
  { node: 'Tires', position: [-2.75, 0, -1.85], rotationY: -0.3 },
]

/**
 * The props, pulled from the same packs the circuit uses and normalised the
 * same way. Suspends on the pack loads; the wall does not wait for them.
 */
function GarageProps(): React.ReactElement {
  const industrial = useGLTF(SCENERY_MODELS.industrial)

  const built = useMemo(() => {
    const objects: Array<{ readonly key: string; readonly object: THREE.Object3D }> = []
    const materials: THREE.Material[] = []
    for (const placement of PROPS) {
      const prop = SCENERY_PROPS.find((candidate) => candidate.node === placement.node)
      if (!prop) continue
      const normalised = normaliseProp(industrial.scene, prop)
      if (!normalised) continue
      materials.push(...applyPs1Materials(normalised))
      normalised.position.set(...placement.position)
      normalised.rotation.y = placement.rotationY
      objects.push({ key: placement.node, object: normalised })
    }
    return { objects, materials }
  }, [industrial.scene])

  useEffect(() => {
    const created = built.materials
    return () => {
      for (const material of created) material.dispose()
    }
  }, [built])

  return (
    <group>
      {built.objects.map((entry) => (
        <primitive key={entry.key} object={entry.object} />
      ))}
    </group>
  )
}

export function Garage(): React.ReactElement {
  const concrete = useTexture(CONCRETE_URL)

  const pages = useMemo(
    () => ({
      brick: makeBrickTexture(),
      door: makeRollerDoorTexture(),
      banner: makeBannerTexture(),
      sign: makeHazardSignTexture(),
      concrete: configurePs1Texture(concrete),
    }),
    [concrete],
  )

  const materials = useMemo(
    () => ({
      brick: createPs1Material({
        color: '#ffffff',
        map: pages.brick,
        worldUvScale: BRICK_UV_SCALE,
        ambient: WALL_AMBIENT,
      }),
      door: createPs1Material({ color: '#ffffff', map: pages.door, ambient: WALL_AMBIENT }),
      recess: createPs1Material({ color: RECESS_COLOR, ambient: 0.4, side: THREE.BackSide }),
      banner: createPs1Material({ color: '#ffffff', map: pages.banner, ambient: 0.8 }),
      sign: createPs1Material({ color: '#ffffff', map: pages.sign, alphaTest: 0.5, ambient: 0.8 }),
      pavement: createPs1Material({ color: GARAGE.kerb, ambient: 0.55 }),
      floor: createPs1Material({
        color: GARAGE.floor,
        map: pages.concrete,
        worldUvScale: FLOOR_UV_SCALE,
        tint: 0.55,
        ambient: 0.6,
      }),
    }),
    [pages],
  )

  // Both the pages and the programs are made here, so both are reclaimed
  // here. The concrete texture belongs to the loader cache and is left alone.
  useEffect(() => {
    return () => {
      for (const material of Object.values(materials)) material.dispose()
      pages.brick.dispose()
      pages.door.dispose()
      pages.banner.dispose()
      pages.sign.dispose()
    }
  }, [materials, pages])

  const sideWidth = (WALL_WIDTH - DOOR_WIDTH) / 2
  const sideCentre = DOOR_WIDTH / 2 + sideWidth / 2
  const lintelHeight = WALL_HEIGHT - DOOR_HEIGHT

  return (
    <group>
      {/* The wall, in three pieces around the door. World-projected bricks,
          so the courses run straight through the joins. */}
      <mesh position={[-sideCentre, WALL_HEIGHT / 2, WALL_Z]} material={materials.brick}>
        <planeGeometry args={[sideWidth, WALL_HEIGHT]} />
      </mesh>
      <mesh position={[sideCentre, WALL_HEIGHT / 2, WALL_Z]} material={materials.brick}>
        <planeGeometry args={[sideWidth, WALL_HEIGHT]} />
      </mesh>
      <mesh position={[0, DOOR_HEIGHT + lintelHeight / 2, WALL_Z]} material={materials.brick}>
        <planeGeometry args={[DOOR_WIDTH, lintelHeight]} />
      </mesh>

      {/* The bay behind the door: a box seen from inside. */}
      <mesh position={[0, DOOR_HEIGHT / 2, WALL_Z - DOOR_DEPTH / 2]} material={materials.recess}>
        <boxGeometry args={[DOOR_WIDTH, DOOR_HEIGHT, DOOR_DEPTH]} />
      </mesh>
      {/* The door, rolled up into its drum. */}
      <mesh
        position={[0, DOOR_HEIGHT - DRUM_SIZE / 2, WALL_Z + DRUM_SIZE / 2 + SURFACE_LIFT]}
        material={materials.door}
      >
        <boxGeometry args={[DOOR_WIDTH + 0.3, DRUM_SIZE, DRUM_SIZE]} />
      </mesh>

      {/* The sponsor rail. */}
      <mesh position={[0, BANNER_Y, WALL_Z + SURFACE_LIFT]} material={materials.banner}>
        <planeGeometry args={[BANNER_WIDTH, BANNER_HEIGHT]} />
      </mesh>
      {/* The sign. */}
      <mesh position={[SIGN_POSITION[0], SIGN_POSITION[1], WALL_Z + SURFACE_LIFT]} material={materials.sign}>
        <planeGeometry args={[SIGN_SIZE, SIGN_SIZE]} />
      </mesh>

      {/* Pavement along the wall, then the concrete the car stands on. */}
      <mesh position={[0, PAVEMENT_HEIGHT / 2, WALL_Z + PAVEMENT_DEPTH / 2]} material={materials.pavement}>
        <boxGeometry args={[FLOOR_WIDTH, PAVEMENT_HEIGHT, PAVEMENT_DEPTH]} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, WALL_Z + FLOOR_DEPTH / 2]} material={materials.floor}>
        <planeGeometry args={[FLOOR_WIDTH, FLOOR_DEPTH]} />
      </mesh>

      <GarageProps />
    </group>
  )
}
