'use client'

import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { createPs1Material } from '../race/Ps1Material'
import { liveryShaderId } from '@/lib/livery'
import { ARENA_FOG_FAR, ARENA_FOG_NEAR, ARENA_SKY } from './arena'
import type { SimFighter } from './useFightSim'

// A fighter, built rather than downloaded. The era's character was ~350
// vertices of hard boxes and the reader does the rest; a rigged glTF with an
// animation library would cost a pipeline and buy smoothness this channel is
// actively trying not to have. Every part is a box, every joint is a nested
// group, and every pose is a handful of Euler targets damped toward — which
// is honestly how the period's idle stances read anyway.
//
// The model is authored facing +x. The right-side fighter's root group is
// yawed PI so the same skeleton fights both ways.

const SKIN = '#d9a878'
const HAIR = '#1b1410'

/** Segment sizes, world units. A fighter stands ~1.8 tall. */
const SIZES = {
  pelvis: [0.42, 0.26, 0.3],
  torso: [0.5, 0.62, 0.34],
  head: [0.26, 0.3, 0.28],
  hair: [0.28, 0.14, 0.3],
  upperArm: [0.36, 0.16, 0.16],
  forearm: [0.34, 0.15, 0.15],
  fist: [0.16, 0.17, 0.17],
  thigh: [0.19, 0.5, 0.22],
  shin: [0.16, 0.48, 0.18],
  foot: [0.3, 0.1, 0.14],
} as const

const HIP_Y = 0.98
const SHOULDER_Y = 0.5
const SHOULDER_Z = 0.28

interface JointPose {
  readonly torsoLean: number
  readonly torsoTwist: number
  readonly headPitch: number
  /** Near arm = the one facing the opponent (z+ authored side). */
  readonly nearShoulder: readonly [number, number, number]
  readonly nearElbow: number
  readonly farShoulder: readonly [number, number, number]
  readonly farElbow: number
  readonly nearHip: number
  readonly nearKnee: number
  readonly farHip: number
  readonly farKnee: number
  /** Whole-body: crouch (root drop), pitch (fall), rootY extra. */
  readonly crouch: number
  readonly bodyPitch: number
}

const GUARD: JointPose = {
  torsoLean: 0.12,
  torsoTwist: -0.35,
  headPitch: 0.05,
  nearShoulder: [0, -0.5, -0.9],
  nearElbow: -1.9,
  farShoulder: [0, -0.9, -0.7],
  farElbow: -2.1,
  nearHip: 0.35,
  nearKnee: -0.55,
  farHip: -0.25,
  farKnee: -0.35,
  crouch: 0.1,
  bodyPitch: 0,
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** A strike's arc: out fast, back slower. 0..1 over the action. */
function strikeArc(t: number): number {
  return Math.sin(Math.min(1, Math.max(0, t)) * Math.PI)
}

/**
 * The pose for an action at a moment. Derived rather than keyframed in data:
 * five actions of a few joints each reads better as arithmetic than as a
 * table of magic numbers with no names.
 */
function poseFor(action: SimFighter['action'], t: number, elapsed: number): JointPose {
  const bob = Math.sin(elapsed * 2.6) * 0.02
  switch (action) {
    case 'punch': {
      const arc = strikeArc(t / 0.46)
      return {
        ...GUARD,
        torsoTwist: lerp(GUARD.torsoTwist, 0.55, arc),
        torsoLean: lerp(GUARD.torsoLean, 0.28, arc),
        nearShoulder: [0, lerp(-0.5, 0.1, arc), lerp(-0.9, -0.05, arc)],
        nearElbow: lerp(-1.9, -0.08, arc),
        crouch: GUARD.crouch + bob,
      }
    }
    case 'kick': {
      const arc = strikeArc(t / 0.46)
      return {
        ...GUARD,
        torsoLean: lerp(GUARD.torsoLean, -0.32, arc),
        nearHip: lerp(GUARD.nearHip, 1.6, arc),
        nearKnee: lerp(GUARD.nearKnee, -0.15, arc),
        farKnee: lerp(GUARD.farKnee, -0.55, arc),
        crouch: GUARD.crouch + 0.06 * arc,
      }
    }
    case 'hit': {
      const arc = strikeArc(t / 0.42)
      return {
        ...GUARD,
        torsoLean: lerp(GUARD.torsoLean, -0.5, arc),
        headPitch: lerp(GUARD.headPitch, -0.45, arc),
        nearShoulder: [0, -0.3, lerp(-0.9, -1.4, arc)],
        farShoulder: [0, -0.6, lerp(-0.7, -1.3, arc)],
        crouch: GUARD.crouch + 0.05 * arc,
        bodyPitch: -0.12 * arc,
      }
    }
    case 'block': {
      const arc = strikeArc(t / 0.42)
      return {
        ...GUARD,
        nearShoulder: [0, -0.2, lerp(-0.9, -1.5, arc)],
        nearElbow: lerp(-1.9, -2.4, arc),
        farShoulder: [0, -0.3, lerp(-0.7, -1.45, arc)],
        farElbow: lerp(-2.1, -2.4, arc),
        crouch: GUARD.crouch + 0.08 * arc,
      }
    }
    case 'ko': {
      // The fall: pitch back over the first half-second, then stay down.
      const fall = Math.min(1, t / 0.55)
      return {
        torsoLean: 0.1,
        torsoTwist: 0,
        headPitch: -0.3 * fall,
        nearShoulder: [0, -0.2, -0.4 - 1.4 * fall],
        nearElbow: -0.4,
        farShoulder: [0, 0.2, -0.4 - 1.6 * fall],
        farElbow: -0.3,
        nearHip: 0.2 * fall,
        nearKnee: -0.4,
        farHip: -0.15,
        farKnee: -0.3,
        crouch: 0,
        bodyPitch: (Math.PI / 2) * fall,
      }
    }
    case 'victory': {
      const pump = Math.abs(Math.sin(elapsed * 3.2))
      return {
        ...GUARD,
        torsoLean: -0.06,
        torsoTwist: 0,
        headPitch: 0.15,
        nearShoulder: [0, 0, Math.PI - 0.3 - pump * 0.15],
        nearElbow: -0.25,
        farShoulder: [0, -0.4, -0.5],
        farElbow: -1.2,
        crouch: 0.04 + pump * 0.03,
      }
    }
    default:
      return { ...GUARD, crouch: GUARD.crouch + bob }
  }
}

interface FighterProps {
  /** Reads the live fighter each frame; null while no bout is on. */
  readonly getFighter: () => SimFighter | null
  /** Fallback kit colour while the sim has nobody for this slot. */
  readonly fallbackColor: string
}

function material(color: string, emissive = 0): THREE.ShaderMaterial {
  return createPs1Material({
    color,
    fogColor: ARENA_SKY.mid,
    fogNear: ARENA_FOG_NEAR,
    fogFar: ARENA_FOG_FAR,
    emissive,
  })
}

/**
 * The gi. Same material as everything else, plus the race's livery decal:
 * the pattern is cut against the torso's own box, so a driver's twin stripe
 * crosses the chest at the same normalised height it crosses the car's
 * flank. The kit is shared by torso, arms and thighs — the smaller boxes
 * sample the middle of the same field, which reads as matching trim.
 */
function kitMaterialFor(color: string): THREE.ShaderMaterial {
  const torsoBounds = new THREE.Box3(
    new THREE.Vector3(-SIZES.torso[0] / 2, -SIZES.torso[1] / 2, -SIZES.torso[2] / 2),
    new THREE.Vector3(SIZES.torso[0] / 2, SIZES.torso[1] / 2, SIZES.torso[2] / 2),
  )
  return createPs1Material({
    color,
    fogColor: ARENA_SKY.mid,
    fogNear: ARENA_FOG_NEAR,
    fogFar: ARENA_FOG_FAR,
    livery: { pattern: 0, paint: color, bounds: torsoBounds },
  })
}

function box(size: readonly [number, number, number]): THREE.BoxGeometry {
  return new THREE.BoxGeometry(size[0], size[1], size[2])
}

/** Limb helper: a joint group whose child box hangs off along -y or +x. */
function Limb({
  geometry,
  mat,
  length,
  axis,
}: {
  readonly geometry: THREE.BoxGeometry
  readonly mat: THREE.ShaderMaterial
  readonly length: number
  readonly axis: 'down' | 'out'
}): React.ReactElement {
  const offset: [number, number, number] =
    axis === 'down' ? [0, -length / 2, 0] : [length / 2, 0, 0]
  return <mesh geometry={geometry} material={mat} position={offset} />
}

export function Fighter({ getFighter, fallbackColor }: FighterProps): React.ReactElement {
  const root = useRef<THREE.Group>(null)
  const body = useRef<THREE.Group>(null)
  const torso = useRef<THREE.Group>(null)
  const head = useRef<THREE.Group>(null)
  const shoulderNear = useRef<THREE.Group>(null)
  const elbowNear = useRef<THREE.Group>(null)
  const shoulderFar = useRef<THREE.Group>(null)
  const elbowFar = useRef<THREE.Group>(null)
  const hipNear = useRef<THREE.Group>(null)
  const kneeNear = useRef<THREE.Group>(null)
  const hipFar = useRef<THREE.Group>(null)
  const kneeFar = useRef<THREE.Group>(null)
  const elapsed = useRef(Math.random() * 10)
  // The undisplaced hip height. Damping has to read back its own previous
  // output, so the fall offset below can never be written into it — subtract
  // the offset only at the point of assignment, or it compounds every frame.
  const baseHipY = useRef(HIP_Y)

  const kitMaterial = useRef<THREE.ShaderMaterial | null>(null)
  const lastPaintJob = useRef<string>('')

  const parts = useMemo(() => {
    const kit = kitMaterialFor(fallbackColor)
    const trim = material('#22222c')
    const skin = material(SKIN)
    const hair = material(HAIR)
    return {
      kit,
      trim,
      skin,
      hair,
      pelvis: box(SIZES.pelvis),
      torso: box(SIZES.torso),
      head: box(SIZES.head),
      hairCap: box(SIZES.hair),
      upperArm: box(SIZES.upperArm),
      forearm: box(SIZES.forearm),
      fist: box(SIZES.fist),
      thigh: box(SIZES.thigh),
      shin: box(SIZES.shin),
      foot: box(SIZES.foot),
    }
  }, [fallbackColor])
  kitMaterial.current = parts.kit

  useFrame((_, delta) => {
    const fighter = getFighter()
    const group = root.current
    if (!group) return
    if (!fighter) {
      group.visible = false
      return
    }
    group.visible = true
    elapsed.current += delta

    // Repaint the gi when the slot changes hands — or when its owner walks
    // out of the paint shop mid-bout. The paint-shop colour wins over the
    // deck's assigned one, exactly as it does on the car, so the costume and
    // the kart are the same paint job seen twice.
    const paintJob = `${fighter.paint ?? fighter.color}|${fighter.livery ?? ''}`
    if (paintJob !== lastPaintJob.current && kitMaterial.current) {
      lastPaintJob.current = paintJob
      const kitColor = fighter.paint ?? fighter.color
      const { uColor, uPaint, uLivery } = kitMaterial.current.uniforms
      if (uColor) (uColor.value as THREE.Color).set(kitColor)
      if (uPaint) (uPaint.value as THREE.Color).set(kitColor)
      if (uLivery) uLivery.value = liveryShaderId(fighter.livery)
    }

    const pose = poseFor(fighter.action, fighter.actionT, elapsed.current)
    const damp = (current: number, target: number): number =>
      THREE.MathUtils.damp(current, target, 16, delta)

    group.position.x = fighter.x
    // The authored model faces +x; the right-side fighter turns around.
    group.rotation.y = fighter.side === -1 ? 0 : Math.PI

    const bodyGroup = body.current
    if (bodyGroup) {
      baseHipY.current = damp(baseHipY.current, HIP_Y - pose.crouch)
      bodyGroup.rotation.z = damp(bodyGroup.rotation.z, pose.bodyPitch)
      // A fallen body pivots at the heels, not the hips: as the pitch grows
      // the root slides down so the shoulders land on the floor.
      const fallen = Math.abs(bodyGroup.rotation.z) / (Math.PI / 2)
      bodyGroup.position.y = baseHipY.current - fallen * (HIP_Y - 0.24)
    }

    const set = (
      groupRef: React.RefObject<THREE.Group | null>,
      x: number,
      y: number,
      z: number,
    ): void => {
      const joint = groupRef.current
      if (!joint) return
      joint.rotation.x = damp(joint.rotation.x, x)
      joint.rotation.y = damp(joint.rotation.y, y)
      joint.rotation.z = damp(joint.rotation.z, z)
    }

    set(torso, 0, pose.torsoTwist, pose.torsoLean)
    set(head, 0, 0, pose.headPitch)
    set(shoulderNear, pose.nearShoulder[0], pose.nearShoulder[1], pose.nearShoulder[2])
    set(elbowNear, 0, pose.nearElbow, 0)
    set(shoulderFar, pose.farShoulder[0], pose.farShoulder[1], pose.farShoulder[2])
    set(elbowFar, 0, pose.farElbow, 0)
    set(hipNear, 0, 0, pose.nearHip)
    set(kneeNear, 0, 0, pose.nearKnee)
    set(hipFar, 0, 0, pose.farHip)
    set(kneeFar, 0, 0, pose.farKnee)
  })

  const armLength = SIZES.upperArm[0]
  const forearmLength = SIZES.forearm[0]
  const thighLength = SIZES.thigh[1]
  const shinLength = SIZES.shin[1]

  return (
    <group ref={root}>
      <group ref={body} position={[0, HIP_Y, 0]}>
        <mesh geometry={parts.pelvis} material={parts.trim} />

        <group ref={torso} position={[0, SIZES.pelvis[1] / 2, 0]}>
          <mesh
            geometry={parts.torso}
            material={parts.kit}
            position={[0, SIZES.torso[1] / 2, 0]}
          />
          <group ref={head} position={[0, SIZES.torso[1] + 0.16, 0]}>
            <mesh geometry={parts.head} material={parts.skin} />
            <mesh geometry={parts.hairCap} material={parts.hair} position={[-0.02, 0.16, 0]} />
          </group>

          {/* Near arm: the opponent-facing side, z negative in author space
              so the punch crosses the centre line. */}
          <group ref={shoulderNear} position={[0, SHOULDER_Y, -SHOULDER_Z]}>
            <Limb geometry={parts.upperArm} mat={parts.kit} length={armLength} axis="out" />
            <group ref={elbowNear} position={[armLength, 0, 0]}>
              <Limb geometry={parts.forearm} mat={parts.skin} length={forearmLength} axis="out" />
              <mesh
                geometry={parts.fist}
                material={parts.trim}
                position={[forearmLength + 0.06, 0, 0]}
              />
            </group>
          </group>

          <group ref={shoulderFar} position={[0, SHOULDER_Y, SHOULDER_Z]}>
            <Limb geometry={parts.upperArm} mat={parts.kit} length={armLength} axis="out" />
            <group ref={elbowFar} position={[armLength, 0, 0]}>
              <Limb geometry={parts.forearm} mat={parts.skin} length={forearmLength} axis="out" />
              <mesh
                geometry={parts.fist}
                material={parts.trim}
                position={[forearmLength + 0.06, 0, 0]}
              />
            </group>
          </group>
        </group>

        <group ref={hipNear} position={[0, -SIZES.pelvis[1] / 2, -0.12]}>
          <Limb geometry={parts.thigh} mat={parts.kit} length={thighLength} axis="down" />
          <group ref={kneeNear} position={[0, -thighLength, 0]}>
            <Limb geometry={parts.shin} mat={parts.trim} length={shinLength} axis="down" />
            <mesh
              geometry={parts.foot}
              material={parts.trim}
              position={[0.08, -shinLength, 0]}
            />
          </group>
        </group>

        <group ref={hipFar} position={[0, -SIZES.pelvis[1] / 2, 0.12]}>
          <Limb geometry={parts.thigh} mat={parts.kit} length={thighLength} axis="down" />
          <group ref={kneeFar} position={[0, -thighLength, 0]}>
            <Limb geometry={parts.shin} mat={parts.trim} length={shinLength} axis="down" />
            <mesh
              geometry={parts.foot}
              material={parts.trim}
              position={[0.08, -shinLength, 0]}
            />
          </group>
        </group>
      </group>
    </group>
  )
}
