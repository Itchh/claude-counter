// The New Genre flower, held as the 19×19 bitmap it actually is rather than as
// vector outlines. Kept as a grid so it can never be scaled into something
// smooth: every cell is one square, drawn with crisp edges, in currentColor.

const FLOWER_GRID: readonly string[] = [
  '...####.....####...',
  '.#######...#######.',
  '.########.########.',
  '###################',
  '###################',
  '###################',
  '###################',
  '.########.########.',
  '.#######...#######.',
  '...####.....####...',
  '..######...######..',
  '.########.########.',
  '###################',
  '###################',
  '###################',
  '###################',
  '.#################.',
  '.########.########.',
  '...#####...#####...',
]

const GRID_SIZE = FLOWER_GRID.length

/** Horizontal runs, so a 299-cell bitmap costs ~40 rects instead of 299. */
function rowRuns(row: string): readonly (readonly [number, number])[] {
  const runs: (readonly [number, number])[] = []
  let start: number | null = null
  for (let column = 0; column <= row.length; column += 1) {
    const filled = row[column] === '#'
    if (filled && start === null) start = column
    if (!filled && start !== null) {
      runs.push([start, column - start])
      start = null
    }
  }
  return runs
}

export function NewGenreMark({ size }: { readonly size: string }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${GRID_SIZE} ${GRID_SIZE}`}
      aria-hidden="true"
      focusable="false"
      shapeRendering="crispEdges"
      style={{ display: 'block', flex: '0 0 auto' }}
    >
      {FLOWER_GRID.map((row, rowIndex) =>
        rowRuns(row).map(([start, length]) => (
          <rect
            key={`${rowIndex}-${start}`}
            x={start}
            y={rowIndex}
            width={length}
            height={1}
            fill="currentColor"
          />
        )),
      )}
    </svg>
  )
}
