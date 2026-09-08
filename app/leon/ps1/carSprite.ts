import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import {
  carModelFor,
  liveryFor,
  WHEEL_MODEL,
} from '../channels/race/cars'
import { splitCarGeometry } from '../channels/race/carGeometry'
import { createPs1Material, configurePs1Texture } from '../channels/race/Ps1Material'

// The scoreboard's cars, baked from the race's own models.
//
// The rows want the actual car — same mesh, same painted livery as the one
// running on the circuit — and the obvious way to get it is a small 3D canvas
// per row. That is the one thing this cannot do: every canvas is a WebGL
// context, browsers hand out about sixteen and then start dropping the oldest,
// and the race channel needs one for a scene that costs real money to rebuild.
// A scoreboard that quietly kills the race when a sixth driver joins is a bad
// trade for a thumbnail.
//
// So the cars are rendered once, off screen, into a sprite sheet: one shared
// renderer, one context, a turntable's worth of frames per car, and the rows
// display an ordinary image stepped through by CSS. It is also exactly how
// the era did a rotating object it did not want to pay for in polygons —
// pre-rendered frames, flipped in sequence — so the artefact is honest.

/** Pixels per frame. Twice the 48px the rows draw, for a crisp downscale. */
const FRAME_SIZE = 96
/** Frames in one full revolution. Twelve reads as a turntable, not a flicker. */
export const SPRITE_FRAMES = 12
/** Seconds the renderer is kept alive after the last bake. */
const IDLE_DISPOSE_S = 8

/**
 * How the shot is framed. The distance is derived from the car's own bounding
 * box rather than fixed: the pack's eight cars differ enough in length that a
 * single camera position framed a hatch nicely and cut the nose off a coupe,
 * and the box is right there to ask.
 */
const CAMERA_FOV = 34
/** Camera height as a fraction of the car's length. */
const CAMERA_RISE = 0.42
/** Air left around the car at its widest rotation, as a fraction of its size. */
const CAMERA_MARGIN = 1.18

const loader = new OBJLoader()
const textureLoader = new THREE.TextureLoader()

let renderer: THREE.WebGLRenderer | null = null
let disposeTimer: number | null = null

/**
 * The one context. Created on the first bake and released once the screen has
 * stopped asking — a scoreboard bakes five cars in a burst and then never
 * again until the board changes.
 */
function acquireRenderer(): THREE.WebGLRenderer | null {
  if (disposeTimer !== null) {
    window.clearTimeout(disposeTimer)
    disposeTimer = null
  }
  if (renderer) return renderer
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: false,
      // The sheet is drawn from the canvas immediately after each render, and
      // without this the buffer is already cleared by the time we read it.
      preserveDrawingBuffer: true,
    })
    renderer.setPixelRatio(1)
    renderer.setSize(FRAME_SIZE, FRAME_SIZE, false)
    return renderer
  } catch (error) {
    // No WebGL at all — a locked-down browser, a lost context that never came
    // back. The caller falls back to the drawn car rather than to a hole.
    console.warn('carSprite: no WebGL context available', error)
    renderer = null
    return null
  }
}

function releaseRendererSoon(): void {
  if (disposeTimer !== null) window.clearTimeout(disposeTimer)
  disposeTimer = window.setTimeout(() => {
    renderer?.dispose()
    renderer?.forceContextLoss()
    renderer = null
    disposeTimer = null
  }, IDLE_DISPOSE_S * 1000)
}

const geometryCache = new Map<string, Promise<THREE.BufferGeometry>>()
const textureCache = new Map<string, Promise<THREE.Texture>>()
const sheetCache = new Map<string, Promise<string>>()

function loadFirstMesh(url: string): Promise<THREE.BufferGeometry> {
  const cached = geometryCache.get(url)
  if (cached) return cached
  const pending = loader.loadAsync(url).then((group) => {
    const mesh = group.children.find(
      (child): child is THREE.Mesh => (child as THREE.Mesh).isMesh,
    )
    if (!mesh) throw new Error(`carSprite: no mesh in ${url}`)
    return mesh.geometry
  })
  geometryCache.set(url, pending)
  // A rejected promise must not be cached, or one dropped request retires the
  // asset for the lifetime of the page. The wheel is shared by every car, so
  // a single failed fetch of it would strand the whole board on the fallback.
  pending.catch(() => geometryCache.delete(url))
  return pending
}

function loadTexture(url: string): Promise<THREE.Texture> {
  const cached = textureCache.get(url)
  if (cached) return cached
  const pending = textureLoader.loadAsync(url)
  textureCache.set(url, pending)
  pending.catch(() => textureCache.delete(url))
  return pending
}

/**
 * Renders one driver's car as a vertical sprite sheet of `SPRITE_FRAMES`
 * frames, and hands back a data URL. Cached per car and livery, so eight
 * drivers sharing a model and a paint job bake once between them.
 */
export function bakeCarSprite(index: number, driverHex: string): Promise<string> {
  const model = carModelFor(index)
  const livery = liveryFor(index, driverHex)
  const key = `${model.objUrl}|${livery}`
  const cached = sheetCache.get(key)
  if (cached) return cached

  const pending = (async (): Promise<string> => {
    const [bodySource, wheelGeometry, liveryTexture, wheelTexture] = await Promise.all([
      loadFirstMesh(model.objUrl),
      loadFirstMesh(WHEEL_MODEL.objUrl),
      loadTexture(livery),
      loadTexture(WHEEL_MODEL.textureUrl),
    ])

    const active = acquireRenderer()
    if (!active) throw new Error('carSprite: no renderer')

    // The disposables are declared out here so the `finally` can reach them.
    // Everything from the renderer's acquisition to its release is wrapped:
    // this module's whole reason to exist is that a WebGL context is scarce,
    // and the paths that can throw — a missing 2D context, a browser refusing
    // toDataURL, a malformed mesh — are exactly the ones that would otherwise
    // strand one for the lifetime of the page.
    let bodyMaterial: THREE.ShaderMaterial | null = null
    let wheelMaterial: THREE.ShaderMaterial | null = null
    let body: THREE.BufferGeometry | null = null

    try {
      // The same split the track cars use, so the thumbnail is the same
      // object: body normalised to track scale, wheels placed from the
      // geometry itself.
      const split = splitCarGeometry(bodySource)
      body = split.body

      const scene = new THREE.Scene()
      // Fog pushed past the far plane: the circuit's shared stops would
      // dissolve a thumbnail sitting four units from the lens into flat sky.
      bodyMaterial = createPs1Material({
        color: '#ffffff',
        map: configurePs1Texture(liveryTexture),
        tint: 0,
        ambient: 0.72,
        fogNear: 900,
        fogFar: 1000,
      })
      wheelMaterial = createPs1Material({
        color: '#ffffff',
        map: configurePs1Texture(wheelTexture),
        tint: 0,
        ambient: 0.62,
        fogNear: 900,
        fogFar: 1000,
      })

      const car = new THREE.Group()
      car.add(new THREE.Mesh(split.body, bodyMaterial))
      for (const placement of split.wheels) {
        const wheel = new THREE.Mesh(wheelGeometry, wheelMaterial)
        wheel.position.set(placement.x, placement.y, placement.z)
        wheel.scale.setScalar(placement.radius / WHEEL_SOURCE_RADIUS)
        car.add(wheel)
      }

      // Framed off the car's own box, and off its longest axis specifically:
      // the turntable swings the length across the frame, so a shot that fits
      // the car head-on clips it a quarter of a turn later.
      const bounds = new THREE.Box3().setFromObject(car)
      const centre = bounds.getCenter(new THREE.Vector3())
      const size = bounds.getSize(new THREE.Vector3())
      const swing = Math.max(size.x, size.z)
      const radius = Math.max(Math.hypot(swing, size.y) / 2, 0.5)
      const distance = (radius * CAMERA_MARGIN) / Math.tan((CAMERA_FOV * Math.PI) / 360)

      // The car turns about its own centre rather than about wherever the
      // exporter left the origin, so the shot stays put while it revolves.
      car.position.sub(centre)
      const pivot = new THREE.Group()
      pivot.add(car)
      scene.add(pivot)

      const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 100)
      camera.position.set(0, radius * CAMERA_RISE, distance)
      camera.lookAt(0, 0, 0)

      const sheet = document.createElement('canvas')
      sheet.width = FRAME_SIZE
      sheet.height = FRAME_SIZE * SPRITE_FRAMES
      const sheetContext = sheet.getContext('2d')
      if (!sheetContext) throw new Error('carSprite: no 2d context for the sheet')

      for (let frame = 0; frame < SPRITE_FRAMES; frame += 1) {
        // Starting a sixth of a turn round puts the first frame — the one a
        // still board shows — on the car's three-quarter rear, which is the
        // angle every car select of the era opened on.
        pivot.rotation.y = (frame / SPRITE_FRAMES) * Math.PI * 2 + Math.PI / 6
        active.render(scene, camera)
        sheetContext.drawImage(active.domElement, 0, frame * FRAME_SIZE)
      }

      return sheet.toDataURL('image/png')
    } finally {
      // The scene is one bake's worth of scaffolding; the geometry and
      // textures are cached and shared, so only what was built here goes.
      bodyMaterial?.dispose()
      wheelMaterial?.dispose()
      body?.dispose()
      releaseRendererSoon()
    }
  })()

  sheetCache.set(key, pending)
  // A failed bake must not poison the cache — the next mount should try again.
  pending.catch(() => sheetCache.delete(key))
  return pending
}

/** The pack wheel's own radius, measured from Wheel.obj. Mirrors Kart.tsx. */
const WHEEL_SOURCE_RADIUS = 0.4586
