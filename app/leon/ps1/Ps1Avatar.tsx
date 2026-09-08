'use client'

import { useMemo } from 'react'
import { Ps1Model, type Face, type Mesh, type Vec3 } from './softModel'

// The player bust: a lathed head, a visor and a tapered torso, in the driver's
// own colour. Geometry only — the projection, the sorting and the 15-bit
// shading all live in softModel, which the car sprite uses too.

const HEAD_SEGMENTS = 7
const HEAD_RINGS = 5
const HEAD_RADIUS = 0.62
const HEAD_CENTRE_Y = 0.55
const TORSO_SEGMENTS = 7

function buildBust(): Mesh {
  const vertices: Vec3[] = []
  const faces: Face[] = []

  // --- Head: a low-segment lathed sphere, squashed slightly front-to-back.
  const headStart = vertices.length
  for (let ring = 0; ring <= HEAD_RINGS; ring += 1) {
    const phi = (ring / HEAD_RINGS) * Math.PI
    const y = Math.cos(phi) * HEAD_RADIUS + HEAD_CENTRE_Y
    const ringRadius = Math.sin(phi) * HEAD_RADIUS
    for (let seg = 0; seg < HEAD_SEGMENTS; seg += 1) {
      const theta = (seg / HEAD_SEGMENTS) * Math.PI * 2
      vertices.push({
        x: Math.cos(theta) * ringRadius,
        y,
        z: Math.sin(theta) * ringRadius * 0.86,
      })
    }
  }

  const headIndex = (ring: number, seg: number): number =>
    headStart + ring * HEAD_SEGMENTS + (seg % HEAD_SEGMENTS)

  for (let ring = 0; ring < HEAD_RINGS; ring += 1) {
    for (let seg = 0; seg < HEAD_SEGMENTS; seg += 1) {
      const topLeft = headIndex(ring, seg)
      const topRight = headIndex(ring, seg + 1)
      const bottomLeft = headIndex(ring + 1, seg)
      const bottomRight = headIndex(ring + 1, seg + 1)
      // The visor band wraps the front two segments of the eye-level ring.
      const isVisor = ring === 2 && (seg === 1 || seg === 2)
      const material = isVisor ? 1 : 0
      faces.push({ a: topLeft, b: bottomLeft, c: bottomRight, material })
      faces.push({ a: topLeft, b: bottomRight, c: topRight, material })
    }
  }

  // --- Torso: a tapered prism. Six-sided, because that is all the budget the
  // hardware would have spent on a background character.
  const torsoStart = vertices.length
  const shoulderY = -0.15
  const baseY = -1.15
  for (let seg = 0; seg < TORSO_SEGMENTS; seg += 1) {
    const theta = (seg / TORSO_SEGMENTS) * Math.PI * 2
    vertices.push({
      x: Math.cos(theta) * 0.52,
      y: shoulderY,
      z: Math.sin(theta) * 0.42,
    })
  }
  for (let seg = 0; seg < TORSO_SEGMENTS; seg += 1) {
    const theta = (seg / TORSO_SEGMENTS) * Math.PI * 2
    vertices.push({
      x: Math.cos(theta) * 0.95,
      y: baseY,
      z: Math.sin(theta) * 0.62,
    })
  }

  for (let seg = 0; seg < TORSO_SEGMENTS; seg += 1) {
    const next = (seg + 1) % TORSO_SEGMENTS
    const topLeft = torsoStart + seg
    const topRight = torsoStart + next
    const bottomLeft = torsoStart + TORSO_SEGMENTS + seg
    const bottomRight = torsoStart + TORSO_SEGMENTS + next
    faces.push({ a: topLeft, b: bottomLeft, c: bottomRight, material: 2 })
    faces.push({ a: topLeft, b: bottomRight, c: topRight, material: 2 })
  }

  return { vertices, faces }
}

const BUST = buildBust()

interface Ps1AvatarProps {
  readonly color: string
  readonly size: number
  /** Drives spin speed — a busy person's avatar visibly revs. */
  readonly intensity?: number
  readonly label?: string
}

export function Ps1Avatar({
  color,
  size,
  intensity = 0,
  label,
}: Ps1AvatarProps): React.ReactElement {
  const mesh = useMemo(() => BUST, [])
  return (
    <Ps1Model
      mesh={mesh}
      color={color}
      size={size}
      intensity={intensity}
      ariaLabel={label ? `${label} avatar` : 'player avatar'}
    />
  )
}
