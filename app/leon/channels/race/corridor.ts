// The gap the cars actually have to drive down.
//
// Two representations, and the distinction between them is the whole of this
// file. A circuit's BOUNDARIES are where its walls are: raw, measured, per
// sample around the lap, in the lateral units the simulation clamps in, and
// written down in `<slug>.track.json` by scripts/bakeCorridor.mjs. A
// circuit's CORRIDOR is what the simulation may use of that: the same
// measurement with a car's shoulder taken off it, capped at the nominal road
// width, floored so a gantry leg cannot pin the field to one line, and
// smoothed so a rail ending between two samples does not shove a car
// sideways.
//
// Keeping them apart is what makes the boundaries editable. Clearance and
// caps are simulation judgements that will be tuned; where the barrier is, is
// a fact about the model. Bake the tuned numbers into the JSON and the file
// stops being a description of the circuit and becomes a description of this
// week's handling.

/**
 * Where the walls are, measured around the lap.
 *
 * Offsets are signed in the circuit's own lateral convention — positive along
 * `UP × tangent`, so `right` is positive and `left` negative — and `null`
 * means the rays reached their limit without touching anything. That null is
 * load-bearing: an open verge is a fact about the road, not a failed
 * measurement, and the nominal width stands there.
 */
export interface TrackBoundaries {
  readonly samples: number
  /** Heights above the road the measuring rays were fired at. */
  readonly probeHeights: ReadonlyArray<number>
  readonly left: ReadonlyArray<number | null>
  readonly right: ReadonlyArray<number | null>
}

/**
 * The free road, as the simulation reads it.
 *
 * Two numbers per sample, both in track units sideways off the centreline:
 * where the middle of the free road is, and how much of it there is either
 * side of that middle.
 */
export interface RoadCorridor {
  readonly samples: number
  /** Lateral offset of the free road's centre from the spline, per sample. */
  readonly centre: Float32Array
  /** Half the free width, measured around that centre. */
  readonly halfWidth: Float32Array
}

/** Somewhere to put a corridor lookup without allocating in a frame loop. */
export interface CorridorSample {
  centre: number
  halfWidth: number
}

/**
 * How far a car is kept off a wall, in game units. A car is 1.7 across in the
 * simulation's own contact box, so this is its shoulder plus a little air —
 * enough that a scrape reads as a scrape rather than as a body halfway
 * through a fence.
 */
export const BARRIER_CLEARANCE = 1.15
/**
 * Narrowest the corridor may get. A gate, a tunnel mouth or a stray triangle
 * can measure narrower than a car, and a corridor narrower than a car is a
 * field of cars pinned to one line.
 */
export const MIN_CORRIDOR_HALF = 1.8
/**
 * How far the corridor's centre may be moved off the traced line, as a
 * fraction of the nominal half width.
 *
 * The shift is the correction for a line that runs closer to one barrier than
 * the other, and it is capped because it can only ever be a correction. A
 * line that has left the road entirely wants re-drawing, not nudging — and
 * letting this pull cars an unbounded distance sideways would hide that
 * rather than show it. The bake does the real correction now (see
 * scripts/bakeCorridor.mjs, which moves the control points themselves); what
 * is left for the runtime is the last few centimetres.
 */
export const MAX_CORRIDOR_SHIFT = 0.8

/**
 * Turns measured walls into the corridor the cars are held inside.
 *
 * Shared by the two places that produce one — the baked boundaries read out
 * of a track's JSON, and the live measurement TrackModel falls back to for a
 * circuit that has none — because a car's clearance from a barrier should not
 * depend on which of those two answered.
 */
export function corridorFromWalls(
  boundaries: TrackBoundaries,
  nominalHalfWidth: number,
): RoadCorridor {
  const samples = boundaries.samples
  const maxShift = nominalHalfWidth * MAX_CORRIDOR_SHIFT
  const centre = new Float32Array(samples)
  const halfWidth = new Float32Array(samples)

  for (let row = 0; row < samples; row++) {
    const right = boundaries.right[row]
    const left = boundaries.left[row]

    // Limits as signed offsets from the line. An unfound wall leaves the
    // nominal width standing on that side.
    const rightLimit =
      right === null || !Number.isFinite(right)
        ? nominalHalfWidth
        : Math.min(nominalHalfWidth, Math.max(-maxShift, right - BARRIER_CLEARANCE))
    const leftLimit =
      left === null || !Number.isFinite(left)
        ? -nominalHalfWidth
        : Math.max(-nominalHalfWidth, Math.min(maxShift, left + BARRIER_CLEARANCE))

    centre[row] = Math.max(-maxShift, Math.min(maxShift, (rightLimit + leftLimit) / 2))
    halfWidth[row] = Math.max(MIN_CORRIDOR_HALF, (rightLimit - leftLimit) / 2)
  }

  smoothCorridor(centre, halfWidth)
  return { samples, centre, halfWidth }
}

/**
 * Takes the measurement noise out, in place.
 *
 * The width runs through a three-tap *minimum* before it is averaged, because
 * the two errors here are not symmetrical: a ray that missed a rail through a
 * gap in it reports the road as wider than it is, and one over-wide sample is
 * a car put through a barrier. Averaging alone would spread that error over
 * its neighbours rather than remove it. The centre is only averaged — there
 * is no safe side to a mis-centred corridor, and a smooth line is what stops
 * the field being nudged sideways sample by sample.
 */
export function smoothCorridor(centre: Float32Array, halfWidth: Float32Array): void {
  const samples = centre.length
  const narrowed = new Float32Array(samples)
  for (let row = 0; row < samples; row++) {
    const before = halfWidth[(row - 1 + samples) % samples]
    const after = halfWidth[(row + 1) % samples]
    narrowed[row] = Math.min(halfWidth[row], before, after)
  }

  const smoothedCentre = new Float32Array(samples)
  for (let row = 0; row < samples; row++) {
    const previous = (row - 1 + samples) % samples
    const next = (row + 1) % samples
    smoothedCentre[row] = (centre[previous] + centre[row] + centre[next]) / 3
    halfWidth[row] = (narrowed[previous] + narrowed[row] + narrowed[next]) / 3
  }
  centre.set(smoothedCentre)
}

/** What a set of measured boundaries turned out to say, in one line. */
export function describeBoundaries(
  boundaries: TrackBoundaries,
  nominalHalfWidth: number,
): string {
  const widths: number[] = []
  let narrowest = Infinity
  let open = 0
  for (let row = 0; row < boundaries.samples; row++) {
    const left = boundaries.left[row]
    const right = boundaries.right[row]
    if (left === null || right === null) {
      open += 1
      continue
    }
    const width = right - left
    widths.push(width)
    narrowest = Math.min(narrowest, width)
  }
  if (widths.length === 0) return 'no walls found anywhere on the lap'
  widths.sort((a, b) => a - b)
  const median = widths[Math.floor(widths.length / 2)]
  const openShare = Math.round((open / boundaries.samples) * 100)
  return (
    `nominal width ${(nominalHalfWidth * 2).toFixed(1)}, ` +
    `median measured ${median.toFixed(1)}, narrowest ${narrowest.toFixed(1)}, ` +
    `${openShare}% of the lap open on at least one side`
  )
}
