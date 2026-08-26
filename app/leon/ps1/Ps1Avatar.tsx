'use client'

import { useEffect, useRef } from 'react'
import { PS1, hexToRgb, shadeToCss, type Rgb } from './theme'

// A software rasteriser, deliberately. The console had no z-buffer — it sorted
// whole polygons back-to-front and accepted the sorting errors — and it snapped
// transformed vertices to integer screen coordinates, which is what produces
// the wobble. Canvas 2D reproduces both honestly; WebGL would have to fake them.
//
// This procedural bust is a stand-in. When real 3D scans arrive, swap
// `buildBust` for a loader that returns the same {vertices, faces} shape and
// everything below keeps working.

const RENDER_SIZE = 72
const FRAME_MS = 1000 / 15 // Console framerate, not a performance compromise.
const FOCAL_LENGTH = 2.1
const CAMERA_Z = 3.4
const SUBPIXEL_STEPS = 1 // Integer vertex snapping. Raise for a modern look.

interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

interface Face {
  readonly a: number
  readonly b: number
  readonly c: number
  /** 0 = skin/kit colour, 1 = visor, 2 = shadowed underside detail. */
  readonly material: number
}

interface Mesh {
  readonly vertices: ReadonlyArray<Vec3>
  readonly faces: ReadonlyArray<Face>
}

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

const LIGHT_DIR: Vec3 = { x: -0.45, y: 0.72, z: 0.53 }
const AMBIENT = 0.6

interface Projected {
  readonly x: number
  readonly y: number
  readonly z: number
}

function project(vertex: Vec3, yaw: number, bobY: number, size: number): Projected {
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const rotatedX = vertex.x * cos - vertex.z * sin
  const rotatedZ = vertex.x * sin + vertex.z * cos
  const viewZ = rotatedZ + CAMERA_Z
  const scale = (FOCAL_LENGTH / viewZ) * (size / 2)
  const screenX = rotatedX * scale + size / 2
  const screenY = -(vertex.y + bobY) * scale + size / 2
  // Integer snapping: the source of the wobble, applied after projection just
  // as the console's GTE did.
  return {
    x: Math.round(screenX * SUBPIXEL_STEPS) / SUBPIXEL_STEPS,
    y: Math.round(screenY * SUBPIXEL_STEPS) / SUBPIXEL_STEPS,
    z: viewZ,
  }
}

const FOG_NEAR = 3.0
const FOG_FAR = 5.0

function fogAmount(viewZ: number): number {
  return Math.max(0, Math.min(0.45, (viewZ - FOG_NEAR) / (FOG_FAR - FOG_NEAR)))
}

function materialColor(material: number, kit: Rgb): Rgb {
  if (material === 1) return hexToRgb(PS1.cyan)
  if (material === 2) return { r: kit.r * 0.62, g: kit.g * 0.62, b: kit.b * 0.8 }
  return kit
}

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
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const intensityRef = useRef(intensity)
  intensityRef.current = intensity

  const colorRef = useRef(color)
  colorRef.current = color

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const ctx = canvas.getContext('2d')
    if (ctx === null) return

    ctx.imageSmoothingEnabled = false

    let frameId = 0
    let lastFrame = 0
    let yaw = 0
    let elapsed = 0

    const draw = (now: number): void => {
      frameId = window.requestAnimationFrame(draw)
      if (now - lastFrame < FRAME_MS) return
      const delta = lastFrame === 0 ? FRAME_MS : now - lastFrame
      lastFrame = now

      elapsed += delta
      yaw += (0.0006 + intensityRef.current * 0.0022) * delta

      const kit = hexToRgb(colorRef.current)
      const bobY = Math.sin(elapsed / 900) * 0.045

      ctx.clearRect(0, 0, RENDER_SIZE, RENDER_SIZE)

      const projected = BUST.vertices.map((vertex) =>
        project(vertex, yaw, bobY, RENDER_SIZE),
      )

      // No z-buffer: sort whole faces by average depth and paint back to front.
      const ordered = BUST.faces
        .map((face) => ({
          face,
          depth:
            (projected[face.a].z + projected[face.b].z + projected[face.c].z) / 3,
        }))
        .sort((left, right) => right.depth - left.depth)

      for (const { face, depth } of ordered) {
        const pa = projected[face.a]
        const pb = projected[face.b]
        const pc = projected[face.c]

        // Backface cull via 2D winding — cheaper than a normal, same result.
        const area = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y)
        if (area <= 0) continue

        const va = BUST.vertices[face.a]
        const vb = BUST.vertices[face.b]
        const vc = BUST.vertices[face.c]
        const ux = vb.x - va.x
        const uy = vb.y - va.y
        const uz = vb.z - va.z
        const wx = vc.x - va.x
        const wy = vc.y - va.y
        const wz = vc.z - va.z
        const nx = uy * wz - uz * wy
        const ny = uz * wx - ux * wz
        const nz = ux * wy - uy * wx
        const length = Math.hypot(nx, ny, nz) || 1
        const cosYaw = Math.cos(yaw)
        const sinYaw = Math.sin(yaw)
        const worldNx = (nx * cosYaw - nz * sinYaw) / length
        const worldNy = ny / length
        const worldNz = (nx * sinYaw + nz * cosYaw) / length
        const lambert =
          AMBIENT +
          (1 - AMBIENT) *
            Math.max(
              0,
              worldNx * LIGHT_DIR.x + worldNy * LIGHT_DIR.y + worldNz * LIGHT_DIR.z,
            )

        ctx.fillStyle = shadeToCss(
          materialColor(face.material, kit),
          lambert,
          fogAmount(depth),
        )
        ctx.beginPath()
        ctx.moveTo(pa.x, pa.y)
        ctx.lineTo(pb.x, pb.y)
        ctx.lineTo(pc.x, pc.y)
        ctx.closePath()
        ctx.fill()
        // Re-stroke the same path: closes the hairline seams the rasteriser
        // leaves between adjacent triangles without adding a visible outline.
        ctx.strokeStyle = ctx.fillStyle
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }

    frameId = window.requestAnimationFrame(draw)
    return () => window.cancelAnimationFrame(frameId)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      width={RENDER_SIZE}
      height={RENDER_SIZE}
      aria-label={label ? `${label} avatar` : 'player avatar'}
      role="img"
      className="ps1-avatar"
      style={{ width: size, height: size }}
    />
  )
}
