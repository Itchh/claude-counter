'use client'

import { useEffect, useRef } from 'react'
import { PS1, hexToRgb, shadeToCss, type Rgb } from './theme'

// A software rasteriser, deliberately. The console had no z-buffer — it sorted
// whole polygons back-to-front and accepted the sorting errors — and it snapped
// transformed vertices to integer screen coordinates, which is what produces
// the wobble. Canvas 2D reproduces both honestly; WebGL would have to fake them.
//
// It is a renderer and nothing else: hand it a mesh and a colour and it turns
// a turntable. What that mesh IS lives next door — a bust in Ps1Avatar, a car
// in Ps1Car — because the two want completely different geometry and exactly
// the same eight lines of projection, sorting and shading. Splitting them is
// also what stops a scoreboard opening a WebGL context per row: five of these
// are five 2D canvases, which the browser does not ration.

const RENDER_SIZE = 72
const FRAME_MS = 1000 / 15 // Console framerate, not a performance compromise.
const FOCAL_LENGTH = 2.1
const CAMERA_Z = 3.4
const SUBPIXEL_STEPS = 1 // Integer vertex snapping. Raise for a modern look.

export interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

export interface Face {
  readonly a: number
  readonly b: number
  readonly c: number
  /** See `materialColor` — 0 is the driver's own colour, the rest are trim. */
  readonly material: number
}

export interface Mesh {
  readonly vertices: ReadonlyArray<Vec3>
  readonly faces: ReadonlyArray<Face>
}

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

/**
 * Four materials, which is three more than the hardware would have spent on
 * something this size and exactly enough to read a car:
 *
 *   0  the driver's own colour — bodywork, kit
 *   1  glass — cyan, because a window is a reflection of sky
 *   2  the shadowed side of the same colour — undersides, tyres
 *   3  a lamp — the one hot accent, tail lights
 */
function materialColor(material: number, kit: Rgb): Rgb {
  if (material === 1) return hexToRgb(PS1.cyan)
  if (material === 2) return { r: kit.r * 0.62, g: kit.g * 0.62, b: kit.b * 0.8 }
  if (material === 3) return hexToRgb(PS1.red)
  return kit
}


export interface Ps1ModelProps {
  readonly mesh: Mesh
  readonly color: string
  readonly size: number
  /** Drives turntable speed — a busy driver's model visibly revs. */
  readonly intensity?: number
  /** Radians per second at rest, before intensity. */
  readonly spin?: number
  /** How far the model bobs, in model units. Zero for anything on wheels. */
  readonly bob?: number
  readonly label?: string
  readonly ariaLabel?: string
}

/**
 * Turns one mesh on a turntable, the way a console's character select did.
 */
export function Ps1Model({
  mesh,
  color,
  size,
  intensity = 0,
  spin = 0.0006,
  bob = 0.045,
  ariaLabel,
}: Ps1ModelProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Everything the frame loop reads lives behind a ref: the loop is bound
  // once, and a colour or a burn rate changing must not rebind it.
  const intensityRef = useRef(intensity)
  intensityRef.current = intensity
  const colorRef = useRef(color)
  colorRef.current = color
  const meshRef = useRef(mesh)
  meshRef.current = mesh

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
      yaw += (spin + intensityRef.current * 0.0022) * delta

      const kit = hexToRgb(colorRef.current)
      const bobY = Math.sin(elapsed / 900) * bob
      const model = meshRef.current

      ctx.clearRect(0, 0, RENDER_SIZE, RENDER_SIZE)

      const projected = model.vertices.map((vertex) =>
        project(vertex, yaw, bobY, RENDER_SIZE),
      )

      // No z-buffer: sort whole faces by average depth and paint back to front.
      const ordered = model.faces
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

        const va = model.vertices[face.a]
        const vb = model.vertices[face.b]
        const vc = model.vertices[face.c]
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
  }, [spin, bob])

  return (
    <canvas
      ref={canvasRef}
      width={RENDER_SIZE}
      height={RENDER_SIZE}
      aria-label={ariaLabel ?? 'player model'}
      role="img"
      className="ps1-avatar"
      style={{ width: size, height: size }}
    />
  )
}
