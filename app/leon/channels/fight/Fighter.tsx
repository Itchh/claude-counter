'use client'

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { configurePs1Texture, createPs1Material, sourceMaterialOf } from '../race/Ps1Material'
import { liveryShaderId, PAINT_STRENGTH } from '@/lib/livery'
import { CLIP_FOR_ACTION, clipTimeScale, fighterFor, fighterModelUrls, fighterOf, pickClip } from './fighters'
import type { FighterAction, SimFighter } from './useFightSim'

// A fighter, as a picture: the baked sculpt from the roster, skinned onto
// the shared skeleton, every material it shipped with thrown away and
// rebuilt in the channel's own shader, the owner's gi colour and pattern on
// its chest, and its clips driven by the simulation's action rather than by
// a clock of their own. Drawn in the ring and on the dojo's turntable by
// this one component, for the same reason the car has one Kart: a select
// screen that shows you a different fighter from the one who then walks
// out is lying.
//
// The clips are not crossfaded so much as cut: a strike arrives in a
// twelfth of a second and leaves as fast, which is how the era's fighters
// moved and also what keeps the simulation's strike frame — the moment the
// spark fires and the world freezes — landing on the frame the fist
// actually reaches out. Each strike clip is played at whatever speed puts
// its measured hit on that frame; see clipTimeScale. Short as the blend is,
// it is always a blend: the outgoing clip fades under the incoming one, so
// there is never a frame of nothing — a rig with no clip on it is a T-pose,
// and a T-pose is the one thing the picture can never show.
//
// Which variant plays is the simulation's call when it has made one (a
// strike's reach depends on it) and this component's otherwise.

/** How fast one clip gives way to the next, in seconds. Short: a cut. */
const CLIP_BLEND_S = 0.07
/** The sculpts face +z; a fighter on the left faces +x, on the right -x. */
const FACING_LEFT = Math.PI / 2
/**
 * The gi: the box on the bind-pose body that takes the owner's paint and
 * pattern. Hips to shoulders, the width of the torso. Everything outside
 * it — face, hands, boots — keeps the page's own colours, which is what
 * makes a respray read as a costume and not as a tint over the whole
 * person.
 */
export const GI_BOUNDS = new THREE.Box3(new THREE.Vector3(-0.34, 0.86, -0.3), new THREE.Vector3(0.34, 1.52, 0.34))

export interface FighterPose {
  readonly action: FighterAction
  readonly actionT: number
  /** The clip the simulation chose for this action, or null to choose here. */
  readonly clip: string | null
  /** True during hit-stop: the clip holds its frame. */
  readonly frozen: boolean
}

/** What the fighter dissolves into, per stage. */
export interface FighterAir {
  readonly fogColor: string
  readonly fogNear: number
  readonly fogFar: number
}

interface FighterModelProps {
  /** Index into FIGHTERS. */
  readonly index: number
  /** The deck's colour, used when the owner has never opened the dojo. */
  readonly color: string
  /** The dojo's choices. Null keeps the page exactly as the bake left it. */
  readonly paint?: string | null
  readonly livery?: string | null
  readonly air: FighterAir
  /** Reads the pose each frame; null hides the fighter. */
  readonly getPose: () => FighterPose | null
}

interface BuiltMaterials {
  readonly all: ReadonlyArray<THREE.ShaderMaterial>
  /** The skin: the page, which is where the paint goes. */
  readonly skin: ReadonlyArray<THREE.ShaderMaterial>
}

function applyRingMaterials(
  root: THREE.Object3D,
  air: FighterAir,
  skin: { readonly paint: string; readonly pattern: number; readonly strength: number },
): BuiltMaterials {
  const all: THREE.ShaderMaterial[] = []
  const skinMaterials: THREE.ShaderMaterial[] = []
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    const source = sourceMaterialOf(child)
    const standard =
      source instanceof THREE.MeshStandardMaterial || source instanceof THREE.MeshBasicMaterial ? source : null
    const map = standard?.map ?? null
    const material = createPs1Material({
      color: map ? '#ffffff' : '#c0a080',
      map: map ? configurePs1Texture(map) : undefined,
      fogColor: air.fogColor,
      fogNear: air.fogNear,
      fogFar: air.fogFar,
      // The sculpt's page carries its own painted shading; the shader only
      // has to keep the far side from crushing to black.
      ambient: 0.6,
      livery: { pattern: skin.pattern, paint: skin.paint, bounds: GI_BOUNDS, paintStrength: skin.strength, clipPaint: true },
    })
    child.material = material
    // A skinned mesh's bounds are its bind pose; a fallen fighter would be
    // culled where he lay.
    child.frustumCulled = false
    all.push(material)
    if (map) skinMaterials.push(material)
  })
  return { all, skin: skinMaterials }
}

export function FighterModel({ index, color, paint = null, livery = null, air, getPose }: FighterModelProps): React.ReactElement {
  const spec = fighterFor(index)
  const { scene, animations } = useGLTF(spec.modelUrl)

  // Cloned with the skeleton: a plain clone shares the bones with the
  // cached scene, and two fighters of the same type would fight as one.
  const model = useMemo(() => {
    const clone = cloneSkeleton(scene)
    clone.updateMatrixWorld(true)
    return clone
  }, [scene])

  // Rebuilt when the owner's choices or the stage's air change — once per
  // bout at most, and a respray is rarer than that. Materials are cheap;
  // a program is compiled once per shader and shared underneath.
  const materials = useMemo(
    () =>
      applyRingMaterials(model, air, {
        paint: paint ?? color,
        pattern: liveryShaderId(livery),
        strength: paint === null ? 0 : PAINT_STRENGTH,
      }),
    [model, air, paint, livery, color],
  )

  const mixer = useMemo(() => new THREE.AnimationMixer(model), [model])
  const actions = useMemo(() => {
    const byName = new Map<string, THREE.AnimationAction>()
    for (const clip of animations) {
      const action = mixer.clipAction(clip, model)
      const loops = Object.values(CLIP_FOR_ACTION).some((choice) => choice.loop && choice.variants.includes(clip.name))
      action.setLoop(loops ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
      action.clampWhenFinished = !loops
      byName.set(clip.name, action)
    }
    return byName
  }, [mixer, animations, model])

  useEffect(() => {
    return () => {
      mixer.stopAllAction()
      for (const material of materials.all) material.dispose()
    }
  }, [mixer, materials])

  const playing = useRef<{ action: FighterAction; clip: THREE.AnimationAction; actionT: number } | null>(null)

  useFrame((_, delta) => {
    const pose = getPose()
    model.visible = pose !== null
    if (!pose) return
    const current = playing.current
    // A new action, or the same action started again: the simulation
    // resets actionT to zero when it does either.
    const restarted = current !== null && pose.actionT < current.actionT - 0.05
    if (current === null || current.action !== pose.action || restarted) {
      const choice = CLIP_FOR_ACTION[pose.action]
      // The simulation's pick, if it is a clip this action can play — a
      // pose from over the wire can name anything — else a pick made here.
      const clipName =
        pose.clip !== null && choice.variants.includes(pose.clip) && actions.has(pose.clip) ? pose.clip : pickClip(pose.action)
      const next = actions.get(clipName)
      if (next) {
        if (current) current.clip.fadeOut(CLIP_BLEND_S)
        next.reset()
        const timeScale = clipTimeScale(spec, clipName, choice)
        next.timeScale = timeScale
        // A clip run backwards has to start from its end, or the first
        // frame it shows is the wrap.
        if (timeScale < 0) next.time = next.getClip().duration
        next.fadeIn(CLIP_BLEND_S).play()
        playing.current = { action: pose.action, clip: next, actionT: pose.actionT }
      }
    } else {
      current.actionT = pose.actionT
    }
    mixer.update(pose.frozen ? 0 : Math.min(delta, 0.1))
  })

  return <primitive object={model} />
}

// --- The ring -------------------------------------------------------------

interface FighterProps {
  /** Reads the live fighter each frame; null while no bout is on. */
  readonly getFighter: () => SimFighter | null
  /** True during hit-stop. */
  readonly isFrozen: () => boolean
  /** Fallback kit colour while the sim has nobody for this slot. */
  readonly fallbackColor: string
  readonly air: FighterAir
  /** The stage's floor under a ring x, in fighter units. */
  readonly floorAt: (x: number) => number
}

interface SlotIdentity {
  readonly key: string
  readonly index: number
  readonly color: string
  readonly paint: string | null
  readonly livery: string | null
}

/**
 * One corner of the ring. Follows the simulation's fighter for its slot:
 * where they stand, which way they face, what they are doing — and who they
 * are, which changes between bouts and swaps the sculpt underneath.
 */
export function Fighter({ getFighter, isFrozen, fallbackColor, air, floorAt }: FighterProps): React.ReactElement {
  const root = useRef<THREE.Group>(null)
  const [identity, setIdentity] = useState<SlotIdentity | null>(null)
  const identityRef = useRef<SlotIdentity | null>(null)

  useFrame(() => {
    const fighter = getFighter()
    const group = root.current
    if (!group) return
    if (!fighter) {
      group.visible = false
      if (identityRef.current !== null) {
        identityRef.current = null
        setIdentity(null)
      }
      return
    }
    group.visible = true
    // Ring units: this group sits inside the scene's scaled ring group, so
    // the simulation's x and the ring floor's height are used as they are.
    group.position.x = fighter.x
    group.position.y = floorAt(fighter.x)
    group.rotation.y = fighter.side === -1 ? FACING_LEFT : -FACING_LEFT

    // Who is standing here. Re-read every frame because the owner may walk
    // out of the dojo mid-bout with a new gi; a change is a React commit,
    // the same value is nothing.
    const current = identityRef.current
    const index = fighterOf(fighter.key, fighter.fighter)
    const paint = fighter.fightPaint
    const livery = fighter.fightLivery
    if (
      current === null ||
      current.key !== fighter.key ||
      current.index !== index ||
      current.paint !== paint ||
      current.livery !== livery ||
      current.color !== fighter.color
    ) {
      const next = { key: fighter.key, index, color: fighter.color, paint, livery }
      identityRef.current = next
      setIdentity(next)
    }
  })

  const getPose = (): FighterPose | null => {
    const fighter = getFighter()
    if (!fighter) return null
    return { action: fighter.action, actionT: fighter.actionT, clip: fighter.clip, frozen: isFrozen() }
  }

  return (
    <group ref={root} visible={false}>
      {identity !== null && (
        <Suspense fallback={null}>
          <FighterModel
            key={identity.index}
            index={identity.index}
            color={identity.color || fallbackColor}
            paint={identity.paint}
            livery={identity.livery}
            air={air}
            getPose={getPose}
          />
        </Suspense>
      )}
    </group>
  )
}

/** Every sculpt, warmed before the first card goes up. */
export function preloadFighters(): void {
  for (const url of fighterModelUrls()) useGLTF.preload(url)
}
