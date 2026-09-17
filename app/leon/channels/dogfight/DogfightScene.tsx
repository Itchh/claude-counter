'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useQuery } from 'convex/react'
import * as THREE from 'three'
import { api } from '../../../../convex/_generated/api'
import { createPs1Material, setJitterAspect } from '../race/Ps1Material'
import { Plane } from './Plane'
import { DogfightHud, type DogfightHudSnapshot } from './DogfightHud'
import {
  THEATRE_FOG_FAR,
  THEATRE_FOG_NEAR,
  THEATRE_INTERNAL_HEIGHT,
  THEATRE_SKY,
} from './theatre'
import { useDogfightSim, type SimPlane } from './useDogfightSim'
import { PS1 } from '../../ps1/theme'
import type { DogfightChannelProps } from './DogfightChannel'

// CH 03: the dogfight. A squadron of teammates wheeling over the fields of
// Kent — airframe from the day's score, throttle and gunnery from the live
// burn, deadeye criticals to keep the sky honest. See useDogfightSim for the
// rules; this file is the theatre, the camera and the wiring.

const HUD_REFRESH_MS = 250
/** More slots than the roster ever fills; empty ones stay invisible. */
const PLANE_SLOTS = 9

/** The wide shot: a slow orbit of the whole box. */
const WIDE_ORBIT_RADIUS = 34
const WIDE_ORBIT_HEIGHT = 15
const WIDE_ORBIT_RATE = 0.045
/** The chase: behind and above the star of the moment. */
const CHASE_BACK = 6.5
const CHASE_UP = 1.8

export function DogfightScene({ isLive, paused = false }: DogfightChannelProps): React.ReactElement {
  const running = isLive && !paused
  const race = useQuery(api.scoring.getRace, { period: 'day' })
  const sim = useDogfightSim(race?.racers)
  const [contextEpoch, setContextEpoch] = useState(0)
  const [hud, setHud] = useState<DogfightHudSnapshot | null>(null)

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => {
      const star = sim.star.current
      const starPlane =
        star && Date.now() < star.until
          ? (sim.planes.current.find((plane) => plane.key === star.key) ?? null)
          : null
      setHud({
        pilots: [...sim.planes.current]
          .sort((a, b) => a.rank - b.rank)
          .map((plane) => ({
            key: plane.key,
            name: plane.name,
            color: plane.color,
            hpFrac: plane.hp / plane.maxHp,
            kills: plane.kills,
            burnRate: plane.burnRate,
            mode: plane.mode,
            rank: plane.rank,
          })),
        events: sim.events.current,
        cameraSubject: starPlane?.name ?? null,
      })
    }, HUD_REFRESH_MS)
    return () => clearInterval(id)
  }, [running, sim])

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%', background: PS1.void }}>
      <TheatreSky />

      <Canvas
        key={contextEpoch}
        // A hidden channel stays mounted so its WebGL context survives,
        // but fiber's loop does not care about visibility: left on
        // "always" every visited game keeps drawing at 60fps behind the
        // one on screen. "never" parks the loop without touching the
        // context, and the next switch resumes it on the same frame.
        frameloop={isLive ? 'always' : 'never'}
        dpr={1}
        flat
        gl={{ antialias: false, powerPreference: 'low-power', alpha: true }}
        camera={{
          fov: 60,
          near: 0.5,
          far: THEATRE_FOG_FAR * 1.35,
          position: [0, WIDE_ORBIT_HEIGHT, WIDE_ORBIT_RADIUS],
        }}
        style={{
          position: 'relative',
          zIndex: 1,
          height: '100%',
          width: '100%',
          imageRendering: 'pixelated',
        }}
        resize={{ scroll: false }}
        onCreated={({ gl }) => {
          gl.setClearColor(new THREE.Color(THEATRE_SKY.mid), 0)
        }}
      >
        <ContextGuard onRestored={() => setContextEpoch((epoch) => epoch + 1)} />
        <SimDriver sim={sim} isLive={running} />
        <ResolutionLock height={THEATRE_INTERNAL_HEIGHT} />
        <PatrolCamera sim={sim} />

        <Countryside />
        <CloudLayer />

        {Array.from({ length: PLANE_SLOTS }, (_, index) => (
          <Plane key={index} getPlane={() => sim.planes.current[index] ?? null} />
        ))}

        <Tracers sim={sim} />
        <Blasts sim={sim} />
      </Canvas>

      <DogfightHud snapshot={hud} paused={paused} />
    </div>
  )
}

// --- Theatre -----------------------------------------------------------------

function TheatreSky(): React.ReactElement {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        backgroundImage: [
          `radial-gradient(130% 55% at 50% 72%, ${THEATRE_SKY.glow}3a 0%, transparent 55%)`,
          `linear-gradient(to bottom, ${THEATRE_SKY.high} 0%, ${THEATRE_SKY.mid} 48%, ${THEATRE_SKY.horizon} 72%, ${THEATRE_SKY.mid} 100%)`,
        ].join(', '),
        backgroundBlendMode: 'screen, normal',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `repeating-linear-gradient(0deg, rgba(0,0,0,${THEATRE_SKY.dither}) 0 1px, transparent 1px 3px)`,
        }}
      />
    </div>
  )
}

/**
 * The fields, drawn rather than shipped: a page of hedged patchwork in the
 * greens and straw-yellows the county actually is from a Spitfire, tiled in
 * world space. One river cut through it so the tiling has a landmark.
 */
function makeCountrysideTexture(): THREE.CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const FIELD_COLORS = ['#5a7a3a', '#6d8a42', '#8a8a4a', '#a89a52', '#4d6b35', '#7a8a3d']
    const cells = 8
    const cell = size / cells
    for (let row = 0; row < cells; row++) {
      for (let col = 0; col < cells; col++) {
        ctx.fillStyle = FIELD_COLORS[(row * 5 + col * 3 + ((row * col) % 4)) % FIELD_COLORS.length]
        ctx.fillRect(col * cell, row * cell, cell, cell)
        // Hedgerows: a dark line on two sides of every field.
        ctx.fillStyle = '#33422a'
        ctx.fillRect(col * cell, row * cell, cell, 1)
        ctx.fillRect(col * cell, row * cell, 1, cell)
      }
    }
    // The river, meandering corner to corner.
    ctx.strokeStyle = '#4a6a8a'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(0, size * 0.7)
    ctx.quadraticCurveTo(size * 0.35, size * 0.45, size * 0.6, size * 0.6)
    ctx.quadraticCurveTo(size * 0.85, size * 0.75, size, size * 0.55)
    ctx.stroke()
    // A village where the river bends.
    ctx.fillStyle = '#8a7a6a'
    for (let i = 0; i < 6; i++) {
      ctx.fillRect(size * 0.55 + (i % 3) * 4, size * 0.62 + Math.floor(i / 3) * 4, 3, 3)
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

function Countryside(): React.ReactElement {
  const material = useMemo(
    () =>
      createPs1Material({
        color: '#ffffff',
        map: makeCountrysideTexture(),
        fogColor: THEATRE_SKY.mid,
        fogNear: THEATRE_FOG_NEAR,
        fogFar: THEATRE_FOG_FAR,
        // The page covers ~48 world units, so a field reads ~6 units across.
        worldUvScale: 1 / 48,
        ambient: 0.55,
      }),
    [],
  )
  return (
    <mesh material={material} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[260, 260]} />
    </mesh>
  )
}

/** Flat white slabs at two heights — the era's clouds were quads, and knew it. */
function CloudLayer(): React.ReactElement {
  const material = useMemo(
    () =>
      createPs1Material({
        color: '#e8ecf0',
        fogColor: THEATRE_SKY.mid,
        fogNear: THEATRE_FOG_NEAR,
        fogFar: THEATRE_FOG_FAR,
        ambient: 0.8,
      }),
    [],
  )
  const clouds = useMemo(() => {
    const list: Array<{ x: number; y: number; z: number; w: number; d: number }> = []
    for (let i = 0; i < 14; i++) {
      const angle = (i / 14) * Math.PI * 2
      const radius = 18 + ((i * 11) % 26)
      list.push({
        x: Math.cos(angle) * radius,
        y: i % 2 === 0 ? 17.5 + (i % 3) : 4.5 + (i % 2) * 1.5,
        z: Math.sin(angle) * radius,
        w: 5 + ((i * 7) % 6),
        d: 3 + ((i * 5) % 4),
      })
    }
    return list
  }, [])
  return (
    <group>
      {clouds.map((cloud, index) => (
        <mesh key={index} material={material} position={[cloud.x, cloud.y, cloud.z]}>
          <boxGeometry args={[cloud.w, 0.5, cloud.d]} />
        </mesh>
      ))}
    </group>
  )
}

// --- FX ----------------------------------------------------------------------

const TRACER_LIFE_MS = 220
const TRACER_POOL = 8

/** Gunfire as stretched boxes — the period's tracer was a lit line, not a particle. */
function Tracers({ sim }: { readonly sim: ReturnType<typeof useDogfightSim> }): React.ReactElement {
  const meshes = useRef<Array<THREE.Mesh | null>>([])
  // One material per pooled slot, not one per kind: opacity is per-tracer, and
  // a shared instance would fade every live tracer in step with the last one
  // the loop happens to touch.
  const materials = useMemo(
    () => ({
      hit: Array.from(
        { length: TRACER_POOL },
        () => new THREE.MeshBasicMaterial({ color: '#ffd24d', transparent: true }),
      ),
      crit: Array.from(
        { length: TRACER_POOL },
        () => new THREE.MeshBasicMaterial({ color: '#ff6a1a', transparent: true }),
      ),
    }),
    [],
  )
  const from = useMemo(() => new THREE.Vector3(), [])
  const to = useMemo(() => new THREE.Vector3(), [])

  useFrame(() => {
    const now = Date.now()
    const live = sim.tracers.current.filter((tracer) => now - tracer.at < TRACER_LIFE_MS)
    for (let i = 0; i < TRACER_POOL; i++) {
      const mesh = meshes.current[i]
      if (!mesh) continue
      const tracer = live[i]
      if (!tracer) {
        mesh.visible = false
        continue
      }
      from.set(tracer.fromX, tracer.fromY, tracer.fromZ)
      to.set(tracer.toX, tracer.toY, tracer.toZ)
      const length = from.distanceTo(to)
      mesh.visible = true
      mesh.position.copy(from).add(to).multiplyScalar(0.5)
      mesh.lookAt(to)
      mesh.scale.set(1, 1, length)
      const material = tracer.crit ? materials.crit[i] : materials.hit[i]
      mesh.material = material
      const age = (now - tracer.at) / TRACER_LIFE_MS
      material.opacity = 1 - age
    }
  })

  return (
    <group>
      {Array.from({ length: TRACER_POOL }, (_, index) => (
        <mesh
          key={index}
          ref={(mesh) => {
            meshes.current[index] = mesh
          }}
          visible={false}
          material={materials.hit[index]}
        >
          <boxGeometry args={[0.06, 0.06, 1]} />
        </mesh>
      ))}
    </group>
  )
}

const BLAST_LIFE_MS = { hit: 300, crash: 800 } as const
const BLAST_POOL = 5

function makeBlastTexture(color: string): THREE.CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.translate(size / 2, size / 2)
    ctx.fillStyle = color
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2
      const long = i % 2 === 0 ? 30 : 18
      ctx.beginPath()
      ctx.moveTo(Math.cos(angle - 0.18) * 6, Math.sin(angle - 0.18) * 6)
      ctx.lineTo(Math.cos(angle) * long, Math.sin(angle) * long)
      ctx.lineTo(Math.cos(angle + 0.18) * 6, Math.sin(angle + 0.18) * 6)
      ctx.closePath()
      ctx.fill()
    }
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(0, 0, 5, 0, Math.PI * 2)
    ctx.fill()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  return texture
}

function Blasts({ sim }: { readonly sim: ReturnType<typeof useDogfightSim> }): React.ReactElement {
  const sprites = useRef<Array<THREE.Sprite | null>>([])
  const materials = useMemo(
    () => ({
      hit: Array.from(
        { length: BLAST_POOL },
        () =>
          new THREE.SpriteMaterial({
            map: makeBlastTexture('#ffd24d'),
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            transparent: true,
          }),
      ),
      crash: Array.from(
        { length: BLAST_POOL },
        () =>
          new THREE.SpriteMaterial({
            map: makeBlastTexture('#ff5a1a'),
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            transparent: true,
          }),
      ),
    }),
    [],
  )

  useFrame(() => {
    const now = Date.now()
    const live = sim.blasts.current.filter(
      (blast) => now - blast.at < BLAST_LIFE_MS[blast.kind],
    )
    for (let i = 0; i < BLAST_POOL; i++) {
      const sprite = sprites.current[i]
      if (!sprite) continue
      const blast = live[i]
      if (!blast) {
        sprite.visible = false
        continue
      }
      const life = BLAST_LIFE_MS[blast.kind]
      const age = (now - blast.at) / life
      sprite.visible = true
      sprite.material = materials[blast.kind][i]
      sprite.position.set(blast.x, blast.y + (blast.kind === 'crash' ? age * 1.2 : 0), blast.z)
      sprite.scale.setScalar(blast.kind === 'crash' ? 1.5 + age * 4 : 0.6 + age * 1.6)
      sprite.material.opacity = 1 - age
    }
  })

  return (
    <group>
      {Array.from({ length: BLAST_POOL }, (_, index) => (
        <sprite
          key={index}
          ref={(sprite) => {
            sprites.current[index] = sprite
          }}
          visible={false}
          material={materials.hit[index]}
        />
      ))}
    </group>
  )
}

// --- Wiring ------------------------------------------------------------------

function SimDriver({
  sim,
  isLive,
}: {
  readonly sim: ReturnType<typeof useDogfightSim>
  readonly isLive: boolean
}): null {
  useFrame((_, delta) => {
    if (!isLive) return
    sim.step(delta)
  })
  return null
}

/**
 * Two shots and a blend: a slow wide orbit of the whole patrol, and a chase
 * of whoever the simulation has flagged as the moment — an attacker on a
 * tail, or a plane going down, followed all the way in.
 */
function PatrolCamera({ sim }: { readonly sim: ReturnType<typeof useDogfightSim> }): null {
  const orbitAngle = useRef(0)
  const desired = useMemo(() => new THREE.Vector3(), [])
  const look = useMemo(() => new THREE.Vector3(), [])

  useFrame(({ camera }, delta) => {
    orbitAngle.current += WIDE_ORBIT_RATE * delta

    const star = sim.star.current
    const subject: SimPlane | null =
      star && Date.now() < star.until
        ? (sim.planes.current.find(
            (plane) => plane.key === star.key && plane.mode !== 'respawn',
          ) ?? null)
        : null

    if (subject) {
      desired.set(
        subject.x - Math.sin(subject.heading) * CHASE_BACK,
        Math.max(2.2, subject.y + CHASE_UP),
        subject.z - Math.cos(subject.heading) * CHASE_BACK,
      )
      look.set(subject.x, subject.y, subject.z)
    } else {
      desired.set(
        Math.cos(orbitAngle.current) * WIDE_ORBIT_RADIUS,
        WIDE_ORBIT_HEIGHT,
        Math.sin(orbitAngle.current) * WIDE_ORBIT_RADIUS,
      )
      // Watch the middle of the band, biased toward wherever the patrol is.
      const patrol = sim.planes.current.filter((plane) => plane.mode !== 'respawn')
      const cx =
        patrol.length > 0
          ? patrol.reduce((sum, plane) => sum + plane.x, 0) / patrol.length
          : 0
      const cz =
        patrol.length > 0
          ? patrol.reduce((sum, plane) => sum + plane.z, 0) / patrol.length
          : 0
      look.set(cx * 0.6, 10, cz * 0.6)
    }

    const ease = Math.min(1, delta * 1.6)
    camera.position.lerp(desired, ease)
    camera.lookAt(look)
  })
  return null
}

function ContextGuard({ onRestored }: { readonly onRestored: () => void }): null {
  const gl = useThree((state) => state.gl)

  useEffect(() => {
    const canvas = gl.domElement
    const handleLost = (event: Event): void => {
      event.preventDefault()
      console.warn('Dogfight channel: WebGL context lost — waiting for restore.')
    }
    const handleRestored = (): void => {
      console.warn('Dogfight channel: WebGL context restored — rebuilding scene.')
      onRestored()
    }
    canvas.addEventListener('webglcontextlost', handleLost)
    canvas.addEventListener('webglcontextrestored', handleRestored)
    return () => {
      canvas.removeEventListener('webglcontextlost', handleLost)
      canvas.removeEventListener('webglcontextrestored', handleRestored)
      // No manual loseContext here: fiber's root teardown force-loses the
      // context itself, and losing it twice poisoned the GPU channel — see
      // the race's ContextGuard for the full story.
    }
  }, [gl, onRestored])

  return null
}

function ResolutionLock({ height }: { readonly height: number }): null {
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
