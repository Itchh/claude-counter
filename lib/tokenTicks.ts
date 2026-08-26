const NICE_STEPS = [1, 2, 2.5, 5, 10] as const
const TARGET_TICK_COUNT = 5

/**
 * Round a raw step up to the nearest "nice" number (1, 2, 2.5, 5, 10 x 10^n)
 * so axis labels land on readable values like 100K / 250K / 1M.
 */
function niceStep(rawStep: number): number {
  if (rawStep <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const normalised = rawStep / magnitude
  const step = NICE_STEPS.find((s) => normalised <= s) ?? 10
  return step * magnitude
}

export interface AxisTick {
  readonly value: number
  /** Position along the axis, 0–100. */
  readonly percent: number
}

export interface TokenAxis {
  readonly ticks: readonly AxisTick[]
  readonly step: number
  /** Step expressed as a percentage of the axis width — used for gridlines. */
  readonly stepPercent: number
}

/**
 * Build evenly spaced "mile marker" ticks from 0 to `max`, where `max` is the
 * highest score on the board (i.e. the full width of the longest bar).
 */
export function buildTokenAxis(max: number): TokenAxis {
  const safeMax = max > 0 ? max : 1
  const step = niceStep(safeMax / TARGET_TICK_COUNT)
  const ticks: AxisTick[] = []
  for (let value = 0; value <= safeMax + step * 0.001; value += step) {
    ticks.push({ value, percent: (value / safeMax) * 100 })
  }
  return { ticks, step, stepPercent: (step / safeMax) * 100 }
}
