'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { configurePs1Texture, createPs1Material, sourceMaterialOf } from '../race/Ps1Material'
import { liveryShaderId, PAINT_STRENGTH } from '@/lib/livery'
import { THEATRE_FOG_FAR, THEATRE_FOG_NEAR, THEATRE_SKY } from './theatre'
import { AIRFRAMES, airframeFor, type Airframe as AirframeSpec } from './airframes'

// One aircraft, as a picture: the baked model from the catalogue, every
// material it shipped with thrown away and rebuilt in the theatre's own
// shader, the pilot's paint and pattern on its skin, and its airscrew
// turning. Drawn on the patrol and on the hangar's turntable by this one
// component, for the same reason the car has one Kart: a select screen that
// shows you a different plane from the one you then fly is lying.
//
// The airscrew is the era's whole answer to a spinning propeller: the blades
// turn at a rate the eye cannot follow, and a translucent disc sits over
// them so the picture reads as motion rather than as a strobe. The disc was
// literally how the period's flight games drew it — a black quad with the
// hardware's semi-transparency on — and it costs a single triangle fan.

/** Spin rate below which the disc is not drawn. Radians per second. */
const DISC_THRESHOLD = 12
/** Spin rate at which the disc is fully dark. */
const DISC_FULL = 40
/**
 * Faint, and pale. The disc was dark and nearly forty percent solid, and a
 * dark circle the size of half the fuselage on the nose reads as an engine
 * cowling — or a tail — from any distance: three people asked why the
 * planes flew backwards. A spinning airscrew is a pale shimmer you see
 * through, and that is all this is now.
 */
const DISC_OPACITY = 0.14
const DISC_SEGMENTS = 12

/** A built airscrew, for the scan whose own is fused into the cowling. */
const BUILT_BLADE_CHORD = 0.09
const BUILT_BLADE_DEPTH = 0.035
const BUILT_SPINNER_RADIUS = 0.06
const BUILT_SPINNER_LENGTH = 0.16

export interface SpinBox {
  /** Airscrew rate, radians per second. Written by the owner's frame loop. */
  rate: number
}

interface AirframeProps {
  /** Index into AIRFRAMES. */
  readonly index: number
  /** The deck's colour, used when the pilot has never opened the hangar. */
  readonly color: string
  /** The hangar's choices. Null keeps the page exactly as the bake left it. */
  readonly paint?: string | null
  readonly livery?: string | null
  readonly spinBox: SpinBox
}

interface BuiltMaterials {
  readonly all: ReadonlyArray<THREE.ShaderMaterial>
  /** The skin: every textured page, which is where the paint goes. */
  readonly skin: ReadonlyArray<THREE.ShaderMaterial>
}

function theatreMaterial(options: Parameters<typeof createPs1Material>[0]): THREE.ShaderMaterial {
  return createPs1Material({
    fogColor: THEATRE_SKY.mid,
    fogNear: THEATRE_FOG_NEAR,
    fogFar: THEATRE_FOG_FAR,
    ...options,
  })
}

/**
 * Replaces every material on the clone with the theatre's own, one per
 * source page or flat colour. Textured pages carry the livery in the
 * airframe's object space against its whole box, so a pattern runs nose to
 * tail and across the wings in the same place on every type.
 */
function applyTheatreMaterials(
  root: THREE.Object3D,
  bounds: THREE.Box3,
  skin: { readonly paint: string; readonly pattern: number; readonly strength: number },
): BuiltMaterials {
  const all: THREE.ShaderMaterial[] = []
  const skinMaterials: THREE.ShaderMaterial[] = []
  const byKey = new Map<string, THREE.ShaderMaterial>()

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    const source = sourceMaterialOf(child)
    const standard = source instanceof THREE.MeshStandardMaterial || source instanceof THREE.MeshBasicMaterial ? source : null
    const map = standard?.map ?? null
    const colour = standard ? `#${standard.color.getHexString()}` : '#9a9ab5'
    // A page the model declared as blended — the Zero's canopy — stays
    // blended. Everything else is a solid, however the artist set it.
    const blended = standard?.transparent === true && (standard.opacity < 1 || map !== null)
    const key = `${map ? map.uuid : `flat:${colour}`}|${blended ? 'blend' : 'solid'}`

    let material = byKey.get(key)
    if (!material) {
      material = theatreMaterial({
        color: map ? '#ffffff' : colour,
        map: map ? configurePs1Texture(map) : undefined,
        tint: 0,
        blend: blended,
        // A page already carries its painted shading; the model only has to
        // keep the underside from crushing to black against the sky.
        ambient: 0.62,
        livery: map
          ? { pattern: skin.pattern, paint: skin.paint, bounds, paintStrength: skin.strength }
          : undefined,
      })
      byKey.set(key, material)
      all.push(material)
      if (map) skinMaterials.push(material)
    }
    child.material = material
  })

  return { all, skin: skinMaterials }
}

export function Airframe({ index, color, paint = null, livery = null, spinBox }: AirframeProps): React.ReactElement {
  const spec = airframeFor(index)
  const { scene } = useGLTF(spec.modelUrl)
  const propRef = useRef<THREE.Object3D | null>(null)
  const discRef = useRef<THREE.Mesh>(null)

  // Cloned because useGLTF caches by URL: two planes of the same type share
  // the cached scene, and rewriting its materials for one would repaint the
  // other. Geometry is still shared underneath — a clone copies the graph,
  // not the buffers.
  const model = useMemo(() => {
    const clone = scene.clone(true)
    clone.updateMatrixWorld(true)
    return clone
  }, [scene])

  const bounds = useMemo(() => new THREE.Box3().setFromObject(model), [model])

  // Built once per model, bare: the pilot's choices are pushed into the
  // uniforms by the effect below rather than rebuilt, because a respray
  // mid-patrol is a uniform write and not a reason to compile programs.
  const materials = useMemo(
    () => applyTheatreMaterials(model, bounds, { paint: '#ffffff', pattern: 0, strength: 0 }),
    [model, bounds],
  )

  useEffect(() => {
    const noseArt = new THREE.Color(paint ?? color)
    const pattern = liveryShaderId(livery)
    const strength = paint === null ? 0 : PAINT_STRENGTH
    for (const material of materials.skin) {
      const { uPaint, uLivery, uPaintMix } = material.uniforms
      if (uPaint) (uPaint.value as THREE.Color).copy(noseArt)
      if (uLivery) uLivery.value = pattern
      if (uPaintMix) uPaintMix.value = strength
    }
  }, [materials, paint, livery, color])

  useEffect(() => {
    return () => {
      for (const material of materials.all) material.dispose()
    }
  }, [materials])

  // The airscrew: the bake's own node where the model has one, or a built
  // two-blade at the hub where it does not.
  const builtProp = useMemo(() => (spec.hasProp ? null : buildAirscrew(spec)), [spec])
  useEffect(() => {
    propRef.current = spec.hasProp ? (model.getObjectByName('propeller') ?? null) : builtProp
  }, [model, spec, builtProp])

  const discMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#dfe6ee',
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    [],
  )
  useEffect(() => () => discMaterial.dispose(), [discMaterial])

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1)
    const prop = propRef.current
    if (prop) prop.rotation.z += spinBox.rate * dt
    const disc = discRef.current
    if (disc) {
      const rate = Math.abs(spinBox.rate)
      const visible = rate > DISC_THRESHOLD
      disc.visible = visible
      if (visible) {
        discMaterial.opacity =
          DISC_OPACITY * Math.min(1, (rate - DISC_THRESHOLD) / (DISC_FULL - DISC_THRESHOLD))
      }
    }
  })

  return (
    <group>
      <primitive object={model} />
      {builtProp !== null && <primitive object={builtProp} />}
      {/* The disc, a hair forward of the blades so it wins the depth test. */}
      <mesh
        ref={discRef}
        material={discMaterial}
        position={[spec.hub[0], spec.hub[1], spec.hub[2] + 0.02]}
        visible={false}
      >
        <circleGeometry args={[spec.propRadius, DISC_SEGMENTS]} />
      </mesh>
    </group>
  )
}

/**
 * A two-blade airscrew and a spinner, from the same hard slabs the
 * procedural plane was made of. For the scan whose own blades are baked into
 * its cowling: they stay where they are, and this turns in front of them.
 */
function buildAirscrew(spec: AirframeSpec): THREE.Group {
  const group = new THREE.Group()
  group.name = 'propeller'
  group.position.set(spec.hub[0], spec.hub[1], spec.hub[2] + 0.04)
  const blade = theatreMaterial({ color: '#1a1a1e' })
  const spinner = theatreMaterial({ color: '#8a8a94' })
  const bladeGeometry = new THREE.BoxGeometry(spec.propRadius * 2, BUILT_BLADE_CHORD, BUILT_BLADE_DEPTH)
  const across = new THREE.Mesh(bladeGeometry, blade)
  const upright = new THREE.Mesh(bladeGeometry, blade)
  upright.rotation.z = Math.PI / 2
  const boss = new THREE.Mesh(
    new THREE.ConeGeometry(BUILT_SPINNER_RADIUS, BUILT_SPINNER_LENGTH, 8),
    spinner,
  )
  boss.rotation.x = Math.PI / 2
  boss.position.z = BUILT_SPINNER_LENGTH / 2
  group.add(across, upright, boss)
  return group
}

/** Every type, warmed before the patrol scrambles. */
export function preloadAirframes(): void {
  for (const airframe of AIRFRAMES) useGLTF.preload(airframe.modelUrl)
}
