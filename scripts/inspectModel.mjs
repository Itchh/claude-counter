import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer'

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder }).registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
for (const file of process.argv.slice(2)) {
  try {
    const doc = await io.read(file)
    const root = doc.getRoot()
    let tris = 0
    for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) { const idx = prim.getIndices(); tris += idx ? idx.getCount()/3 : prim.getAttribute('POSITION').getCount()/3 }
    const bbox = (() => { let min=[Infinity,Infinity,Infinity], max=[-Infinity,-Infinity,-Infinity]; for (const node of root.listNodes()) { const m = node.getMesh(); if(!m) continue; const wm = node.getWorldMatrix(); for (const p of m.listPrimitives()) { const pos = p.getAttribute('POSITION'); const n = pos.getCount(); const v=[0,0,0]; for (let i=0;i<n;i+=Math.max(1,Math.floor(n/2000))) { pos.getElement(i,v); const x=wm[0]*v[0]+wm[4]*v[1]+wm[8]*v[2]+wm[12]; const y=wm[1]*v[0]+wm[5]*v[1]+wm[9]*v[2]+wm[13]; const z=wm[2]*v[0]+wm[6]*v[1]+wm[10]*v[2]+wm[14]; min=[Math.min(min[0],x),Math.min(min[1],y),Math.min(min[2],z)]; max=[Math.max(max[0],x),Math.max(max[1],y),Math.max(max[2],z)] } } } return {min:min.map(n=>+n.toFixed(2)),max:max.map(n=>+n.toFixed(2))} })()
    console.log('==', file.split('/').pop())
    console.log('  meshes', root.listMeshes().length, 'nodes', root.listNodes().length, 'tris', tris, 'skins', root.listSkins().length, 'anims', root.listAnimations().map(a=>a.getName()), 'textures', root.listTextures().map(t=>`${t.getName()||'?'}:${t.getSize()?.join('x')}`), 'materials', root.listMaterials().map(m=>m.getName()), 'ext', root.listExtensionsUsed().map(e=>e.extensionName))
    console.log('  bbox', JSON.stringify(bbox))
    for (const skin of root.listSkins()) console.log('  skin joints', skin.listJoints().length, skin.listJoints().slice(0,80).map(j=>j.getName()).join(','))
  } catch (e) { console.log('==', file, 'ERR', e.message) }
}
