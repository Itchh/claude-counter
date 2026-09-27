//
// Reads a baked circuit back out of its .glb as plain world-space triangles.
//
// Everything downstream of the bake — the corridor, the boundaries, any
// future measurement — has to ask questions of the geometry that is actually
// drawn, not of the source asset it came from. The source has a different
// scale, a different polygon count and, on a rip, whole chunks the bake
// dropped; measuring a barrier there and racing against the one in `public`
// is how cars end up half a metre inside a rail.
//
// So this loads the shipped file. Two things have to be undone first: the
// bake's vertex quantisation, which stores positions as integers with the
// real scale parked on a node, and the node hierarchy itself, which is
// walked here so every vertex comes back in the same space the traced
// control points live in.

import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dequantize, flatten } from '@gltf-transform/functions'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** Column-major 4x4 multiply, matching glTF's own matrix convention. */
function multiplyMatrices(a, b) {
  const out = new Array(16).fill(0)
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k]
      out[column * 4 + row] = sum
    }
  }
  return out
}

function transformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ]
}

/**
 * Every triangle in a baked circuit, in world space.
 *
 * Returned as a flat Float32Array of nine numbers per triangle rather than as
 * positions plus indices: every consumer here walks triangles one at a time
 * and none of them care which vertices were shared, so the indirection would
 * only be a second array to index wrongly.
 */
export async function readTriangles(path) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const document = await io.read(path)
  // dequantize first: until it runs, POSITION is integers and the scale that
  // makes them metres is sitting on a node the flatten below would fold away.
  await document.transform(dequantize(), flatten())

  const triangles = []

  const visit = (node, parentMatrix) => {
    const matrix = multiplyMatrices(parentMatrix, node.getMatrix())
    const mesh = node.getMesh()
    if (mesh) {
      for (const primitive of mesh.listPrimitives()) {
        const source = primitive.getAttribute('POSITION')?.getArray()
        if (!source) continue
        const count = source.length / 3
        const world = new Float64Array(source.length)
        for (let i = 0; i < count; i++) {
          const [x, y, z] = transformPoint(
            matrix,
            source[i * 3],
            source[i * 3 + 1],
            source[i * 3 + 2],
          )
          world[i * 3] = x
          world[i * 3 + 1] = y
          world[i * 3 + 2] = z
        }
        const indices = primitive.getIndices()?.getArray()
        const total = indices ? indices.length : count
        for (let i = 0; i + 2 < total; i += 3) {
          for (let corner = 0; corner < 3; corner++) {
            const vertex = (indices ? indices[i + corner] : i + corner) * 3
            triangles.push(world[vertex], world[vertex + 1], world[vertex + 2])
          }
        }
      }
    }
    for (const child of node.listChildren()) visit(child, matrix)
  }

  for (const scene of document.getRoot().listScenes()) {
    for (const node of scene.listChildren()) visit(node, IDENTITY)
  }

  return Float32Array.from(triangles)
}

/** Unit normal of the triangle at `base`, written into `out`. */
export function triangleNormal(data, base, out) {
  const ux = data[base + 3] - data[base]
  const uy = data[base + 4] - data[base + 1]
  const uz = data[base + 5] - data[base + 2]
  const vx = data[base + 6] - data[base]
  const vy = data[base + 7] - data[base + 1]
  const vz = data[base + 8] - data[base + 2]
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  const length = Math.hypot(nx, ny, nz)
  if (length === 0) {
    out[0] = 0
    out[1] = 0
    out[2] = 0
    return 0
  }
  out[0] = nx / length
  out[1] = ny / length
  out[2] = nz / length
  return length
}

/** Keeps the triangles whose unit normal passes `accept(|normal.y|)`. */
export function filterByNormal(data, accept) {
  const kept = []
  const normal = [0, 0, 0]
  for (let base = 0; base + 8 < data.length; base += 9) {
    if (triangleNormal(data, base, normal) === 0) continue
    if (!accept(Math.abs(normal[1]))) continue
    for (let i = 0; i < 9; i++) kept.push(data[base + i])
  }
  return Float32Array.from(kept)
}
