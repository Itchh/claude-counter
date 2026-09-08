'use client'

import { useEffect, useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { createPs1Material, configurePs1Texture } from './Ps1Material'
import { useCircuit } from './CircuitContext'
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
  const model = useMemo(() => scene.clone(true), [scene])

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

/** Rays cast around the lap when measuring the road's real height. */
const HEIGHT_PROFILE_SAMPLES = 176
/** How far above the highest plausible road the rays start. */
const RAY_CEILING = 260
/** Lift applied to the measured surface, so wheels sit on it, not in it. */
const ROAD_CLEARANCE = 0.06

/**
 * Measures the road's actual height around the lap and hands it to the
 * circuit — the fix for the floating grid.
 *
 * The baked spline's x/z trace is derived from the road's own footprint and
 * is trustworthy; its y is reconstructed from a 2D grid and is not — on the
 * mountain circuits it runs metres above or below the tarmac, so the cars
 * hovered in some corners and sank in others. The model itself is the ground
 * truth, and once it is mounted, asking it is one raycast per sample: straight
 * down at each of 176 points along the centreline, keeping whichever hit lies
 * nearest the spline's own estimate so an overpass does not capture the road
 * running underneath it.
 *
 * An effect rather than a bake-time fix, deliberately: it corrects every
 * track that will ever be imported, including ones whose bake nobody
 * re-checks, and it can never disagree with what is actually rendered —
 * because what is actually rendered is what it measured.
 */
function SplineGrounding({ model }: { readonly model: THREE.Object3D }): null {
  const circuit = useCircuit()

  useEffect(() => {
    const raycaster = new THREE.Raycaster()
    raycaster.ray.direction.set(0, -1, 0)
    raycaster.far = RAY_CEILING * 2

    const profile = new Float32Array(HEIGHT_PROFILE_SAMPLES)
    const misses: number[] = []
    const point = new THREE.Vector3()
    const tangent = new THREE.Vector3()

    // The model must have world matrices before it can be raycast; it has
    // only just mounted and three will not update it until the next render.
    model.updateWorldMatrix(true, true)

    for (let index = 0; index < HEIGHT_PROFILE_SAMPLES; index++) {
      circuit.sampleInto(index / HEIGHT_PROFILE_SAMPLES, 0, point, tangent)
      const splineY = point.y
      raycaster.ray.origin.set(point.x, splineY + RAY_CEILING, point.z)
      const hits = raycaster.intersectObject(model, true)

      if (hits.length === 0) {
        misses.push(index)
        profile[index] = Number.NaN
        continue
      }
      // Nearest to the spline's own estimate, not nearest to the sky:
      // a bridge over the road would otherwise capture the lap below it.
      let best = hits[0].point.y
      for (const hit of hits) {
        if (Math.abs(hit.point.y - splineY) < Math.abs(best - splineY)) best = hit.point.y
      }
      profile[index] = best + ROAD_CLEARANCE
    }

    // A missed ray (a gap in the mesh, a bridge seam) borrows its neighbours.
    for (const index of misses) {
      let before = index
      let after = index
      for (let step = 0; step < HEIGHT_PROFILE_SAMPLES; step++) {
        if (!Number.isNaN(profile[before])) break
        before = (before - 1 + HEIGHT_PROFILE_SAMPLES) % HEIGHT_PROFILE_SAMPLES
      }
      for (let step = 0; step < HEIGHT_PROFILE_SAMPLES; step++) {
        if (!Number.isNaN(profile[after])) break
        after = (after + 1) % HEIGHT_PROFILE_SAMPLES
      }
      if (Number.isNaN(profile[before]) || Number.isNaN(profile[after])) {
        // Nothing measured at all — a model with no road under the spline.
        // Leave the circuit uncorrected rather than pin the field to NaN.
        console.warn('SplineGrounding: no road found under the spline; profile discarded.')
        circuit.setHeightProfile(null)
        return
      }
      profile[index] = (profile[before] + profile[after]) / 2
    }

    // A three-tap median pass: a single ray that clipped a barrier top or a
    // kerb edge would otherwise put a step into the lap that every car jumps.
    const smoothed = new Float32Array(HEIGHT_PROFILE_SAMPLES)
    for (let index = 0; index < HEIGHT_PROFILE_SAMPLES; index++) {
      const a = profile[(index - 1 + HEIGHT_PROFILE_SAMPLES) % HEIGHT_PROFILE_SAMPLES]
      const b = profile[index]
      const c = profile[(index + 1) % HEIGHT_PROFILE_SAMPLES]
      smoothed[index] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))
    }

    circuit.setHeightProfile(smoothed)
    return () => circuit.setHeightProfile(null)
  }, [model, circuit])

  return null
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
    const source = Array.isArray(child.material) ? child.material[0] : child.material
    // The source material's name is recorded on the mesh the first time
    // through, because after that there is no source material left to ask —
    // this function has replaced it. Under StrictMode the swap runs twice on
    // the same object, and the second pass was reading back our own shader
    // materials, finding them nameless, and repainting the entire circuit in
    // the fallback grey. The whole track came out the colour of nothing.
    const remembered = child.userData.trackSurface as string | undefined
    const name = remembered ?? source?.name ?? ''
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
    child.position.y = surface.lift ?? 0

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
      const sourceAlphaTest = standard && standard.alphaTest > 0 ? Math.max(0.3, standard.alphaTest) : 0
      const sourceDoubleSided = standard?.side === THREE.DoubleSide
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

/** Neutral grey. Loud enough to notice, quiet enough not to ruin a shot. */
const FALLBACK_SURFACE: TrackSurface = { color: '#9a9ab5', ambient: 0.6 }
