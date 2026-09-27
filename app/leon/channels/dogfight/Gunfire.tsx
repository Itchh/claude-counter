'use client'

import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { RacerState } from '../race/types'
import { airframeFor, airframeOf } from './airframes'
import type { useDogfightSim } from './useDogfightSim'

// Gunnery, as the period drew it. The simulation reports a burst as one
// event — who fired, at whom — and this turns it into rounds: a pair from
// every gun position on the attacker's airframe, leaving the muzzles with a
// flash, crossing the gap as lit streaks, and dying on the target. Nothing
// here changes the outcome; the damage was done the instant the sim spoke.
// This is the picture of it.
//
// A round is a stretched box, full-bright and additive, because that is
// what a tracer was on the hardware: a lit line, not a particle. It homes
// gently onto the target's live position so a burst fired at a plane in a
// hard turn still lands on the plane, which is what the gun-camera footage
// this is quoting always showed — the rounds converging on the target,
// never the target flying out of them.

const BULLET_POOL = 64
const BULLET_SPEED = 58
/** Rounds per gun per burst, and the gap between them along the line of fire. */
const ROUNDS_PER_GUN = 2
const ROUND_STAGGER = 0.42
/** How hard a round bends toward the target's live position, per second. */
const HOMING = 7
/** A round this close to the target has arrived. */
const ARRIVAL_RADIUS = 0.35
/** Rounds that never arrive still stop here. */
const MAX_FLIGHT_S = 0.6
const BULLET_LENGTH = 0.9
const BULLET_THICKNESS = 0.045
/** Jitter on the muzzle direction, radians — a burst is a cone, not a line. */
const SPREAD = 0.045

const FLASH_POOL = 16
const FLASH_LIFE_MS = 70
const FLASH_SIZE = 0.34

interface Round {
  alive: boolean
  crit: boolean
  targetKey: string
  bornAt: number
  position: THREE.Vector3
  velocity: THREE.Vector3
}

interface Flash {
  bornAt: number
  position: THREE.Vector3
}

function makeFlashTexture(): THREE.CanvasTexture {
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.translate(size / 2, size / 2)
    // A four-point star with a hot core — hard steps, no gradient.
    ctx.fillStyle = '#ffb85a'
    for (let i = 0; i < 4; i++) {
      const angle = (i / 4) * Math.PI * 2 + Math.PI / 4
      ctx.beginPath()
      ctx.moveTo(Math.cos(angle - 0.35) * 4, Math.sin(angle - 0.35) * 4)
      ctx.lineTo(Math.cos(angle) * 15, Math.sin(angle) * 15)
      ctx.lineTo(Math.cos(angle + 0.35) * 4, Math.sin(angle + 0.35) * 4)
      ctx.closePath()
      ctx.fill()
    }
    ctx.fillStyle = '#fff6d0'
    ctx.beginPath()
    ctx.arc(0, 0, 5, 0, Math.PI * 2)
    ctx.fill()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  return texture
}

interface GunfireProps {
  readonly sim: ReturnType<typeof useDogfightSim>
  /** The live roster, for whose airframe carries which guns. */
  readonly getPilot: (key: string) => RacerState | null
}

export function Gunfire({ sim, getPilot }: GunfireProps): React.ReactElement {
  const bulletMeshes = useRef<Array<THREE.Mesh | null>>([])
  const flashSprites = useRef<Array<THREE.Sprite | null>>([])
  const rounds = useRef<Round[]>(
    Array.from({ length: BULLET_POOL }, () => ({
      alive: false,
      crit: false,
      targetKey: '',
      bornAt: 0,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
    })),
  )
  const flashes = useRef<Flash[]>(
    Array.from({ length: FLASH_POOL }, () => ({ bornAt: 0, position: new THREE.Vector3() })),
  )
  const nextRound = useRef(0)
  const nextFlash = useRef(0)
  const lastTracerId = useRef(0)

  const materials = useMemo(
    () => ({
      hit: new THREE.MeshBasicMaterial({ color: '#ffe38a', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
      crit: new THREE.MeshBasicMaterial({ color: '#ff8a2a', blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
      flash: new THREE.SpriteMaterial({
        map: makeFlashTexture(),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    }),
    [],
  )
  const bulletGeometry = useMemo(
    () => new THREE.BoxGeometry(BULLET_THICKNESS, BULLET_THICKNESS, BULLET_LENGTH),
    [],
  )

  // Scratch space, allocated once: the muzzle transform, the aim, the lead.
  const scratch = useMemo(
    () => ({
      airframe: new THREE.Object3D(),
      muzzle: new THREE.Vector3(),
      aim: new THREE.Vector3(),
      target: new THREE.Vector3(),
      ahead: new THREE.Vector3(),
    }),
    [],
  )

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1)
    const now = Date.now()
    const planes = sim.planes.current

    // New bursts since the last frame become rounds.
    for (const tracer of sim.tracers.current) {
      if (tracer.id <= lastTracerId.current) continue
      lastTracerId.current = tracer.id
      const attacker = planes.find((plane) => plane.key === tracer.attackerKey)
      const target = planes.find((plane) => plane.key === tracer.targetKey)
      if (!attacker || !target) continue
      const pilot = getPilot(attacker.key)
      const airframe = airframeFor(airframeOf(attacker.key, pilot?.airframe))

      // Where the guns are right now, in the world.
      const { airframe: frame, muzzle, aim, target: targetPosition, ahead } = scratch
      frame.position.set(attacker.x, attacker.y, attacker.z)
      frame.rotation.set(attacker.pitch, attacker.heading, attacker.bank, 'YXZ')
      frame.updateMatrixWorld(true)
      targetPosition.set(target.x, target.y, target.z)

      for (const gun of airframe.guns) {
        muzzle.set(gun[0], gun[1], gun[2]).applyMatrix4(frame.matrixWorld)

        const flash = flashes.current[nextFlash.current]
        flash.bornAt = now
        flash.position.copy(muzzle)
        nextFlash.current = (nextFlash.current + 1) % FLASH_POOL

        // Aim at the target with a little lead, and a little scatter.
        aim.copy(targetPosition).sub(muzzle)
        const flight = aim.length() / BULLET_SPEED
        ahead.set(Math.sin(target.heading), 0, Math.cos(target.heading)).multiplyScalar(target.speed * flight * 0.6)
        aim.add(ahead).normalize()
        aim.x += (Math.random() - 0.5) * SPREAD
        aim.y += (Math.random() - 0.5) * SPREAD
        aim.z += (Math.random() - 0.5) * SPREAD
        aim.normalize()

        for (let n = 0; n < ROUNDS_PER_GUN; n++) {
          const round = rounds.current[nextRound.current]
          nextRound.current = (nextRound.current + 1) % BULLET_POOL
          round.alive = true
          round.crit = tracer.crit
          round.targetKey = target.key
          round.bornAt = now
          round.velocity.copy(aim).multiplyScalar(BULLET_SPEED)
          // The second round of the pair starts a little behind the first.
          round.position.copy(muzzle).addScaledVector(aim, -n * ROUND_STAGGER)
        }
      }
    }

    // Fly every live round.
    for (let i = 0; i < BULLET_POOL; i++) {
      const round = rounds.current[i]
      const mesh = bulletMeshes.current[i]
      if (!mesh) continue
      if (!round.alive) {
        mesh.visible = false
        continue
      }
      const age = (now - round.bornAt) / 1000
      const target = planes.find((plane) => plane.key === round.targetKey)
      if (target && target.mode !== 'respawn') {
        scratch.target.set(target.x, target.y, target.z)
        scratch.aim.copy(scratch.target).sub(round.position)
        const distance = scratch.aim.length()
        if (distance < ARRIVAL_RADIUS) {
          round.alive = false
          mesh.visible = false
          continue
        }
        // Bend toward the target: keep the speed, turn the direction.
        scratch.aim.divideScalar(distance)
        round.velocity.lerp(scratch.aim.multiplyScalar(BULLET_SPEED), Math.min(1, HOMING * dt))
        round.velocity.setLength(BULLET_SPEED)
      }
      if (age > MAX_FLIGHT_S) {
        round.alive = false
        mesh.visible = false
        continue
      }
      round.position.addScaledVector(round.velocity, dt)
      mesh.visible = true
      mesh.position.copy(round.position)
      scratch.aim.copy(round.position).add(round.velocity)
      mesh.lookAt(scratch.aim)
      mesh.material = round.crit ? materials.crit : materials.hit
    }

    // Muzzle flashes.
    for (let i = 0; i < FLASH_POOL; i++) {
      const sprite = flashSprites.current[i]
      if (!sprite) continue
      const flash = flashes.current[i]
      const age = now - flash.bornAt
      if (flash.bornAt === 0 || age > FLASH_LIFE_MS) {
        sprite.visible = false
        continue
      }
      sprite.visible = true
      sprite.position.copy(flash.position)
      // Two frames of the flash, as the era animated it: big, then small.
      sprite.scale.setScalar(age < FLASH_LIFE_MS / 2 ? FLASH_SIZE : FLASH_SIZE * 0.6)
    }
  })

  return (
    <group>
      {Array.from({ length: BULLET_POOL }, (_, index) => (
        <mesh
          key={index}
          ref={(mesh) => {
            bulletMeshes.current[index] = mesh
          }}
          geometry={bulletGeometry}
          material={materials.hit}
          visible={false}
        />
      ))}
      {Array.from({ length: FLASH_POOL }, (_, index) => (
        <sprite
          key={index}
          ref={(sprite) => {
            flashSprites.current[index] = sprite
          }}
          material={materials.flash}
          visible={false}
        />
      ))}
    </group>
  )
}
