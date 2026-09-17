'use client'

import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'

// The floating name over a car, always on.
//
// A billboarded sprite carrying a canvas-drawn label, in the driver's own
// colour over a hard black outline — the same ink treatment every HUD label
// in the channel wears, drawn the way the era drew trackside text: as a
// texture, nearest-sampled, so the low internal resolution pixelates it into
// the same world as everything else rather than floating over it as crisp
// modern type.
//
// It attenuates with distance like any other sprite. A constant screen-size
// tag would stay legible from the establishing shot, but eight of them over
// a distant pack becomes a wall of text with a race somewhere behind it —
// the tower already names the order, and the tag's job is to name the car
// the camera is actually near.

/** Canvas pixels per character cell. Doubled and downscaled for the outline. */
const FONT_PX = 44
const PAD_PX = 14
/** World height of the tag. A car is ~1.1 tall; the tag reads over the roof. */
const TAG_HEIGHT = 0.72
/** Where the tag floats, in car space. Above the live marker's cube. */
const TAG_Y = 1.95

/**
 * The HUD's own face, by family name rather than through the CSS variable —
 * a canvas 2D context resolves no custom properties. Falls back to a plain
 * monospace for the first frames before the @font-face arrives; see the
 * rebake effect below.
 */
const TAG_FONT = `700 ${FONT_PX}px 'MGS1 HUD', 'Courier New', monospace`

interface NameTagProps {
  readonly name: string
  readonly color: string
}

function bakeLabel(name: string, color: string): THREE.CanvasTexture {
  const label = name.toUpperCase()
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return new THREE.CanvasTexture(canvas)

  const font = TAG_FONT
  context.font = font
  const width = Math.ceil(context.measureText(label).width) + PAD_PX * 2
  canvas.width = width
  canvas.height = FONT_PX + PAD_PX * 2

  // Setting width resets the context, so the font goes back on.
  context.font = font
  context.textBaseline = 'middle'
  context.textAlign = 'center'
  const x = canvas.width / 2
  const y = canvas.height / 2

  // The outline: the name stamped in ink at the eight compass offsets, which
  // is exactly how the HUD's CSS text-shadow builds the same edge.
  context.fillStyle = '#000000'
  for (const dx of [-3, 0, 3]) {
    for (const dy of [-3, 0, 3]) {
      if (dx === 0 && dy === 0) continue
      context.fillText(label, x + dx, y + dy)
    }
  }
  context.fillStyle = color
  context.fillText(label, x, y)

  const texture = new THREE.CanvasTexture(canvas)
  // Nearest, so the internal framebuffer quantises the type into the same
  // pixel grid as the car under it.
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export function NameTag({ name, color }: NameTagProps): React.ReactElement {
  // Bumped once the HUD face has finished loading, so a tag baked in the
  // first frames — when the canvas could only reach the fallback monospace —
  // re-bakes in the face the rest of the channel is set in.
  //
  // Deliberately waits on `document.fonts.ready` rather than asking for the
  // face with `document.fonts.load()`. The two look interchangeable and are
  // not: `load()` *starts* a load, which flips the whole FontFaceSet back
  // into its loading state and re-pends the `ready` promise anybody else is
  // already awaiting. The cabinet's boot gate awaits exactly that promise
  // before it can bake its title cloth (see TitleCard), and the race mounts
  // underneath the gate — so a grid of cars each asking for a font held the
  // set in "loading" and left the screen on NOW LOADING for good. `ready` is
  // read-only, so waiting on it can never do that to anyone.
  const [fontEpoch, setFontEpoch] = useState(0)
  useEffect(() => {
    if (document.fonts.check(TAG_FONT)) return
    let live = true
    document.fonts.ready
      .then(() => {
        // Only re-bake if the face actually arrived; otherwise the fallback
        // already on screen is the best there is.
        if (live && document.fonts.check(TAG_FONT)) setFontEpoch((epoch) => epoch + 1)
      })
      .catch(() => {
        // The fallback face is already on screen; nothing further to do.
      })
    return () => {
      live = false
    }
  }, [])

  const texture = useMemo(() => bakeLabel(name, color), [name, color, fontEpoch])

  const material = useMemo(
    () =>
      new THREE.SpriteMaterial({
        map: texture,
        // Drawn through everything at any depth: a name that vanishes behind
        // a hillside or another car is a name the viewer loses exactly when
        // two cars are close enough to need telling apart.
        depthTest: false,
        depthWrite: false,
        transparent: true,
      }),
    [texture],
  )

  useEffect(() => {
    return () => {
      material.dispose()
      texture.dispose()
    }
  }, [material, texture])

  const image = texture.image as HTMLCanvasElement
  const aspect = image.width > 0 && image.height > 0 ? image.width / image.height : 4

  return (
    <sprite
      material={material}
      position={[0, TAG_Y, 0]}
      scale={[TAG_HEIGHT * aspect, TAG_HEIGHT, 1]}
      // After the opaque scene and the effects, so "no depth test" cannot be
      // undone by draw order.
      renderOrder={20}
    />
  )
}
