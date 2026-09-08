'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useCircuit } from './CircuitContext'
import { BOOST_THRESHOLD, speedFraction, type SimRacer } from './useRaceSim'

// Exhaust flame and tyre smoke for the whole field.
//
// One component for every car rather than one per car, on purpose. Particles
// have to be left *behind* in world space — a system parented to a car drags
// its own smoke along at 30 units a second, which is the single most common
// way this effect ends up looking wrong — so they live at scene root anyway,
// and once they do, pooling the entire grid into two buffers costs two draw
// calls instead of sixteen.
//
// The look is the era's, not a modern particle sim's: chunky nearest-filtered
// sprites, additive flame, no soft particles, no depth write. What sells it is
// entirely the emission rules — where the particles come from and when — and
// those are driven by the same simulation numbers the HUD reads.

/** Particles in flight at once, across all cars. */
const FLAME_POOL = 180
const SMOKE_POOL = 240
/**
 * Impact flashes in flight. Small: a flash lives a fifth of a second and the
 * whole grid can only crash so often, so this is generous for eight cars.
 */
const IMPACT_POOL = 40

/** Flame lifetime, seconds. Very short: this is a flare, not a plume. */
const FLAME_LIFE = 0.34
const SMOKE_LIFE = 1.15
/**
 * Impact flash lifetime, seconds.
 *
 * Two frames at 60Hz would be a glitch and half a second would be an
 * explosion. A fifth of a second is the era's own answer — the sprite is on
 * screen long enough to be *seen* to have happened and gone before the eye
 * can examine it, which is the whole reason it can be four white shapes on a
 * canvas rather than a simulation.
 */
const IMPACT_LIFE = 0.2

/** Particles per second, per car, at full effect. */
const FLAME_RATE = 34
const SMOKE_RATE = 30
/** Smoke released in one go when two cars touch. */
const BUMP_PUFF = 18
/** Sparks thrown off a car-to-car shunt, and off a scrape along a barrier. */
const BUMP_SPARKS = 16
const WALL_SPARKS = 12
/** Smoke released in one go when a car scrubs the barrier. */
const WALL_PUFF = 10
/** How fast a spark leaves the point of contact, in units per second. */
const SPARK_SPEED = 9
/** Spark lifetime, seconds. Shorter than the exhaust's — these are chips. */
const SPARK_LIFE = 0.3

/** How big the flash is at the moment of contact, and what it grows to. */
const IMPACT_SIZE_START = 1.1
const IMPACT_SIZE_END = 2.6
/** How high off the road a flash sits: bumper height, not roof height. */
const IMPACT_HEIGHT = 0.5

/** How hard a car must be sliding before the tyres let go visibly. */
const SMOKE_THRESHOLD = 0.42

/** Where the effects hang off the car, in car-local units. */
const REAR_OFFSET = 1.35
const TRACK_HALF = 0.62
const EXHAUST_HEIGHT = 0.34
const TYRE_HEIGHT = 0.16

// Sprite sizes in world units at the emitter, and what they grow to.
//
// Small, and smaller than instinct suggests. A car is 2.6 units long, so a
// 1.5-unit flame is a fireball half the length of the vehicle — which looked
// fine in a wide shot and completely filled the screen the moment the
// director cut to an onboard camera three units behind the exhaust. These are
// sized against the car, not against the frame.
const FLAME_SIZE = 0.3
const SMOKE_SIZE_START = 0.24
const SMOKE_SIZE_END = 1.1

/**
 * The sprite. A radial falloff drawn once into a small canvas, kept at 16px
 * and nearest-filtered so a particle near the camera is visibly a handful of
 * squares — the same grid as everything else in the scene.
 *
 * Built lazily and shared: a texture per car would be eight uploads of an
 * identical image.
 */
let sharedSprite: THREE.Texture | null = null

function getSprite(): THREE.Texture {
  if (sharedSprite) return sharedSprite

  const size = 16
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) {
    // No 2D context is survivable — a flat white sprite still reads as a
    // particle, it just loses its soft edge — so this warns rather than
    // throwing and taking the whole channel down with it.
    console.warn('RacerFx: 2D context unavailable; particles will be hard squares.')
    sharedSprite = new THREE.Texture()
    return sharedSprite
  }

  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  gradient.addColorStop(0, 'rgba(255,255,255,1)')
  gradient.addColorStop(0.45, 'rgba(255,255,255,0.85)')
  gradient.addColorStop(1, 'rgba(255,255,255,0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, size, size)

  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  sharedSprite = texture
  return texture
}

/**
 * The impact sprite: a four-pointed star with a hot square core, drawn once
 * into a 16px canvas and nearest-filtered like everything else.
 *
 * Hand-drawn rather than derived from a gradient because this is the one
 * effect in the scene that is openly a *symbol*. The era did not simulate a
 * collision, it stamped a shape over it — and the shape is doing something a
 * puff of smoke cannot: saying "that was a hit" in the one frame a glance
 * gets. Sixteen pixels is deliberate. Blown up to two metres it is visibly a
 * handful of squares, which is the same grid the cars and the road are on.
 */
let sharedImpactSprite: THREE.Texture | null = null

function getImpactSprite(): THREE.Texture {
  if (sharedImpactSprite) return sharedImpactSprite

  const size = 16
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) {
    console.warn('RacerFx: 2D context unavailable; impacts will not be drawn.')
    sharedImpactSprite = new THREE.Texture()
    return sharedImpactSprite
  }

  context.clearRect(0, 0, size, size)
  context.fillStyle = '#ffffff'
  // Four arms and a core, in whole pixels. A star drawn with strokes and
  // anti-aliasing would arrive as grey fringes, and grey fringes on an
  // additive sprite are a smudge.
  const arms: ReadonlyArray<readonly [number, number, number, number]> = [
    [7, 0, 2, 16],
    [0, 7, 16, 2],
    [5, 5, 6, 6],
  ]
  for (const [x, y, width, height] of arms) context.fillRect(x, y, width, height)
  // The diagonals, at half strength — what turns a plus into a burst.
  context.fillStyle = 'rgba(255,255,255,0.55)'
  for (let i = 2; i < 14; i++) {
    context.fillRect(i, i, 1, 1)
    context.fillRect(i, 15 - i, 1, 1)
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  sharedImpactSprite = texture
  return texture
}

const POINT_VERTEX = `
  uniform float uMaxSize;
  attribute float aSize;
  attribute vec4 aColor;
  varying vec4 vColor;
  void main() {
    vColor = aColor;
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    // Perspective-correct sizing: a particle is a world-space object that
    // happens to be drawn as a sprite, not a fixed number of screen pixels.
    // ...and clamped, because "world-space object" stops being true when the
    // camera is close enough that one particle would cover the picture. The
    // onboard shot sits a couple of units from the exhaust, which is exactly
    // where an unclamped sprite becomes a full-screen wash of orange.
    // The clamp is per-effect: 24px is right for a particle in a stream of
    // two hundred, and wrong for a single flash that IS the event — capping
    // an impact at the same size hid every crash the camera was close enough
    // to care about.
    gl_PointSize = min(uMaxSize, aSize * (300.0 / max(0.001, -viewPosition.z)));
    gl_Position = projectionMatrix * viewPosition;
  }
`

/** Screen-space ceiling for a stream particle, in pixels. */
const PARTICLE_MAX_PIXELS = 24
/** ...and for an impact flash, which is one sprite and the point of the shot. */
const IMPACT_MAX_PIXELS = 220

const POINT_FRAGMENT = `
  uniform sampler2D uMap;
  varying vec4 vColor;
  void main() {
    vec4 texel = texture2D(uMap, gl_PointCoord);
    gl_FragColor = vec4(vColor.rgb, vColor.a * texel.a);
    if (gl_FragColor.a < 0.02) discard;
  }
`

/**
 * A pool of particles as flat typed arrays.
 *
 * Deliberately not an array of objects. This updates every particle every
 * frame and uploads straight into the geometry's attributes, so the data has
 * to be laid out the way the GPU wants it anyway; keeping a parallel array of
 * JS objects would mean copying between the two sixty times a second for no
 * gain in readability.
 */
interface Pool {
  readonly geometry: THREE.BufferGeometry
  readonly positions: Float32Array
  readonly colors: Float32Array
  readonly sizes: Float32Array
  readonly velocities: Float32Array
  readonly life: Float32Array
  readonly maxLife: Float32Array
  /** Round-robin cursor. Oldest particle is recycled once the pool is full. */
  cursor: number
}

function createPool(count: number): Pool {
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 4)
  const sizes = new Float32Array(count)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 4))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
  // The pool never moves as a whole and particles are already in world space,
  // so the bounding sphere three would compute is meaningless. Culling is
  // switched off at the Points instead — see the JSX.
  geometry.setDrawRange(0, count)

  return {
    geometry,
    positions,
    colors,
    sizes,
    velocities: new Float32Array(count * 3),
    life: new Float32Array(count),
    maxLife: new Float32Array(count),
    cursor: 0,
  }
}

function emit(
  pool: Pool,
  x: number,
  y: number,
  z: number,
  velocityX: number,
  velocityY: number,
  velocityZ: number,
  life: number,
): number {
  const count = pool.sizes.length
  const index = pool.cursor
  pool.cursor = (pool.cursor + 1) % count

  pool.positions[index * 3] = x
  pool.positions[index * 3 + 1] = y
  pool.positions[index * 3 + 2] = z
  pool.velocities[index * 3] = velocityX
  pool.velocities[index * 3 + 1] = velocityY
  pool.velocities[index * 3 + 2] = velocityZ
  pool.life[index] = life
  pool.maxLife[index] = life
  return index
}

interface RacerFxProps {
  readonly racersRef: React.RefObject<SimRacer[]>
  /** Off when the channel is not on screen, so nothing burns in the dark. */
  readonly enabled: boolean
}

export function RacerFx({ racersRef, enabled }: RacerFxProps): React.ReactElement {
  const circuit = useCircuit()
  const flame = useMemo(() => createPool(FLAME_POOL), [])
  const smoke = useMemo(() => createPool(SMOKE_POOL), [])
  const impact = useMemo(() => createPool(IMPACT_POOL), [])

  const sprite = useMemo(getSprite, [])
  const impactSprite = useMemo(getImpactSprite, [])
  const impactMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uMap: { value: impactSprite }, uMaxSize: { value: IMPACT_MAX_PIXELS } },
        vertexShader: POINT_VERTEX,
        fragmentShader: POINT_FRAGMENT,
        transparent: true,
        depthWrite: false,
        // Additive and depth-tested but never occluding: a flash is light, and
        // light off a bumper does not hide the car it came from.
        blending: THREE.AdditiveBlending,
      }),
    [impactSprite],
  )
  const flameMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uMap: { value: sprite }, uMaxSize: { value: PARTICLE_MAX_PIXELS } },
        vertexShader: POINT_VERTEX,
        fragmentShader: POINT_FRAGMENT,
        transparent: true,
        depthWrite: false,
        // Additive, so overlapping flame goes white-hot at the core the way
        // the reference does — the brightness is the density.
        blending: THREE.AdditiveBlending,
      }),
    [sprite],
  )
  const smokeMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: { uMap: { value: sprite }, uMaxSize: { value: PARTICLE_MAX_PIXELS } },
        vertexShader: POINT_VERTEX,
        fragmentShader: POINT_FRAGMENT,
        transparent: true,
        depthWrite: false,
        // Normal blending: smoke has to *occlude*, or it reads as more fire.
        blending: THREE.NormalBlending,
      }),
    [sprite],
  )

  // Compiled programs and GPU buffers are not reclaimed on their own, and this
  // component remounts on every WebGL context restore.
  useEffect(() => {
    return () => {
      flameMaterial.dispose()
      smokeMaterial.dispose()
      impactMaterial.dispose()
      flame.geometry.dispose()
      smoke.geometry.dispose()
      impact.geometry.dispose()
    }
  }, [flame, smoke, impact, flameMaterial, smokeMaterial, impactMaterial])

  // Emission carries a fractional remainder between frames. Without it a rate
  // below one particle per frame rounds to zero and the effect never fires.
  const flameDebt = useRef<number[]>([])
  const smokeDebt = useRef<number[]>([])
  const lastBumps = useRef<number[]>([])
  const lastWalls = useRef<number[]>([])

  const position = useMemo(() => new THREE.Vector3(), [])
  const tangent = useMemo(() => new THREE.Vector3(), [])
  const normal = useMemo(() => new THREE.Vector3(), [])
  // The point of contact is not the car's own position — see `impactT` on the
  // simulation — so it is sampled separately rather than borrowed.
  const contact = useMemo(() => new THREE.Vector3(), [])
  const contactTangent = useMemo(() => new THREE.Vector3(), [])
  const drawnThisFrame = useMemo<number[]>(() => [], [])

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1)
    const field = racersRef.current ?? []
    // Contact points already flashed this frame. Reset rather than
    // reallocated, and at most one entry per car.
    drawnThisFrame.length = 0

    if (enabled) {
      for (let index = 0; index < field.length; index++) {
        const racer = field[index]
        circuit.sampleInto(racer.t, racer.lateral, position, tangent)

        // The emitter hangs off the BODY, not the road. In a drift the body
        // is yawed away from the tangent, and an exhaust computed from the
        // tangent alone slides off the corner of the car — flame coming out
        // of a rear wing's side is the one thing that instantly breaks the
        // effect. So: heading plus yaw, exactly as Racer.tsx points the mesh.
        const heading = Math.atan2(tangent.x, tangent.z) + racer.yaw
        const backX = -Math.sin(heading)
        const backZ = -Math.cos(heading)
        // The body's own right-hand side, for the tyre positions.
        normal.set(-backZ, 0, backX)

        const rearX = position.x + backX * REAR_OFFSET
        const rearZ = position.z + backZ * REAR_OFFSET
        const driftSpeed = racer.speed

        // --- exhaust flame -------------------------------------------------
        // Only above the boost threshold, and ramping from nothing at the
        // threshold to full at the limiter, so the flame lights *in* rather
        // than switching on.
        const pace = speedFraction(racer.speed)
        const boost =
          pace > BOOST_THRESHOLD ? (pace - BOOST_THRESHOLD) / (1 - BOOST_THRESHOLD) : 0

        flameDebt.current[index] = (flameDebt.current[index] ?? 0) + boost * FLAME_RATE * dt
        while (flameDebt.current[index] >= 1) {
          flameDebt.current[index] -= 1
          const side = Math.random() < 0.5 ? -1 : 1
          const spread = (Math.random() - 0.5) * 0.3
          const particle = emit(
            flame,
            rearX + normal.x * (side * TRACK_HALF * 0.5 + spread),
            position.y + EXHAUST_HEIGHT + Math.random() * 0.1,
            rearZ + normal.z * (side * TRACK_HALF * 0.5 + spread),
            // Thrown backwards out of the pipe, against the direction of
            // travel — but at less than the car's own speed, so the flame
            // still trails rather than overtaking the car that made it.
            backX * driftSpeed * 0.28 + (Math.random() - 0.5) * 1.2,
            0.9 + Math.random() * 0.7,
            backZ * driftSpeed * 0.28 + (Math.random() - 0.5) * 1.2,
            FLAME_LIFE * (0.7 + Math.random() * 0.6),
          )
          flame.sizes[particle] = FLAME_SIZE * (0.7 + Math.random() * 0.7)
        }

        // --- tyre smoke ----------------------------------------------------
        // Two sources, one buffer: the tyres letting go in a corner, and the
        // burst thrown off by a shunt. They look the same because they are
        // the same thing — rubber and dust off the surface.
        const slide = racer.driftLoad > SMOKE_THRESHOLD
          ? (racer.driftLoad - SMOKE_THRESHOLD) / (1 - SMOKE_THRESHOLD)
          : 0

        let due = 0
        smokeDebt.current[index] = (smokeDebt.current[index] ?? 0) + slide * SMOKE_RATE * dt

        // A hit is counted, not sampled: the frame loop must never miss a
        // bang because it happened between two of its own ticks.
        const bumps = racer.bumpCount
        const seenBumps = lastBumps.current[index] ?? bumps
        const hitCar = bumps > seenBumps
        lastBumps.current[index] = bumps

        const walls = racer.wallCount
        const seenWalls = lastWalls.current[index] ?? walls
        const hitWall = walls > seenWalls
        lastWalls.current[index] = walls

        if (hitCar) due += BUMP_PUFF
        if (hitWall) due += WALL_PUFF

        while (smokeDebt.current[index] >= 1) {
          smokeDebt.current[index] -= 1
          due += 1
        }

        for (let n = 0; n < due; n++) {
          const side = Math.random() < 0.5 ? -1 : 1
          const particle = emit(
            smoke,
            rearX + normal.x * side * TRACK_HALF,
            position.y + TYRE_HEIGHT,
            rearZ + normal.z * side * TRACK_HALF,
            // Kicked sideways off the tyre and dragged backwards, then left
            // to hang: smoke has no momentum of its own worth modelling.
            normal.x * side * 1.5 + (Math.random() - 0.5) * 1.4 + backX * driftSpeed * 0.12,
            0.7 + Math.random() * 0.6,
            normal.z * side * 1.5 + (Math.random() - 0.5) * 1.4 + backZ * driftSpeed * 0.12,
            SMOKE_LIFE * (0.7 + Math.random() * 0.6),
          )
          smoke.sizes[particle] = SMOKE_SIZE_START
        }

        // --- the bang ------------------------------------------------------
        // Drawn at the point of contact, which the simulation recorded for
        // exactly this: a side-swipe happens at the corner of the car, and a
        // flash at the car's centre reads as the engine going up.
        if (hitCar || hitWall) {
          circuit.sampleInto(racer.impactT, racer.impactLateral, contact, contactTangent)
          // One flash per contact, not one per car. Both cars in a shunt
          // record the *same* point, so drawing it twice puts two additive
          // sprites in the same place and doubles the brightness of exactly
          // the hits that already look biggest. Whoever gets there first this
          // frame draws it; the other one still sparks.
          const already = drawnThisFrame.includes(racer.impactT)
          if (!already) {
            drawnThisFrame.push(racer.impactT)
            const flash = emit(
              impact,
              contact.x,
              contact.y + IMPACT_HEIGHT,
              contact.z,
              0,
              0,
              0,
              IMPACT_LIFE,
            )
            impact.sizes[flash] = IMPACT_SIZE_START
          }

          // Sparks. Thrown into the flame pool rather than a fourth of their
          // own: they are chips of hot metal cooling on the way down, which
          // is the flame's whole behaviour already.
          const count = hitCar ? BUMP_SPARKS : WALL_SPARKS
          for (let n = 0; n < count; n++) {
            const angle = Math.random() * Math.PI * 2
            const speed = SPARK_SPEED * (0.4 + Math.random() * 0.9)
            const particle = emit(
              flame,
              contact.x,
              contact.y + IMPACT_HEIGHT,
              contact.z,
              Math.cos(angle) * speed,
              0.6 + Math.random() * 2.4,
              Math.sin(angle) * speed,
              SPARK_LIFE * (0.6 + Math.random() * 0.8),
            )
            flame.sizes[particle] = FLAME_SIZE * (0.5 + Math.random() * 0.5)
          }
        }
      }
    }

    advanceFlame(flame, dt)
    advanceSmoke(smoke, dt)
    advanceImpacts(impact, dt)
  })

  return (
    <>
      {/* Culling off on both: the particles are in world space inside a
          geometry whose bounds three cannot know, so a computed bounding
          sphere would cull the whole system the moment the camera moved. */}
      <points frustumCulled={false} geometry={smoke.geometry} material={smokeMaterial} />
      <points frustumCulled={false} geometry={flame.geometry} material={flameMaterial} />
      {/* Last, so a flash sits over its own sparks and smoke rather than
          behind them — the bang is the thing being read. */}
      <points frustumCulled={false} geometry={impact.geometry} material={impactMaterial} />
    </>
  )
}

/** Flame: rises, slows, and cools yellow → orange → red as it dies. */
function advanceFlame(pool: Pool, dt: number): void {
  const count = pool.sizes.length
  for (let i = 0; i < count; i++) {
    if (pool.life[i] <= 0) {
      pool.colors[i * 4 + 3] = 0
      continue
    }
    pool.life[i] -= dt

    const drag = 1 - Math.min(1, 3.4 * dt)
    pool.velocities[i * 3] *= drag
    pool.velocities[i * 3 + 2] *= drag
    pool.positions[i * 3] += pool.velocities[i * 3] * dt
    pool.positions[i * 3 + 1] += pool.velocities[i * 3 + 1] * dt
    pool.positions[i * 3 + 2] += pool.velocities[i * 3 + 2] * dt

    // `age` runs 0 at birth to 1 at death.
    const age = 1 - Math.max(0, pool.life[i]) / pool.maxLife[i]
    // Yellow core to orange to deep red. Two straight ramps rather than a
    // curve: the hardware could not hold a smooth gradient either.
    const red = 1
    const green = age < 0.45 ? 0.88 - age * 0.9 : 0.47 - (age - 0.45) * 0.75
    const blue = Math.max(0, 0.5 - age * 1.6)
    pool.colors[i * 4] = red
    pool.colors[i * 4 + 1] = Math.max(0, green)
    pool.colors[i * 4 + 2] = blue
    // Additive already fades towards black, so the alpha only has to take the
    // last of it off rather than carry the whole fade.
    pool.colors[i * 4 + 3] = Math.max(0, 1 - age * age)
  }
  commit(pool)
}

/**
 * Impact: appears at full brightness, opens out, and is gone.
 *
 * No velocity and no drag — a flash does not travel, it happens at a place.
 * The fade is deliberately front-loaded (`1 - age²` rather than `1 - age`) so
 * the sprite is at its whitest in the frame the collision occurs and spends
 * the rest of its life leaving, which is what makes a fifth of a second read
 * as a bang rather than as a light being switched off.
 */
function advanceImpacts(pool: Pool, dt: number): void {
  const count = pool.sizes.length
  for (let i = 0; i < count; i++) {
    if (pool.life[i] <= 0) {
      pool.colors[i * 4 + 3] = 0
      continue
    }
    pool.life[i] -= dt

    const age = 1 - Math.max(0, pool.life[i]) / pool.maxLife[i]
    pool.sizes[i] = IMPACT_SIZE_START + (IMPACT_SIZE_END - IMPACT_SIZE_START) * age
    // White at the core of the moment, cooling through the same yellow the
    // exhaust flame uses so the two effects read as one material.
    pool.colors[i * 4] = 1
    pool.colors[i * 4 + 1] = 1 - age * 0.35
    pool.colors[i * 4 + 2] = Math.max(0, 0.9 - age * 1.5)
    pool.colors[i * 4 + 3] = Math.max(0, 1 - age * age)
  }
  commit(pool)
}

/** Smoke: rises, expands, thins out. */
function advanceSmoke(pool: Pool, dt: number): void {
  const count = pool.sizes.length
  for (let i = 0; i < count; i++) {
    if (pool.life[i] <= 0) {
      pool.colors[i * 4 + 3] = 0
      continue
    }
    pool.life[i] -= dt

    const drag = 1 - Math.min(1, 1.9 * dt)
    pool.velocities[i * 3] *= drag
    pool.velocities[i * 3 + 2] *= drag
    pool.positions[i * 3] += pool.velocities[i * 3] * dt
    pool.positions[i * 3 + 1] += pool.velocities[i * 3 + 1] * dt
    pool.positions[i * 3 + 2] += pool.velocities[i * 3 + 2] * dt

    const age = 1 - Math.max(0, pool.life[i]) / pool.maxLife[i]
    pool.sizes[i] = SMOKE_SIZE_START + (SMOKE_SIZE_END - SMOKE_SIZE_START) * age
    // Starts pale and dirties as it cools, which is what stops a cloud of
    // grey dots reading as fog.
    const grey = 0.72 - age * 0.34
    pool.colors[i * 4] = grey
    pool.colors[i * 4 + 1] = grey * 0.97
    pool.colors[i * 4 + 2] = grey * 0.99
    // Fades in fast, out slowly. A puff that appears at full opacity pops.
    const fadeIn = Math.min(1, age / 0.12)
    pool.colors[i * 4 + 3] = fadeIn * (1 - age) * 0.55
  }
  commit(pool)
}

function commit(pool: Pool): void {
  pool.geometry.attributes.position.needsUpdate = true
  pool.geometry.attributes.aColor.needsUpdate = true
  pool.geometry.attributes.aSize.needsUpdate = true
}
