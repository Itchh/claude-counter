import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { createPs1Material, configurePs1Texture } from '../channels/race/Ps1Material'
import { airframeFor } from '../channels/dogfight/airframes'
import { fighterFor, CLIP_FOR_ACTION } from '../channels/fight/fighters'
import { GI_BOUNDS } from '../channels/fight/Fighter'
import { liveryShaderId, PAINT_STRENGTH } from '@/lib/livery'
import { acquireRenderer, releaseRendererSoon, renderTurntableSheet } from './carSprite'

// The scoreboard's planes and fighters, baked from the games' own models —
// the same route carSprite.ts takes for the cars, and the same one context.
// A board opened over the dogfight shows the squadron; over the fight, the
// roster. What each row shows is the rig that is actually out there, with
// the hangar's or the dojo's choices on it.

const loader = new GLTFLoader()
const modelCache = new Map<string, Promise<GLTF>>()
const sheetCache = new Map<string, Promise<string>>()

/** Where the idle is sampled, in seconds: past the settle, on the guard. */
const FIGHTER_POSE_SECONDS = 0.4
/** A standing figure is tall and narrow; the lens sits lower than for a car. */
const FIGHTER_RISE = 0.18
/** Quarter-front, so the wing's shape reads and the nose art is on screen. */
const PLANE_FIRST_FRAME = Math.PI * 0.8

function loadModel(url: string): Promise<GLTF> {
  const cached = modelCache.get(url)
  if (cached) return cached
  const pending = loader.loadAsync(url)
  modelCache.set(url, pending)
  // A rejected promise must not be cached, or one dropped request retires
  // the asset for the lifetime of the page.
  pending.catch(() => modelCache.delete(url))
  return pending
}

function cached(key: string, bake: () => Promise<string>): Promise<string> {
  const hit = sheetCache.get(key)
  if (hit) return hit
  const pending = bake()
  sheetCache.set(key, pending)
  pending.catch(() => sheetCache.delete(key))
  return pending
}

function sourceOf(child: THREE.Mesh): THREE.MeshStandardMaterial | THREE.MeshBasicMaterial | null {
  const source = Array.isArray(child.material) ? child.material[0] : child.material
  return source instanceof THREE.MeshStandardMaterial || source instanceof THREE.MeshBasicMaterial ? source : null
}

/** Fog pushed past the far plane: the shared stops would dissolve a thumbnail into sky. */
const NO_FOG = { fogNear: 900, fogFar: 1000 } as const

/**
 * A pilot's plane, with the hangar's paint and livery on the skin — the
 * recipe Airframe.tsx applies in the theatre, on a clone of the same bake.
 */
export function bakePlaneSprite(index: number, driverHex: string, paint: string | null, livery: string | null): Promise<string> {
  const spec = airframeFor(index)
  return cached(`plane|${spec.modelUrl}|${paint ?? driverHex}|${livery ?? ''}`, async () => {
    const gltf = await loadModel(spec.modelUrl)
    const active = acquireRenderer()
    if (!active) throw new Error('rigSprite: no renderer')
    const built: THREE.ShaderMaterial[] = []
    try {
      const model = gltf.scene.clone(true)
      model.updateMatrixWorld(true)
      const bounds = new THREE.Box3().setFromObject(model)
      model.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return
        const standard = sourceOf(child)
        const map = standard?.map ?? null
        const blended = standard?.transparent === true && (standard.opacity < 1 || map !== null)
        const material = createPs1Material({
          color: map ? '#ffffff' : `#${standard?.color.getHexString() ?? '9a9ab5'}`,
          map: map ? configurePs1Texture(map) : undefined,
          tint: 0,
          blend: blended,
          ambient: 0.62,
          livery: map
            ? { pattern: liveryShaderId(livery), paint: paint ?? driverHex, bounds, paintStrength: paint === null ? 0 : PAINT_STRENGTH }
            : undefined,
          ...NO_FOG,
        })
        child.material = material
        built.push(material)
      })
      return renderTurntableSheet(active, new THREE.Scene(), model, { firstFrame: PLANE_FIRST_FRAME })
    } finally {
      for (const material of built) material.dispose()
      releaseRendererSoon()
    }
  })
}

/**
 * A fighter on guard, in the dojo's colours. Posed by running the idle clip
 * to its guard frame before the shot: the bind pose is a T, and nobody's
 * select screen ever showed one.
 */
export function bakeFighterSprite(index: number, driverHex: string, paint: string | null, livery: string | null): Promise<string> {
  const spec = fighterFor(index)
  return cached(`fighter|${spec.modelUrl}|${paint ?? driverHex}|${livery ?? ''}`, async () => {
    const gltf = await loadModel(spec.modelUrl)
    const active = acquireRenderer()
    if (!active) throw new Error('rigSprite: no renderer')
    const built: THREE.ShaderMaterial[] = []
    let mixer: THREE.AnimationMixer | null = null
    try {
      const model = cloneSkeleton(gltf.scene)
      model.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return
        const map = sourceOf(child)?.map ?? null
        const material = createPs1Material({
          color: map ? '#ffffff' : '#c0a080',
          map: map ? configurePs1Texture(map) : undefined,
          ambient: 0.6,
          livery: {
            pattern: liveryShaderId(livery),
            paint: paint ?? driverHex,
            bounds: GI_BOUNDS,
            paintStrength: paint === null ? 0 : PAINT_STRENGTH,
            clipPaint: true,
          },
          ...NO_FOG,
        })
        child.material = material
        child.frustumCulled = false
        built.push(material)
      })

      const guard = gltf.animations.find((clip) => CLIP_FOR_ACTION.idle.variants.includes(clip.name))
      if (guard) {
        mixer = new THREE.AnimationMixer(model)
        mixer.clipAction(guard).play()
        mixer.update(FIGHTER_POSE_SECONDS)
      }
      model.updateMatrixWorld(true)
      return renderTurntableSheet(active, new THREE.Scene(), model, { rise: FIGHTER_RISE })
    } finally {
      mixer?.stopAllAction()
      for (const material of built) material.dispose()
      releaseRendererSoon()
    }
  })
}
