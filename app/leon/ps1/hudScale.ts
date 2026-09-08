import type { CSSProperties } from 'react'

// One knob for how large the cabinet's chrome reads.
//
// The alternative was raising every number in the type scale and then chasing
// the dozens of paddings, gaps, dial radii and map sizes that were tuned
// against them — a change that would have to be made again the next time
// someone asks for bigger. Scaling the layer instead keeps every proportion
// the HUD was designed with and moves one value.
//
// `zoom` rather than `transform: scale()` on purpose: zoom recomputes font
// sizes and layout at the new size, so the bitmap faces stay crisp and text
// still wraps against the real box. A transform would resample the rendered
// pixels, which on a pixel face is exactly the blur the whole look avoids.
//
// It applies to the HUD layers only. The 3D canvas is deliberately left alone:
// zooming it would shrink the renderer's internal buffer and coarsen the
// picture, and the picture is not what is hard to read from across the room.

/** How much larger than its designed size the chrome is drawn. */
export const HUD_SCALE = 1.35

/**
 * A layer that fills its parent. Percentages resolve against the parent before
 * the zoom is applied, so the layer still covers the screen exactly while its
 * interior is measured in the smaller, pre-zoom pixels the HUD was drawn in —
 * which is why a bottom-anchored instrument band still sits on the bottom edge.
 */
export const SCALED_SURFACE: CSSProperties = {
  width: '100%',
  height: '100%',
  zoom: HUD_SCALE,
}

/**
 * Chrome that sizes itself to its contents and hangs off one corner. Its own
 * offsets scale with it, so the ident keeps its proportional inset rather than
 * drifting into the frame edge.
 */
export const SCALED_CHROME: CSSProperties = {
  zoom: HUD_SCALE,
}

/**
 * A viewport dimension, expressed in the pre-zoom pixels a scaled layer is
 * measured in.
 *
 * `100vw` inside a zoomed element still means the whole viewport, but the box
 * it sizes is then multiplied by the zoom — so a panel written as
 * `min(430px, 100vw - 40px)` renders 35% wider than the viewport it was
 * trying to fit inside, and runs off the edge of the screen. Anything that
 * has to fit the frame rather than hug its own contents has to divide the
 * measurement back down.
 */
export function scaledViewport(axis: 'vw' | 'vh', inset: number): string {
  return `calc((100${axis} - ${inset}px) / ${HUD_SCALE})`
}
