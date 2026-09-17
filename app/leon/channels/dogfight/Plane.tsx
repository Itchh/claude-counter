'use client'

import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { createPs1Material } from '../race/Ps1Material'
import { liveryShaderId } from '@/lib/livery'
import { THEATRE_FOG_FAR, THEATRE_FOG_NEAR, THEATRE_SKY } from './theatre'
import type { SimPlane } from './useDogfightSim'

// A fighter aircraft, built rather than downloaded, to the same argument as
// the boxer next door: the era's plane was a couple of hundred vertices of
// hard slabs and the reader supplies the Spitfire. Camouflage upper surfaces,
// the roundels as stacked discs, the fin flash as three painted slats — the
// decals are geometry, exactly as the period drew them, because a 128-texel
// page has no room for a circle that stays round.
//
// The pilot's own colour takes the nose cowl, the spinner and a fuselage
// band — nose art, in the only paint shop this squadron has.

const CAMO = '#4d5a38'
/** The fuselage slab, nose to tail along +z. Also the livery's canvas. */
const FUSELAGE_SIZE: readonly [number, number, number] = [0.34, 0.36, 2.2]
const UNDERSIDE = '#8a94a0'
const CANOPY = '#7fd4e8'
/** The roundel, outside in. */
const ROUNDEL = ['#1b3a8f', '#e8e8e8', '#c22525'] as const
const ROUNDEL_RADII = [0.24, 0.16, 0.08] as const

function material(color: string, emissive = 0): THREE.ShaderMaterial {
  return createPs1Material({
    color,
    fogColor: THEATRE_SKY.mid,
    fogNear: THEATRE_FOG_NEAR,
    fogFar: THEATRE_FOG_FAR,
    emissive,
  })
}

/**
 * The fuselage's own material: camo like the rest of the airframe, plus the
 * race's livery decal so the pilot's chosen pattern runs nose to tail in
 * their paint's tones — squadron markings from the same paint shop that
 * does the cars. Pattern 0 (bare) until a pilot with a livery holds the slot.
 */
function fuselageMaterial(): THREE.ShaderMaterial {
  const bounds = new THREE.Box3(
    new THREE.Vector3(-FUSELAGE_SIZE[0] / 2, -FUSELAGE_SIZE[1] / 2, -FUSELAGE_SIZE[2] / 2),
    new THREE.Vector3(FUSELAGE_SIZE[0] / 2, FUSELAGE_SIZE[1] / 2, FUSELAGE_SIZE[2] / 2),
  )
  return createPs1Material({
    color: CAMO,
    fogColor: THEATRE_SKY.mid,
    fogNear: THEATRE_FOG_NEAR,
    fogFar: THEATRE_FOG_FAR,
    livery: { pattern: 0, paint: '#00f0ff', bounds },
  })
}

// --- Smoke ------------------------------------------------------------------

const SMOKE_POOL = 6
const SMOKE_LIFE_MS = 1100
const SMOKE_DROP_INTERVAL_S = 0.14

function makeSmokeTexture(): THREE.CanvasTexture {
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
  /** Reads the live plane each frame; null when the slot is empty. */
  readonly getPlane: () => SimPlane | null
}

export function Plane({ getPlane }: PlaneProps): React.ReactElement {
  const root = useRef<THREE.Group>(null)
  const prop = useRef<THREE.Group>(null)
  const smokeSprites = useRef<Array<THREE.Sprite | null>>([])
  const puffs = useRef<SmokePuff[]>(
    Array.from({ length: SMOKE_POOL }, () => ({ bornAt: 0, x: 0, y: 0, z: 0 })),
  )
  const nextPuff = useRef(0)
  const sinceDrop = useRef(0)
  const lastPaintJob = useRef('')

  const parts = useMemo(() => {
    return {
      camo: material(CAMO),
      fuselage: fuselageMaterial(),
      underside: material(UNDERSIDE),
      canopy: material(CANOPY, 0.35),
      pilot: material('#00f0ff'),
      roundel: ROUNDEL.map((color) => material(color)),
      flash: [material('#c22525'), material('#e8e8e8'), material('#1b3a8f')],
      propBlade: material('#1a1a1e'),
      // One material per pooled sprite: opacity is per-puff, and a shared
      // material would fade every puff in step with the newest one.
      smoke: (() => {
        const map = makeSmokeTexture()
        return Array.from(
          { length: SMOKE_POOL },
          () => new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false }),
        )
      })(),
    }
  }, [])

  useFrame((_, delta) => {
    const plane = getPlane()
    const group = root.current
    if (!group) return
    if (!plane || plane.mode === 'respawn') {
      group.visible = false
    } else {
      group.visible = true

      // Repaint when the slot changes hands, or when its pilot resprays
      // mid-patrol. The paint-shop colour wins over the deck's assigned one,
      // exactly as it does on the car and the gi.
      const paintJob = `${plane.paint ?? plane.color}|${plane.livery ?? ''}`
      if (paintJob !== lastPaintJob.current) {
        lastPaintJob.current = paintJob
        const noseArt = plane.paint ?? plane.color
        const uColor = parts.pilot.uniforms.uColor
        if (uColor) (uColor.value as THREE.Color).set(noseArt)
        const { uPaint, uLivery } = parts.fuselage.uniforms
        if (uPaint) (uPaint.value as THREE.Color).set(noseArt)
        if (uLivery) uLivery.value = liveryShaderId(plane.livery)
      }

      group.position.set(plane.x, plane.y, plane.z)
      group.rotation.order = 'YXZ'
      group.rotation.y = plane.heading
      group.rotation.x = plane.pitch
      group.rotation.z = plane.bank

      const spinner = prop.current
      if (spinner) {
        // The engine note, visually: full chat in flight, windmilling down.
        const rate = plane.mode === 'down' ? 4 : 24 + plane.speed * 2.4
        spinner.rotation.z += rate * delta
      }

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
        {/* Fuselage, nose to tail along +z. Its own material, because it is
            also the livery's canvas. */}
        <mesh material={parts.fuselage} position={[0, 0, 0]}>
          <boxGeometry args={[...FUSELAGE_SIZE]} />
        </mesh>
        <mesh material={parts.pilot} position={[0, 0, 1.25]}>
          <boxGeometry args={[0.3, 0.32, 0.36]} />
        </mesh>
        <mesh material={parts.canopy} position={[0, 0.24, 0.25]}>
          <boxGeometry args={[0.22, 0.14, 0.5]} />
        </mesh>
        {/* The pilot's band, just forward of the tail. */}
        <mesh material={parts.pilot} position={[0, 0, -0.7]}>
          <boxGeometry args={[0.37, 0.39, 0.14]} />
        </mesh>

        {/* Wings, and their roundels. */}
        <mesh material={parts.camo} position={[0, -0.05, 0.15]}>
          <boxGeometry args={[3.1, 0.09, 0.72]} />
        </mesh>
        {[-1, 1].map((side) => (
          <group key={side} position={[side * 0.95, 0.01, 0.15]}>
            {ROUNDEL.map((_, ring) => (
              <mesh
                key={ring}
                material={parts.roundel[ring]}
                position={[0, 0.012 * (ring + 1), 0]}
                rotation={[0, 0, 0]}
              >
                <cylinderGeometry args={[ROUNDEL_RADII[ring], ROUNDEL_RADII[ring], 0.01, 10]} />
              </mesh>
            ))}
          </group>
        ))}

        {/* Tailplane and fin, with the flash. */}
        <mesh material={parts.underside} position={[0, 0.05, -1.05]}>
          <boxGeometry args={[1.15, 0.07, 0.42]} />
        </mesh>
        <mesh material={parts.camo} position={[0, 0.3, -1.08]}>
          <boxGeometry args={[0.07, 0.5, 0.42]} />
        </mesh>
        {parts.flash.map((flashMaterial, index) => (
          <mesh
            key={index}
            material={flashMaterial}
            position={[0, 0.3, -0.94 + index * 0.09]}
          >
            <boxGeometry args={[0.09, 0.46, 0.08]} />
          </mesh>
        ))}

        {/* The airscrew. */}
        <group ref={prop} position={[0, 0, 1.48]}>
          <mesh material={parts.propBlade}>
            <boxGeometry args={[1.15, 0.09, 0.04]} />
          </mesh>
          <mesh material={parts.propBlade} rotation={[0, 0, Math.PI / 2]}>
            <boxGeometry args={[1.15, 0.09, 0.04]} />
          </mesh>
        </group>
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
            material={parts.smoke[index]}
          />
        ))}
      </group>
    </>
  )
}
