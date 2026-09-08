'use client'

import { useEffect, useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { createPs1Material, configurePs1Texture } from './Ps1Material'
import { useCircuit } from './CircuitContext'
import { ROAD_CLEARANCE } from './circuit'
import { buildGroundField } from './groundField'
import type { TrackDefinition, TrackSurface } from './tracks/types'

// An imported circuit, rebuilt as PS1 geometry.
//
// Everything expensive already happened offline (see scripts/bakeTrack.mjs) —
// the model that arrives here is 39k triangles with 128px indexed textures,
// down from 314k and a 2K PBR set. What is left to do at runtime is the one
// thing the bake cannot: throw away the source's lighting model entirely.
//
// That is the substance of point 3. A downloaded track is authored for a
// physically-based renderer, so its materials describe how light *behaves* on
// a surface — roughness, metalness, a normal map standing in for geometry that
// was never there. The console had none of that. It had a colour per vertex,
// worked out once, interpolated flat across the triangle, and a fog value. So
// the surfaces are not adjusted here, they are replaced: every material the
// model shipped with is discarded and rebuilt from the track's own palette,
// and the result is lit by the same single directional term as the karts.

interface TrackModelProps {
  readonly definition: TrackDefinition
}

export function TrackModel({ definition }: TrackModelProps): React.ReactElement | null {
  const path = definition.model
  // Hooks cannot be conditional, and the procedural circuit has no model —
  // the caller guards on `definition.model`, so this is only ever reached with
  // a real path. The assertion keeps that contract in one place.
  if (!path) throw new Error(`Track "${definition.slug}" has no model to load`)

  const { scene } = useGLTF(path)

  // Cloned because useGLTF caches by URL: mutating the cached scene's
  // materials would corrupt the copy handed to the next mount, and this
  // channel remounts on every WebGL context loss.
  const model = useMemo(() => {
    const clone = scene.clone(true)
    // Applied here rather than on a wrapping group because everything
    // downstream — the ground index, the height profile, the camera's
    // collision probes — reads world matrices off this object, and a group
    // scaled by React would not have updated them by the time those effects
    // run.
    clone.scale.setScalar(definition.worldScale ?? 1)
    clone.updateMatrixWorld(true)
    return clone
  }, [scene, definition.worldScale])

  const materials = useMemo(
    () => applyTrackSurfaces(model, definition),
    [model, definition],
  )

  useEffect(() => {
    return () => {
      for (const material of materials) material.dispose()
    }
  }, [materials])

  return (
    <>
      <primitive object={model} />
      <SplineGrounding model={model} />
    </>
  )
}

/** Points sampled around the lap when measuring the road's real height. */
const HEIGHT_PROFILE_SAMPLES = 192
/** Measurements taken across the road at each of those samples. */
const HEIGHT_PROFILE_SLOTS = 7
/** How far past the kerb the measured strip reaches, in game units. */
const HEIGHT_PROFILE_MARGIN = 2.5
/**
 * How far a measurement may sit from the spline's own guess before it is
 * treated as something other than the road — a bridge deck, a roof, the
 * inside of a tunnel — and the guess is preferred instead.
 */
const HEIGHT_PLAUSIBLE_BAND = 30

/**
 * Measures the road's actual height around and across the lap, hands it to
 * the circuit, and hands the whole scene the ground index everything else
 * asks about where the world is.
 *
 * The baked spline's x/z trace is derived from the road's own footprint and
 * is trustworthy; its y is reconstructed from a 2D grid and is not — on the
 * mountain circuits it runs metres above or below the tarmac, so the cars
 * hovered in some corners and sank in others. The model itself is the ground
 * truth, and once it is mounted and indexed, asking it is a lookup per
 * sample — see groundField.ts for why that indexing is not optional.
 *
 * It is measured across the road as well as around it because a mountain
 * circuit is banked and cambered: one height per point on the lap is only
 * ever right for a car on the exact centreline, and every other lane was
 * floating above the tarmac or buried in it by however much the road leaned.
 *
 * An effect rather than a bake-time fix, deliberately: it corrects every
 * track that will ever be imported, including ones whose bake nobody
 * re-checks, and it can never disagree with what is actually rendered —
 * because what is actually rendered is what it measured.
 */
function SplineGrounding({ model }: { readonly model: THREE.Object3D }): null {
  const circuit = useCircuit()

  useEffect(() => {
    // The index first, and everything else through it. Built once, in tens of
    // milliseconds; the raycasting version of this effect blocked the main
    // thread for twenty seconds and froze the race where it stood.
    const field = buildGroundField(model)
    circuit.setGround(field)
    // Cleared before measuring, so the probes read the spline's own y as
    // their hint rather than the last track's measurements.
    circuit.setHeightField(null)

    const extent = circuit.halfWidth + HEIGHT_PROFILE_MARGIN
    const slots = HEIGHT_PROFILE_SLOTS
    const centre = (slots - 1) / 2
    const data = new Float32Array(HEIGHT_PROFILE_SAMPLES * slots)
    const point = new THREE.Vector3()
    const tangent = new THREE.Vector3()
    let measuredAnything = false
    let previousCentre = Number.NaN

    for (let row = 0; row < HEIGHT_PROFILE_SAMPLES; row++) {
      circuit.sampleInto(row / HEIGHT_PROFILE_SAMPLES, 0, point, tangent)
      const splineY = point.y
      // The previous sample's road is a better guess than the spline's own y
      // — but only while the two still agree about roughly where the road is,
      // or one bad reading on a roof would drag the rest of the lap up onto it.
      const centreHint =
        Number.isNaN(previousCentre) || Math.abs(previousCentre - splineY) > HEIGHT_PLAUSIBLE_BAND
          ? splineY
          : previousCentre
      const centreHeight = field.heightAt(point.x, point.z, centreHint)
      if (!Number.isNaN(centreHeight)) {
        previousCentre = centreHeight
        measuredAnything = true
      }
      data[row * slots + centre] = centreHeight

      // Sideways from the centre outwards, each column hinted by the one
      // beside it: across a banked road the neighbour is always the closest
      // available truth, and it keeps a barrier top from capturing the strip.
      for (const direction of [-1, 1] as const) {
        let hint = Number.isNaN(centreHeight) ? centreHint : centreHeight
        for (let step = 1; step <= centre; step++) {
          const column = centre + direction * step
          const lateral = (column / centre - 1) * extent
          circuit.sampleInto(row / HEIGHT_PROFILE_SAMPLES, lateral, point, tangent)
          const height = field.heightAt(point.x, point.z, hint)
          if (!Number.isNaN(height)) {
            hint = height
            measuredAnything = true
          }
          data[row * slots + column] = height
        }
      }
    }

    if (!measuredAnything) {
      // Nothing measured at all — a model with no road under the spline.
      // Leave the circuit uncorrected rather than pin the field to NaN.
      console.warn('SplineGrounding: no ground found under the spline; field discarded.')
      circuit.setHeightField(null)
      return () => {
        circuit.setGround(null)
      }
    }

    fillGaps(data, HEIGHT_PROFILE_SAMPLES, slots)

    // A three-tap median pass along the lap: a single reading that caught a
    // barrier top or a kerb edge would otherwise put a step into the road
    // that every car jumps.
    const smoothed = new Float32Array(data.length)
    for (let row = 0; row < HEIGHT_PROFILE_SAMPLES; row++) {
      for (let column = 0; column < slots; column++) {
        const a = data[((row - 1 + HEIGHT_PROFILE_SAMPLES) % HEIGHT_PROFILE_SAMPLES) * slots + column]
        const b = data[row * slots + column]
        const c = data[((row + 1) % HEIGHT_PROFILE_SAMPLES) * slots + column]
        smoothed[row * slots + column] =
          Math.max(Math.min(a, b), Math.min(Math.max(a, b), c)) + ROAD_CLEARANCE
      }
    }

    circuit.setHeightField({
      samples: HEIGHT_PROFILE_SAMPLES,
      slots,
      extent,
      data: smoothed,
    })

    return () => {
      circuit.setHeightField(null)
      circuit.setGround(null)
    }
  }, [model, circuit])

  return null
}

/**
 * Fills every unmeasured cell from its measured neighbours.
 *
 * A missed ray is a gap in the mesh, a bridge seam, or a strip of road that
 * genuinely runs out beyond the kerb. Borrowing sideways first keeps the
 * road's own camber; borrowing around the lap is the fallback when a whole
 * slice of the width found nothing at all.
 */
function fillGaps(data: Float32Array, rows: number, slots: number): void {
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < slots; column++) {
      const index = row * slots + column
      if (!Number.isNaN(data[index])) continue

      // Sideways: nearest measured cell in this row.
      let replacement = Number.NaN
      for (let distance = 1; distance < slots && Number.isNaN(replacement); distance++) {
        const left = column - distance
        const right = column + distance
        if (left >= 0 && !Number.isNaN(data[row * slots + left])) {
          replacement = data[row * slots + left]
        } else if (right < slots && !Number.isNaN(data[row * slots + right])) {
          replacement = data[row * slots + right]
        }
      }

      // Around the lap: nearest measured cell in this column.
      for (let distance = 1; distance <= rows / 2 && Number.isNaN(replacement); distance++) {
        const before = data[((row - distance + rows) % rows) * slots + column]
        const after = data[((row + distance) % rows) * slots + column]
        if (!Number.isNaN(before) && !Number.isNaN(after)) replacement = (before + after) / 2
        else if (!Number.isNaN(before)) replacement = before
        else if (!Number.isNaN(after)) replacement = after
      }

      data[index] = replacement
    }
  }
}

/**
 * Replaces every material in the model with a PS1 one, chosen by the source
 * material's own name.
 *
 * Naming is the only handle a downloaded asset offers — there is no semantic
 * layer in a glTF saying "this is the road" — so an unlisted material falls
 * back to a neutral surface rather than throwing. That fallback is deliberate:
 * a track with one unstyled material should still render, visibly wrong, so it
 * can be spotted and named. Silently hiding it would be worse.
 */
function applyTrackSurfaces(
  root: THREE.Object3D,
  definition: TrackDefinition,
): ReadonlyArray<THREE.Material> {
  const { surfaces } = definition
  const created: THREE.Material[] = []
  // One material per source material, shared across every mesh using it. The
  // bake already merged the model down to one primitive per material, so this
  // is a handful of shader programs for an entire circuit.
  const byName = new Map<string, THREE.ShaderMaterial>()

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    // The material the model shipped with is recorded on the mesh the first
    // time through, because after that there is none left to ask — this
    // function has replaced it. The swap runs more than once on the same
    // object (StrictMode double-invokes, and the memo re-runs whenever the
    // definition identity changes), and every later pass was reading back our
    // own shader materials: nameless, and carrying no texture. Remembering
    // only the *name* was not enough. It kept the palette right and quietly
    // dropped every texture page on the second pass, which is why both game
    // rips rendered as one flat sheet of fallback grey — a hundred textured
    // chunks rebuilt from a source that no longer had a map.
    const current = Array.isArray(child.material) ? child.material[0] : child.material
    const remembered = child.userData.trackSourceMaterial as THREE.Material | undefined
    const source = remembered ?? current
    child.userData.trackSourceMaterial = source
    const name = source?.name ?? ''
    child.userData.trackSurface = name

    const surface = surfaces[name] ?? definition.surfaceDefaults ?? FALLBACK_SURFACE

    if (surface.hidden) {
      child.visible = false
      return
    }

    // Coplanar surfaces are pulled apart here rather than in the geometry, so
    // the separation stays visible and adjustable next to the colours it
    // belongs with. The bake merges the model to one mesh per material, which
    // is what makes moving a whole surface this cheap.
    //
    // Relative to where the chunk already was, which it was not. This line
    // used to assign `surface.lift ?? 0` outright, and a rip is a hundred
    // chunks each placed by its own node translation — so on every imported
    // circuit it silently flattened all hundred of them onto y = 0, moving
    // parts of the mountain by tens of units and tearing holes where two
    // chunks had met. Nothing caught it because everything downstream
    // measured the same displaced geometry: the cars drove on the surface
    // that was actually drawn, wrong as it was. What gave it away was the
    // road ending up 56 units below the spline that was traced from it.
    const restingY = (child.userData.trackRestingY ?? child.position.y) as number
    child.userData.trackRestingY = restingY
    // The lift is stated in game units, and these positions are in the
    // model's own units — which `worldScale` no longer leaves equal.
    child.position.y = restingY + (surface.lift ?? 0) / (definition.worldScale ?? 1)

    let material = byName.get(name)
    if (!material) {
      const standard =
        source instanceof THREE.MeshStandardMaterial || source instanceof THREE.MeshBasicMaterial
          ? source
          : null
      const map = standard?.map ?? null

      // What the surface entry does not decide, the source material does. On
      // a rip with a hundred anonymous materials this is where foliage keeps
      // its alpha mask, fences keep their two sides and tinted glass keeps
      // its colour — the glTF already says all of it, per material, and a
      // registry entry could only ever repeat it back worse.
      // A glTF says "this material is see-through" in two different ways and
      // this renderer can only honour one of them. `alphaMode: MASK` arrives
      // as an alphaTest, which is a cut-out and is exactly what the hardware
      // did. `alphaMode: BLEND` arrives as `transparent`, which is a blend —
      // a thing this shader does not do at all, because the console barely
      // did either. Reading only the first was why Bushido Peak's cherry
      // blossom hung in the sky as solid pink slabs: the rip declares its
      // foliage BLEND, we saw an alphaTest of zero, and drew every cut-out
      // card as an opaque quad. A blended surface is treated as a masked one
      // here, at the cutoff the era's own foliage used.
      const sourceBlended = standard !== null && standard.transparent && standard.alphaTest === 0
      const sourceMasked = standard !== null && (standard.alphaTest > 0 || standard.transparent)
      const sourceAlphaTest = !sourceMasked
        ? 0
        : standard.alphaTest > 0
          ? Math.max(0.3, standard.alphaTest)
          : FOLIAGE_ALPHA_TEST
      // A cut-out card is drawn from both sides whatever the rip claims: a
      // masked surface is a leaf, a fence or a sign, and every one of those
      // is a plane the camera can end up behind.
      const sourceDoubleSided = standard?.side === THREE.DoubleSide || sourceMasked
      const sourceColor = standard && !map ? `#${standard.color.getHexString()}` : undefined

      material = createPs1Material({
        // With a texture the base colour becomes the tint pulled over it, so
        // the map has to arrive at full strength and be pulled towards the
        // palette by `tint`. Without one, the colour *is* the surface.
        color: surface.color ?? sourceColor ?? '#9a9ab5',
        map: map
          ? configurePs1Texture(map, {
              distant: surface.distant,
              anisotropy: definition.render.anisotropy,
            })
          : undefined,
        tint: map ? (surface.tint ?? 0.3) : 0,
        alphaTest: map ? (surface.alphaTest ?? sourceAlphaTest) : 0,
        // Blended as well as masked, for the handful of surfaces a rip draws
        // with soft edges: the threshold removes the page's empty background
        // and the blend carries what is left of a leaf's own edge, instead of
        // squaring it off into the slabs that were hanging over this circuit.
        blend: map ? sourceBlended : false,
        // A baked texture already carries the shading its author painted into
        // it; the lighting model here only has to stop the unlit side of a
        // barrier crushing to black.
        ambient: surface.ambient ?? 0.6,
        emissive: surface.emissive ?? 0,
        side: surface.doubleSided || sourceDoubleSided ? THREE.DoubleSide : THREE.FrontSide,
      })
      byName.set(name, material)
      created.push(material)
    }

    child.material = material
  })

  return created
}

/**
 * Cut-out threshold for a surface the source declared blended.
 *
 * Low, and lower again now that these surfaces blend as well as cut out: the
 * threshold's only remaining job is to throw away the page's empty
 * background before it can write depth, and the soft edge of a leaf is
 * carried by the blend rather than squared off by the cut. Set it near the
 * middle and a mipmapped canopy thins to nothing at distance, because the
 * mip has averaged every leaf against the emptiness around it.
 */
const FOLIAGE_ALPHA_TEST = 0.16

/** Neutral grey. Loud enough to notice, quiet enough not to ruin a shot. */
const FALLBACK_SURFACE: TrackSurface = { color: '#9a9ab5', ambient: 0.6 }
