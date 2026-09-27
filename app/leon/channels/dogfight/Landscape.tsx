'use client'

import { useEffect, useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { configurePs1Texture, createPs1Material } from '../race/Ps1Material'
import { THEATRE_FOG_FAR, THEATRE_FOG_NEAR, THEATRE_SKY } from './theatre'
import { TERRAIN } from './airframes'

// The ground under the patrol: a photogrammetry scan of a Peak District
// hillside — Broadlee Bank, above Edale — baked to a console tile (see
// scripts/bakePlanes.mjs) and laid out three by three.
//
// Tiled because the scan is a square kilometre and the fog is not: at the
// tile's scale the far edge would sit inside the wide shot's view, ending
// the world against the sky in a hard line. Every second tile is mirrored,
// so the edges meet their own reflection and the seams need no matching.
// Twenty-five copies of three thousand triangles is a small price for a
// horizon that never arrives, and the fog owns everything past the middle
// tile.

/**
 * Tiles per side. The camera's far plane is 1.35 times the fog's, and the
 * chase shot can stand at the edge of the combat box: five tiles puts
 * terrain under every pixel from anywhere the camera goes, with a tile to
 * spare in each direction for the ground to fog out over.
 */
const TILES_PER_SIDE = 5

/** A mesh's geometry with its world transform applied, positions widened to floats. */
function toWorldGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
  const geometry = mesh.geometry.clone()
  const source = geometry.getAttribute('position')
  const positions = new Float32Array(source.count * 3)
  for (let i = 0; i < source.count; i += 1) {
    positions[i * 3] = source.getX(i)
    positions[i * 3 + 1] = source.getY(i)
    positions[i * 3 + 2] = source.getZ(i)
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.applyMatrix4(mesh.matrixWorld)
  return geometry
}

export function Landscape(): React.ReactElement {
  const { scene } = useGLTF(TERRAIN.modelUrl)

  const surface = useMemo(() => {
    let geometry: THREE.BufferGeometry | null = null
    let map: THREE.Texture | null = null
    scene.updateMatrixWorld(true)
    scene.traverse((child) => {
      if (geometry !== null || !(child instanceof THREE.Mesh)) return
      // The bake leaves the tile's scale on its node — a hundred and twenty
      // times — and the tiles below are built from the geometry alone, so the
      // node's transform is pressed into the vertices here. The positions
      // arrive as normalised shorts spanning -1..1, which a scale would push
      // off the end of; they go to floats first.
      geometry = toWorldGeometry(child)
      const source = Array.isArray(child.material) ? child.material[0] : child.material
      if (source instanceof THREE.MeshStandardMaterial) map = source.map
    })
    const built: { readonly geometry: THREE.BufferGeometry | null; readonly map: THREE.Texture | null } = { geometry, map }
    return built
  }, [scene])

  useEffect(() => () => surface.geometry?.dispose(), [surface])

  const material = useMemo(
    () =>
      createPs1Material({
        color: '#ffffff',
        map: surface.map ? configurePs1Texture(surface.map, { distant: true }) : undefined,
        tint: 0,
        fogColor: THEATRE_SKY.mid,
        fogNear: THEATRE_FOG_NEAR,
        fogFar: THEATRE_FOG_FAR,
        ambient: 0.6,
        // Mirrored tiles wind their triangles the other way, so the sampler
        // has to accept both faces.
        side: THREE.DoubleSide,
      }),
    [surface.map],
  )

  useEffect(() => () => material.dispose(), [material])

  const tiles = useMemo(() => {
    const list: Array<{ readonly key: string; readonly position: readonly [number, number, number]; readonly scale: readonly [number, number, number] }> = []
    const half = Math.floor(TILES_PER_SIDE / 2)
    for (let column = -half; column <= half; column++) {
      for (let row = -half; row <= half; row++) {
        list.push({
          key: `${column}:${row}`,
          position: [column * TERRAIN.width, 0, row * TERRAIN.depth],
          scale: [column % 2 === 0 ? 1 : -1, 1, row % 2 === 0 ? 1 : -1],
        })
      }
    }
    return list
  }, [])

  if (!surface.geometry) return <group />

  return (
    <group>
      {tiles.map((tile) => (
        <mesh
          key={tile.key}
          geometry={surface.geometry ?? undefined}
          material={material}
          position={[...tile.position]}
          scale={[...tile.scale]}
        />
      ))}
    </group>
  )
}

useGLTF.preload(TERRAIN.modelUrl)
