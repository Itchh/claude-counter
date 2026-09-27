#!/usr/bin/env node
//
// Turns the downloaded fighters into characters the fight channel can put
// in a ring: rigged, animated, and cut down to the console's budget.
//
// The models arrive as sculpts — a quarter of a million triangles each, one
// 1024 page, no skeleton, standing in an A-pose. A sculpt cannot fight. What
// it needs is a skeleton with fighting moves on it, and building one by hand
// is a week in Blender per character. So the skeleton is borrowed instead:
// Quaternius's Universal Animation Library (CC0) ships a humanoid rig with
// jabs, crosses, flinches, a death and an idle already keyed on it. The
// sculpt is scaled to that rig, the rig's arms are lowered to meet the
// sculpt's, and every vertex is bound to the nearest bones — which is how
// the era's own characters were skinned, by a person doing exactly this
// with a paint tool and less patience.
//
// Per fighter, in this order:
//
//   1. Flatten, merge and decimate the sculpt to the polygon budget.
//   2. Stand it on the floor at the rig's height, facing +z.
//   3. Pose the rig's arms to the sculpt's measured A-pose, and bind every
//      vertex to the four closest bones by inverse-distance.
//   4. Write the sculpt, the rig, and the clips into one glb.
//
// The moves the library does not have — the kicks, a block, the guard
// stance, a stagger — are authored here as keyframes on the same bones, so
// the runtime never has to know which clips were bought and which were made.
//
// Two ways in. `--src` is the full bake from the sculpts. `--from-baked`
// takes the last bake's own output as the source instead: the mesh, the
// bind and the rig are kept exactly as they were, the clips are stripped
// and installed again from the library and from the tables below, and the
// strikes are re-measured. That is the path for changing the choreography
// without re-downloading a quarter of a million triangles, and the only
// path when the sculpts are no longer on the machine.
//
// Usage: node scripts/bakeFighters.mjs --src <dir of .glb files> [--only <slug>] [--check 1]
//        node scripts/bakeFighters.mjs --from-baked 1 [--only <slug>] [--check 1]

import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { quantize } from '@gltf-transform/functions'
import * as THREE from 'three'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { resolve, dirname, join as joinPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseArguments, findSources, flattenToWorld, transformAll, allPrimitives,
  boundsOf, countTriangles, decimate, reduceTextures, join, prune, rotationY,
  scaleTranslate, multiplyMatrices,
} from './bakeShared.mjs'

// --- The roster -------------------------------------------------------------

/**
 * Triangles per fighter. The era's characters were a few hundred to a
 * couple of thousand; at 270 lines a fighter stands a hundred pixels tall,
 * and past two and a half thousand triangles nothing more reaches a pixel.
 */
const BUDGET = 2400
/** The colour page. Twice the cars' 128: a face has to survive. */
const PAGE_SIZE = 256

/**
 * One entry per source file. The slug names the baked file and the name is
 * what the select screen prints. `flip` turns a sculpt that faces -z; the
 * bake measures the feet and warns when it thinks a flag is wrong.
 */
const FIGHTERS = [
  { slug: 'kaida', file: 'fantasy_fighter.glb', name: 'Kaida', note: 'Blue gi, white sash' },
  { slug: 'roan', file: 'fantasy_fighter-2.glb', name: 'Roan', note: 'Long reach, longer memory' },
  { slug: 'mireille', file: 'fantasy_fighter-3.glb', name: 'Mireille', note: 'Fights on the front foot' },
  { slug: 'tobias', file: 'fantasy_fighter-4.glb', name: 'Tobias', note: 'Broad shoulders, short fuse' },
  { slug: 'sable', file: 'fantasy_fighter-5.glb', name: 'Sable', note: 'Never blocks twice' },
  { slug: 'ines', file: 'fantasy_fighter-6.glb', name: 'Inés', note: 'Patient until she is not' },
  { slug: 'hollis', file: 'fantasy_fighter-7.glb', name: 'Hollis', note: 'Counter-puncher' },
]

// --- The library ------------------------------------------------------------

/**
 * The rig and the clips. Public domain (CC0 1.0), by Quaternius, redistributed
 * as plain glTF by J-Ponzo. Fetched into the package cache on first use
 * rather than committed: four megabytes of mannequin the runtime never sees.
 */
const LIBRARY = {
  base: 'https://raw.githubusercontent.com/J-Ponzo/gltf-universal-animation-library/HEAD/glTF/',
  gltf: 'AnimationLibrary_Godot_Standard.gltf',
  bin: 'AnimationLibrary_Godot_Standard.bin',
}

/**
 * The clips the bout uses, and nothing else — every other clip in the
 * library is stripped before the rig is written, along with every finger
 * bone, which a hundred-pixel fighter has no use for.
 *
 * This is the whole of what the library has for a fight. Its forty-odd
 * clips are an adventurer's — swimming, pistols, sitting down — and the
 * combat in it is two punches, two flinches, a death and the stance the
 * punches start from. No kick, no block, no dodge, no sidestep, no walk
 * backwards, no stagger, no taunt: those are authored below or made at
 * runtime (a retreat is the walk played in reverse, the era's own trick).
 * Dance_Loop is the closest thing to a victory pose and is used as one.
 *
 * `strikeAt` and `reach` are measured, not guessed: the moment the striking
 * limb is furthest forward, as a fraction of the clip, and how far forward
 * it gets, in the fighter's own units. The runtime speeds each strike up so
 * the moment lands on the simulation's own hit frame, and only scores the
 * hit if the opponent is inside the reach on that frame.
 */
const LIBRARY_CLIPS = [
  'Idle_Loop',
  'Walk_Loop',
  'Punch_Enter',
  'Punch_Jab',
  'Punch_Cross',
  'Hit_Chest',
  'Hit_Head',
  'Death01',
  'Dance_Loop',
]

/** Which clips are strikes, and which limb does the striking. */
const STRIKE_LIMB = {
  Punch_Jab: 'hands',
  Punch_Cross: 'hands',
  Kick: 'feet',
  Kick_Round: 'feet',
}
const LIMB_JOINTS = {
  hands: ['DEF-hand.L', 'DEF-hand.R'],
  feet: ['DEF-foot.L', 'DEF-foot.R', 'DEF-toe.L', 'DEF-toe.R'],
}

/** The authored clips, by name — stripped and rewritten on a re-bake. */
const AUTHORED_CLIPS = ['Kick', 'Kick_Round', 'Block', 'Guard', 'Guard_Shift', 'Hit_Stagger']

/** Joints kept. Everything under a hand is dropped. */
const DROPPED_JOINT = /^DEF-(f_|thumb)/

/** The bones a vertex may bind to: joint -> the joint its bone runs to. */
const BONES = [
  ['DEF-hips', 'DEF-spine.001'],
  ['DEF-spine.001', 'DEF-spine.002'],
  ['DEF-spine.002', 'DEF-spine.003'],
  ['DEF-spine.003', 'DEF-neck'],
  ['DEF-neck', 'DEF-head'],
  ['DEF-head', null],
  ['DEF-shoulder.L', 'DEF-upper_arm.L'],
  ['DEF-upper_arm.L', 'DEF-forearm.L'],
  ['DEF-forearm.L', 'DEF-hand.L'],
  ['DEF-hand.L', null],
  ['DEF-shoulder.R', 'DEF-upper_arm.R'],
  ['DEF-upper_arm.R', 'DEF-forearm.R'],
  ['DEF-forearm.R', 'DEF-hand.R'],
  ['DEF-hand.R', null],
  ['DEF-thigh.L', 'DEF-shin.L'],
  ['DEF-shin.L', 'DEF-foot.L'],
  ['DEF-foot.L', 'DEF-toe.L'],
  ['DEF-thigh.R', 'DEF-shin.R'],
  ['DEF-shin.R', 'DEF-foot.R'],
  ['DEF-foot.R', 'DEF-toe.R'],
]

/** Length of a bone with no child joint — the head and the hands. */
const STUB_LENGTH = { 'DEF-head': 0.22, 'DEF-hand.L': 0.12, 'DEF-hand.R': 0.12 }

/** Bones per vertex. The hardware's own skinning limit, as it happens. */
const INFLUENCES = 4
/** Falloff of the inverse-distance bind. Higher is crisper joints. */
const BIND_POWER = 4
/** Passes of weight smoothing over the mesh graph after the bind. */
const SMOOTHING_PASSES = 2

async function fetchLibrary() {
  const cacheDir = resolve(dirname(fileURLToPath(import.meta.url)), '../node_modules/.cache/ual')
  await mkdir(cacheDir, { recursive: true })
  for (const file of [LIBRARY.gltf, LIBRARY.bin]) {
    const target = joinPath(cacheDir, file)
    try {
      await access(target)
    } catch {
      console.log(`fetching ${file}`)
      const response = await fetch(LIBRARY.base + file)
      if (!response.ok) throw new Error(`Could not fetch ${file}: ${response.status}`)
      await writeFile(target, Buffer.from(await response.arrayBuffer()))
    }
  }
  return joinPath(cacheDir, LIBRARY.gltf)
}

/**
 * Strips the library to the rig and the clips the bout needs: no mannequin,
 * no fingers, no swimming.
 */
function pruneLibrary(document) {
  const root = document.getRoot()
  for (const animation of root.listAnimations()) {
    if (!LIBRARY_CLIPS.includes(animation.getName())) {
      for (const channel of animation.listChannels()) channel.dispose()
      for (const sampler of animation.listSamplers()) sampler.dispose()
      animation.dispose()
    }
  }
  const dropped = root.listNodes().filter((node) => DROPPED_JOINT.test(node.getName()))
  for (const animation of root.listAnimations()) {
    for (const channel of animation.listChannels()) {
      if (dropped.includes(channel.getTargetNode())) channel.dispose()
    }
  }
  const skin = root.listSkins()[0]
  // The mannequin's own mesh and skin go; the joints are re-listed on a new
  // skin per fighter, with the fighter's own bind matrices.
  for (const node of root.listNodes()) {
    if (node.getMesh()) {
      node.getMesh().dispose()
      node.dispose()
    }
  }
  skin.dispose()
  for (const node of dropped) node.dispose()
  pruneConstantChannels(document)
}

/**
 * Constant channels are dead weight: a scale track that says 1 for two
 * seconds is a kilobyte of nothing per clip per joint. A constant track is
 * also the joint's rest, so restating it as the node's own transform loses
 * nothing.
 */
function pruneConstantChannels(document) {
  for (const animation of document.getRoot().listAnimations()) {
    for (const channel of animation.listChannels()) {
      const sampler = channel.getSampler()
      const output = sampler.getOutput()
      const values = output.getArray()
      const size = output.getElementSize()
      let constant = true
      for (let i = size; i < values.length && constant; i++) {
        if (Math.abs(values[i] - values[i % size]) > 1e-5) constant = false
      }
      if (!constant) continue
      const path = channel.getTargetPath()
      const node = channel.getTargetNode()
      if (path === 'scale') node.setScale([values[0], values[1], values[2]])
      if (path === 'translation') node.setTranslation([values[0], values[1], values[2]])
      if (path === 'rotation') node.setRotation([values[0], values[1], values[2], values[3]])
      channel.dispose()
    }
  }
}

/**
 * Copies the library's fight clips onto a rig in another document, joint
 * by joint by name. Channels aimed at joints the rig no longer has — the
 * fingers — are left behind. This is how a re-bake gets its clips: the
 * baked file's rig is the library's rig minus the fingers, so every name
 * lands.
 */
function installLibraryClips(target, library) {
  const joints = new Map(target.getRoot().listNodes().map((node) => [node.getName(), node]))
  const copied = new Map()
  const copyAccessor = (source) => {
    let accessor = copied.get(source)
    if (!accessor) {
      accessor = target.createAccessor(source.getName()).setType(source.getType()).setArray(source.getArray().slice())
      copied.set(source, accessor)
    }
    return accessor
  }
  for (const source of library.getRoot().listAnimations()) {
    if (!LIBRARY_CLIPS.includes(source.getName())) continue
    const animation = target.createAnimation(source.getName())
    for (const channel of source.listChannels()) {
      const joint = joints.get(channel.getTargetNode()?.getName() ?? '')
      if (!joint) continue
      const sampler = channel.getSampler()
      const copy = target.createAnimationSampler()
        .setInput(copyAccessor(sampler.getInput()))
        .setOutput(copyAccessor(sampler.getOutput()))
        .setInterpolation(sampler.getInterpolation())
      animation.addSampler(copy)
      animation.addChannel(target.createAnimationChannel().setTargetNode(joint).setTargetPath(channel.getTargetPath()).setSampler(copy))
    }
  }
  pruneConstantChannels(target)
}

/** Every clip off a rig, so a re-bake starts from silence. */
function stripClips(document) {
  for (const animation of document.getRoot().listAnimations()) {
    for (const channel of animation.listChannels()) channel.dispose()
    for (const sampler of animation.listSamplers()) sampler.dispose()
    animation.dispose()
  }
}

// --- Rig arithmetic ---------------------------------------------------------

function jointByName(document, name) {
  const joint = document.getRoot().listNodes().find((node) => node.getName() === name)
  if (!joint) throw new Error(`Rig has no joint ${name}`)
  return joint
}

function listJoints(document) {
  const root = jointByName(document, 'root')
  const joints = []
  const visit = (node) => {
    joints.push(node)
    for (const child of node.listChildren()) visit(child)
  }
  visit(root)
  return joints
}

function worldMatrixOf(node) {
  return new THREE.Matrix4().fromArray(node.getWorldMatrix())
}

function worldPositionOf(node) {
  const matrix = node.getWorldMatrix()
  return new THREE.Vector3(matrix[12], matrix[13], matrix[14])
}

/**
 * Rotates a joint so that, in world space, its bone turns by `delta`. The
 * joint's local rotation is what the file stores, so the world turn is
 * conjugated through the parent's world rotation first.
 */
function turnJointInWorld(joint, delta) {
  const parent = joint.getParentNode()
  const parentWorld = parent ? new THREE.Quaternion().setFromRotationMatrix(worldMatrixOf(parent)) : new THREE.Quaternion()
  const local = new THREE.Quaternion().fromArray(joint.getRotation())
  const next = parentWorld.clone().invert().multiply(delta).multiply(parentWorld).multiply(local)
  joint.setRotation(next.toArray())
}

/** A world-space quaternion for a turn about a world axis. */
function aboutWorld(axis, radians) {
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), radians)
}

// --- Binding ----------------------------------------------------------------

/**
 * Distance from a point to a bone segment, and where along it. The plain
 * capsule test; there is no cleverer geometry a 2400-triangle character
 * would reward.
 */
function distanceToSegment(point, a, b) {
  const ab = b.clone().sub(a)
  const length2 = ab.lengthSq()
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, point.clone().sub(a).dot(ab) / length2))
  return point.distanceTo(a.clone().add(ab.multiplyScalar(t)))
}

/**
 * Binds every vertex to its nearest bones, in whatever pose the rig is in
 * when this is called — which is the A-pose matched to the sculpt.
 */
function bindVertices(document, positions, indices, jointOrder, log) {
  const bones = BONES.map(([from, to]) => {
    const a = worldPositionOf(jointByName(document, from))
    const b = to
      ? worldPositionOf(jointByName(document, to))
      : a.clone().add(boneDirection(document, from).multiplyScalar(STUB_LENGTH[from] ?? 0.1))
    return { joint: from, index: jointOrder.indexOf(from), a, b }
  })
  const vertexCount = positions.length / 3
  const jointsOut = new Uint8Array(vertexCount * 4)
  const weightsOut = new Float32Array(vertexCount * 4)
  const dense = new Float32Array(vertexCount * bones.length)
  const point = new THREE.Vector3()

  for (let v = 0; v < vertexCount; v++) {
    point.set(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2])
    const scored = bones.map((bone, index) => ({
      index,
      weight: 1 / Math.pow(distanceToSegment(point, bone.a, bone.b) + 0.015, BIND_POWER),
    }))
    scored.sort((x, y) => y.weight - x.weight)
    const kept = scored.slice(0, INFLUENCES)
    const total = kept.reduce((sum, entry) => sum + entry.weight, 0)
    for (const entry of kept) dense[v * bones.length + entry.index] = entry.weight / total
  }

  // Smoothing over the mesh graph: a vertex takes on a share of its
  // neighbours' bindings, which is what keeps a knee from creasing to a
  // point the moment the shin turns.
  const neighbours = Array.from({ length: vertexCount }, () => new Set())
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]]
    neighbours[a].add(b).add(c)
    neighbours[b].add(a).add(c)
    neighbours[c].add(a).add(b)
  }
  let current = dense
  for (let pass = 0; pass < SMOOTHING_PASSES; pass++) {
    const next = new Float32Array(current.length)
    for (let v = 0; v < vertexCount; v++) {
      const around = neighbours[v]
      const own = 0.5
      const share = around.size > 0 ? (1 - own) / around.size : 0
      for (let bone = 0; bone < bones.length; bone++) {
        let value = current[v * bones.length + bone] * (around.size > 0 ? own : 1)
        for (const n of around) value += current[n * bones.length + bone] * share
        next[v * bones.length + bone] = value
      }
    }
    current = next
  }

  let unbound = 0
  for (let v = 0; v < vertexCount; v++) {
    const row = Array.from({ length: bones.length }, (_, bone) => ({ bone, weight: current[v * bones.length + bone] }))
    row.sort((x, y) => y.weight - x.weight)
    const kept = row.slice(0, INFLUENCES)
    const total = kept.reduce((sum, entry) => sum + entry.weight, 0)
    if (total <= 0) unbound++
    for (let slot = 0; slot < INFLUENCES; slot++) {
      const entry = kept[slot]
      jointsOut[v * 4 + slot] = entry ? bones[entry.bone].index : 0
      weightsOut[v * 4 + slot] = entry && total > 0 ? entry.weight / total : slot === 0 ? 1 : 0
    }
  }
  if (unbound > 0) log(`  warning: ${unbound} vertices found no bone`)
  return { jointsOut, weightsOut }
}

/** The direction a stub bone points: on from its parent, in world. */
function boneDirection(document, name) {
  const joint = jointByName(document, name)
  const parent = joint.getParentNode()
  const here = worldPositionOf(joint)
  const from = parent ? worldPositionOf(parent) : here.clone().sub(new THREE.Vector3(0, 1, 0))
  const direction = here.clone().sub(from)
  return direction.lengthSq() === 0 ? new THREE.Vector3(0, 1, 0) : direction.normalize()
}

// --- Clip evaluation, for measuring and for checking -------------------------

/** Samples one channel at `time`, linearly, in whatever the output is. */
function sampleChannel(channel, time) {
  const sampler = channel.getSampler()
  const times = sampler.getInput().getArray()
  const output = sampler.getOutput()
  const size = output.getElementSize()
  const values = output.getArray()
  const last = times.length - 1
  if (time <= times[0]) return Array.from(values.slice(0, size))
  if (time >= times[last]) return Array.from(values.slice(last * size, last * size + size))
  let hi = 1
  while (times[hi] < time) hi++
  const lo = hi - 1
  const t = (time - times[lo]) / (times[hi] - times[lo])
  const a = Array.from(values.slice(lo * size, lo * size + size))
  const b = Array.from(values.slice(hi * size, hi * size + size))
  if (size === 4) {
    return new THREE.Quaternion().fromArray(a).slerp(new THREE.Quaternion().fromArray(b), t).toArray()
  }
  return a.map((value, i) => value + (b[i] - value) * t)
}

/** Poses the rig at `time` in `animation`. Returns a restore function. */
function poseRig(document, animation, time) {
  const saved = new Map()
  for (const channel of animation.listChannels()) {
    const node = channel.getTargetNode()
    if (!node) continue
    if (!saved.has(node)) saved.set(node, { t: node.getTranslation(), r: node.getRotation(), s: node.getScale() })
    const value = sampleChannel(channel, time)
    const path = channel.getTargetPath()
    if (path === 'translation') node.setTranslation(value)
    if (path === 'rotation') node.setRotation(value)
    if (path === 'scale') node.setScale(value)
  }
  return () => {
    for (const [node, rest] of saved) {
      node.setTranslation(rest.t).setRotation(rest.r).setScale(rest.s)
    }
  }
}

function clipDuration(animation) {
  let max = 0
  for (const channel of animation.listChannels()) max = Math.max(max, channel.getSampler().getInput().getMax([])[0])
  return max
}

/**
 * When the striking limb is furthest forward, as a fraction of the clip, and
 * how far forward it gets. Forward is +z, the way the sculpt faces; the
 * distance is from the fighter's own origin, which is where the simulation
 * stands them, so a reach of 0.8 means a fist 0.8 units in front of the
 * mark the fighter is standing on.
 */
function measureStrike(document, animation, limb) {
  const duration = clipDuration(animation)
  const joints = LIMB_JOINTS[limb].map((name) => jointByName(document, name))
  let best = { t: 0.4, reach: -Infinity }
  for (let step = 0; step <= 40; step++) {
    const time = (step / 40) * duration
    const restore = poseRig(document, animation, time)
    const reach = Math.max(...joints.map((joint) => worldPositionOf(joint).z))
    restore()
    if (reach > best.reach) best = { t: step / 40, reach }
  }
  return best
}

/**
 * Skins the mesh on the CPU and draws its front silhouette — the one check
 * there is on a bind without opening a browser. Twenty lines of ASCII will
 * show a leg left behind or an arm bound to the hip.
 */
function silhouette(document, animation, time, positions, jointsOut, weightsOut, jointOrder, inverseBinds, label) {
  const restore = animation ? poseRig(document, animation, time) : () => {}
  const worlds = jointOrder.map((name) => worldMatrixOf(jointByName(document, name)))
  const skinned = worlds.map((world, i) => world.clone().multiply(inverseBinds[i]))
  restore()
  const W = 44, H = 30
  const front = Array.from({ length: H }, () => Array(W).fill(' '))
  const side = Array.from({ length: H }, () => Array(W).fill(' '))
  const point = new THREE.Vector3()
  const out = new THREE.Vector3()
  const temp = new THREE.Vector3()
  for (let v = 0; v < positions.length / 3; v++) {
    point.set(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2])
    out.set(0, 0, 0)
    for (let slot = 0; slot < 4; slot++) {
      const weight = weightsOut[v * 4 + slot]
      if (weight === 0) continue
      temp.copy(point).applyMatrix4(skinned[jointsOut[v * 4 + slot]])
      out.addScaledVector(temp, weight)
    }
    const row = Math.min(H - 1, Math.max(0, Math.round((1 - out.y / 2) * (H - 1))))
    const col = Math.min(W - 1, Math.max(0, Math.round(((out.x + 1.2) / 2.4) * (W - 1))))
    const colZ = Math.min(W - 1, Math.max(0, Math.round(((out.z + 1.2) / 2.4) * (W - 1))))
    front[row][col] = '#'
    side[row][colZ] = '#'
  }
  console.log(`  ${label}`)
  for (let row = 0; row < H; row++) console.log(`  |${front[row].join('')}|${side[row].join('')}|`)
}

// --- Authored clips ---------------------------------------------------------

/**
 * Writes a clip onto the rig from a table of keys: for each joint, a list of
 * [time, world-axis, radians] turns relative to the base pose. Rotations
 * only; a fighter's feet stay where the simulation puts them.
 */
function authorClip(document, name, basePose, keys, duration) {
  // The whole rig in the base pose while the keys are computed: a world-axis
  // turn is conjugated through the parent's world rotation, and a shoulder
  // in the guard does not point where a shoulder in the T-pose does.
  const saved = new Map()
  for (const [joint, base] of basePose) {
    saved.set(joint, { r: joint.getRotation(), t: joint.getTranslation() })
    joint.setRotation(base.r)
    if (base.t) joint.setTranslation(base.t)
  }
  const animation = document.createAnimation(name)
  const times = [...new Set(keys.flatMap((key) => key.frames.map(([t]) => t)).concat([0, duration]))].sort((a, b) => a - b)
  const input = document.createAccessor(`${name}.time`).setType('SCALAR').setArray(new Float32Array(times))
  for (const key of keys) {
    const joint = jointByName(document, key.joint)
    const base = basePose.get(joint) ?? { r: joint.getRotation() }
    const values = new Float32Array(times.length * 4)
    for (let i = 0; i < times.length; i++) {
      const time = times[i]
      // Piecewise-linear turn amount between this joint's own keys.
      const frames = key.frames
      let angle = 0
      if (time <= frames[0][0]) angle = frames[0][2] * (frames[0][0] === 0 ? 1 : time / frames[0][0])
      else if (time >= frames[frames.length - 1][0]) angle = frames[frames.length - 1][2]
      else {
        let hi = 1
        while (frames[hi][0] < time) hi++
        const [t0, , a0] = frames[hi - 1]
        const [t1, , a1] = frames[hi]
        angle = a0 + ((time - t0) / (t1 - t0)) * (a1 - a0)
      }
      // Keys are world-axis turns; conjugate through the base pose's parent.
      joint.setRotation(base.r)
      turnJointInWorld(joint, aboutWorld(key.frames[0][1], angle))
      const rotation = joint.getRotation()
      values.set(rotation, i * 4)
      joint.setRotation(base.r)
    }
    const output = document.createAccessor(`${name}.${key.joint}`).setType('VEC4').setArray(values)
    const sampler = document.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR')
    animation.addSampler(sampler)
    animation.addChannel(document.createAnimationChannel().setTargetNode(joint).setTargetPath('rotation').setSampler(sampler))
  }
  // Every other joint holds the base pose, so a clip is a complete pose and
  // not a delta the runtime has to layer.
  const held = document.getRoot().listNodes().filter((node) => /^DEF-/.test(node.getName()) && !keys.some((key) => key.joint === node.getName()))
  for (const joint of held) {
    const base = basePose.get(joint)
    if (!base) continue
    const output = document.createAccessor(`${name}.${joint.getName()}`).setType('VEC4').setArray(new Float32Array([...base.r, ...base.r]))
    const twoKeys = document.createAccessor(`${name}.hold`).setType('SCALAR').setArray(new Float32Array([0, duration]))
    const sampler = document.createAnimationSampler().setInput(twoKeys).setOutput(output).setInterpolation('LINEAR')
    animation.addSampler(sampler)
    animation.addChannel(document.createAnimationChannel().setTargetNode(joint).setTargetPath('rotation').setSampler(sampler))
    if (base.t) {
      const tOut = document.createAccessor(`${name}.${joint.getName()}.t`).setType('VEC3').setArray(new Float32Array([...base.t, ...base.t]))
      const tSampler = document.createAnimationSampler().setInput(twoKeys).setOutput(tOut).setInterpolation('LINEAR')
      animation.addSampler(tSampler)
      animation.addChannel(document.createAnimationChannel().setTargetNode(joint).setTargetPath('translation').setSampler(tSampler))
    }
  }
  for (const [joint, rest] of saved) joint.setRotation(rest.r).setTranslation(rest.t)
  return animation
}

/** The rig's pose at the end of a clip, joint by joint. */
function captureBasePose(document, animation, time) {
  const restore = poseRig(document, animation, time)
  const pose = new Map()
  for (const node of document.getRoot().listNodes()) {
    if (!/^DEF-|^root$/.test(node.getName())) continue
    const hasTranslation = animation.listChannels().some((channel) => channel.getTargetNode() === node && channel.getTargetPath() === 'translation')
    pose.set(node, { r: node.getRotation(), t: hasTranslation ? node.getTranslation() : null })
  }
  restore()
  return pose
}

const DEG = Math.PI / 180
const X = [1, 0, 0]
const Y = [0, 1, 0]
const Z = [0, 0, 1]

/**
 * The moves the library does not ship, keyed on the guard stance the
 * library's own "enter fighting" clip ends in.
 *
 * Two kicks from the back leg. The front kick: knee up and chambered, shin
 * snaps out, body leans away. The roundhouse: the knee comes up and out,
 * the hips turn, and the shin whips across the front. A hook off the rear
 * hand: elbow up, arm swung level across the body. A block: both forearms
 * across the face. A stagger: the heavier flinch, head and shoulders thrown
 * back and the arms opened, for the hit that lands hard.
 *
 * Two guards, chosen between at random when a fighter drops into idle. Both
 * are the stance with weight on it — the hips rock from foot to foot, the
 * knees give and take, the head checks the opponent — because a guard held
 * perfectly still is a mannequin, and the one thing a fighting game must
 * never look like is its own select screen.
 */
function authorFightClips(document, basePose) {
  authorClip(document, 'Kick', basePose, [
    { joint: 'DEF-thigh.R', frames: [[0, X, 0], [0.14, X, -95 * DEG], [0.26, X, -85 * DEG], [0.46, X, 0]] },
    { joint: 'DEF-shin.R', frames: [[0, X, 0], [0.14, X, 105 * DEG], [0.26, X, 5 * DEG], [0.46, X, 0]] },
    { joint: 'DEF-spine.001', frames: [[0, X, 0], [0.26, X, 18 * DEG], [0.46, X, 0]] },
    { joint: 'DEF-thigh.L', frames: [[0, X, 0], [0.26, X, 12 * DEG], [0.46, X, 0]] },
    { joint: 'DEF-upper_arm.R', frames: [[0, X, 0], [0.26, X, 25 * DEG], [0.46, X, 0]] },
  ], 0.46)
  authorClip(document, 'Kick_Round', basePose, [
    { joint: 'DEF-thigh.R', frames: [[0, X, 0], [0.14, X, -80 * DEG], [0.28, X, -75 * DEG], [0.5, X, 0]] },
    { joint: 'DEF-thigh.L', frames: [[0, Y, 0], [0.14, Y, -20 * DEG], [0.28, Y, -45 * DEG], [0.5, Y, 0]] },
    { joint: 'DEF-shin.R', frames: [[0, X, 0], [0.14, X, 110 * DEG], [0.28, X, 10 * DEG], [0.5, X, 0]] },
    { joint: 'DEF-hips', frames: [[0, Y, 0], [0.14, Y, 20 * DEG], [0.28, Y, 45 * DEG], [0.5, Y, 0]] },
    { joint: 'DEF-spine.001', frames: [[0, X, 0], [0.28, X, 22 * DEG], [0.5, X, 0]] },
    { joint: 'DEF-upper_arm.L', frames: [[0, X, 0], [0.28, X, 30 * DEG], [0.5, X, 0]] },
  ], 0.5)
  authorClip(document, 'Block', basePose, [
    { joint: 'DEF-upper_arm.L', frames: [[0, Y, 0], [0.1, Y, -55 * DEG], [0.4, Y, -55 * DEG]] },
    { joint: 'DEF-upper_arm.R', frames: [[0, Y, 0], [0.1, Y, 55 * DEG], [0.4, Y, 55 * DEG]] },
    { joint: 'DEF-forearm.L', frames: [[0, Z, 0], [0.1, Z, 60 * DEG], [0.4, Z, 60 * DEG]] },
    { joint: 'DEF-forearm.R', frames: [[0, Z, 0], [0.1, Z, -60 * DEG], [0.4, Z, -60 * DEG]] },
    { joint: 'DEF-spine.002', frames: [[0, X, 0], [0.1, X, 10 * DEG], [0.4, X, 10 * DEG]] },
  ], 0.4)
  authorClip(document, 'Hit_Stagger', basePose, [
    { joint: 'DEF-spine.001', frames: [[0, X, 0], [0.1, X, 24 * DEG], [0.28, X, 20 * DEG], [0.45, X, 0]] },
    { joint: 'DEF-spine.002', frames: [[0, X, 0], [0.1, X, 12 * DEG], [0.45, X, 0]] },
    { joint: 'DEF-head', frames: [[0, X, 0], [0.08, X, 22 * DEG], [0.45, X, 0]] },
    { joint: 'DEF-upper_arm.L', frames: [[0, Z, 0], [0.1, Z, 35 * DEG], [0.45, Z, 0]] },
    { joint: 'DEF-upper_arm.R', frames: [[0, Z, 0], [0.1, Z, -35 * DEG], [0.45, Z, 0]] },
  ], 0.45)
  // The rock: hips over one foot, then the other, the knees taking the
  // weight as it arrives and the shoulders following a beat behind.
  authorClip(document, 'Guard', basePose, [
    { joint: 'DEF-hips', frames: [[0, Z, 0], [0.5, Z, 4 * DEG], [1.5, Z, -4 * DEG], [2.0, Z, 0]] },
    { joint: 'DEF-thigh.L', frames: [[0, X, 0], [0.5, X, 8 * DEG], [1.5, X, 2 * DEG], [2.0, X, 0]] },
    { joint: 'DEF-thigh.R', frames: [[0, X, 0], [0.5, X, 2 * DEG], [1.5, X, 8 * DEG], [2.0, X, 0]] },
    { joint: 'DEF-shin.L', frames: [[0, X, 0], [0.5, X, -10 * DEG], [1.5, X, -3 * DEG], [2.0, X, 0]] },
    { joint: 'DEF-shin.R', frames: [[0, X, 0], [0.5, X, -3 * DEG], [1.5, X, -10 * DEG], [2.0, X, 0]] },
    { joint: 'DEF-spine.002', frames: [[0, Z, 0], [0.7, Z, -3 * DEG], [1.7, Z, 3 * DEG], [2.0, Z, 0]] },
    { joint: 'DEF-upper_arm.L', frames: [[0, X, 0], [0.6, X, 6 * DEG], [1.6, X, -3 * DEG], [2.0, X, 0]] },
    { joint: 'DEF-upper_arm.R', frames: [[0, X, 0], [0.6, X, -3 * DEG], [1.6, X, 6 * DEG], [2.0, X, 0]] },
    { joint: 'DEF-head', frames: [[0, Y, 0], [0.7, Y, 5 * DEG], [1.5, Y, -4 * DEG], [2.0, Y, 0]] },
  ], 2.0)
  // The bounce: the boxer's, quicker, on the toes — both knees give
  // together and the guard pumps with them.
  authorClip(document, 'Guard_Shift', basePose, [
    { joint: 'DEF-thigh.L', frames: [[0, X, 0], [0.3, X, 10 * DEG], [0.6, X, 0], [0.9, X, 10 * DEG], [1.2, X, 0]] },
    { joint: 'DEF-thigh.R', frames: [[0, X, 0], [0.3, X, 10 * DEG], [0.6, X, 0], [0.9, X, 10 * DEG], [1.2, X, 0]] },
    { joint: 'DEF-shin.L', frames: [[0, X, 0], [0.3, X, -16 * DEG], [0.6, X, 0], [0.9, X, -16 * DEG], [1.2, X, 0]] },
    { joint: 'DEF-shin.R', frames: [[0, X, 0], [0.3, X, -16 * DEG], [0.6, X, 0], [0.9, X, -16 * DEG], [1.2, X, 0]] },
    { joint: 'DEF-spine.001', frames: [[0, X, 0], [0.3, X, -5 * DEG], [0.6, X, 0], [0.9, X, -5 * DEG], [1.2, X, 0]] },
    { joint: 'DEF-upper_arm.L', frames: [[0, X, 0], [0.3, X, 8 * DEG], [0.6, X, 0], [0.9, X, 8 * DEG], [1.2, X, 0]] },
    { joint: 'DEF-upper_arm.R', frames: [[0, X, 0], [0.3, X, 8 * DEG], [0.6, X, 0], [0.9, X, 8 * DEG], [1.2, X, 0]] },
    { joint: 'DEF-hips', frames: [[0, Z, 0], [0.3, Z, 2 * DEG], [0.9, Z, -2 * DEG], [1.2, Z, 0]] },
  ], 1.2)
}

/** The runtime's clip table names these; a bake that forgets one is a T-pose. */
function assertAuthored(document) {
  const names = new Set(document.getRoot().listAnimations().map((animation) => animation.getName()))
  for (const name of [...AUTHORED_CLIPS, ...LIBRARY_CLIPS]) {
    if (!names.has(name)) throw new Error(`Clip ${name} missing after authoring`)
  }
}

// --- The bake ---------------------------------------------------------------

async function bakeFighter(io, libraryPath, sourcePath, spec, outputDir) {
  const log = (line) => console.log(line)
  log(`\n${spec.slug} — ${spec.file}`)

  // A fresh copy of the rig per fighter: the arms are posed to this sculpt
  // and the bind matrices are this sculpt's.
  const document = await io.read(libraryPath)
  pruneLibrary(document)
  // keepLeaves: the toes are leaf joints with nothing on them, and the skin
  // that will reference them is not built until the bind is done.
  await document.transform(prune({ keepLeaves: true }))
  const rigHeight = 1.83

  // 1. The sculpt, flattened and cut to budget.
  const sculpt = await io.read(sourcePath)
  log(`  source: ${Math.round(countTriangles(sculpt)).toLocaleString()} triangles`)
  await flattenToWorld(sculpt)
  await sculpt.transform(join({ keepNamed: false }))
  await decimate(sculpt, BUDGET, log, { error: 0.5 })
  log(`  decimated: ${Math.round(countTriangles(sculpt)).toLocaleString()} triangles`)

  // 2. On the floor, at the rig's height, facing +z.
  let bounds = boundsOf(allPrimitives(sculpt))
  const scale = rigHeight / (bounds.max[1] - bounds.min[1])
  transformAll(sculpt, scaleTranslate([scale, scale, scale], [-bounds.centre[0] * scale, -bounds.min[1] * scale, -bounds.centre[2] * scale]))
  bounds = boundsOf(allPrimitives(sculpt))
  const primitive = allPrimitives(sculpt)[0]
  let positions = primitive.getAttribute('POSITION').getArray()
  // The feet tell the facing: the toes reach further from the body's
  // centre than the heels do.
  let toes = 0, count = 0
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 1] < 0.06) { toes += positions[i + 2]; count++ }
  }
  const facing = count > 0 && toes / count < 0 ? -1 : 1
  if (facing < 0 !== Boolean(spec.flip)) log(`  note: feet suggest the sculpt faces ${facing < 0 ? '-z' : '+z'}; flip=${Boolean(spec.flip)}`)
  if (spec.flip) {
    transformAll(sculpt, rotationY(Math.PI))
    bounds = boundsOf(allPrimitives(sculpt))
  }
  positions = primitive.getAttribute('POSITION').getArray()

  // 3. The rig's arms, dropped to the sculpt's.
  const shoulder = worldPositionOf(jointByName(document, 'DEF-upper_arm.L'))
  let hand = new THREE.Vector3(shoulder.x, shoulder.y, 0)
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 1] > rigHeight * 0.8 || positions[i + 1] < rigHeight * 0.2) continue
    if (positions[i] > hand.x) hand.set(positions[i], positions[i + 1], positions[i + 2])
  }
  const drop = Math.atan2(shoulder.y - hand.y, hand.x - shoulder.x)
  log(`  arms: hand at x ${hand.x.toFixed(2)} y ${hand.y.toFixed(2)}, dropped ${(drop / DEG).toFixed(0)}°`)
  const joints = listJoints(document)
  const jointOrder = joints.map((joint) => joint.getName())
  const rest = new Map(joints.map((joint) => [joint, joint.getRotation()]))
  turnJointInWorld(jointByName(document, 'DEF-upper_arm.L'), aboutWorld(Z, -drop))
  turnJointInWorld(jointByName(document, 'DEF-upper_arm.R'), aboutWorld(Z, drop))

  const indices = primitive.getIndices().getArray()
  const { jointsOut, weightsOut } = bindVertices(document, positions, indices, jointOrder, log)
  const inverseBinds = joints.map((joint) => worldMatrixOf(joint).invert())
  for (const [joint, rotation] of rest) joint.setRotation(rotation)

  // 4. The authored clips, on the stance the library's own clip ends in.
  const enter = document.getRoot().listAnimations().find((animation) => animation.getName() === 'Punch_Enter')
  const basePose = captureBasePose(document, enter, clipDuration(enter))
  authorFightClips(document, basePose)
  assertAuthored(document)

  // The sculpt's mesh, into the rig's document.
  const skin = document.createSkin('fighter').setSkeleton(jointByName(document, 'root'))
  for (const joint of joints) skin.addJoint(joint)
  const ibm = new Float32Array(joints.length * 16)
  inverseBinds.forEach((matrix, i) => ibm.set(matrix.toArray(), i * 16))
  skin.setInverseBindMatrices(document.createAccessor('ibm').setType('MAT4').setArray(ibm))

  const copyAccessor = (name, source) => document.createAccessor(name).setType(source.getType()).setArray(source.getArray())
  const sourceMaterial = primitive.getMaterial()
  const sourceTexture = sourceMaterial?.getBaseColorTexture()
  const material = document.createMaterial('skin').setBaseColorFactor(sourceMaterial?.getBaseColorFactor() ?? [1, 1, 1, 1])
  if (sourceTexture) {
    const texture = document.createTexture('page').setImage(sourceTexture.getImage()).setMimeType(sourceTexture.getMimeType())
    material.setBaseColorTexture(texture)
  }
  const outPrimitive = document.createPrimitive()
    .setAttribute('POSITION', copyAccessor('position', primitive.getAttribute('POSITION')))
    .setAttribute('TEXCOORD_0', copyAccessor('uv', primitive.getAttribute('TEXCOORD_0')))
    .setAttribute('JOINTS_0', document.createAccessor('joints').setType('VEC4').setArray(jointsOut))
    .setAttribute('WEIGHTS_0', document.createAccessor('weights').setType('VEC4').setArray(weightsOut))
    .setIndices(document.createAccessor('indices').setType('SCALAR').setArray(indices))
    .setMaterial(material)
  const normals = primitive.getAttribute('NORMAL')
  if (normals) outPrimitive.setAttribute('NORMAL', copyAccessor('normal', normals))
  const mesh = document.createMesh('fighter').addPrimitive(outPrimitive)
  const meshNode = document.createNode('fighter').setMesh(mesh).setSkin(skin)
  document.getRoot().listScenes()[0].addChild(meshNode)

  // Pages, then the check.
  await reduceTextures(document, { size: PAGE_SIZE })
  // Positions are left unquantised: quantize compensates by scaling the
  // mesh's node, and a skinned mesh ignores its node's transform.
  await document.transform(prune({ keepLeaves: true }), quantize({ pattern: /^(NORMAL|TEXCOORD_0)$/, quantizeNormal: 8, quantizeTexcoord: 12 }))

  const { clips, bytes } = await finishFighter(io, document, spec, outputDir, {
    positions, jointsOut, weightsOut, jointOrder, inverseBinds,
  }, log)
  return {
    slug: spec.slug,
    name: spec.name,
    note: spec.note,
    height: Number((bounds.max[1] - bounds.min[1]).toFixed(3)),
    width: Number((bounds.max[0] - bounds.min[0]).toFixed(3)),
    depth: Number((bounds.max[2] - bounds.min[2]).toFixed(3)),
    triangles: Math.round(countTriangles(document)),
    clips,
    bytes,
  }
}

/**
 * The re-bake: the last bake's own file as the source. Mesh, bind and rig
 * are untouched; the clips come off, the library's go back on by name, the
 * authored ones are written again from the tables above, and every strike
 * is measured afresh.
 */
async function rebakeFighter(io, libraryPath, spec, outputDir, previous) {
  const log = (line) => console.log(line)
  log(`\n${spec.slug} — re-clipping ${spec.slug}.glb`)
  const document = await io.read(joinPath(outputDir, `${spec.slug}.glb`))
  const library = await io.read(libraryPath)
  stripClips(document)
  installLibraryClips(document, library)
  const enter = document.getRoot().listAnimations().find((animation) => animation.getName() === 'Punch_Enter')
  const basePose = captureBasePose(document, enter, clipDuration(enter))
  authorFightClips(document, basePose)
  assertAuthored(document)

  const skin = document.getRoot().listSkins()[0]
  const primitive = allPrimitives(document)[0]
  const jointOrder = skin.listJoints().map((joint) => joint.getName())
  const ibm = skin.getInverseBindMatrices().getArray()
  const inverseBinds = jointOrder.map((_, i) => new THREE.Matrix4().fromArray(ibm, i * 16))
  const { clips, bytes } = await finishFighter(io, document, spec, outputDir, {
    positions: primitive.getAttribute('POSITION').getArray(),
    jointsOut: primitive.getAttribute('JOINTS_0').getArray(),
    weightsOut: primitive.getAttribute('WEIGHTS_0').getArray(),
    jointOrder,
    inverseBinds,
  }, log)
  return { ...previous, slug: spec.slug, name: spec.name, note: spec.note, triangles: Math.round(countTriangles(document)), clips, bytes }
}

/**
 * The end of either path: measure the strikes, draw the checks, prune what
 * nothing references any more, write the file. Returns the clip table the
 * manifest carries.
 */
async function finishFighter(io, document, spec, outputDir, bind, log) {
  await document.transform(prune({ keepLeaves: true }))
  const clips = {}
  for (const animation of document.getRoot().listAnimations()) {
    const name = animation.getName()
    const limb = STRIKE_LIMB[name] ?? null
    const strike = limb ? measureStrike(document, animation, limb) : null
    clips[name] = {
      duration: Number(clipDuration(animation).toFixed(3)),
      strikeAt: strike ? Number(strike.t.toFixed(3)) : null,
      reach: strike ? Number(strike.reach.toFixed(3)) : null,
    }
  }
  const strikes = Object.entries(clips).filter(([, clip]) => clip.reach !== null)
  log(`  reach: ${strikes.map(([name, clip]) => `${name} ${clip.reach.toFixed(2)}@${clip.strikeAt.toFixed(2)}`).join(', ')}`)
  if (spec.check) {
    const { positions, jointsOut, weightsOut, jointOrder, inverseBinds } = bind
    const anims = Object.fromEntries(document.getRoot().listAnimations().map((animation) => [animation.getName(), animation]))
    const draw = (name, at, label) => silhouette(document, anims[name], at, positions, jointsOut, weightsOut, jointOrder, inverseBinds, label)
    silhouette(document, null, 0, positions, jointsOut, weightsOut, jointOrder, inverseBinds, 'rest (T-pose rig on A-pose bind)')
    draw('Guard', 0.5, 'Guard, weight left')
    for (const name of Object.keys(STRIKE_LIMB)) draw(name, clips[name].strikeAt * clips[name].duration, `${name} at strike`)
    draw('Hit_Stagger', 0.1, 'Hit_Stagger')
    draw('Walk_Loop', 0.3, 'Walk_Loop')
    draw('Death01', clips.Death01.duration, 'Death01 end')
  }

  const output = joinPath(outputDir, `${spec.slug}.glb`)
  const bytes = await io.writeBinary(document)
  await writeFile(output, bytes)
  log(`  wrote ${output} — ${(bytes.byteLength / 1024).toFixed(0)}KB, ${Math.round(countTriangles(document))} triangles, clips ${Object.keys(clips).join(' ')}`)
  return { clips, bytes: bytes.byteLength }
}

// --- Main -------------------------------------------------------------------

async function main() {
  const args = parseArguments(process.argv)
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const fromBaked = 'from-baked' in args
  if (!args.src && !fromBaked) {
    throw new Error('Usage: node scripts/bakeFighters.mjs (--src <dir> | --from-baked 1) [--only <slug>] [--check 1]')
  }
  const files = args.src ? await findSources(resolve(args.src)) : null
  const libraryPath = await fetchLibrary()
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  const outputDir = resolve(root, 'public/ps1/fighters')
  await mkdir(outputDir, { recursive: true })

  const manifestPath = resolve(root, 'app/leon/channels/fight/fighters.json')
  let manifest = { fighters: [] }
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    // First bake.
  }

  for (const spec of FIGHTERS) {
    if (args.only && args.only !== spec.slug) continue
    const check = { ...spec, check: args.check === '1' }
    let baked
    if (files) {
      const source = files.get(spec.file)
      if (!source) throw new Error(`Missing source ${spec.file} under ${args.src}`)
      baked = await bakeFighter(io, libraryPath, source, check, outputDir)
    } else {
      const previous = manifest.fighters.find((entry) => entry.slug === spec.slug)
      if (!previous) throw new Error(`No previous bake of ${spec.slug} to re-clip; run with --src`)
      baked = await rebakeFighter(io, libraryPath, check, outputDir, previous)
    }
    // The byte count is for the log, not the manifest.
    const { bytes, ...entry } = baked
    void bytes
    manifest.fighters = [...manifest.fighters.filter((item) => item.slug !== spec.slug), entry]
  }
  manifest.fighters.sort((a, b) => FIGHTERS.findIndex((s) => s.slug === a.slug) - FIGHTERS.findIndex((s) => s.slug === b.slug))
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`\nmanifest: ${manifestPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
