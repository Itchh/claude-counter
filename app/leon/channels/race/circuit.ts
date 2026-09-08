import * as THREE from 'three'
import type { TrackDefinition, TrackFrame } from './tracks/types'

// The circuit. A closed Catmull-Rom spline is the whole source of truth: the
// road ribbon, the kerbs, the kart positions, the minimap and the trackside
// cameras are all sampled from it, so changing these control points changes
// everything at once.
//
// This used to be a module of constants — one hard-coded oval, read directly
// by six files. It is a factory now because the channel runs a different
// circuit each race, and a module-level singleton cannot be swapped. The
// helpers are otherwise unchanged; they just close over a definition instead
// of over a file-scoped array.

const UP = new THREE.Vector3(0, 1, 0)

export interface Circuit {
  readonly definition: TrackDefinition
  readonly curve: THREE.CatmullRomCurve3
  /** Lap distance in game units. Drives lap times and grid spacing. */
  readonly length: number
  readonly halfWidth: number
  readonly laneCount: number
  /**
   * Half the circuit's widest span. The camera rig sizes its establishing
   * shot off this, which is what stops a 340-unit road course being framed
   * like the 70-unit oval the shot was originally written for.
   */
  readonly radius: number

  /** Sideways offset for a lane index, in game units from the centreline. */
  laneOffset(laneIndex: number): number
  /**
   * Signed curvature at a point on the lap, in radians per game unit.
   *
   * Positive means the road bends towards the side `sample` calls positive,
   * which is the outside of a right-hand bend. The simulation multiplies this
   * by speed squared to get the sideways load on a car, so the sign is what
   * decides which way a drift goes — get it backwards and the field slides
   * into the apex instead of away from it.
   */
  curvatureAt(t: number): number
  /**
   * Position and orientation at a normalised distance around the lap, offset
   * sideways into a lane. Allocates fresh vectors — callers in a frame loop
   * should use `sampleInto` instead.
   */
  sample(t: number, lateral: number): TrackFrame
  /**
   * Signed curvature at a point on the lap, in radians per unit of road.
   *
   * Positive means the road bends towards `UP × tangent` — the same side a
   * positive `lateral` offset lies on — so the sign says directly which way a
   * sliding car gets thrown, and which way its nose has to point to catch it.
   * That correspondence is the reason this is signed rather than a magnitude:
   * an unsigned curvature tells you a corner is coming but not which way to
   * fall out of it.
   */
  curvatureAt(t: number): number
  /** Allocation-free variant for useFrame. */
  sampleInto(
    t: number,
    lateral: number,
    outPosition: THREE.Vector3,
    outTangent: THREE.Vector3,
  ): void
  /**
   * Overrides the spline's height with a measured one.
   *
   * The traced spline's x/z are good — they came off the road's own
   * footprint — but its y is guesswork from a 2D grid, and on the mountain
   * rips it runs metres above or below the tarmac in places. Once the model
   * is actually loaded the truth is available for the asking, so TrackModel
   * raycasts the road at `HEIGHT_PROFILE_SAMPLES` points around the lap and
   * hands the result back here. Every consumer of `sample`/`sampleInto` —
   * cars, cameras, effects, parked props — is corrected by the one call.
   *
   * Null clears it (a new model is about to measure its own).
   */
  setHeightProfile(profile: Float32Array | null): void
  /**
   * Road surface as a flat ribbon of quads. Only used by the procedural
   * circuit; an imported track brings its own tarmac.
   */
  buildRoadGeometry(segments: number): THREE.BufferGeometry
  /** Raised kerb strip running alongside one edge of the road. */
  buildKerbGeometry(
    segments: number,
    side: -1 | 1,
    width: number,
    height: number,
  ): THREE.BufferGeometry
}

export function createCircuit(definition: TrackDefinition): Circuit {
  const curve = new THREE.CatmullRomCurve3(
    definition.controlPoints.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
    true,
    'catmullrom',
    definition.curveTension,
  )

  const length = curve.getLength()
  const { roadHalfWidth: halfWidth, laneCount } = definition

  // Lanes keep karts from occupying the same metre of tarmac. A kart is ~1.3m
  // across including wheels, so the inset has to clear that or bodies overlap
  // and the onboard camera ends up inside a rival.
  const LANE_INSET = 1.3
  const span = Math.max(0, (halfWidth - LANE_INSET) * 2)
  const step = span / Math.max(1, laneCount - 1)

  const bounds = new THREE.Box3().setFromPoints(curve.getSpacedPoints(240))
  const size = bounds.getSize(new THREE.Vector3())
  const radius = Math.max(size.x, size.z) / 2

  // Scratch vectors, per circuit rather than per module. One circuit is live
  // at a time, but a factory that shared mutable state between its products
  // would be a trap waiting for whoever cross-fades two tracks later.
  const scratchTangent = new THREE.Vector3()
  const scratchNormal = new THREE.Vector3()

  const laneOffset = (laneIndex: number): number => -(span / 2) + laneIndex * step

  // See setHeightProfile on the interface. Read every frame by sampleInto,
  // so it lives in a closure rather than behind any kind of lookup.
  let heightProfile: Float32Array | null = null

  const profileHeight = (wrapped: number): number => {
    const profile = heightProfile
    if (!profile || profile.length === 0) return Number.NaN
    const scaled = wrapped * profile.length
    const index = Math.floor(scaled) % profile.length
    const next = (index + 1) % profile.length
    const blend = scaled - Math.floor(scaled)
    return profile[index] * (1 - blend) + profile[next] * blend
  }

  const sample = (t: number, lateral: number): TrackFrame => {
    const wrapped = ((t % 1) + 1) % 1
    const position = curve.getPointAt(wrapped)
    const tangent = curve.getTangentAt(wrapped).normalize()
    const normal = new THREE.Vector3().crossVectors(UP, tangent).normalize()
    position.addScaledVector(normal, lateral)
    const measured = profileHeight(wrapped)
    if (!Number.isNaN(measured)) position.y = measured
    return { position, tangent, normal }
  }

  // Sampling window for the curvature finite difference, as a fraction of
  // the lap. Wide enough to ignore the spline's own wobble, narrow enough
  // that a hairpin does not average out into a bend.
  const CURVATURE_DELTA = 0.004
  const curvatureTangentA = new THREE.Vector3()
  const curvatureTangentB = new THREE.Vector3()
  const curvatureNormal = new THREE.Vector3()

  /**
   * Measured by finite difference rather than analytically. A Catmull-Rom
   * segment has a closed-form second derivative, but three.js does not expose
   * it, and at the width of this road the difference between the two is far
   * below the width of one car.
   */
  const curvatureAt = (t: number): number => {
    const wrapped = ((t % 1) + 1) % 1
    const before = (wrapped - CURVATURE_DELTA + 1) % 1
    const after = (wrapped + CURVATURE_DELTA) % 1

    curve.getTangentAt(before, curvatureTangentA).normalize()
    curve.getTangentAt(after, curvatureTangentB).normalize()
    curvatureNormal.crossVectors(UP, curvatureTangentA).normalize()

    // How far the tangent swung over the window, and towards which side.
    const swing = curvatureTangentB.dot(curvatureNormal)
    const arc = CURVATURE_DELTA * 2 * length
    return arc > 0 ? swing / arc : 0
  }

  const sampleInto = (
    t: number,
    lateral: number,
    outPosition: THREE.Vector3,
    outTangent: THREE.Vector3,
  ): void => {
    const wrapped = ((t % 1) + 1) % 1
    curve.getPointAt(wrapped, outPosition)
    curve.getTangentAt(wrapped, scratchTangent)
    outTangent.copy(scratchTangent).normalize()
    scratchNormal.crossVectors(UP, outTangent).normalize()
    outPosition.addScaledVector(scratchNormal, lateral)
    const measured = profileHeight(wrapped)
    if (!Number.isNaN(measured)) outPosition.y = measured
  }

  /**
   * Built by hand rather than with ExtrudeGeometry so the vertex count stays
   * low enough that the snapping shader reads as wobble rather than as noise.
   */
  const buildRibbon = (
    segments: number,
    innerOffset: number,
    outerOffset: number,
    height: number,
  ): THREE.BufferGeometry => {
    const positions: number[] = []
    const normals: number[] = []
    const indices: number[] = []

    for (let i = 0; i <= segments; i++) {
      const { position, normal } = sample(i / segments, 0)
      for (const offset of [innerOffset, outerOffset]) {
        positions.push(
          position.x + normal.x * offset,
          position.y + height,
          position.z + normal.z * offset,
        )
        normals.push(0, 1, 0)
      }
    }

    for (let i = 0; i < segments; i++) {
      const a = i * 2
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    geometry.setIndex(indices)
    return geometry
  }

  return {
    definition,
    curve,
    length,
    halfWidth,
    laneCount,
    radius,
    laneOffset,
    curvatureAt,
    sample,
    sampleInto,
    setHeightProfile: (profile) => {
      heightProfile = profile
    },
    buildRoadGeometry: (segments) => buildRibbon(segments, -halfWidth, halfWidth, 0),
    buildKerbGeometry: (segments, side, width, height) =>
      buildRibbon(segments, halfWidth * side, (halfWidth + width) * side, height),
  }
}
