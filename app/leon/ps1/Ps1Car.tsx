'use client'

import { useEffect, useMemo, useState } from 'react'
import { bakeCarSprite, SPRITE_FRAMES } from './carSprite'
import { Ps1Model, type Face, type Mesh, type Vec3 } from './softModel'

// The driver's car, on a turntable, in the driver's own colour.
//
// It replaces the bust on the scoreboard for the reason the era's own select
// screens showed a machine rather than a portrait: this is a racing channel,
// the thing being compared is a car, and five rows of near-identical heads
// told the room nothing.
//
// What a row actually shows is the *same car that is out on the circuit* —
// same mesh, same painted livery — pre-rendered into a sprite sheet by
// carSprite.ts and stepped through by CSS. That indirection is not shyness
// about 3D: a live canvas per row is a WebGL context per row, and the browser
// rations those hard enough that a sixth driver could cost the race channel
// its scene.
//
// The forty-triangle car below is the fallback, and it earns its place twice:
// it is what the rows draw while the bake is in flight, and it is what they
// keep drawing if there is no WebGL to bake with at all.

/**
 * Body shapes, one per driver, cycled by their place on the board.
 *
 * The pack the race draws from ships eight cars and hands them out by index
 * (see `carModelFor`), so a driver already has a car; these are the same idea
 * at a fortieth of the polygons. Proportions only — a hatch is short and tall,
 * a coupe is long and low — because a silhouette is what survives at this
 * size and a spoiler is four triangles nobody will resolve.
 */
interface CarShape {
  /** Half-length, nose to tail. */
  readonly length: number
  /** Half-width across the body. */
  readonly width: number
  /** Roof height above the sill. */
  readonly roof: number
  /** Where the cabin sits, -1 nose to 1 tail. */
  readonly cabinBias: number
  /** How much narrower the cabin is than the body, 0..1. */
  readonly cabinInset: number
  /** Ride height — the gap between sill and ground. */
  readonly ride: number
}

const SHAPES: ReadonlyArray<CarShape> = [
  { length: 1.05, width: 0.52, roof: 0.42, cabinBias: 0.06, cabinInset: 0.18, ride: 0.2 },
  { length: 1.18, width: 0.5, roof: 0.34, cabinBias: 0.18, cabinInset: 0.22, ride: 0.16 },
  { length: 0.92, width: 0.54, roof: 0.5, cabinBias: -0.04, cabinInset: 0.14, ride: 0.26 },
  { length: 1.12, width: 0.56, roof: 0.38, cabinBias: 0.1, cabinInset: 0.2, ride: 0.18 },
  { length: 1.0, width: 0.48, roof: 0.46, cabinBias: -0.1, cabinInset: 0.16, ride: 0.24 },
  { length: 1.22, width: 0.52, roof: 0.32, cabinBias: 0.22, cabinInset: 0.24, ride: 0.14 },
  { length: 0.96, width: 0.58, roof: 0.44, cabinBias: 0.0, cabinInset: 0.12, ride: 0.28 },
  { length: 1.08, width: 0.5, roof: 0.4, cabinBias: 0.14, cabinInset: 0.2, ride: 0.22 },
]

/**
 * Everything below is written at a comfortable arm's-length scale and then
 * multiplied, because the renderer's camera is fixed: the bust it was built
 * for is a head and shoulders, and a car drawn to the same numbers sits in
 * the middle of the frame like a die-cast toy on a shelf. This fills it.
 */
const SCALE = 1.32

/** Sill height above the model's own origin. Wheels hang below it. */
const SILL_Y = -0.18
const WHEEL_RADIUS = 0.21
const WHEEL_WIDTH = 0.07
const WHEEL_SIDES = 6

/** Materials, as softModel reads them. */
const BODY = 0
const GLASS = 1
const SHADE = 2
const LAMP = 3

function box(
  vertices: Vec3[],
  faces: Face[],
  min: Vec3,
  max: Vec3,
  materials: {
    readonly sides: number
    readonly top?: number
    readonly front?: number
    readonly back?: number
  },
): void {
  const start = vertices.length
  for (const y of [min.y, max.y]) {
    for (const z of [min.z, max.z]) {
      for (const x of [min.x, max.x]) vertices.push({ x, y, z })
    }
  }
  // Corner indices, low y first: 0..3 bottom, 4..7 top, x fastest.
  const quad = (a: number, b: number, c: number, d: number, material: number): void => {
    faces.push({ a: start + a, b: start + b, c: start + c, material })
    faces.push({ a: start + a, b: start + c, c: start + d, material })
  }
  const { sides, top = sides, front = sides, back = sides } = materials
  quad(4, 5, 7, 6, top)
  quad(0, 2, 3, 1, sides)
  quad(0, 1, 5, 4, back)
  quad(2, 6, 7, 3, front)
  quad(0, 4, 6, 2, sides)
  quad(1, 3, 7, 5, sides)
}

function wheel(
  vertices: Vec3[],
  faces: Face[],
  x: number,
  z: number,
  centreY: number,
): void {
  const start = vertices.length
  for (const side of [-WHEEL_WIDTH, WHEEL_WIDTH]) {
    for (let step = 0; step < WHEEL_SIDES; step += 1) {
      const angle = (step / WHEEL_SIDES) * Math.PI * 2
      vertices.push({
        x: x + side,
        y: centreY + Math.sin(angle) * WHEEL_RADIUS,
        z: z + Math.cos(angle) * WHEEL_RADIUS,
      })
    }
  }
  for (let step = 0; step < WHEEL_SIDES; step += 1) {
    const next = (step + 1) % WHEEL_SIDES
    const innerA = start + step
    const innerB = start + next
    const outerA = start + WHEEL_SIDES + step
    const outerB = start + WHEEL_SIDES + next
    faces.push({ a: innerA, b: outerA, c: outerB, material: SHADE })
    faces.push({ a: innerA, b: outerB, c: innerB, material: SHADE })
  }
}

/**
 * Builds one car. Cheap enough to call per row, but memoised at the call site
 * anyway — the shape only changes when the driver's place does.
 */
export function buildCar(variant: number): Mesh {
  const shape = SHAPES[((variant % SHAPES.length) + SHAPES.length) % SHAPES.length]
  const vertices: Vec3[] = []
  const faces: Face[] = []

  // Body: sill to waist, full length. The tail face carries the lamps.
  const waistY = SILL_Y + shape.ride + 0.24
  box(
    vertices,
    faces,
    { x: -shape.width, y: SILL_Y + shape.ride, z: -shape.length },
    { x: shape.width, y: waistY, z: shape.length },
    { sides: BODY, top: BODY, front: BODY, back: BODY },
  )

  // Cabin: narrower, shorter, sitting on the waist. Its long faces are glass,
  // which is the whole reason a car reads as a car at this size — a plain
  // block in one colour is a brick.
  const cabinLength = shape.length * 0.52
  const cabinCentre = shape.length * shape.cabinBias
  const cabinWidth = shape.width * (1 - shape.cabinInset)
  box(
    vertices,
    faces,
    { x: -cabinWidth, y: waistY, z: cabinCentre - cabinLength },
    { x: cabinWidth, y: waistY + shape.roof, z: cabinCentre + cabinLength },
    { sides: GLASS, top: BODY, front: GLASS, back: GLASS },
  )

  // Tail lamps: two shallow plates on the back face, the one hot accent.
  const lampY = SILL_Y + shape.ride + 0.12
  for (const side of [-1, 1] as const) {
    box(
      vertices,
      faces,
      { x: side * shape.width * 0.78 - 0.09, y: lampY, z: shape.length },
      { x: side * shape.width * 0.78 + 0.09, y: lampY + 0.1, z: shape.length + 0.03 },
      { sides: LAMP },
    )
  }

  // Wheels sit at the body's own width, not inside it: tucked in they
  // disappeared behind the sill from every angle the turntable passes
  // through, and a car with no visible wheels is a doorstop.
  const axle = shape.length * 0.6
  for (const z of [-axle, axle]) {
    for (const x of [-shape.width, shape.width]) {
      wheel(vertices, faces, x, z, SILL_Y + shape.ride - 0.02)
    }
  }

  return {
    vertices: vertices.map((vertex) => ({
      x: vertex.x * SCALE,
      y: vertex.y * SCALE,
      z: vertex.z * SCALE,
    })),
    faces,
  }
}

interface Ps1CarProps {
  readonly color: string
  readonly size: number
  /** Which car in the pack's order — the driver's place on the board. */
  readonly variant: number
  /** Drives turntable speed — a busy driver's car visibly revs. */
  readonly intensity?: number
  readonly label?: string
}

/** Seconds for one revolution of the baked turntable, at rest. */
const TURNTABLE_S = 9
/** How much a driver at full burn speeds it up. */
const TURNTABLE_BOOST = 2.4

export function Ps1Car({
  color,
  size,
  variant,
  intensity = 0,
  label,
}: Ps1CarProps): React.ReactElement {
  const mesh = useMemo(() => buildCar(variant), [variant])
  const [sheet, setSheet] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    // Cleared first: the row is about to show a different car, and holding
    // the previous driver's sheet while the new bake is in flight — or
    // forever, if it fails — puts the wrong car against the right name.
    setSheet(null)
    bakeCarSprite(variant, color)
      .then((url) => {
        if (live) setSheet(url)
      })
      .catch((error) => {
        // Not fatal, and not silent: the drawn car stays on screen, but a
        // pack that has stopped loading should say so once.
        console.warn('Ps1Car: falling back to the drawn car', error)
      })
    return () => {
      live = false
    }
  }, [variant, color])

  if (sheet) {
    return (
      <div
        role="img"
        aria-label={label ? `${label}'s car` : "driver's car"}
        className="ps1-car-sprite"
        style={{
          width: size,
          height: size,
          backgroundImage: `url(${sheet})`,
          backgroundSize: `100% ${SPRITE_FRAMES * 100}%`,
          // Stepped, never eased: the sheet is twelve discrete frames and
          // sliding between them would smear two of them together.
          animationDuration: `${TURNTABLE_S / (1 + intensity * TURNTABLE_BOOST)}s`,
          animationTimingFunction: `steps(${SPRITE_FRAMES})`,
        }}
      />
    )
  }

  return (
    <Ps1Model
      mesh={mesh}
      color={color}
      size={size}
      intensity={intensity}
      // Slower than the bust and dead level: a car on a turntable rotates,
      // it does not bob, and a floating car is the one thing that would make
      // this read as a sprite rather than as a model.
      spin={0.00045}
      bob={0}
      ariaLabel={label ? `${label}'s car` : "driver's car"}
    />
  )
}
