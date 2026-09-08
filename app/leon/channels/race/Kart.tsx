'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useLoader } from '@react-three/fiber'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import * as THREE from 'three'
import { createPs1Material, configurePs1Texture } from './Ps1Material'
import { carModelFor, liveryFor, WHEEL_MODEL, SHADOW_TEXTURE_URL } from './cars'
import { liveryShaderId } from '@/lib/livery'
import { splitCarGeometry, type WheelPlacement } from './carGeometry'
import { PS1 } from '../../ps1/theme'

// One car on the grid: a body, four live wheels, and a blob shadow.
//
// The wheels used to be part of the body mesh — the pack bakes them in — and
// that was defended here as the era's trade. It was the wrong defence: the
// pack also ships the wheel as its own model because the era's games DID spin
// their wheels, and carGeometry.ts can lift the baked ones out exactly. So
// now the wheels roll at the speed the car is actually doing and the front
// pair steers with the simulation's own steering angle, at a cost of four
// more matrices per car — the same trade the era resolved this way round.
//
// The shadow is the period's whole answer to shadows: a translucent blob on
// the road. No light, no projection, no shadow map. It does the one job a car
// shadow has at 288 pixels — gluing the car to the tarmac — for one quad, and
// its softness is a Bayer checkerboard rather than an alpha ramp, because the
// hardware faded things by dithering them.

/** Ride height dips by this much at full speed, in track units. */
const SQUAT_DEPTH = 0.06
/** Amplitude and rate of the road-surface shiver, scaled by speed. */
const SHIVER_HEIGHT = 0.02
const SHIVER_HZ = 18
/** Speed at which squat and shiver are fully on. */
const SPEED_REFERENCE = 12

/** The pack wheel's own rolling radius, measured from Wheel.obj. */
const WHEEL_MODEL_RADIUS = 0.4586

/**
 * Shadow card size relative to the car footprint, and its lift off the road.
 *
 * Grown from 1.55 x 2.75 when the blob stopped filling its page: the old mask
 * was opaque corner to corner, so the quad *was* the shadow. The stepped one
 * spends its outer fifth on the faintest band, so the card has to be a little
 * larger than the car for the darkest step to still sit under the sills.
 */
const SHADOW_WIDTH = 1.82
const SHADOW_LENGTH = 2.98
const SHADOW_HEIGHT = 0.02

export interface MotionBox {
  /** Metres per second. Written by Racer's frame loop. */
  value: number
  /** Front-wheel angle, radians. Same loop. */
  steer: number
}

interface KartProps {
  /** Picks the model. Stable per driver, so a car is an identity. */
  readonly index: number
  readonly color: string
  /**
   * The driver's chosen paint, set in the paint shop. Null means they have
   * never opened it, and the car keeps the pack's own page untouched — which
   * is the state every car on the grid starts in.
   */
  readonly paint?: string | null
  /** The pattern id from lib/livery.ts. */
  readonly livery?: string | null
  /** Mutable box written by the parent's frame loop. Never through React. */
  readonly speedBox: MotionBox
  readonly isActive: boolean
}

/**
 * How far a chosen paint respray takes the pack's own page.
 *
 * Short of 1 on purpose. The respray keeps the page's luminance and replaces
 * its hue (see uPaintMix in Ps1Material), so at 1 the glass and the lamps go
 * the colour of the bodywork too. Held here, a little of the artist's own
 * page shows through everywhere the paint is not — which is what stops eight
 * repainted cars looking like eight coloured toys.
 */
const PAINT_STRENGTH = 0.82

export function Kart({ index, color, paint = null, livery = null, speedBox, isActive }: KartProps): React.ReactElement {
  const bodyRef = useRef<THREE.Group>(null)
  const model = carModelFor(index)

  // All loaders cache by URL inside fiber, so the grid shares wheel geometry,
  // shadow texture, and any repeated body or livery. Suspends on first use —
  // Racer holds the boundary.
  const loaded = useLoader(OBJLoader, model.objUrl)
  // The pack's own livery nearest the driver's colour, exactly as painted —
  // the colour wash this replaced muddied every page it touched.
  const texture = useLoader(THREE.TextureLoader, liveryFor(index, paint ?? color))
  const wheelObj = useLoader(OBJLoader, WHEEL_MODEL.objUrl)
  const wheelTexture = useLoader(THREE.TextureLoader, WHEEL_MODEL.textureUrl)
  const shadowTexture = useLoader(THREE.TextureLoader, SHADOW_TEXTURE_URL)

  const split = useMemo(() => {
    const mesh = loaded.children.find(
      (child): child is THREE.Mesh => (child as THREE.Mesh).isMesh,
    )
    return mesh ? splitCarGeometry(mesh.geometry) : null
  }, [loaded])

  const wheelGeometry = useMemo(() => {
    const mesh = wheelObj.children.find(
      (child): child is THREE.Mesh => (child as THREE.Mesh).isMesh,
    )
    return mesh ? mesh.geometry : null
  }, [wheelObj])

  // The body's own box, measured once per chassis. The livery is painted
  // against it, so a pattern lands identically on a long car and a short one.
  const bodyBounds = useMemo(() => {
    if (!split) return new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1))
    split.body.computeBoundingBox()
    return split.body.boundingBox ?? new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1))
  }, [split])

  const material = useMemo(
    () =>
      createPs1Material({
        color: '#ffffff',
        map: configurePs1Texture(texture),
        // No tint. The respray below replaces the page's hue outright; a
        // multiply on top of it would only darken what it just set.
        tint: 0,
        livery: {
          pattern: liveryShaderId(livery),
          paint: paint ?? color,
          bounds: bodyBounds,
          paintStrength: paint === null ? 0 : PAINT_STRENGTH,
        },
        // A texture page already carries its own painted-in shading, so the
        // lighting model only has to keep the car from going flat.
        ambient: 0.62,
      }),
    [texture, paint, livery, color, bodyBounds],
  )

  const wheelMaterial = useMemo(
    () =>
      createPs1Material({
        color: '#ffffff',
        map: configurePs1Texture(wheelTexture),
        tint: 0,
        ambient: 0.62,
      }),
    [wheelTexture],
  )

  const shadowMaterial = useMemo(() => {
    const created = createPs1Material({
      color: '#000000',
      map: configurePs1Texture(shadowTexture),
      // Blended, because the page is three steps of low opacity rather than a
      // mask — the shadow darkens the tarmac instead of replacing it, which
      // is the whole difference between a shadow and a hole. The alpha test
      // is only there to throw away the empty corners of the card before they
      // cost a blend.
      blend: true,
      alphaTest: 0.02,
      emissive: 0,
    })
    // Sits a hair above the tarmac; the offset stops the two quads shimmering
    // against each other where the road's own jitter brings them together.
    created.polygonOffset = true
    created.polygonOffsetFactor = -2
    return created
  }, [shadowTexture])

  const markerMaterial = useMemo(
    () => createPs1Material({ color: PS1.gold, emissive: 0.9 }),
    [],
  )

  // ShaderMaterials and derived geometry are not reclaimed by three on their
  // own, and a driver dropping off the board would otherwise leak a compiled
  // program and a vertex buffer per car. The wheel geometry is NOT disposed:
  // it belongs to the loader's shared cache, and every other car on the grid
  // is drawing with it.
  useEffect(() => {
    return () => {
      material.dispose()
      wheelMaterial.dispose()
      shadowMaterial.dispose()
      markerMaterial.dispose()
      split?.body.dispose()
    }
  }, [material, wheelMaterial, shadowMaterial, markerMaterial, split])

  if (!split) return <group />

  return (
    <group>
      <group ref={bodyRef}>
        <BodyAndWheels
          index={index}
          split={split}
          material={material}
          wheelGeometry={wheelGeometry}
          wheelMaterial={wheelMaterial}
          speedBox={speedBox}
        />
      </group>

      {/* The blob. Outside the squat group: a shadow is where the car meets
          the road, so it must not dip and shiver with the bodywork. */}
      <mesh
        geometry={SHADOW_PLANE}
        material={shadowMaterial}
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, SHADOW_HEIGHT, 0]}
        scale={[SHADOW_WIDTH, SHADOW_LENGTH, 1]}
      />

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

/** One quad, shared by every shadow on the grid. */
const SHADOW_PLANE = new THREE.PlaneGeometry(1, 1)

function BodyAndWheels({
  index,
  split,
  material,
  wheelGeometry,
  wheelMaterial,
  speedBox,
}: {
  readonly index: number
  readonly split: { body: THREE.BufferGeometry; wheels: ReadonlyArray<WheelPlacement> }
  readonly material: THREE.Material
  readonly wheelGeometry: THREE.BufferGeometry | null
  readonly wheelMaterial: THREE.Material
  readonly speedBox: MotionBox
}): React.ReactElement {
  const groupRef = useRef<THREE.Group>(null)
  // Rolled distance accumulates here rather than deriving angle from position:
  // a wheel's angle is a history, and speed is the only honest input.
  const spin = useRef(0)

  useFrame((state, delta) => {
    const group = groupRef.current
    if (!group) return

    const dt = Math.min(delta, 0.1)
    // All wheels share one radius for the spin rate — per-wheel rates on a
    // 288p screen are indistinguishable, and one accumulator is one register.
    const radius = split.wheels[0]?.radius ?? WHEEL_MODEL_RADIUS
    spin.current = (spin.current + (speedBox.value / Math.max(radius, 0.05)) * dt) % (Math.PI * 2)

    for (const child of group.children) {
      const placement = split.wheels[Number(child.userData.wheel)]
      if (!placement) continue
      // Steer on the carrier, spin on the wheel inside it, so the two axes
      // compose in the right order: a steered wheel rolls about its own
      // turned axle, not the car's.
      child.rotation.y = placement.front ? speedBox.steer : 0
      const spinner = (child as THREE.Group).children[0]
      if (spinner) spinner.rotation.x = spin.current
    }

    // Squat and shiver, moved here from the parent so the wheels stay planted
    // while only the body works over the bumps.
    const body = group.getObjectByName('car-body')
    if (body) {
      const load = Math.min(1, speedBox.value / SPEED_REFERENCE)
      const shiver =
        Math.sin(state.clock.elapsedTime * SHIVER_HZ + index) * SHIVER_HEIGHT * load
      body.position.y = shiver - load * SQUAT_DEPTH
    }
  })

  return (
    <group ref={groupRef}>
      {split.wheels.map((placement, wheelIndex) => {
        if (!wheelGeometry) return null
        const scale = placement.radius / WHEEL_MODEL_RADIUS
        return (
          <group
            // Position is the placement, which is stable for the car's life.
            key={`wheel-${wheelIndex}`}
            userData={{ wheel: wheelIndex }}
            position={[placement.x, placement.y, placement.z]}
          >
            <mesh geometry={wheelGeometry} material={wheelMaterial} scale={scale} />
          </group>
        )
      })}
      <mesh name="car-body" geometry={split.body} material={material} />
    </group>
  )
}
