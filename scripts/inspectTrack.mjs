#!/usr/bin/env node
//
// Which of a game rip's hundred anonymous materials is the road?
//
// A marketplace model answers with a name; a rip answers with nothing. But a
// road has a signature no other surface shares: it is a large, *thin* thing —
// enormous perimeter for its area — lying flat. This renders every material's
// top-down footprint, scores it by (up-facing area x thinness), and writes a
// contact sheet of the best candidates so a human can point at the road.
//
// Usage: node scripts/inspectTrack.mjs --in <file.glb> --out /tmp/sheet.png

import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, flatten, resample } from '@gltf-transform/functions'
import sharp from 'sharp'
import { resolve } from 'node:path'

const args = {}
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1]

const GRID = 220
const CANDIDATES = 24

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
const document = await io.read(resolve(args.in))
await document.transform(resample(), dedup(), flatten())

// World-space triangles per material, walked with node transforms applied.
const IDENT = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
const mul = (a,b) => { const o=new Array(16).fill(0); for(let c=0;c<4;c++)for(let r=0;r<4;r++){let t=0;for(let k=0;k<4;k++)t+=a[k*4+r]*b[c*4+k];o[c*4+r]=t} return o }
const tp = (m,x,y,z) => [m[0]*x+m[4]*y+m[8]*z+m[12], m[1]*x+m[5]*y+m[9]*z+m[13], m[2]*x+m[6]*y+m[10]*z+m[14]]

const perMaterial = new Map()
const visit = (node, parent) => {
  const matrix = mul(parent, node.getMatrix())
  const mesh = node.getMesh()
  if (mesh) for (const prim of mesh.listPrimitives()) {
    const name = prim.getMaterial()?.getName() ?? '?'
    const pos = prim.getAttribute('POSITION')?.getArray()
    const idx = prim.getIndices()?.getArray()
    if (!pos || !idx) continue
    let bucket = perMaterial.get(name)
    if (!bucket) perMaterial.set(name, bucket = [])
    for (let t = 0; t < idx.length; t += 3) {
      const a = tp(matrix, pos[idx[t]*3], pos[idx[t]*3+1], pos[idx[t]*3+2])
      const b = tp(matrix, pos[idx[t+1]*3], pos[idx[t+1]*3+1], pos[idx[t+1]*3+2])
      const c = tp(matrix, pos[idx[t+2]*3], pos[idx[t+2]*3+1], pos[idx[t+2]*3+2])
      bucket.push([a, b, c])
    }
  }
  for (const child of node.listChildren()) visit(child, matrix)
}
for (const scene of document.getRoot().listScenes()) for (const n of scene.listChildren()) visit(n, IDENT)

// Global bounds, so every footprint is drawn in the same frame.
let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity
for (const tris of perMaterial.values()) for (const t of tris) for (const p of t) {
  if (p[0]<minX)minX=p[0]; if (p[0]>maxX)maxX=p[0]
  if (p[2]<minZ)minZ=p[2]; if (p[2]>maxZ)maxZ=p[2]
}
const cell = Math.max(maxX-minX, maxZ-minZ) / GRID

const scored = []
for (const [name, tris] of perMaterial) {
  const grid = new Uint8Array(GRID*GRID)
  let flatArea = 0
  for (const [a,b,c] of tris) {
    // Up-facing only: walls and fences are what we are trying not to see.
    const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2], vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2]
    const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx
    const len=Math.hypot(nx,ny,nz); if(len===0) continue
    if (Math.abs(ny)/len < 0.65) continue
    flatArea += len/2
    for (const p of [a,b,c]) {
      const gx=Math.min(GRID-1,Math.max(0,Math.floor((p[0]-minX)/cell)))
      const gz=Math.min(GRID-1,Math.max(0,Math.floor((p[2]-minZ)/cell)))
      grid[gz*GRID+gx]=1
    }
  }
  let cells=0, edge=0
  for (let z=1;z<GRID-1;z++) for (let x=1;x<GRID-1;x++){
    const i=z*GRID+x; if(!grid[i])continue; cells++
    if(!grid[i-1]||!grid[i+1]||!grid[i-GRID]||!grid[i+GRID]) edge++
  }
  if (cells < 30) continue
  // A ribbon is nearly all edge; a field is nearly none.
  const thinness = edge / cells
  scored.push({ name, grid, cells, thinness, score: cells * thinness })
}
scored.sort((a,b)=>b.score-a.score)

const top = scored.slice(0, CANDIDATES)
const COLS = 6
const rows = Math.ceil(top.length/COLS)
const px = Buffer.alloc(COLS*GRID*rows*GRID*3)
top.forEach((entry, i) => {
  const ox=(i%COLS)*GRID, oz=Math.floor(i/COLS)*GRID
  for(let z=0;z<GRID;z++)for(let x=0;x<GRID;x++){
    const v = entry.grid[z*GRID+x]?230:18
    const o=((oz+z)*COLS*GRID+(ox+x))*3
    px[o]=v; px[o+1]=v; px[o+2]=v
  }
})
await sharp(px,{raw:{width:COLS*GRID,height:rows*GRID,channels:3}}).png().toFile(resolve(args.out))
top.forEach((e,i)=>console.log(String(i).padStart(2), e.name.padEnd(18), 'cells',String(e.cells).padStart(6), 'thin', e.thinness.toFixed(2)))
console.log('sheet ->', args.out)
