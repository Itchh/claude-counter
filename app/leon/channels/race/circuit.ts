import * as THREE from 'three'

// The circuit. A closed Catmull-Rom spline is the whole source of truth: the
// road ribbon, the kerbs, the kart positions and the trackside cameras are all
// sampled from it, so changing these control points changes everything at once.

const CONTROL_POINTS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, -34],
  [22, 0, -28],
  [34, 0, -8],
  [30, 0, 14],
  [12, 0, 26],
  [-8, 0, 30],
  [-26, 0, 20],
  [-36, 0, 0],
  [-30, 0, -20],
  [-14, 0, -34],
]

export const TRACK_CURVE = new THREE.CatmullRomCurve3(
  CONTROL_POINTS.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
  true,
  'catmullrom',
  0.5,
)

export const TRACK_LENGTH = TRACK_CURVE.getLength()
// Wide enough that eight karts abreast don't intersect: a kart is ~1.3m across
// including wheels, so the lane step has to clear that or bodies overlap and
// the onboard camera ends up inside a rival.
export const ROAD_HALF_WIDTH = 7.4
/** Lanes keep karts from occupying the same metre of tarmac. */
export const LANE_COUNT = 8
const LANE_INSET = 1.3

export function laneOffset(laneIndex: number): number {
  const span = (ROAD_HALF_WIDTH - LANE_INSET) * 2
  const step = span / Math.max(1, LANE_COUNT - 1)
  return -(span / 2) + laneIndex * step
}

export interface TrackFrame {
  readonly position: THREE.Vector3
  readonly tangent: THREE.Vector3
  readonly normal: THREE.Vector3
}

const UP = new THREE.Vector3(0, 1, 0)

/**
 * Position and orientation at a normalised distance around the lap, offset
 * sideways into a lane. Allocates fresh vectors — callers in a frame loop
 * should use `sampleTrackInto` instead.
 */
export function sampleTrack(t: number, lateral: number): TrackFrame {
  const wrapped = ((t % 1) + 1) % 1
  const position = TRACK_CURVE.getPointAt(wrapped)
  const tangent = TRACK_CURVE.getTangentAt(wrapped).normalize()
  const normal = new THREE.Vector3().crossVectors(UP, tangent).normalize()
  position.addScaledVector(normal, lateral)
  return { position, tangent, normal }
}

const scratchTangent = new THREE.Vector3()
const scratchNormal = new THREE.Vector3()

/** Allocation-free variant for useFrame. */
export function sampleTrackInto(
  t: number,
  lateral: number,
  outPosition: THREE.Vector3,
  outTangent: THREE.Vector3,
): void {
  const wrapped = ((t % 1) + 1) % 1
  TRACK_CURVE.getPointAt(wrapped, outPosition)
  TRACK_CURVE.getTangentAt(wrapped, scratchTangent)
  outTangent.copy(scratchTangent).normalize()
  scratchNormal.crossVectors(UP, outTangent).normalize()
  outPosition.addScaledVector(scratchNormal, lateral)
}

/**
 * Road surface as a flat ribbon of quads. Built by hand rather than with
 * ExtrudeGeometry so the vertex count stays low enough that the snapping
 * shader reads as wobble rather than as noise.
 */
export function buildRoadGeometry(segments: number): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []

  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const { position, normal } = sampleTrack(t, 0)
    for (const side of [-1, 1] as const) {
      positions.push(
        position.x + normal.x * ROAD_HALF_WIDTH * side,
        position.y,
        position.z + normal.z * ROAD_HALF_WIDTH * side,
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

/** Raised kerb strip running alongside one edge of the road. */
export function buildKerbGeometry(
  segments: number,
  side: -1 | 1,
  width: number,
  height: number,
): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []

  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const { position, normal } = sampleTrack(t, 0)
    const inner = ROAD_HALF_WIDTH * side
    const outer = (ROAD_HALF_WIDTH + width) * side

    positions.push(
      position.x + normal.x * inner,
      position.y + height,
      position.z + normal.z * inner,
    )
    normals.push(0, 1, 0)
    positions.push(
      position.x + normal.x * outer,
      position.y + height,
      position.z + normal.z * outer,
    )
    normals.push(0, 1, 0)
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
