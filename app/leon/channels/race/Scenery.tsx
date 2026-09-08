'use client'

import { useEffect, useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { useCircuit } from './CircuitContext'
import type { Circuit } from './circuit'
import {
  SCENERY_MODELS,
  SCENERY_PROPS,
  applyPs1Materials,
  mulberry32,
  normaliseProp,
  pickWeighted,
  type SceneryProp,
  type SceneryZone,
} from './sceneryCatalogue'

// The trackside. Barriers, tyre stacks, oil drums and a yard of containers,
// scattered once from a fixed seed and then never moved.
//
// The point is not decoration. The circuit is a flat ribbon on a flat plane,
// and at 288 pixels tall with a wobbling camera there is nothing in frame to
// measure speed against — the road just slides. Props at known heights give
// the eye a scale and a parallax, which is the whole reason every racer of the
// era lined its straights with objects nobody ever looked at directly.

/** How many of each zone to place around the lap. */
const COUNTS: Readonly<Record<SceneryZone, number>> = {
  barrier: 44,
  verge: 34,
  yard: 26,
}

/**
 * How far off the centreline each zone sits, in metres. The road's own half
 * width is 7.4 and the kerb takes it to 8.15, so nothing starts before 9.
 */
const BANDS: Readonly<Record<SceneryZone, readonly [number, number]>> = {
  barrier: [9.2, 10.0],
  verge: [12.5, 17.0],
  yard: [19.0, 34.0],
}

/** Pillars stand this far outside the road edge; props keep out of their lane. */
const PILLAR_INSET = 3.4
const PILLAR_CLEARANCE = 0.9

interface Placement {
  readonly key: string
  readonly prop: SceneryProp
  readonly position: THREE.Vector3
  readonly rotationY: number
}

function buildPlacements(circuit: Circuit): ReadonlyArray<Placement> {
  const pillarOffset = circuit.halfWidth + PILLAR_INSET
  // Fixed seed: the circuit is a place, and a place does not rearrange itself
  // between page loads.
  const random = mulberry32(0x5eed_1a9e)
  const placements: Placement[] = []

  for (const zone of ['barrier', 'verge', 'yard'] as const) {
    const catalogue = SCENERY_PROPS.filter((prop) => prop.zone === zone)
    if (catalogue.length === 0) continue
    const [near, far] = BANDS[zone]

    for (let index = 0; index < COUNTS[zone]; index++) {
      const prop = pickWeighted(catalogue, random)
      const side = random() < 0.5 ? -1 : 1
      // Evenly spread around the lap with jitter, rather than uniformly
      // random: pure random clumps, and a bare half-lap reads as unfinished.
      const t = (index + random()) / COUNTS[zone]

      let lateral = near + random() * (far - near)
      if (Math.abs(lateral - pillarOffset) < PILLAR_CLEARANCE) {
        lateral += PILLAR_CLEARANCE * (lateral < pillarOffset ? -1 : 1)
      }

      const frame = circuit.sample(t, lateral * side)
      const alongTrack = Math.atan2(frame.tangent.x, frame.tangent.z)
      // Barriers face the track because that is what makes them barriers.
      // Everything else is dropped at whatever angle it landed.
      const rotationY =
        zone === 'barrier' ? alongTrack : alongTrack + (random() - 0.5) * Math.PI * 2

      placements.push({
        key: `${zone}-${index}`,
        prop,
        position: frame.position,
        rotationY,
      })
    }
  }

  return placements
}

export function Scenery(): React.ReactElement {
  const circuit = useCircuit()
  // One load per pack, cached by URL inside fiber, shared by every instance.
  const industrial = useGLTF(SCENERY_MODELS.industrial)
  const street = useGLTF(SCENERY_MODELS.street)
  const barrel = useGLTF(SCENERY_MODELS.barrel)

  const scenes = useMemo(
    () => ({
      industrial: industrial.scene,
      street: street.scene,
      barrel: barrel.scene,
    }),
    [industrial.scene, street.scene, barrel.scene],
  )

  /**
   * One normalised template per prop kind, materials swapped once. Instances
   * are clones of these, so a hundred props share a handful of geometries and
   * two shader programs.
   */
  const templates = useMemo(() => {
    const built = new Map<string, THREE.Object3D>()
    const materials: THREE.Material[] = []

    for (const prop of SCENERY_PROPS) {
      const key = `${prop.pack}:${prop.node}`
      if (built.has(key)) continue
      const normalised = normaliseProp(scenes[prop.pack], prop)
      if (!normalised) continue
      materials.push(...applyPs1Materials(normalised))
      built.set(key, normalised)
    }

    return { built, materials }
  }, [scenes])

  const placements = useMemo(() => buildPlacements(circuit), [circuit])

  const instances = useMemo(
    () =>
      placements.flatMap((placement) => {
        const template = templates.built.get(
          `${placement.prop.pack}:${placement.prop.node}`,
        )
        if (!template) return []
        const object = template.clone(true)
        object.position.copy(placement.position)
        object.rotation.y = placement.rotationY
        return [{ key: placement.key, object }]
      }),
    [placements, templates],
  )

  // Materials are created here, so they are disposed here. Geometry and
  // textures belong to the GLTF cache and are shared with any future channel
  // that loads the same pack — disposing those would break it.
  useEffect(() => {
    const created = templates.materials
    return () => {
      for (const material of created) material.dispose()
    }
  }, [templates])

  return (
    <group>
      {instances.map((instance) => (
        <primitive key={instance.key} object={instance.object} />
      ))}
    </group>
  )
}

useGLTF.preload(SCENERY_MODELS.industrial)
useGLTF.preload(SCENERY_MODELS.street)
useGLTF.preload(SCENERY_MODELS.barrel)
