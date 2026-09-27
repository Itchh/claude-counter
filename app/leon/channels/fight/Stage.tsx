'use client'

import { useEffect, useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { configurePs1Texture, createPs1Material, sourceMaterialOf } from '../race/Ps1Material'
import type { StageDefinition } from './stages'

// A baked venue, rebuilt as console geometry.
//
// Everything expensive happened offline — see scripts/bakeStages.mjs. What
// is left to do here is the one thing the bake cannot: throw away the
// source's lighting model. Every material the model shipped with is
// discarded and rebuilt in the channel's own shader from its colour page
// alone, fogged into this stage's sky, and lit by the same single term as
// the fighters. A downloaded temple and a downloaded tomb arrive from two
// different renderers; they leave here from one.

interface StageModelProps {
  readonly stage: StageDefinition
}

/** Where a stage's own pages are nearest-sampled but mipmapped: they recede. */
const STAGE_TEXTURE = { distant: true, anisotropy: 2 } as const

function applyStageMaterials(root: THREE.Object3D, stage: StageDefinition): ReadonlyArray<THREE.ShaderMaterial> {
  const built: THREE.ShaderMaterial[] = []
  const byKey = new Map<string, THREE.ShaderMaterial>()

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    const source = sourceMaterialOf(child)
    const standard =
      source instanceof THREE.MeshStandardMaterial || source instanceof THREE.MeshBasicMaterial ? source : null
    const map = standard?.map ?? null
    const colour = standard ? `#${standard.color.getHexString()}` : '#8a8a96'
    const treatment = { ...stage.surfaceDefaults, ...(stage.surfaces[source?.name ?? ''] ?? {}) }
    const key = `${map ? map.uuid : `flat:${colour}`}|${treatment.alphaTest ?? 0}|${treatment.ambient ?? ''}`

    let material = byKey.get(key)
    if (!material) {
      material = createPs1Material({
        color: map ? '#ffffff' : colour,
        map: map ? configurePs1Texture(map, STAGE_TEXTURE) : undefined,
        fogColor: stage.sky.mid,
        fogNear: stage.fog.near,
        fogFar: stage.fog.far,
        alphaTest: treatment.alphaTest,
        // A downloaded page carries its own painted shading; the model only
        // has to keep the shadowed side from crushing to black.
        ambient: treatment.ambient ?? 0.62,
        // Every stage material is drawn from both sides. A scan has no
        // consistent winding, and the camera stands inside the chamber.
        side: THREE.DoubleSide,
      })
      byKey.set(key, material)
      built.push(material)
    }
    child.material = material
    // Big, static, and already cut to budget: nothing here is worth the
    // per-frame bounds test.
    child.frustumCulled = false
  })

  return built
}

/**
 * One baked stage. Mounted for the bout it hosts and unmounted for the
 * next, so a channel that has cycled every venue is not holding four of
 * them in the same context.
 */
export function StageModel({ stage }: StageModelProps): React.ReactElement | null {
  const path = stage.model
  if (!path) throw new Error(`Stage "${stage.slug}" has no model to load`)

  const { scene } = useGLTF(path)

  // Cloned because useGLTF caches by URL: rewriting the cached scene's
  // materials would corrupt the copy handed to the next mount, and this
  // channel remounts on every WebGL context loss.
  const model = useMemo(() => {
    const clone = scene.clone(true)
    clone.updateMatrixWorld(true)
    return clone
  }, [scene])

  const materials = useMemo(() => applyStageMaterials(model, stage), [model, stage])

  useEffect(() => {
    return () => {
      for (const material of materials) material.dispose()
    }
  }, [materials])

  return <primitive object={model} />
}
