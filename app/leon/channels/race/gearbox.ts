// The gearbox. Six speeds, as every car in those games had.
//
// A car's pace is its burn rate, and until now that was the whole of it: the
// gear on the HUD was which band of the tachometer the rate sat in, a second
// reading of one number. Now every car carries a gear and an engine speed of
// its own, driven by the road speed the simulation is actually moving it at —
// so a car recovering from a shunt climbs back through the box, and a car
// held at its ceiling sits in top with the revs on the line.
//
// Ceilings are fractions of the field's top speed, and they start high
// because the field's floor does: an idling car still rolls at a third of
// full pace, so first gear is short, and the rest divide what is left.

/** Speed, as a fraction of MAX_SPEED, at which each gear runs out. */
const GEAR_CEILINGS: ReadonlyArray<number> = [0.42, 0.52, 0.63, 0.75, 0.87, 1]
export const GEAR_COUNT = GEAR_CEILINGS.length

/** Where the needle rests in first with the car barely rolling. */
const IDLE_RPM = 0.12
/** Where the revs land after an upshift, as a fraction of the redline. */
const SHIFT_DROP_RPM = 0.48

/** Units per second to miles per hour. The track is metric. */
const MPH_PER_UNIT_PER_SECOND = 2.23694

export interface GearState {
  /** 1..GEAR_COUNT. */
  readonly gear: number
  /** Engine speed as a fraction of the redline, 0..1. */
  readonly rpm: number
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/**
 * Gear and revs for a car at `fraction` of top speed.
 *
 * Revs climb linearly through each gear from the drop-in point to the
 * redline, then fall back on the shift. The drop is what makes a box read as
 * a box: a needle that only ever climbs is a speedometer with extra steps.
 */
export function gearFor(fraction: number): GearState {
  const speed = clamp01(fraction)
  let floor = 0
  for (let index = 0; index < GEAR_CEILINGS.length; index++) {
    const ceiling = GEAR_CEILINGS[index]
    const isTop = index === GEAR_CEILINGS.length - 1
    if (speed < ceiling || isTop) {
      const within = clamp01((speed - floor) / (ceiling - floor))
      const base = index === 0 ? IDLE_RPM : SHIFT_DROP_RPM
      return { gear: index + 1, rpm: clamp01(base + (1 - base) * within) }
    }
    floor = ceiling
  }
  return { gear: GEAR_COUNT, rpm: 1 }
}

export function toMph(unitsPerSecond: number): number {
  return Math.max(0, unitsPerSecond) * MPH_PER_UNIT_PER_SECOND
}
