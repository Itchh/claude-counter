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
//
// The value lives in a CSS custom property rather than a JS constant so it can
// step with the viewport: the wall display wants the chrome large, a laptop
// wants it a touch smaller, and a phone — where the race is only half the
// screen — wants it smaller still. See HUD_SCALE_STYLES for the steps.

/** The custom property every race-chrome layer reads. */
const HUD_SCALE_VAR = 'var(--hud-scale)'
/**
 * The one the stacked layout's panel reads. Identical to the HUD's on a wide
 * screen; on a phone the two part ways, because the race chrome has to shrink
 * to fit a band half the screen tall while the board underneath it is the
 * thing a phone is for and wants full size.
 */
const UI_SCALE_VAR = 'var(--ui-scale)'

/** Chrome zoom on a wall-sized display. Below this width it steps down. */
export const HUD_SCALE_LARGE = 1.35
/** Chrome zoom on an ordinary laptop. */
export const HUD_SCALE_LAPTOP = 1.2
/** Chrome zoom in the narrow layout, where the race is a band above the UI. */
export const HUD_SCALE_NARROW = 0.85
/** Panel zoom in the narrow layout. The type is sized for a phone already. */
export const UI_SCALE_NARROW = 1

/** Viewports at or above this width get the wall-display zoom. */
export const LARGE_BREAKPOINT_PX = 1400
/**
 * Below this width the cabinet stops floating windows over the race and
 * stacks instead — race on top, the board and menu underneath. Shared with
 * useNarrowViewport so the JS layout switch and the CSS steps agree.
 */
export const NARROW_BREAKPOINT_PX = 900

/**
 * The steps, as CSS. Mounted once by the cabinet alongside its other styles.
 */
export const HUD_SCALE_STYLES = `
  :root { --hud-scale: ${HUD_SCALE_LAPTOP}; --ui-scale: ${HUD_SCALE_LAPTOP}; }
  @media (min-width: ${LARGE_BREAKPOINT_PX}px) {
    :root { --hud-scale: ${HUD_SCALE_LARGE}; --ui-scale: ${HUD_SCALE_LARGE}; }
  }
  @media (max-width: ${NARROW_BREAKPOINT_PX - 1}px) {
    :root { --hud-scale: ${HUD_SCALE_NARROW}; --ui-scale: ${UI_SCALE_NARROW}; }
  }
`

/**
 * A layer that fills its parent. Percentages resolve against the parent before
 * the zoom is applied, so the layer still covers the screen exactly while its
 * interior is measured in the smaller, pre-zoom pixels the HUD was drawn in —
 * which is why a bottom-anchored instrument band still sits on the bottom edge.
 */
export const SCALED_SURFACE: CSSProperties = {
  width: '100%',
  height: '100%',
  zoom: HUD_SCALE_VAR,
}

/**
 * Chrome that sizes itself to its contents and hangs off one corner. Its own
 * offsets scale with it, so the ident keeps its proportional inset rather than
 * drifting into the frame edge.
 */
export const SCALED_CHROME: CSSProperties = {
  zoom: HUD_SCALE_VAR,
}

/**
 * The stacked layout's panel: fills its parent like SCALED_SURFACE, but at
 * the panel's own scale rather than the race chrome's.
 */
export const SCALED_PANEL: CSSProperties = {
  width: '100%',
  height: '100%',
  zoom: UI_SCALE_VAR,
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
  return `calc((100${axis} - ${inset}px) / ${HUD_SCALE_VAR})`
}
