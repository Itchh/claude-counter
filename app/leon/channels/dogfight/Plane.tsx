'use client'

import { Suspense, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { RacerState } from '../race/types'
import { Airframe, type SpinBox } from './Airframe'
import { airframeOf } from './airframes'
import type { SimPlane } from './useDogfightSim'

// One aircraft on the patrol. Reads its position straight from the mutable
// sim state each frame rather than from props, so the simulation can run at
// frame rate without React re-rendering anything; reads its identity — type,
// paint, markings — from the pilot's live record, so a choice made in the
// hangar lands on the patrol in the same subscription tick.
//
// The airframe itself is the catalogue's baked model, drawn by Airframe;
// this file is the flying of it and the smoke when it stops.

/** Airscrew rate at idle and per unit of airspeed, radians per second. */
const PROP_IDLE_RATE = 24
const PROP_RATE_PER_SPEED = 2.4
/** Windmilling, engine dead. */
const PROP_DOWN_RATE = 4

// --- Smoke ------------------------------------------------------------------

const SMOKE_POOL = 6
const SMOKE_LIFE_MS = 1100
const SMOKE_DROP_INTERVAL_S = 0.14

/** The smoke texel. Shared with the wreck's trickle in the scene. */
export function makeSmokeTexture(): THREE.CanvasTexture {
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    // Three hard steps, not a gradient — the console's semi-transparency.
    ctx.fillStyle = 'rgba(30,30,34,0.5)'
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, 14, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = 'rgba(52,52,58,0.6)'
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, 9, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = 'rgba(80,80,88,0.7)'
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, 5, 0, Math.PI * 2)
    ctx.fill()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  return texture
}

interface SmokePuff {
  bornAt: number
  x: number
  y: number
  z: number
}

interface PlaneProps {
  /** The pilot's live record: type, paint and markings. */
  readonly pilot: RacerState
  /** Reads the live plane each frame; null until the sim has scrambled it. */
  readonly getPlane: () => SimPlane | null
}

export function Plane({ pilot, getPlane }: PlaneProps): React.ReactElement {
  const root = useRef<THREE.Group>(null)
  const spinBox = useMemo<SpinBox>(() => ({ rate: PROP_IDLE_RATE }), [])
  const smokeSprites = useRef<Array<THREE.Sprite | null>>([])
  const puffs = useRef<SmokePuff[]>(
    Array.from({ length: SMOKE_POOL }, () => ({ bornAt: 0, x: 0, y: 0, z: 0 })),
  )
  const nextPuff = useRef(0)
  const sinceDrop = useRef(0)

  // One material per pooled sprite: opacity is per-puff, and a shared
  // material would fade every puff in step with the newest one.
  const smokeMaterials = useMemo(() => {
    const map = makeSmokeTexture()
    return Array.from(
      { length: SMOKE_POOL },
      () => new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false }),
    )
  }, [])

  useFrame((_, delta) => {
    const plane = getPlane()
    const group = root.current
    if (!group) return
    if (!plane || plane.mode === 'respawn') {
      group.visible = false
    } else {
      group.visible = true
      group.position.set(plane.x, plane.y, plane.z)
      group.rotation.order = 'YXZ'
      group.rotation.y = plane.heading
      group.rotation.x = plane.pitch
      group.rotation.z = plane.bank

      // The engine note, visually: full chat in flight, windmilling down.
      spinBox.rate =
        plane.mode === 'down' ? PROP_DOWN_RATE : PROP_IDLE_RATE + plane.speed * PROP_RATE_PER_SPEED

      // Drop smoke while going down.
      if (plane.mode === 'down') {
        sinceDrop.current += delta
        if (sinceDrop.current >= SMOKE_DROP_INTERVAL_S) {
          sinceDrop.current = 0
          const puff = puffs.current[nextPuff.current]
          puff.bornAt = Date.now()
          puff.x = plane.x
          puff.y = plane.y + 0.2
          puff.z = plane.z
          nextPuff.current = (nextPuff.current + 1) % SMOKE_POOL
        }
      }
    }

    // Puffs outlive the crash on purpose — the column marks where they went in.
    const now = Date.now()
    for (let i = 0; i < SMOKE_POOL; i++) {
      const sprite = smokeSprites.current[i]
      if (!sprite) continue
      const puff = puffs.current[i]
      const age = now - puff.bornAt
      if (puff.bornAt === 0 || age > SMOKE_LIFE_MS) {
        sprite.visible = false
        continue
      }
      const life = age / SMOKE_LIFE_MS
      sprite.visible = true
      sprite.position.set(puff.x, puff.y + life * 0.6, puff.z)
      sprite.scale.setScalar(0.5 + life * 1.1)
      ;(sprite.material as THREE.SpriteMaterial).opacity = 1 - life
    }
  })

  return (
    <>
      <group ref={root} visible={false}>
        {/* The model suspends on first load; until it lands the slot is an
            empty transform, which on a wall screen is a plane still
            scrambling. */}
        <Suspense fallback={null}>
          <Airframe
            index={airframeOf(pilot.key, pilot.airframe)}
            color={pilot.color ?? '#00f0ff'}
            paint={pilot.planePaint ?? null}
            livery={pilot.planeLivery ?? null}
            spinBox={spinBox}
          />
        </Suspense>
      </group>

      {/* Smoke lives outside the airframe's transform — it hangs in the sky
          where it was made, which is the whole reading of a trail. */}
      <group>
        {Array.from({ length: SMOKE_POOL }, (_, index) => (
          <sprite
            key={index}
            ref={(sprite) => {
              smokeSprites.current[index] = sprite
            }}
            visible={false}
            material={smokeMaterials[index]}
          />
        ))}
      </group>
    </>
  )
}
