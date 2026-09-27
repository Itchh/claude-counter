'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useCircuit } from './CircuitContext'
import { CRASH_TUMBLE_SHARE, type SimRacer } from './useRaceSim'

// Rubber on the road, for the whole field.
//
// The smoke says a car is sliding *now*. The marks say where it slid, and
// they keep saying it after the car has gone — which is most of what makes a
// circuit look raced rather than driven around. By the second lap the
// braking zones are black and the hairpin has a fan of streaks across it, and
// none of that costs a decision: a car that slides leaves a mark, and the
// marks fade at the speed the day forgets them.
//
// One geometry, one draw call, for every mark on the circuit. A ring of
// short quads: each frame a sliding car adds one strip per rear wheel,
// between where the tyre touched last time and where it touches now, and
// when the ring is full the oldest strip is overwritten. Nothing allocates
// after mount. The fade is done in the shader from a birth time per vertex,
// so laying a mark writes eight floats and the rest of the buffer is never
// touched again.

/**
 * Strips in the ring, across all cars. Bigger than instinct: at pace a wheel
 * lays two strips a second per unit of SKID_STEP, so a three-car slide fills
 * six hundred in a few seconds and the marks would be gone before the fade
 * had begun. At this size a busy field's marks last their whole fade and a
 * quiet one's last a good deal longer. It is still 28k floats — a fraction
 * of one car's body.
 */
const SKID_SEGMENTS = 2400
/** Metres of road a wheel must cover before it lays the next strip. */
const SKID_STEP = 0.5
/**
 * A gap between contacts longer than this is not a slide continuing, it is
 * a car placed somewhere else — a lap wrap, a remote correction, a respawn —
 * and the strip is not laid across it.
 */
const SKID_BREAK = 3
/** Width of a tyre's mark, in track units. A little under the tyre. */
const SKID_WIDTH = 0.24
/** Seconds a mark takes to fade out completely. */
const SKID_LIFE = 25
/** How dark a fresh mark at full strength is, as an alpha over the tarmac. */
const SKID_OPACITY = 0.62
/**
 * Alpha steps the fade is quantised to. The hardware faded by dithering, not
 * by blending, and eight visible steps between black and gone is what a
 * mark that ages in bands looks like rather than one that dissolves.
 */
const SKID_FADE_STEPS = 8
/** How far above the measured road a mark sits. A hair: the offset does the rest. */
const SKID_LIFT = 0.02
/**
 * How far the measured ground may sit from the field's own answer before it
 * is treated as another surface and ignored. Same band Racer.tsx uses.
 */
const GROUND_SNAP_BAND = 4

/** How hard a car must be sliding before the tyres mark the road. */
const SKID_SLIP_THRESHOLD = 0.45
/**
 * A pace multiplier below this means the car has just been shunted or has
 * hit the wall and is being held back — the tyres are locked and dragging,
 * whatever the slip number says. See speedScale on the simulation.
 */
const SKID_SHUNT_SCALE = 0.72

/** Where the rear tyres are, in car-local units. Same as the smoke's. */
const REAR_OFFSET = 1.35
const TRACK_HALF = 0.62

/** A strip is a quad: four vertices, two triangles. */
const VERTICES_PER_STRIP = 4
const INDICES_PER_STRIP = 6
/** Birth stamp for a strip that has never been laid. Faded out forever. */
const NEVER = -1e9

const SKID_VERTEX = `
  attribute float aBirth;
  attribute float aStrength;
  varying float vBirth;
  varying float vStrength;
  varying float vDepth;
  void main() {
    vBirth = aBirth;
    vStrength = aStrength;
    vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
    vDepth = -viewPosition.z;
    gl_Position = projectionMatrix * viewPosition;
  }
`

// Rubber is not black. It is the tarmac, darker — so the mark multiplies
// what is there rather than painting over it, and a mark on a pale kerb is
// grey while the same mark on dark asphalt is nearly gone. The fog is the
// same argument the PS1 materials make in their own shader: the road under
// the mark is already the fog colour at distance, so a mark only has to
// thin out at the same rate to vanish into it.
const SKID_FRAGMENT = `
  uniform float uTime;
  uniform float uLife;
  uniform float uOpacity;
  uniform float uSteps;
  uniform float uFogNear;
  uniform float uFogFar;
  varying float vBirth;
  varying float vStrength;
  varying float vDepth;
  void main() {
    float age = (uTime - vBirth) / uLife;
    if (age >= 1.0) discard;
    float fade = 1.0 - age;
    float fog = 1.0 - smoothstep(uFogNear, uFogFar, vDepth);
    float alpha = floor(fade * vStrength * fog * uSteps) / uSteps * uOpacity;
    if (alpha < 0.02) discard;
    gl_FragColor = vec4(0.04, 0.04, 0.05, alpha);
  }
`

/**
 * The ring, as flat typed arrays feeding one geometry. Same reasoning as the
 * particle pools next door: the layout is the GPU's, and a parallel array of
 * objects would only be copied into it.
 */
interface SkidBuffer {
  readonly geometry: THREE.BufferGeometry
  readonly positions: Float32Array
  readonly birth: Float32Array
  readonly strength: Float32Array
  /** Next strip to overwrite. */
  cursor: number
  /** True once anything has been written this frame, so the upload is skipped otherwise. */
  dirty: boolean
}

function createSkidBuffer(): SkidBuffer {
  const positions = new Float32Array(SKID_SEGMENTS * VERTICES_PER_STRIP * 3)
  const birth = new Float32Array(SKID_SEGMENTS * VERTICES_PER_STRIP).fill(NEVER)
  const strength = new Float32Array(SKID_SEGMENTS * VERTICES_PER_STRIP)
  // The index never changes: strip n is always vertices 4n..4n+3.
  const indices = new Uint32Array(SKID_SEGMENTS * INDICES_PER_STRIP)
  for (let strip = 0; strip < SKID_SEGMENTS; strip++) {
    const vertex = strip * VERTICES_PER_STRIP
    const index = strip * INDICES_PER_STRIP
    indices[index] = vertex
    indices[index + 1] = vertex + 1
    indices[index + 2] = vertex + 2
    indices[index + 3] = vertex + 2
    indices[index + 4] = vertex + 1
    indices[index + 5] = vertex + 3
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aBirth', new THREE.BufferAttribute(birth, 1))
  geometry.setAttribute('aStrength', new THREE.BufferAttribute(strength, 1))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  // World-space strips all over a circuit hundreds of units across: the
  // bounding sphere three would compute is either stale or the whole track.
  // Culling is off at the mesh instead — see the JSX.
  return { geometry, positions, birth, strength, cursor: 0, dirty: false }
}

/**
 * Lays one strip from the tyre's last contact to its current one. `sideX/Z`
 * is the car's own right-hand unit vector, which is what a tyre's width is
 * measured along — a strip built across the direction of travel would be
 * the right width on a straight and a needle in a full drift.
 */
function layStrip(
  buffer: SkidBuffer,
  fromX: number,
  fromY: number,
  fromZ: number,
  toX: number,
  toY: number,
  toZ: number,
  sideX: number,
  sideZ: number,
  strength: number,
  time: number,
): void {
  const strip = buffer.cursor
  buffer.cursor = (buffer.cursor + 1) % SKID_SEGMENTS
  const half = SKID_WIDTH / 2
  const vertex = strip * VERTICES_PER_STRIP
  const p = buffer.positions
  let offset = vertex * 3
  // Two vertices at the old contact, two at the new, each pair astride the
  // tyre's centreline. Winding matches the index built in createSkidBuffer;
  // the material is double-sided anyway, since a road can be banked past
  // the camera's side of it.
  p[offset++] = fromX - sideX * half
  p[offset++] = fromY
  p[offset++] = fromZ - sideZ * half
  p[offset++] = fromX + sideX * half
  p[offset++] = fromY
  p[offset++] = fromZ + sideZ * half
  p[offset++] = toX - sideX * half
  p[offset++] = toY
  p[offset++] = toZ - sideZ * half
  p[offset++] = toX + sideX * half
  p[offset++] = toY
  p[offset] = toZ + sideZ * half
  for (let corner = 0; corner < VERTICES_PER_STRIP; corner++) {
    buffer.birth[vertex + corner] = time
    buffer.strength[vertex + corner] = strength
  }
  buffer.dirty = true
}

/**
 * Where each car's two rear tyres last touched, and whether they were
 * marking at the time. Flat arrays indexed by car, grown once when a car
 * first appears and never per frame.
 */
interface TyreMemory {
  /** x, y, z per tyre: two tyres per car. */
  contact: Float32Array
  /** 1 while the tyre is laying, so the next strip has a start point. */
  laying: Uint8Array
}

const TYRES_PER_CAR = 2

function ensureMemory(memory: TyreMemory, cars: number): TyreMemory {
  const needed = cars * TYRES_PER_CAR
  if (memory.laying.length >= needed) return memory
  // A new driver joined the grid. Copy what exists; the new tyres start
  // with nothing laid, which is right.
  const contact = new Float32Array(needed * 3)
  contact.set(memory.contact)
  const laying = new Uint8Array(needed)
  laying.set(memory.laying)
  return { contact, laying }
}

interface SkidMarksProps {
  readonly racersRef: React.RefObject<SimRacer[]>
  /** Off when the channel is not on screen. Marks neither lay nor fade while paused. */
  readonly enabled: boolean
}

export function SkidMarks({ racersRef, enabled }: SkidMarksProps): React.ReactElement {
  const circuit = useCircuit()
  const buffer = useMemo(createSkidBuffer, [])
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uLife: { value: SKID_LIFE },
          uOpacity: { value: SKID_OPACITY },
          uSteps: { value: SKID_FADE_STEPS },
          uFogNear: { value: circuit.definition.fog.near },
          uFogFar: { value: circuit.definition.fog.far },
        },
        vertexShader: SKID_VERTEX,
        fragmentShader: SKID_FRAGMENT,
        transparent: true,
        // A mark never occludes anything: it is a stain on a surface that
        // already has the depth.
        depthWrite: false,
        side: THREE.DoubleSide,
        // Pulled towards the camera in depth so the strip beats the road it
        // lies a fingernail above, at every angle — including the onboard
        // shot looking straight along it, where a raw lift of two
        // centimetres is far below what the depth buffer can tell apart
        // at distance and the strips would flicker in and out of the
        // tarmac.
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    [circuit],
  )

  useEffect(() => {
    return () => {
      material.dispose()
      buffer.geometry.dispose()
    }
  }, [material, buffer])

  const memory = useRef<TyreMemory>({ contact: new Float32Array(0), laying: new Uint8Array(0) })
  /**
   * The clock the marks age against. Accumulated from frame deltas rather
   * than read off the wall, so the marks hold still while the channel is
   * paused — a paused race is a still frame, and a still frame's rubber
   * does not fade.
   */
  const clock = useRef(0)
  const position = useMemo(() => new THREE.Vector3(), [])
  const tangent = useMemo(() => new THREE.Vector3(), [])

  useFrame((_, delta) => {
    if (!enabled) return
    const dt = Math.min(delta, 0.1)
    clock.current += dt
    material.uniforms.uTime.value = clock.current

    const field = racersRef.current ?? []
    memory.current = ensureMemory(memory.current, field.length)
    const { contact, laying } = memory.current

    for (let index = 0; index < field.length; index++) {
      const racer = field[index]

      // --- is this car marking the road ------------------------------------
      // Three reasons a tyre draws: it is sliding, it has just been hit and
      // is being dragged back to pace, or the car is tumbling — a wreck
      // scrubs the road hard for as long as it is on it. Strength is the
      // darkness of the mark, so a marginal slide is a faint one.
      const slide =
        racer.driftLoad > SKID_SLIP_THRESHOLD
          ? (racer.driftLoad - SKID_SLIP_THRESHOLD) / (1 - SKID_SLIP_THRESHOLD)
          : 0
      const shunted =
        racer.speedScale < SKID_SHUNT_SCALE ? (SKID_SHUNT_SCALE - racer.speedScale) / SKID_SHUNT_SCALE : 0
      const tumbling =
        racer.crashTimer > 0 && 1 - racer.crashTimer / racer.crashDuration < CRASH_TUMBLE_SHARE
      const strength = tumbling ? 1 : Math.min(1, Math.max(slide, shunted))

      if (strength <= 0) {
        laying[index * TYRES_PER_CAR] = 0
        laying[index * TYRES_PER_CAR + 1] = 0
        continue
      }

      // --- where the tyres are -------------------------------------------
      // Off the body, not the road, exactly as the smoke is placed: in a
      // drift the body is yawed away from the tangent and the marks have to
      // come from where the wheels actually are, or a drift lays two neat
      // lines down the lane while the car is visibly sideways.
      circuit.sampleInto(racer.t, racer.lateral, position, tangent)
      const heading = Math.atan2(tangent.x, tangent.z) + racer.yaw
      const backX = -Math.sin(heading)
      const backZ = -Math.cos(heading)
      const sideX = -backZ
      const sideZ = backX
      const rearX = position.x + backX * REAR_OFFSET
      const rearZ = position.z + backZ * REAR_OFFSET

      for (let tyre = 0; tyre < TYRES_PER_CAR; tyre++) {
        const sign = tyre === 0 ? -1 : 1
        const x = rearX + sideX * sign * TRACK_HALF
        const z = rearZ + sideZ * sign * TRACK_HALF
        // The road under this tyre, not under the car's centre: on a banked
        // corner the two are a wheel's height apart, and a mark floating
        // above the outside wheel is a mark the camera sees the road through.
        const ground = circuit.groundAt(x, z, position.y)
        const y =
          (!Number.isNaN(ground) && Math.abs(ground - position.y) < GROUND_SNAP_BAND ? ground : position.y) +
          SKID_LIFT

        const slot = index * TYRES_PER_CAR + tyre
        const at = slot * 3
        const wasLaying = laying[slot] === 1
        const dx = x - contact[at]
        const dy = y - contact[at + 1]
        const dz = z - contact[at + 2]
        const travelled = Math.sqrt(dx * dx + dy * dy + dz * dz)

        if (!wasLaying || travelled > SKID_BREAK) {
          // First contact of this slide, or a jump. Remember the point and
          // draw nothing yet: a strip needs two ends.
          contact[at] = x
          contact[at + 1] = y
          contact[at + 2] = z
          laying[slot] = 1
          continue
        }
        if (travelled < SKID_STEP) continue

        layStrip(buffer, contact[at], contact[at + 1], contact[at + 2], x, y, z, sideX, sideZ, strength, clock.current)
        contact[at] = x
        contact[at + 1] = y
        contact[at + 2] = z
      }
    }

    if (buffer.dirty) {
      buffer.dirty = false
      buffer.geometry.attributes.position.needsUpdate = true
      buffer.geometry.attributes.aBirth.needsUpdate = true
      buffer.geometry.attributes.aStrength.needsUpdate = true
    }
  })

  // Culling off: the strips are in world space inside a geometry whose
  // bounds three cannot know without being told every frame.
  return <mesh frustumCulled={false} geometry={buffer.geometry} material={material} />
}
