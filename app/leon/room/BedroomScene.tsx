'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import { api } from '@/convex/_generated/api'
import { useCachedQuery } from '@/lib/useCachedQuery'
import { fmtTokensShort } from '@/lib/formatters'
import { configurePs1Texture, createPs1Material, setJitterAspect, sourceMaterialOf, type Ps1Lamp } from '../channels/race/Ps1Material'
import { useNarrowViewport } from '../ps1/useNarrowViewport'
import { PS1 } from '../ps1/theme'
import type { CabinetGame } from '../cabinet/games'
import { ROOM_ROWS, isSetupRow, stepRow } from './roomMenu'
import { SCREEN_PAGE, makeScreenPage, paintScreen, rowAtUv, waitForScreenFace } from './arcadeScreen'
import {
  BANNER_PAGE,
  POSTER_PAGE,
  TV_PAGE,
  makeBannerPage,
  makePosterPage,
  makeTvPage,
  paintBanner,
  paintPoster,
  paintTv,
} from './roomPages'

// The room the cabinet boots into: a teenager's bedroom with an arcade
// machine standing in the middle of it, its screen lit and listing the
// library, the bed and the desk in the corner behind.
//
// It is the shelf's job done as a place rather than as furniture on a
// gradient. The menu is on the machine's own glass — a page painted at
// console resolution and hung on the cabinet — and the camera stands in the
// room in front of it, drifting with the pointer the way a head does.
// Choosing a game pushes the camera into the glass and then cuts to the
// game itself, which is the period-correct beat between a cabinet and what
// it runs.
//
// The camera has a few places it stands — the middle of the room, the glass,
// the poster over the desk — and moves between them on one eased beat. It
// can also be let off the rail: W, or a click on the room, puts you on your
// feet at eye height, walking with the keys and looking with the pointer,
// and the same glass and poster answer to Enter when you are stood in front
// of them. The room is bounded by its walls and its furniture, so you cannot
// walk through the bed; you can walk up to it.
//
// The diorama shipped with the cabinet against its open wall, which put the
// bed behind the camera. The cabinet is lifted out of the model at load and
// re-stood at the room's centre, turned to face the corner the camera now
// stands in, so the bed and the desk read behind it; the glass and banner
// ride the same pose. The room is lit by the bedside lamp — one point light
// in the shader, warm — and the ambient is dropped so the light is the
// light.
//
// The model is the downloaded diorama baked down in scripts/bakeBedroom.mjs.
// As with the fight stages, everything it shipped for lighting is thrown
// away here and rebuilt in the channel's own shader from the colour pages
// alone; the licensed marquee and screen art were blanked in the bake so the
// quads below have nothing showing round their edges.

const ROOM_MODEL_URL = '/ps1/room/bedroom.glb'

/** The room's fog: a dark corner, not a sky. Reaches the far wall only. */
const ROOM_FOG = { color: '#120c14', near: 12, far: 30 } as const
/** Low, because the lamp does the lighting; this is what the far corner keeps. */
const ROOM_AMBIENT = 0.6
/** The bedside lamp: where the diorama's shade is, warm, reaching most of the room. */
const ROOM_LAMP: Ps1Lamp = {
  position: new THREE.Vector3(-3.3, 3.9, -0.4),
  color: '#ffb266',
  intensity: 1.35,
  radius: 11,
}
/** The lamp's colour as the shader holds it — colour times intensity. The flicker scales this. */
const LAMP_BASE = new THREE.Color(ROOM_LAMP.color).multiplyScalar(ROOM_LAMP.intensity)
/** The material the cabinet is painted with — the one mesh lifted out of the room. */
const CABINET_MATERIAL = 'diorama_final_arcade_mat1'
/**
 * Materials whose surface is a light source in the room: the bedside lamp,
 * the television. Lifted further, the way the source's emissive maps did.
 */
const LIT_MATERIALS: Readonly<Record<string, number>> = {
  diorama_final_velador_mat: 0.7,
  diorama_final_tv_mat1: 0.5,
}
/** The walls are a box wound outward; drawing both sides closes the room. */
const WALLS_MATERIAL = 'diorama_final_paredes_piso_mat'
/** The one flat-coloured surface in the bake, which has no page to miss. */
const UNPAGED_MATERIAL = 'diorama_final_lambert8'
/** The furniture that moves: found by material, since the bake kept no node names. */
const FAN_MATERIAL = 'diorama_final_ventilador_mat'
const XWING_MATERIAL = 'diorama_final_dioram_xwing_mat'
const SKATEBOARD_MATERIAL = 'diorama_final_skate_mat3'

/**
 * A face on the cabinet, measured off the baked model in world units: where
 * it is, how big, and which way it leans. Each leans back on its own angle —
 * the glass about twenty-two degrees, the marquee about eighteen — and a
 * quad hung on the wrong one sinks into the cabinet along one edge, which
 * is the model's own bezel swallowing half the page.
 */
interface CabinetFace {
  readonly centre: THREE.Vector3
  readonly width: number
  readonly height: number
  /** Out of the cabinet, towards the room. */
  readonly normal: THREE.Vector3
}
const SCREEN: CabinetFace = {
  centre: new THREE.Vector3(0.445, 4.565, 5.075),
  width: 1.85,
  height: 2.19,
  normal: new THREE.Vector3(0, 0.37, -0.929).normalize(),
}
/** The top panel over the glass, where the model's marquee was. The banner hangs here. */
const MARQUEE: CabinetFace = {
  centre: new THREE.Vector3(0.445, 6.34, 4.92),
  width: 2.41,
  height: 0.92,
  normal: new THREE.Vector3(0, 0.307, -0.952).normalize(),
}
/** The cabinet's footprint on the model's floor, for the walker to bump into. */
const CABINET_FOOTPRINT = { minX: -0.77, maxX: 1.65, minZ: 3.58, maxZ: 6.24 } as const
/** How far the quads sit proud of the face, towards the room, so they never z-fight. */
const QUAD_LIFT = 0.03

/**
 * The banner: a strip of cloth pinned to the top panel, a little askew the
 * way a thing pinned by hand is. Not lit from within — it is paper in the
 * lamp's light, the same as the cabinet it hangs on.
 */
const BANNER = { width: 2.6, height: 2.6 * (BANNER_PAGE.height / BANNER_PAGE.width), skew: 0.02 } as const

/**
 * The poster: on the blank wall over the desk, facing into the room. Lifted
 * a touch out of the lighting so it reads across the room in lamp light,
 * not so far that it glows like the screens.
 */
/**
 * The -x wall is a slab: its outer face is at -5.29 and its inner face, the
 * one the room sees, at -4.77. The diorama's own page has a band poster
 * printed on that face exactly here; ours hangs a hair in front of it and
 * is cut a little larger, so the printed one is covered rather than seen
 * round the edges.
 */
const POSTER = {
  centre: new THREE.Vector3(-4.77 + QUAD_LIFT, 5.05, 3.0),
  width: 2.4,
  height: 3.2,
  emissive: 0.15,
  /** The wall's inner face. Where the poster station stands off from. */
  wallX: -4.77,
} as const

/**
 * The television's glass, measured off the front of the CRT in the bake: the
 * front face runs x 3.79..5.46, z -2.68..-1.75, y 0.94..2.06 and points a
 * little short of thirty degrees off +z towards -x, into the room. The page
 * sits in the middle of that, four-by-three, the bezel left showing.
 */
const TV_NORMAL = new THREE.Vector3(-0.488, 0, 0.873).normalize()
const TV = {
  centre: new THREE.Vector3(4.625, 1.5, -2.215).addScaledVector(TV_NORMAL, QUAD_LIFT),
  width: 1.44,
  height: 1.44 * (TV_PAGE.height / TV_PAGE.width),
  yaw: Math.atan2(TV_NORMAL.x, TV_NORMAL.z),
  emissive: 0.9,
} as const
/** How many drivers fit on a television that small. */
const TV_ROWS = 3
/** The board's own fallback ramp, for a driver who has not chosen a colour. */
const TV_FALLBACK_COLOURS: ReadonlyArray<string> = [PS1.gold, PS1.cyan, PS1.green]

/**
 * The cabinet's new pose. The model stands it at CABINET_SOURCE facing -z;
 * it is turned to face the +x/+z corner and moved so its footprint sits at
 * CABINET_TARGET, the middle of the rug. Everything measured on the model —
 * the glass, the banner, the dolly's end — is carried through `toRoom`.
 */
const UP = new THREE.Vector3(0, 1, 0)
const CABINET_YAW = -Math.PI * 0.75
const CABINET_SOURCE = new THREE.Vector3(0.445, 0, 4.91)
const CABINET_TARGET = new THREE.Vector3(0.2, 0, -0.3)
const CABINET_POSITION = CABINET_TARGET.clone().sub(CABINET_SOURCE.clone().applyAxisAngle(UP, CABINET_YAW))
function toRoom(measured: THREE.Vector3): THREE.Vector3 {
  return measured.clone().applyAxisAngle(UP, CABINET_YAW).add(CABINET_POSITION)
}
/** Out of the glass towards where the camera stands. */
const CABINET_FACING = new THREE.Vector3(0, 0, -1).applyAxisAngle(UP, CABINET_YAW).normalize()

// --- Where the camera stands ------------------------------------------------

/** A place the camera rests: where it is and what it looks at. */
interface Vantage {
  readonly position: THREE.Vector3
  readonly lookAt: THREE.Vector3
}
type StationId = 'home' | 'glass' | 'poster'
/** On the rail, driving the menu; or off it, on foot. */
export type RoomMode = 'menu' | 'look'

/** Eye height, standing. The floor is at 0.7 and a unit is about a foot. */
const EYE_HEIGHT = 5.3
/** The glass, and the room's centre the stations are measured from. */
const GLASS_CENTRE = toRoom(SCREEN.centre)
const HOME_WIDE: Vantage = { position: GLASS_CENTRE.clone().addScaledVector(CABINET_FACING, 7.5).setY(EYE_HEIGHT), lookAt: GLASS_CENTRE }
const HOME_NARROW: Vantage = { position: GLASS_CENTRE.clone().addScaledVector(CABINET_FACING, 6.2).setY(EYE_HEIGHT), lookAt: GLASS_CENTRE }
/** The push into the glass: where the launch ends. */
const GLASS: Vantage = { position: toRoom(SCREEN.centre.clone().addScaledVector(SCREEN.normal, -1.05)), lookAt: GLASS_CENTRE }
/** Stood off the wall, square to the poster. */
const POSTER_STAND = 4.2
const POSTER_STATION: Vantage = { position: new THREE.Vector3(POSTER.wallX + POSTER_STAND, EYE_HEIGHT, POSTER.centre.z), lookAt: POSTER.centre }
const FOV = { wide: 40, narrow: 50 } as const
/** How far the pointer moves the camera, in world units, and how lazily. */
const PARALLAX = { x: 0.5, y: 0.28, ease: 0.06 } as const
/** One beat between any two stations. */
const MOVE_MS = 900
/** The cursor block's blink, on the period's beat. */
const BLINK_MS = 450
/** The pixel grid — the same contract as the channels' own locks. */
const ROOM_INTERNAL_HEIGHT = 480

// --- On foot ----------------------------------------------------------------

/** Walking pace in units a second, and how the pointer turns the head. */
const WALK_SPEED = 3
const LOOK_RADIANS_PER_PIXEL = 0.005
const PITCH_LIMIT = 0.6
/** The longest step the walker takes in one frame, so a stalled tab does not throw it through a wall. */
const MAX_STEP_SECONDS = 0.05
/** How wide the walker is, for the walls and the furniture. */
const WALKER_RADIUS = 0.45
/** The floor you can stand on, inside the walls. */
const FLOOR = { minX: -5.0, maxX: 7.1, minZ: -5.5, maxZ: 6.2 } as const
/** A footprint on the floor: something you walk round rather than through. */
interface Footprint {
  readonly minX: number
  readonly maxX: number
  readonly minZ: number
  readonly maxZ: number
}
/** The cabinet's footprint, measured on the model, turned and moved with it. */
function cabinetFootprint(): Footprint {
  const corners = [
    toRoom(new THREE.Vector3(CABINET_FOOTPRINT.minX, 0, CABINET_FOOTPRINT.minZ)),
    toRoom(new THREE.Vector3(CABINET_FOOTPRINT.maxX, 0, CABINET_FOOTPRINT.minZ)),
    toRoom(new THREE.Vector3(CABINET_FOOTPRINT.minX, 0, CABINET_FOOTPRINT.maxZ)),
    toRoom(new THREE.Vector3(CABINET_FOOTPRINT.maxX, 0, CABINET_FOOTPRINT.maxZ)),
  ]
  return {
    minX: Math.min(...corners.map((corner) => corner.x)),
    maxX: Math.max(...corners.map((corner) => corner.x)),
    minZ: Math.min(...corners.map((corner) => corner.z)),
    maxZ: Math.max(...corners.map((corner) => corner.z)),
  }
}
/** The furniture, as measured on the bake. The skateboard is left out: it is thin, and it is the thing you walk up to. */
const FURNITURE: ReadonlyArray<Footprint> = [
  { minX: -4.5, maxX: 1.1, minZ: -5.2, maxZ: -1.7 }, // bed
  { minX: -4.1, maxX: -2.6, minZ: -1.3, maxZ: 0.4 }, // bedside table
  { minX: -4.2, maxX: -2.4, minZ: 1.0, maxZ: 5.3 }, // desk
  { minX: -3.0, maxX: -1.8, minZ: 2.0, maxZ: 3.2 }, // chair
  { minX: 3.5, maxX: 6.3, minZ: -4.5, maxZ: -1.6 }, // television
  { minX: 2.7, maxX: 7.3, minZ: 3.7, maxZ: 6.2 }, // dresser
  cabinetFootprint(),
]
/** How close, and how square-on, the glass and the poster answer to Enter on foot. */
const GLASS_REACH = 2.2
const GLASS_FACING = 0.5
const POSTER_REACH = 3
/** How far ahead the walker's first look point sits, so no push-out can pass it. */
const LOOK_ENTRY_REACH = 8

/**
 * Keeps a point on the floor and out of the furniture. A point inside a
 * footprint is pushed out through the nearest side — the era's collision,
 * which is all a walk round a bedroom needs.
 */
function keepOnFloor(point: THREE.Vector3): void {
  point.x = THREE.MathUtils.clamp(point.x, FLOOR.minX + WALKER_RADIUS, FLOOR.maxX - WALKER_RADIUS)
  point.z = THREE.MathUtils.clamp(point.z, FLOOR.minZ + WALKER_RADIUS, FLOOR.maxZ - WALKER_RADIUS)
  for (const box of FURNITURE) {
    const minX = box.minX - WALKER_RADIUS
    const maxX = box.maxX + WALKER_RADIUS
    const minZ = box.minZ - WALKER_RADIUS
    const maxZ = box.maxZ + WALKER_RADIUS
    if (point.x <= minX || point.x >= maxX || point.z <= minZ || point.z >= maxZ) continue
    const toMinX = point.x - minX
    const toMaxX = maxX - point.x
    const toMinZ = point.z - minZ
    const toMaxZ = maxZ - point.z
    const least = Math.min(toMinX, toMaxX, toMinZ, toMaxZ)
    if (least === toMinX) point.x = minX
    else if (least === toMaxX) point.x = maxX
    else if (least === toMinZ) point.z = minZ
    else point.z = maxZ
  }
}

// --- The furniture that moves -----------------------------------------------

/** The fan turns, the X-wing sways, the skateboard rolls when you get near. */
const FAN_RADIANS_PER_SECOND = 1.2
const XWING_SWAY = { radians: 0.05, hertz: 0.4 } as const
/** Above the model's top, where the string would be tied. */
const XWING_STRING = 0.5
const SKATEBOARD = { centre: new THREE.Vector3(-3.83, 0, 5.9), reach: 1.5, roll: -0.3, seconds: 0.5 } as const
/**
 * The bulb catches twice on the way up, in the first second and a half, and
 * then holds. Once per room — it is the room coming on, not a fault.
 */
const LAMP_FLICKER = { dipTo: 0.4 / ROOM_LAMP.intensity, dipMs: 80, dipsAt: [320, 780], totalMs: 1500 } as const

/**
 * Every material lit by the lamp, so the flicker reaches the banner and the
 * poster as well as the room. Registered on build, struck on dispose.
 */
const lampLit = new Set<THREE.ShaderMaterial>()

function setLampScale(scale: number): void {
  for (const material of lampLit) {
    const value: unknown = material.uniforms.uLampColor?.value
    if (value instanceof THREE.Color) value.copy(LAMP_BASE).multiplyScalar(scale)
  }
}

/**
 * Hangs a +z plane on a face. The camera stands at -z looking in, so its
 * right hand is world -x: the plane's own x has to run that way or the page
 * reads mirrored, and its y has to run up the lean or the page hangs upside
 * down. A shortest-arc turn from +z to the normal gets both wrong at once,
 * which put the menu on the glass rotated a half turn.
 */
function faceQuaternion(face: CabinetFace): THREE.Quaternion {
  const right = new THREE.Vector3(-1, 0, 0)
  const up = new THREE.Vector3().crossVectors(face.normal, right).normalize()
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, face.normal))
}
function facePosition(face: CabinetFace): THREE.Vector3 {
  return face.centre.clone().addScaledVector(face.normal, QUAD_LIFT)
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

/** An angle brought back into -π..π, so a turn is measured the short way round. */
function wrapAngle(radians: number): number {
  return Math.atan2(Math.sin(radians), Math.cos(radians))
}

interface BedroomSceneProps {
  /** The cartridge most recently in the machine — the cursor starts on it. */
  readonly lastGame: CabinetGame | null
  /** False while the room is hidden behind a game, which parks its loop. */
  readonly isLive: boolean
  /** False while a window is open over the room and the keys belong to it. */
  readonly inputEnabled: boolean
  readonly onPick: (game: CabinetGame) => void
  readonly onSetup: () => void
  /** Told each time the room goes on foot or back on the rail, for the hint strip. */
  readonly onModeChange: (mode: RoomMode) => void
}

// --- The model --------------------------------------------------------------

function applyRoomMaterials(root: THREE.Object3D): ReadonlyArray<THREE.ShaderMaterial> {
  const built: THREE.ShaderMaterial[] = []
  const byKey = new Map<string, THREE.ShaderMaterial>()
  const unpaged: string[] = []

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    const source = sourceMaterialOf(child)
    const standard =
      source instanceof THREE.MeshStandardMaterial || source instanceof THREE.MeshBasicMaterial ? source : null
    const map = standard?.map ?? null
    const colour = standard ? `#${standard.color.getHexString()}` : '#8a8a96'
    const name = source?.name ?? ''
    if (!map && name !== UNPAGED_MATERIAL) unpaged.push(`${name || '(unnamed)'} <- ${source?.type ?? 'none'}`)
    const emissive = LIT_MATERIALS[name] ?? 0
    const key = `${map ? map.uuid : `flat:${colour}`}|${emissive}|${name === WALLS_MATERIAL ? 'walls' : ''}`

    let material = byKey.get(key)
    if (!material) {
      material = createPs1Material({
        color: map ? '#ffffff' : colour,
        map: map ? configurePs1Texture(map) : undefined,
        fogColor: ROOM_FOG.color,
        fogNear: ROOM_FOG.near,
        fogFar: ROOM_FOG.far,
        ambient: ROOM_AMBIENT,
        emissive,
        lamp: ROOM_LAMP,
        side: name === WALLS_MATERIAL ? THREE.DoubleSide : THREE.FrontSide,
      })
      byKey.set(key, material)
      built.push(material)
    }
    child.material = material
    child.frustumCulled = false
  })

  // Every surface in the bake but one carries a page. A room arriving
  // without them is a loader or cache problem, not a style, and it should
  // say so rather than quietly render as plaster.
  if (unpaged.length > 0) console.warn(`Bedroom: ${unpaged.length} surfaces have no colour page`, unpaged)

  return built
}

function meshWithMaterial(root: THREE.Object3D, materialName: string): THREE.Mesh | null {
  let found: THREE.Mesh | null = null
  root.traverse((child) => {
    if (found === null && child instanceof THREE.Mesh && sourceMaterialOf(child)?.name === materialName) found = child
  })
  return found
}

/**
 * Re-parents a mesh under a group standing at `pivot`, keeping the mesh where
 * it is in the world. The bake flattened every node to world space, so a
 * mesh's own origin is wherever the modeller left it; a swing or a spin has
 * to be about a point measured on the thing itself.
 */
function pivotUnder(mesh: THREE.Mesh, pivot: THREE.Vector3): THREE.Group {
  const parent = mesh.parent
  const group = new THREE.Group()
  group.position.copy(pivot)
  if (parent) parent.add(group)
  group.updateMatrixWorld(true)
  group.attach(mesh)
  return group
}

interface RoomParts {
  readonly room: THREE.Group
  readonly cabinet: THREE.Group
  readonly fan: THREE.Group | null
  readonly xwing: THREE.Group | null
  readonly skateboard: THREE.Mesh | null
}

/** What the walker's frame loop needs to know that React state is too slow for. */
interface Rig {
  mode: RoomMode
  /** Where the camera is resting or heading, on the rail. */
  station: StationId
  move: Move | null
  /** On foot: where the eye is and which way it points. */
  position: THREE.Vector3
  yaw: number
  pitch: number
  /** The keys held this instant, by name. */
  held: Set<string>
  /** Once per visit on foot. */
  skateboardRolled: boolean
  skateboardStartedAt: number | null
}

interface Move {
  readonly startedAt: number
  readonly from: Vantage
  readonly to: Vantage
  readonly onDone: (() => void) | null
}

function RoomLife({ parts, rig }: { readonly parts: RoomParts; readonly rig: Rig }): null {
  const flickerStartedAt = useRef<number | null>(null)
  const lampScale = useRef(1)
  const skateboardRest = useMemo(() => parts.skateboard?.position.z ?? 0, [parts])

  useFrame(({ camera, clock }, delta) => {
    const now = performance.now()

    if (parts.fan) parts.fan.rotation.y += FAN_RADIANS_PER_SECOND * Math.min(delta, MAX_STEP_SECONDS)
    if (parts.xwing) parts.xwing.rotation.z = XWING_SWAY.radians * Math.sin(clock.elapsedTime * Math.PI * 2 * XWING_SWAY.hertz)

    // The bulb, on arrival. Written to the uniform only when the scale
    // changes, which is four times.
    if (flickerStartedAt.current === null) flickerStartedAt.current = now
    const lit = now - flickerStartedAt.current
    if (lit <= LAMP_FLICKER.totalMs) {
      const dipping = LAMP_FLICKER.dipsAt.some((at) => lit >= at && lit < at + LAMP_FLICKER.dipMs)
      const scale = dipping ? LAMP_FLICKER.dipTo : 1
      if (scale !== lampScale.current) {
        lampScale.current = scale
        setLampScale(scale)
      }
    }

    // The skateboard: walked up to, it rolls a little, the way one does.
    const skateboard = parts.skateboard
    if (skateboard) {
      if (rig.mode === 'look' && rig.move === null && !rig.skateboardRolled) {
        const dx = camera.position.x - SKATEBOARD.centre.x
        const dz = camera.position.z - SKATEBOARD.centre.z
        if (dx * dx + dz * dz < SKATEBOARD.reach * SKATEBOARD.reach) {
          rig.skateboardRolled = true
          rig.skateboardStartedAt = now
        }
      }
      if (rig.skateboardStartedAt !== null) {
        const t = Math.min(1, (now - rig.skateboardStartedAt) / (SKATEBOARD.seconds * 1000))
        skateboard.position.z = skateboardRest + SKATEBOARD.roll * smoothstep(t)
      }
    }
  })

  return null
}

function RoomModel({ rig, onRoomClick }: { readonly rig: Rig; readonly onRoomClick: () => void }): React.ReactElement {
  const { scene } = useGLTF(ROOM_MODEL_URL)

  // Cloned because useGLTF caches by URL and the materials are rewritten.
  // The cabinet's meshes are lifted into a group of their own so they can
  // be re-stood; the bake flattened every node to world space, so a mesh
  // moves cleanly between parents. The fan and the X-wing are hung under
  // pivots of their own for the same reason.
  const parts = useMemo((): RoomParts => {
    const room = scene.clone(true)
    room.updateMatrixWorld(true)
    const cabinet = new THREE.Group()
    const lifted: THREE.Mesh[] = []
    room.traverse((child) => {
      if (child instanceof THREE.Mesh && sourceMaterialOf(child)?.name === CABINET_MATERIAL) lifted.push(child)
    })
    for (const mesh of lifted) cabinet.add(mesh)

    const bounds = new THREE.Box3()
    const centre = new THREE.Vector3()
    const fanMesh = meshWithMaterial(room, FAN_MATERIAL)
    const fan = fanMesh ? pivotUnder(fanMesh, bounds.setFromObject(fanMesh).getCenter(centre).setY(0)) : null
    const xwingMesh = meshWithMaterial(room, XWING_MATERIAL)
    const xwing = xwingMesh
      ? pivotUnder(xwingMesh, bounds.setFromObject(xwingMesh).getCenter(centre).setY(bounds.max.y + XWING_STRING))
      : null
    const skateboard = meshWithMaterial(room, SKATEBOARD_MATERIAL)
    if (!fan || !xwing || !skateboard) console.warn('Bedroom: some of the furniture that moves is missing from the bake')

    return { room, cabinet, fan, xwing, skateboard }
  }, [scene])

  const materials = useMemo(() => [...applyRoomMaterials(parts.room), ...applyRoomMaterials(parts.cabinet)], [parts])

  useEffect(() => {
    for (const material of materials) lampLit.add(material)
    return () => {
      for (const material of materials) {
        lampLit.delete(material)
        material.dispose()
      }
    }
  }, [materials])

  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>): void => {
      event.stopPropagation()
      onRoomClick()
    },
    [onRoomClick],
  )

  return (
    <>
      <primitive object={parts.room} onClick={handleClick} />
      <group position={CABINET_POSITION} rotation-y={CABINET_YAW}>
        <primitive object={parts.cabinet} />
      </group>
      <RoomLife parts={parts} rig={rig} />
    </>
  )
}

// --- The pages hung in the room ---------------------------------------------

/** A page's material and its life: painted once the face is in, disposed with the page. */
function usePageMaterial(
  page: { readonly texture: THREE.CanvasTexture; readonly ctx: CanvasRenderingContext2D },
  options: { readonly emissive: number; readonly lit: boolean },
  paint: (ctx: CanvasRenderingContext2D) => void,
): THREE.ShaderMaterial {
  const material = useMemo(
    () =>
      createPs1Material({
        color: '#ffffff',
        map: page.texture,
        emissive: options.emissive,
        ambient: options.lit ? ROOM_AMBIENT : undefined,
        lamp: options.lit ? ROOM_LAMP : undefined,
        fogColor: ROOM_FOG.color,
        fogNear: ROOM_FOG.near,
        fogFar: ROOM_FOG.far,
      }),
    [page, options.emissive, options.lit],
  )

  useEffect(() => {
    let cancelled = false
    const repaint = (): void => {
      paint(page.ctx)
      page.texture.needsUpdate = true
    }
    repaint()
    void waitForScreenFace().then(() => {
      if (!cancelled) repaint()
    })
    return () => {
      cancelled = true
    }
  }, [page, paint])

  useEffect(() => {
    if (options.lit) lampLit.add(material)
    return () => {
      lampLit.delete(material)
      material.dispose()
      page.texture.dispose()
    }
  }, [page, material, options.lit])

  return material
}

const BANNER_OPTIONS = { emissive: 0, lit: true } as const
const POSTER_OPTIONS = { emissive: POSTER.emissive, lit: true } as const
const TV_OPTIONS = { emissive: TV.emissive, lit: false } as const

function Banner(): React.ReactElement {
  const page = useMemo(() => makeBannerPage(), [])
  const material = usePageMaterial(page, BANNER_OPTIONS, paintBanner)
  const position = useMemo(() => facePosition(MARQUEE), [])
  const quaternion = useMemo(
    () => faceQuaternion(MARQUEE).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), BANNER.skew)),
    [],
  )

  return (
    <mesh material={material} position={position} quaternion={quaternion}>
      <planeGeometry args={[BANNER.width, BANNER.height]} />
    </mesh>
  )
}

function Poster(): React.ReactElement {
  const page = useMemo(() => makePosterPage(), [])
  const material = usePageMaterial(page, POSTER_OPTIONS, paintPoster)

  return (
    <mesh material={material} position={POSTER.centre} rotation-y={Math.PI / 2}>
      <planeGeometry args={[POSTER.width, POSTER.height]} />
    </mesh>
  )
}

/**
 * The CRT on the floor by the console shows the podium. Nobody is told; it
 * is there for whoever wanders over. Repainted when the board changes.
 */
function Television(): React.ReactElement {
  const page = useMemo(() => makeTvPage(), [])
  const data = useCachedQuery('leaderboard', api.leaderboard.get, {})
  const rows = useMemo(
    () =>
      (data?.leaderboard ?? [])
        .filter((entry) => entry.rank <= TV_ROWS)
        .sort((a, b) => a.rank - b.rank)
        .map((entry) => ({
          name: entry.name,
          score: fmtTokensShort(entry.totalTokens),
          color: entry.color ?? TV_FALLBACK_COLOURS[(entry.rank - 1) % TV_FALLBACK_COLOURS.length],
        })),
    [data],
  )
  const paint = useCallback((ctx: CanvasRenderingContext2D): void => paintTv(ctx, rows), [rows])
  const material = usePageMaterial(page, TV_OPTIONS, paint)

  return (
    <mesh material={material} position={TV.centre} rotation-y={TV.yaw}>
      <planeGeometry args={[TV.width, TV.height]} />
    </mesh>
  )
}

interface ScreenProps {
  readonly cursor: number
  readonly launching: boolean
  /** On foot the glass is a thing in the room, not a menu: the pointer leaves it alone. */
  readonly interactive: boolean
  readonly onHover: (index: number) => void
  readonly onActivate: (index: number) => void
}

function Screen({ cursor, launching, interactive, onHover, onActivate }: ScreenProps): React.ReactElement {
  const page = useMemo(() => makeScreenPage(), [])
  const material = useMemo(
    () => createPs1Material({ color: '#ffffff', map: page.texture, emissive: 1, fogColor: ROOM_FOG.color, fogNear: ROOM_FOG.near, fogFar: ROOM_FOG.far }),
    [page],
  )
  const [blinkOn, setBlinkOn] = useState(true)
  const [faceReady, setFaceReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    void waitForScreenFace().then(() => {
      if (!cancelled) setFaceReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const id = setInterval(() => setBlinkOn((on) => !on), BLINK_MS)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    paintScreen(page.ctx, { cursor, blinkOn, launching })
    page.texture.needsUpdate = true
  }, [page, cursor, blinkOn, launching, faceReady])

  useEffect(() => {
    return () => {
      material.dispose()
      page.texture.dispose()
    }
  }, [page, material])

  const position = useMemo(() => facePosition(SCREEN), [])
  const quaternion = useMemo(() => faceQuaternion(SCREEN), [])

  const handleMove = useCallback(
    (event: ThreeEvent<PointerEvent>): void => {
      if (!interactive || !event.uv) return
      const row = rowAtUv(event.uv)
      if (row !== null) onHover(row)
    },
    [interactive, onHover],
  )
  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>): void => {
      event.stopPropagation()
      if (!interactive || !event.uv) return
      const row = rowAtUv(event.uv)
      if (row !== null) onActivate(row)
    },
    [interactive, onActivate],
  )

  return (
    <mesh
      material={material}
      position={position}
      quaternion={quaternion}
      onPointerMove={handleMove}
      onClick={handleClick}
    >
      <planeGeometry args={[SCREEN.width, SCREEN.height]} />
    </mesh>
  )
}

// --- Camera and lock --------------------------------------------------------

function RoomResolutionLock({ height }: { readonly height: number }): null {
  const applied = useRef(0)

  useFrame(({ gl, size, camera }) => {
    const aspect = size.width / size.height
    const targetWidth = Math.round(height * aspect)
    if (applied.current === targetWidth) return
    applied.current = targetWidth
    setJitterAspect(aspect)
    gl.setSize(targetWidth, height, false)
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.aspect = aspect
      camera.updateProjectionMatrix()
    }
  })

  return null
}

/** Which way the walker faces, from the yaw and pitch it holds. */
function headingOf(yaw: number, pitch: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
}

/**
 * Stands in the room and looks at the glass. On the rail the pointer moves
 * the eye a little — a parallax, not an orbit: the look point never leaves
 * the station's mark. Between stations it moves on one eased beat, position
 * and look point together. On foot it is the walker's head.
 */
function RoomCamera({
  narrow,
  rig,
  onMoveDone,
}: {
  readonly narrow: boolean
  readonly rig: Rig
  readonly onMoveDone: (move: Move) => void
}): null {
  const scratch = useMemo(() => ({ target: new THREE.Vector3(), look: new THREE.Vector3(), dir: new THREE.Vector3(), right: new THREE.Vector3() }), [])

  useFrame(({ camera, pointer }, delta) => {
    const fov = narrow ? FOV.narrow : FOV.wide
    if (camera instanceof THREE.PerspectiveCamera && camera.fov !== fov) {
      camera.fov = fov
      camera.updateProjectionMatrix()
    }

    const move = rig.move
    if (move !== null) {
      const t = Math.min(1, (performance.now() - move.startedAt) / MOVE_MS)
      const eased = smoothstep(t)
      camera.position.lerpVectors(move.from.position, move.to.position, eased)
      scratch.look.lerpVectors(move.from.lookAt, move.to.lookAt, eased)
      camera.lookAt(scratch.look)
      if (t >= 1) {
        rig.move = null
        onMoveDone(move)
      }
      return
    }

    if (rig.mode === 'look') {
      const step = WALK_SPEED * Math.min(delta, MAX_STEP_SECONDS)
      const held = rig.held
      const forward = (held.has('w') || held.has('arrowup') ? 1 : 0) - (held.has('s') || held.has('arrowdown') ? 1 : 0)
      const strafe = (held.has('d') || held.has('arrowright') ? 1 : 0) - (held.has('a') || held.has('arrowleft') ? 1 : 0)
      if (forward !== 0 || strafe !== 0) {
        // Walking is on the floor plane whatever the head is doing.
        const sinYaw = Math.sin(rig.yaw)
        const cosYaw = Math.cos(rig.yaw)
        rig.position.x += (sinYaw * forward - cosYaw * strafe) * step
        rig.position.z += (cosYaw * forward + sinYaw * strafe) * step
        keepOnFloor(rig.position)
      }
      rig.position.y = EYE_HEIGHT
      camera.position.copy(rig.position)
      camera.lookAt(scratch.look.copy(rig.position).add(headingOf(rig.yaw, rig.pitch, scratch.dir)))
      return
    }

    const station = rig.station === 'glass' ? GLASS : rig.station === 'poster' ? POSTER_STATION : narrow ? HOME_NARROW : HOME_WIDE
    scratch.dir.subVectors(station.lookAt, station.position).normalize()
    scratch.right.crossVectors(scratch.dir, UP).normalize()
    scratch.target.copy(station.position).addScaledVector(scratch.right, pointer.x * PARALLAX.x).addScaledVector(UP, pointer.y * PARALLAX.y)
    camera.position.lerp(scratch.target, PARALLAX.ease)
    camera.lookAt(station.lookAt)
  })

  return null
}

// --- The scene --------------------------------------------------------------

function initialCursor(lastGame: CabinetGame | null): number {
  const index = ROOM_ROWS.findIndex((row) => row.id === lastGame)
  return index === -1 ? 0 : index
}

function makeRig(): Rig {
  return {
    mode: 'menu',
    station: 'home',
    move: null,
    position: HOME_WIDE.position.clone(),
    yaw: 0,
    pitch: 0,
    held: new Set(),
    skateboardRolled: false,
    skateboardStartedAt: null,
  }
}

/** Whether a keystroke belongs to a field rather than the room. */
function isTyping(event: KeyboardEvent): boolean {
  const target = event.target
  return target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'INPUT')
}

export function BedroomScene({ lastGame, isLive, inputEnabled, onPick, onSetup, onModeChange }: BedroomSceneProps): React.ReactElement {
  const [cursor, setCursor] = useState(() => initialCursor(lastGame))
  const [mode, setMode] = useState<RoomMode>('menu')
  const [station, setStation] = useState<StationId>('home')
  const [moving, setMoving] = useState(false)
  const rig = useMemo(makeRig, [])
  const cameraRef = useRef<THREE.Camera | null>(null)
  const isNarrow = useNarrowViewport()
  const drag = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    onModeChange(mode)
  }, [mode, onModeChange])

  const homeVantage = isNarrow ? HOME_NARROW : HOME_WIDE

  /** Where the camera is this instant, as a vantage: the start of any move. */
  const currentVantage = useCallback((): Vantage => {
    const camera = cameraRef.current
    if (!camera) return { position: homeVantage.position.clone(), lookAt: homeVantage.lookAt.clone() }
    const position = camera.position.clone()
    const lookAt = camera.getWorldDirection(new THREE.Vector3()).add(position)
    return { position, lookAt }
  }, [homeVantage])

  const startMove = useCallback(
    (to: Vantage, onDone: (() => void) | null): void => {
      rig.move = { startedAt: performance.now(), from: currentVantage(), to, onDone }
      setMoving(true)
    },
    [rig, currentVantage],
  )

  const handleMoveDone = useCallback((move: Move): void => {
    setMoving(false)
    if (move.onDone) move.onDone()
  }, [])

  // Coming back from a game: the camera is inside the glass from the last
  // launch, so stand it back in the room before the first live frame — on
  // the rail, at home, whatever it was doing when it left.
  useEffect(() => {
    if (!isLive) return
    rig.move = null
    rig.mode = 'menu'
    rig.station = 'home'
    rig.held.clear()
    setMoving(false)
    setMode('menu')
    setStation('home')
    const camera = cameraRef.current
    if (camera) camera.position.copy(homeVantage.position)
  }, [isLive, homeVantage, rig])

  const goHome = useCallback((): void => {
    rig.mode = 'menu'
    rig.station = 'home'
    rig.held.clear()
    setMode('menu')
    setStation('home')
    startMove(homeVantage, null)
  }, [rig, homeVantage, startMove])

  const launch = useCallback(
    (index: number): void => {
      const row = ROOM_ROWS[index]
      if (isSetupRow(row.id)) {
        onSetup()
        return
      }
      const game = row.id
      rig.station = 'glass'
      setStation('glass')
      startMove(GLASS, () => onPick(game))
    },
    [rig, startMove, onPick, onSetup],
  )

  /** Enter on the rail: a game row launches, the set-up row walks to the poster. */
  const activate = useCallback(
    (index: number): void => {
      if (moving || mode !== 'menu' || station !== 'home') return
      setCursor(index)
      if (isSetupRow(ROOM_ROWS[index].id)) {
        rig.station = 'poster'
        setStation('poster')
        startMove(POSTER_STATION, null)
        return
      }
      launch(index)
    },
    [moving, mode, station, rig, startMove, launch],
  )

  /** Off the rail. The eye eases from wherever it is to the nearest clear floor, then the keys take over. */
  const enterLook = useCallback((): void => {
    if (moving || mode === 'look') return
    const from = currentVantage()
    const position = from.position.clone().setY(EYE_HEIGHT)
    keepOnFloor(position)
    // The look point is kept far down the line of sight, not one unit ahead
    // as the vantage carries it: the push out of the furniture can move the
    // eye past a near point, and the walker would arrive facing the wall.
    const heading = from.lookAt.clone().sub(from.position).setY(0).normalize()
    const lookAt = position.clone().addScaledVector(heading, LOOK_ENTRY_REACH)
    rig.mode = 'look'
    rig.skateboardRolled = false
    setMode('look')
    startMove({ position, lookAt }, () => {
      const camera = cameraRef.current
      if (!camera) return
      rig.position.copy(camera.position)
      const heading = camera.getWorldDirection(new THREE.Vector3())
      rig.yaw = Math.atan2(heading.x, heading.z)
      rig.pitch = THREE.MathUtils.clamp(Math.asin(heading.y), -PITCH_LIMIT, PITCH_LIMIT)
    })
  }, [moving, mode, rig, currentVantage, startMove])

  /** Enter on foot: the glass if you are at it and facing it, the poster if you are near it. */
  const actOnNearby = useCallback((): void => {
    if (moving) return
    const dxGlass = GLASS_CENTRE.x - rig.position.x
    const dzGlass = GLASS_CENTRE.z - rig.position.z
    const glassDistance = Math.hypot(dxGlass, dzGlass)
    const offGlass = Math.abs(wrapAngle(Math.atan2(dxGlass, dzGlass) - rig.yaw))
    if (glassDistance < GLASS_REACH && offGlass < GLASS_FACING) {
      launch(cursor)
      return
    }
    if (Math.hypot(POSTER.centre.x - rig.position.x, POSTER.centre.z - rig.position.z) < POSTER_REACH) onSetup()
  }, [moving, rig, cursor, launch, onSetup])

  const hover = useCallback(
    (index: number): void => {
      if (!moving && mode === 'menu' && station === 'home') setCursor(index)
    },
    [moving, mode, station],
  )

  // The keys on the rail: the cursor, Enter, and the way off the rail.
  useEffect(() => {
    if (!isLive || !inputEnabled || mode !== 'menu') return
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event)) return
      const key = event.key.toLowerCase()
      if (key === 'w') {
        event.preventDefault()
        enterLook()
      } else if (key === 'escape') {
        if (station !== 'poster' || moving) return
        event.preventDefault()
        goHome()
      } else if (key === 'enter' || key === ' ') {
        event.preventDefault()
        if (station === 'poster') {
          if (!moving) onSetup()
        } else activate(cursor)
      } else if (station === 'home' && key === 'arrowdown') {
        event.preventDefault()
        setCursor((current) => stepRow(current, 1))
      } else if (station === 'home' && key === 'arrowup') {
        event.preventDefault()
        setCursor((current) => stepRow(current, -1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isLive, inputEnabled, mode, station, moving, cursor, activate, enterLook, goHome, onSetup])

  // The keys on foot: held, not pressed, so the frame loop reads them.
  useEffect(() => {
    if (!isLive || !inputEnabled || mode !== 'look') return
    const held = rig.held
    const onDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event)) return
      const key = event.key.toLowerCase()
      if (key === 'escape') {
        event.preventDefault()
        if (!moving) goHome()
      } else if (key === 'enter' || key === ' ') {
        event.preventDefault()
        actOnNearby()
      } else if (key === 'w' || key === 'a' || key === 's' || key === 'd' || key.startsWith('arrow')) {
        event.preventDefault()
        held.add(key)
      }
    }
    const onUp = (event: KeyboardEvent): void => {
      held.delete(event.key.toLowerCase())
    }
    const onBlur = (): void => held.clear()
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
      held.clear()
    }
  }, [isLive, inputEnabled, mode, moving, rig, goHome, actOnNearby])

  // The pointer on foot: a drag turns the head. On the rail the pointer is
  // the parallax, handled in the frame loop, and a drag is nothing.
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (mode !== 'look' || !inputEnabled) return
      drag.current = { x: event.clientX, y: event.clientY }
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [mode, inputEnabled],
  )
  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      const last = drag.current
      if (last === null || rig.mode !== 'look' || rig.move !== null) return
      rig.yaw -= (event.clientX - last.x) * LOOK_RADIANS_PER_PIXEL
      rig.pitch = THREE.MathUtils.clamp(rig.pitch - (event.clientY - last.y) * LOOK_RADIANS_PER_PIXEL, -PITCH_LIMIT, PITCH_LIMIT)
      drag.current = { x: event.clientX, y: event.clientY }
    },
    [rig],
  )
  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current !== null && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    drag.current = null
  }, [])

  const onRoomClick = useCallback((): void => {
    if (mode === 'menu' && inputEnabled && !moving) enterLook()
  }, [mode, inputEnabled, moving, enterLook])

  const launching = moving && station === 'glass'
  const interactive = mode === 'menu' && station === 'home' && !moving

  return (
    <div
      style={{ position: 'relative', height: '100%', width: '100%', background: ROOM_FOG.color, touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <Canvas
        frameloop={isLive ? 'always' : 'never'}
        dpr={1}
        flat
        gl={{ antialias: false, powerPreference: 'low-power' }}
        camera={{ fov: FOV.wide, near: 0.2, far: 40, position: HOME_WIDE.position.toArray() }}
        style={{ position: 'relative', height: '100%', width: '100%', imageRendering: 'pixelated' }}
        resize={{ scroll: false }}
        onCreated={({ gl, camera }) => {
          gl.setClearColor(new THREE.Color(ROOM_FOG.color), 1)
          cameraRef.current = camera
          // Development only: the camera on the window, so a browser session
          // can read where the eye is. Never in production.
          if (process.env.NODE_ENV !== 'production') {
            const scope = globalThis as typeof globalThis & { roomCamera?: THREE.Camera }
            scope.roomCamera = camera
          }
        }}
      >
        <RoomResolutionLock height={ROOM_INTERNAL_HEIGHT} />
        <RoomCamera narrow={isNarrow} rig={rig} onMoveDone={handleMoveDone} />
        {/* The glass lights before the room streams in: a screen on in the
            dark is the honest picture of a model still downloading. */}
        <group position={CABINET_POSITION} rotation-y={CABINET_YAW}>
          <Banner />
          <Screen cursor={cursor} launching={launching} interactive={interactive} onHover={hover} onActivate={activate} />
        </group>
        <Poster />
        <Television />
        <Suspense fallback={null}>
          <RoomModel rig={rig} onRoomClick={onRoomClick} />
        </Suspense>
      </Canvas>
    </div>
  )
}

useGLTF.preload(ROOM_MODEL_URL)

// Page sizes are referenced so a change to a painter's grid is caught here
// rather than discovered as a squashed page on the wall.
const SCREEN_ASPECT = SCREEN.width / SCREEN.height
const PAGE_ASPECT = SCREEN_PAGE.width / SCREEN_PAGE.height
if (Math.abs(SCREEN_ASPECT - PAGE_ASPECT) > 0.05) {
  console.warn(`Arcade screen page aspect ${PAGE_ASPECT.toFixed(2)} does not match the glass ${SCREEN_ASPECT.toFixed(2)}`)
}
const POSTER_ASPECT = POSTER.width / POSTER.height
const POSTER_PAGE_ASPECT = POSTER_PAGE.width / POSTER_PAGE.height
if (Math.abs(POSTER_ASPECT - POSTER_PAGE_ASPECT) > 0.05) {
  console.warn(`Poster page aspect ${POSTER_PAGE_ASPECT.toFixed(2)} does not match the wall quad ${POSTER_ASPECT.toFixed(2)}`)
}
