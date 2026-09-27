import * as THREE from 'three'

/**
 * The stone court, drawn rather than shipped: a small canvas of flagstones,
 * nearest-sampled and tiled in world space. Generating it keeps the forest
 * court assetless and the page a hard 64 texels square — which is the look.
 * Shared by the court and by the dojo's floor, so the fighter on the
 * turntable stands on the same stone as the fighter in the ring.
 */
export function makeStoneTexture(): THREE.CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#2a3527'
    ctx.fillRect(0, 0, size, size)
    const tiles = 4
    const tile = size / tiles
    for (let row = 0; row < tiles; row++) {
      for (let col = 0; col < tiles; col++) {
        const jitter = ((row * 7 + col * 13) % 5) - 2
        const shade = 58 + ((row * 11 + col * 5) % 4) * 7 + jitter
        ctx.fillStyle = `rgb(${shade - 12}, ${shade}, ${shade - 18})`
        ctx.fillRect(col * tile + 1, row * tile + 1, tile - 2, tile - 2)
        // One worn corner per stone, so the grid does not read as graph paper.
        ctx.fillStyle = 'rgba(0,0,0,0.18)'
        ctx.fillRect(col * tile + 1, row * tile + tile - 4, tile - 2, 3)
      }
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestMipmapLinearFilter
  texture.generateMipmaps = true
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  return texture
}
