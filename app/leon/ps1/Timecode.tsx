'use client'

// The platform's timecode face.
//
// Every number on this screen that measures TIME is drawn on seven segments,
// and nothing that is not a duration ever is. A lap, a split, a total, a
// countdown — those are a machine's readings, so they get a machine's glyphs;
// a rank, a name, a token count and a position stay in the HUD face. Keeping
// that split is what makes the timing read as instrumentation rather than as
// decoration. If everything were a segment display, nothing would be.
//
// Drawn rather than set, and the reason is the bed. A real segment display
// shows its unlit segments under the lit ones, which is why a 1 occupies
// exactly the same width as an 8 and a running clock never reflows mid-lap. A
// font gives you the glyphs and not the bed, so it would have to be faked with
// a ghost "888" layer underneath anyway — at which point the font is doing
// less work than the sixty lines below.
//
// Sized in one number: `size` is the cap height in pixels, and the SVG scales
// to it. Everything else here is in glyph units.

/** Glyph box, in the units every segment below is measured in. */
const DIGIT_WIDTH = 10
const DIGIT_HEIGHT = 18
const THICKNESS = 2.2
/** Gap between glyph boxes, and the width a separator occupies. */
const TRACKING = 3
const SEPARATOR_WIDTH = 5

/**
 * One segment, as the chamfered bar a real display etches: a hexagon whose
 * mitred ends let two segments meet at a corner without overlapping.
 */
function bar(x: number, y: number, length: number, vertical: boolean): string {
  const t = THICKNESS
  const points: ReadonlyArray<readonly [number, number]> = vertical
    ? [
        [x + t / 2, y],
        [x + t, y + t / 2],
        [x + t, y + length - t / 2],
        [x + t / 2, y + length],
        [x, y + length - t / 2],
        [x, y + t / 2],
      ]
    : [
        [x, y + t / 2],
        [x + t / 2, y],
        [x + length - t / 2, y],
        [x + length, y + t / 2],
        [x + length - t / 2, y + t],
        [x + t / 2, y + t],
      ]
  return points.map(([px, py]) => `${px.toFixed(2)},${py.toFixed(2)}`).join(' ')
}

/** The seven segments, in the usual a–g order. */
const SEGMENTS: Readonly<Record<string, string>> = {
  a: bar(0, 0, DIGIT_WIDTH, false),
  b: bar(DIGIT_WIDTH - THICKNESS, 0, DIGIT_HEIGHT / 2 + 1, true),
  c: bar(DIGIT_WIDTH - THICKNESS, DIGIT_HEIGHT / 2 - 1, DIGIT_HEIGHT / 2 + 1, true),
  d: bar(0, DIGIT_HEIGHT - THICKNESS, DIGIT_WIDTH, false),
  e: bar(0, DIGIT_HEIGHT / 2 - 1, DIGIT_HEIGHT / 2 + 1, true),
  f: bar(0, 0, DIGIT_HEIGHT / 2 + 1, true),
  g: bar(0, DIGIT_HEIGHT / 2 - THICKNESS / 2, DIGIT_WIDTH, false),
}

const LIT: Readonly<Record<string, string>> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abdeg',
  '3': 'abcdg',
  '4': 'bcfg',
  '5': 'acdfg',
  '6': 'acdefg',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
  '-': 'g',
}

const SEGMENT_NAMES = Object.keys(SEGMENTS)

function advanceOf(glyph: string): number {
  return LIT[glyph] === undefined ? SEPARATOR_WIDTH : DIGIT_WIDTH + TRACKING
}

export interface TimecodeProps {
  /**
   * The formatted string. Digits, `:`, `.`, `'`, `"` and `-` are drawn;
   * anything else is skipped. `formatLapTime` output goes straight in.
   */
  readonly value: string
  /** Cap height in pixels. */
  readonly size?: number
  readonly color?: string
  /**
   * How brightly the dead segments sit under the lit ones. Lower it over a
   * busy picture, never to zero — the bed is the whole point.
   */
  readonly bedOpacity?: number
  /** Spoken form, for anyone who is not looking at a dashboard. */
  readonly label?: string
}

export function Timecode({
  value,
  size = 22,
  color = '#ff8c1a',
  bedOpacity = 0.16,
  label,
}: TimecodeProps): React.ReactElement {
  const glyphs = value.split('')
  const totalWidth = glyphs.reduce((sum, glyph) => sum + advanceOf(glyph), 0)
  const scale = size / DIGIT_HEIGHT

  let cursor = 0
  return (
    <svg
      width={Math.ceil(totalWidth * scale)}
      height={Math.ceil(DIGIT_HEIGHT * scale)}
      viewBox={`-1 -1 ${totalWidth + 2} ${DIGIT_HEIGHT + 2}`}
      role="img"
      aria-label={label ?? value}
      style={{ display: 'block', overflow: 'visible' }}
    >
      {glyphs.map((glyph, index) => {
        const x = cursor
        cursor += advanceOf(glyph)
        const lit = LIT[glyph]

        if (lit !== undefined) {
          return (
            <g key={index} transform={`translate(${x} 0)`}>
              {SEGMENT_NAMES.map((name) => (
                <polygon
                  key={name}
                  points={SEGMENTS[name]}
                  fill={color}
                  opacity={lit.includes(name) ? 1 : bedOpacity}
                />
              ))}
            </g>
          )
        }

        // The separators. A colon and a decimal point sit on the baseline
        // grid; the minute and second marks hang from the cap line, which is
        // where a lap board has always put them.
        if (glyph === ':') {
          return (
            <g key={index} transform={`translate(${x} 0)`}>
              <rect x={0.6} y={DIGIT_HEIGHT * 0.28} width={2.2} height={2.2} fill={color} />
              <rect x={0.6} y={DIGIT_HEIGHT * 0.62} width={2.2} height={2.2} fill={color} />
            </g>
          )
        }
        if (glyph === '.') {
          return <rect key={index} x={x + 0.6} y={DIGIT_HEIGHT - 2.4} width={2.4} height={2.4} fill={color} />
        }
        if (glyph === "'") {
          return <rect key={index} x={x + 1} y={0} width={1.8} height={4.6} fill={color} />
        }
        if (glyph === '"') {
          return (
            <g key={index} transform={`translate(${x} 0)`}>
              <rect x={0} y={0} width={1.6} height={4.6} fill={color} />
              <rect x={2.8} y={0} width={1.6} height={4.6} fill={color} />
            </g>
          )
        }
        return null
      })}
    </svg>
  )
}
