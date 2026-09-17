'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useQuery } from 'convex/react'
import * as THREE from 'three'
import { api } from '../../../../convex/_generated/api'
import { createPs1Material, setJitterAspect } from '../race/Ps1Material'
import { Fighter } from './Fighter'
import { FightHud, type HudSnapshot } from './FightHud'
import {
  ARENA_FLOOR_SIZE,
  ARENA_FOG_FAR,
  ARENA_FOG_NEAR,
  ARENA_INTERNAL_HEIGHT,
  ARENA_SKY,
} from './arena'
import { useFightSim, type SimFighter, type SparkEvent } from './useFightSim'
import { PS1 } from '../../ps1/theme'
import type { FightChannelProps } from './FightChannel'

// CH 02: the fighting game. Two teammates, health from the day's standing,
// offence from the live burn — see useFightSim for the rules. This file is
// only the venue and the wiring: arena, camera, sparks, HUD refresh.

const HUD_REFRESH_MS = 150


/** Camera: the genre's one shot — side-on, waist height, dollying with gap. */
const CAMERA_HEIGHT = 1.45
const CAMERA_LOOK_HEIGHT = 1.0
const CAMERA_DISTANCE_BASE = 4.4
const CAMERA_DISTANCE_PER_GAP = 0.85
/** KO push-in: closer, lower, slower — the era's slow-motion tell. */
const KO_DISTANCE = 3.1
const KO_HEIGHT = 0.9

export function FightScene({ isLive, paused = false }: FightChannelProps): React.ReactElement {
  const running = isLive && !paused
  const race = useQuery(api.scoring.getRace, { period: 'day' })
  const sim = useFightSim(race?.racers)
  const [contextEpoch, setContextEpoch] = useState(0)
  const [hud, setHud] = useState<HudSnapshot | null>(null)

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => {
      const state = sim.state.current
      const [left, right] = state.fighters ?? [null, null]
      const toHud = (fighter: SimFighter | null) =>
        fighter
          ? {
              key: fighter.key,
              name: fighter.name,
              color: fighter.color,
              hpFrac: fighter.hp / fighter.maxHp,
              trailFrac: (fighter.hp + fighter.trail) / fighter.maxHp,
              burnRate: fighter.burnRate,
              wins: sim.wins.current.get(fighter.key) ?? 0,
              rank: fighter.rank,
            }
          : null
      const winner =
        state.winnerKey === null
          ? null
          : (state.fighters?.find((fighter) => fighter.key === state.winnerKey)?.name ?? null)
      setHud({
        phase: state.phase,
        phaseT: state.phaseT,
        clock: state.clock,
        left: toHud(left),
        right: toHud(right),
        winnerName: winner,
        nextPair: state.nextPair,
        stageNumber: state.stageNumber,
        critFlashUntil: state.critFlashUntil,
        events: sim.events.current,
      })
    }, HUD_REFRESH_MS)
    return () => clearInterval(id)
  }, [running, sim])

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%', background: PS1.void }}>
      <ArenaSky />

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
          fov: 52,
          near: 0.3,
          far: ARENA_FOG_FAR * 1.35,
          position: [0, CAMERA_HEIGHT, CAMERA_DISTANCE_BASE],
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
          gl.setClearColor(new THREE.Color(ARENA_SKY.mid), 0)
        }}
      >
        <ContextGuard onRestored={() => setContextEpoch((epoch) => epoch + 1)} />
        <SimDriver sim={sim} isLive={running} />
        <ResolutionLock height={ARENA_INTERNAL_HEIGHT} />
        <FightCamera sim={sim} />

        <ArenaFloor />
        <ArenaDressing />

        <Fighter
          getFighter={() => sim.state.current.fighters?.[0] ?? null}
          fallbackColor={PS1.cyan}
        />
        <Fighter
          getFighter={() => sim.state.current.fighters?.[1] ?? null}
          fallbackColor={PS1.hot}
        />

        <HitSparks sim={sim} />
      </Canvas>

      {/* The critical flash: one hard beat of white, then gone. An overlay
          rather than a light — the era flashed the framebuffer, not the
          scene. Self-expiring against its own deadline, so a paused HUD
          snapshot can never leave it burning over the whole picture. */}
      <CritFlash until={hud?.critFlashUntil ?? 0} />

      <FightHud snapshot={hud} paused={paused} />
    </div>
  )
}

/**
 * The crit flash, bounded by wall clock rather than by HUD polling: it
 * renders only while its deadline is in the future and arranges its own
 * removal at that deadline, so it can never be left on by a frozen snapshot.
 */
function CritFlash({ until }: { readonly until: number }): React.ReactElement | null {
  const [, forceExpiry] = useState(0)

  useEffect(() => {
    const remaining = until - Date.now()
    if (remaining <= 0) return
    const id = setTimeout(() => forceExpiry((tick) => tick + 1), remaining + 20)
    return () => clearTimeout(id)
  }, [until])

  if (Date.now() >= until) return null

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 2,
        pointerEvents: 'none',
        background: 'rgba(255, 240, 220, 0.55)',
        mixBlendMode: 'screen',
      }}
    />
  )
}

// --- Venue -------------------------------------------------------------------

/** The forest backdrop: painted gradient, no geometry — the era's skybox. */
function ArenaSky(): React.ReactElement {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        backgroundImage: [
          `radial-gradient(120% 60% at 50% 74%, ${ARENA_SKY.glow}44 0%, transparent 55%)`,
          `linear-gradient(to bottom, ${ARENA_SKY.high} 0%, ${ARENA_SKY.mid} 55%, ${ARENA_SKY.horizon} 80%, ${ARENA_SKY.mid} 100%)`,
        ].join(', '),
        backgroundBlendMode: 'screen, normal',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `repeating-linear-gradient(0deg, rgba(0,0,0,${ARENA_SKY.dither}) 0 1px, transparent 1px 3px)`,
        }}
      />
    </div>
  )
}

/**
 * The stone court, drawn rather than shipped: a small canvas of flagstones,
 * nearest-sampled and tiled in world space. Generating it keeps the channel
 * assetless and the page a hard 64 texels square — which is the look.
 */
function makeStoneTexture(): THREE.CanvasTexture {
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

function ArenaFloor(): React.ReactElement {
  const material = useMemo(
    () =>
      createPs1Material({
        color: '#ffffff',
        map: makeStoneTexture(),
        fogColor: ARENA_SKY.mid,
        fogNear: ARENA_FOG_NEAR,
        fogFar: ARENA_FOG_FAR,
        // Tile every ~2.2 world units, in world space — the plane's own UVs
        // would stretch one page across the whole court.
        worldUvScale: 1 / 2.2,
      }),
    [],
  )
  return (
    <mesh material={material} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
      <planeGeometry args={[ARENA_FLOOR_SIZE, ARENA_FLOOR_SIZE]} />
    </mesh>
  )
}

/**
 * The tree line and the shrine: boxes in fog. Nothing here is closer than the
 * fog's near plane, so all of it reads as depth rather than as geometry —
 * exactly the era's set dressing budget.
 */
function ArenaDressing(): React.ReactElement {
  const trunk = useMemo(
    () =>
      createPs1Material({
        color: '#233521',
        fogColor: ARENA_SKY.mid,
        fogNear: ARENA_FOG_NEAR,
        fogFar: ARENA_FOG_FAR,
      }),
    [],
  )
  const canopy = useMemo(
    () =>
      createPs1Material({
        color: '#1a2c1a',
        fogColor: ARENA_SKY.mid,
        fogNear: ARENA_FOG_NEAR,
        fogFar: ARENA_FOG_FAR,
      }),
    [],
  )
  const shrine = useMemo(
    () =>
      createPs1Material({
        color: '#4a3a2a',
        fogColor: ARENA_SKY.mid,
        fogNear: ARENA_FOG_NEAR,
        fogFar: ARENA_FOG_FAR,
      }),
    [],
  )

  // A fixed ring of trees. Deterministic, so the venue is the same venue
  // every time the channel tunes in.
  const trees = useMemo(() => {
    const ring: Array<{ x: number; z: number; h: number }> = []
    const count = 26
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2
      const radius = 13 + ((i * 7) % 5)
      ring.push({
        x: Math.cos(angle) * radius,
        z: Math.sin(angle) * radius,
        h: 7 + ((i * 3) % 4),
      })
    }
    return ring
  }, [])

  return (
    <group>
      {trees.map((tree, index) => (
        <group key={index} position={[tree.x, 0, tree.z]}>
          <mesh material={trunk} position={[0, tree.h / 2, 0]}>
            <boxGeometry args={[0.7, tree.h, 0.7]} />
          </mesh>
          <mesh material={canopy} position={[0, tree.h + 1.6, 0]}>
            <boxGeometry args={[2.6, 3.6, 2.6]} />
          </mesh>
        </group>
      ))}

      {/* The shrine, behind the fight — the one landmark, straight from the
          reference frames. */}
      <group position={[0, 0, -9]}>
        <mesh material={shrine} position={[0, 1.1, 0]}>
          <boxGeometry args={[3.4, 2.2, 2.2]} />
        </mesh>
        <mesh material={canopy} position={[0, 2.7, 0]}>
          <boxGeometry args={[4.6, 1.0, 3.2]} />
        </mesh>
      </group>
    </group>
  )
}

// --- FX ----------------------------------------------------------------------

const SPARK_LIFE_MS = 320
const SPARK_POOL = 6

function makeSparkTexture(color: string): THREE.CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.translate(size / 2, size / 2)
    ctx.fillStyle = color
    // An eight-point starburst of hard triangles — the era's hit spark was a
    // handful of additive quads, never a soft particle.
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

const SPARK_COLORS: Record<SparkEvent['kind'], string> = {
  hit: '#4dc8ff',
  crit: '#ff8c1a',
  block: '#e8e8f0',
}

function HitSparks({ sim }: { readonly sim: ReturnType<typeof useFightSim> }): React.ReactElement {
  const sprites = useRef<Array<THREE.Sprite | null>>([])
  // One starburst per kind, shared: the texture never varies within a kind.
  const textures = useMemo(
    () => ({
      hit: makeSparkTexture(SPARK_COLORS.hit),
      crit: makeSparkTexture(SPARK_COLORS.crit),
      block: makeSparkTexture(SPARK_COLORS.block),
    }),
    [],
  )
  // But one material per pooled slot: opacity is per-spark, and a material
  // shared across slots would fade every live spark of that kind in step with
  // whichever one the loop wrote last. The kind's texture is swapped onto the
  // slot's own material when the spark lands.
  const materials = useMemo(
    () =>
      Array.from(
        { length: SPARK_POOL },
        () =>
          new THREE.SpriteMaterial({
            map: textures.hit,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            transparent: true,
          }),
      ),
    [textures],
  )

  useEffect(
    () => () => {
      for (const material of materials) material.dispose()
      for (const texture of Object.values(textures)) texture.dispose()
    },
    [materials, textures],
  )

  useFrame(() => {
    const now = Date.now()
    const live = sim.sparks.current.filter((spark) => now - spark.at < SPARK_LIFE_MS)
    for (let i = 0; i < SPARK_POOL; i++) {
      const sprite = sprites.current[i]
      if (!sprite) continue
      const spark = live[i]
      if (!spark) {
        sprite.visible = false
        continue
      }
      const age = (now - spark.at) / SPARK_LIFE_MS
      const pop = 0.4 + age * (spark.kind === 'crit' ? 2.6 : 1.5)
      const material = materials[i]
      material.map = textures[spark.kind]
      material.opacity = 1 - age
      sprite.visible = true
      sprite.material = material
      sprite.position.set(spark.x, spark.y, 0.3)
      sprite.scale.setScalar(pop)
    }
  })

  return (
    <group>
      {Array.from({ length: SPARK_POOL }, (_, index) => (
        <sprite
          key={index}
          ref={(sprite) => {
            sprites.current[index] = sprite
          }}
          visible={false}
          material={materials[index]}
        />
      ))}
    </group>
  )
}

// --- Wiring ------------------------------------------------------------------

/** Advances the bout once per frame. Pauses when the channel is off. */
function SimDriver({
  sim,
  isLive,
}: {
  readonly sim: ReturnType<typeof useFightSim>
  readonly isLive: boolean
}): null {
  useFrame((_, delta) => {
    if (!isLive) return
    sim.step(delta)
  })
  return null
}

/** The genre's camera: side-on, dollying with the gap, pushing in on a KO. */
function FightCamera({ sim }: { readonly sim: ReturnType<typeof useFightSim> }): null {
  useFrame(({ camera }, delta) => {
    const state = sim.state.current
    const fighters = state.fighters
    const [left, right] = fighters ?? [null, null]
    const midX = left && right ? (left.x + right.x) / 2 : 0
    const gap = left && right ? Math.abs(right.x - left.x) : 3

    const dramatic = state.phase === 'ko' || state.phase === 'victory'
    const targetDistance = dramatic
      ? KO_DISTANCE
      : CAMERA_DISTANCE_BASE + Math.max(0, gap - 2.4) * CAMERA_DISTANCE_PER_GAP
    const targetHeight = dramatic ? KO_HEIGHT : CAMERA_HEIGHT
    // During the intro the camera swings around the pair — the walk-on shot.
    const introSwing =
      state.phase === 'intro' ? Math.sin((1 - state.phaseT / 3.2) * 1.2) * 2.2 : 0

    const ease = Math.min(1, delta * 2.4)
    camera.position.x += (midX + introSwing - camera.position.x) * ease
    camera.position.y += (targetHeight - camera.position.y) * ease
    camera.position.z += (targetDistance - camera.position.z) * ease
    camera.lookAt(midX, CAMERA_LOOK_HEIGHT, 0)
  })
  return null
}

/** Same contract as the race's: survive context loss, release on unmount. */
function ContextGuard({ onRestored }: { readonly onRestored: () => void }): null {
  const gl = useThree((state) => state.gl)

  useEffect(() => {
    const canvas = gl.domElement
    const handleLost = (event: Event): void => {
      event.preventDefault()
      console.warn('Fight channel: WebGL context lost — waiting for restore.')
    }
    const handleRestored = (): void => {
      console.warn('Fight channel: WebGL context restored — rebuilding scene.')
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

/** Fixed low internal height, browser-scaled up — the pixel grid. */
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
