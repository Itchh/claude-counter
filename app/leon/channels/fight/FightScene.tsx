'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import { useCachedQuery } from '@/lib/useCachedQuery'
import * as THREE from 'three'
import { ContextGuard } from '../../ps1/ContextGuard'
import { api } from '../../../../convex/_generated/api'
import { createPs1Material, setJitterAspect } from '../race/Ps1Material'
import { Fighter, preloadFighters, type FighterAir } from './Fighter'
import { FightHud, type HudSnapshot } from './FightHud'
import { DojoLayer, type DojoFighter } from './Dojo'
import { useMe } from '../../control/useMe'
import { fillRoster } from '@/lib/cpuRoster'
import { StageModel } from './Stage'
import { fighterOf } from './fighters'
import { ARENA_FLOOR_SIZE, ARENA_INTERNAL_HEIGHT } from './arena'
import { ringFloorAt, stageFloorAt, stageModelUrls, type StageDefinition, type StageSky } from './stages'
import { makeStoneTexture } from './stoneTexture'
import { STANCE_X, useFightSim, type SimFighter, type SparkEvent } from './useFightSim'
import { PS1 } from '../../ps1/theme'
import type { FightChannelProps } from './FightChannel'

// CH 02: the fighting game. Two teammates, health from the day's standing,
// offence from the live burn — see useFightSim for the rules. This file is
// only the venue and the wiring: stage, camera, sparks, HUD refresh, and
// the dojo window over the top.
//
// The venue is the one thing here that changes between bouts. The
// simulation names a stage per bout; the scene reads it on the HUD tick and
// swaps the model, the sky and every material's fog in one commit, so the
// fighters walk out somewhere new each time the card goes up.
//
// The venue also sets the scale. The simulation fights in fighter units
// and the scanned stages are large, so the two fighters and their sparks
// sit in one group scaled by the stage's fighterScale, and the camera's
// distances are multiplied by the same number: the shot is the same shot
// on every stage, framed on the fighters, and it is the hall behind them
// that reads as big or small. The stage model itself is never scaled —
// its line was measured at its own size.

const HUD_REFRESH_MS = 150

/**
 * Camera: the genre's one shot — side-on, waist height, dollying with gap.
 * All in fighter units; the stage's fighterScale is applied when the camera
 * is placed, so these are distances from a 1.83-tall body whatever the venue.
 */
const CAMERA_HEIGHT = 1.45
const CAMERA_LOOK_HEIGHT = 1.0
const CAMERA_DISTANCE_BASE = 3.5
/** The scene's own field of view; a venue may widen it (see StageCamera). */
const CAMERA_FOV = 46
const CAMERA_DISTANCE_PER_GAP = 0.85
/** The gap the dolly starts pulling back from, in fighter units. */
const CAMERA_GAP_REST = 2.4
/** KO push-in: closer, lower, slower — the era's slow-motion tell. */
const KO_DISTANCE = 3.1
/** Names on a card before the machine fills the other corner. */
const MIN_FIGHT_CARD = 2
const KO_HEIGHT = 0.9
/** The intro's swing around the pair: how wide, and how long it takes to settle. */
/**
 * In fighter units, scaled with the ring: at 2.2 the swing's far end pushed
 * the left fighter out of frame on the largest stages once the pair stood
 * 1.6 times taller. 1.3 keeps both in shot through the walk-on.
 */
const INTRO_SWING = 1.3
const INTRO_SWING_S = 3.2
/** How quickly the camera settles onto its mark. */
const CAMERA_EASE = 2.4

// Every sculpt and every venue, warmed the moment the module loads: a
// bout that has to wait for its fighter to download is a card with nobody
// under it.
preloadFighters()
for (const url of stageModelUrls()) useGLTF.preload(url)

export function FightScene({ isLive, paused = false }: FightChannelProps): React.ReactElement {
  const [dojoKey, setDojoKey] = useState<string | null>(null)
  // The bout holds while the dojo is open, for the same reason the race
  // holds for the paint shop: the picture behind an open window is there to
  // be read, not to move on without you.
  const running = isLive && !paused && dojoKey === null
  // Today's card, and the month's behind it: a ring that waits for two
  // people to burn tokens on the same day is dark most mornings, and a dark
  // ring shows nobody the fighters or the venues. The day's roster wins
  // whenever it has a bout in it; the month's is the attract mode.
  const today = useCachedQuery('race:day', api.scoring.getRace, { period: 'day' })
  const todayHasBout = today !== undefined && today.racers.length >= 2
  const month = useCachedQuery('race:month', api.scoring.getRace, todayHasBout ? 'skip' : { period: 'month' })
  const race = todayHasBout ? today : (month ?? today)
  // And behind the month, the machine: a card that still has one name on it
  // gets a CPU across the ring. Padded only once the roster has arrived, so
  // nobody sees a bot walk on and then vanish when the real card lands.
  const roster = useMemo(() => (race === undefined ? undefined : fillRoster(race.racers, MIN_FIGHT_CARD)), [race])
  const sim = useFightSim(roster)
  const [contextEpoch, setContextEpoch] = useState(0)
  const [hud, setHud] = useState<HudSnapshot | null>(null)
  // The stage in React state so the venue swaps as one commit. Read off the
  // simulation on the HUD tick, never during render.
  const [stage, setStage] = useState<StageDefinition>(() => sim.state.current.stage)

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
      setStage((current) => (current.slug === state.stage.slug ? current : state.stage))
      setHud({
        phase: state.phase,
        phaseT: state.phaseT,
        clock: state.clock,
        left: toHud(left),
        right: toHud(right),
        winnerName: winner,
        nextPair: state.nextPair,
        stageNumber: state.stageNumber,
        stageTitle: state.stage.title,
        critFlashUntil: state.critFlashUntil,
        events: sim.events.current,
      })
    }, HUD_REFRESH_MS)
    return () => clearInterval(id)
  }, [running, sim])

  const air = useMemo<FighterAir>(
    () => ({ fogColor: stage.sky.mid, fogNear: stage.fog.near, fogFar: stage.fog.far }),
    [stage],
  )
  // The ring floor: fighter units in, fighter units out, for everything
  // inside the scaled ring group. The camera stands outside it and asks
  // for the world floor instead.
  const floorAt = useCallback((x: number): number => ringFloorAt(stage, x), [stage])
  const isFrozen = useCallback((): boolean => sim.state.current.hitStop > 0, [sim])

  // Only your own fighter opens: setFighterLivery writes to whoever is
  // signed in, so a dojo opened on someone else would dress you in theirs.
  const me = useMe()
  const myKey = me?.key ?? null
  const handleOpenDojo = useCallback(
    (fighterKey: string): void => {
      if (myKey !== null && fighterKey === myKey) setDojoKey(fighterKey)
    },
    [myKey],
  )
  const handleCloseDojo = useCallback((): void => {
    setDojoKey(null)
  }, [])

  // The dojo's owner, from the roster: the fighter as they are drawn now
  // and the choices behind that.
  const dojoFighter = useMemo<DojoFighter | null>(() => {
    if (dojoKey === null) return null
    const racer = race?.racers.find((candidate) => candidate.key === dojoKey)
    if (!racer) return null
    return {
      key: racer.key,
      name: racer.name,
      index: fighterOf(racer.key, racer.fighter),
      fighter: racer.fighter,
      color: racer.color ?? PS1.cyan,
      paint: racer.fightPaint,
      livery: racer.fightLivery,
      score: racer.score,
      velocity: racer.velocityTokensPerMin,
    }
  }, [dojoKey, race])

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%', background: PS1.void }}>
      <StageSkyBackdrop sky={stage.sky} />

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
          fov: CAMERA_FOV,
          near: 0.3,
          far: 120,
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
          gl.setClearColor(new THREE.Color(stage.sky.mid), 0)
        }}
      >
        <ContextGuard label="Fight" onRestored={() => setContextEpoch((epoch) => epoch + 1)} />
        <SimDriver sim={sim} isLive={running} />
        <ResolutionLock height={ARENA_INTERNAL_HEIGHT} />
        <FightCamera sim={sim} />

        {stage.model === null ? (
          <ForestCourt sky={stage.sky} fogNear={stage.fog.near} fogFar={stage.fog.far} />
        ) : (
          <Suspense fallback={null}>
            <StageModel key={stage.slug} stage={stage} />
          </Suspense>
        )}

        {/* The ring: everything that lives in fighter units, brought up to
            the venue's size in one place. */}
        <group scale={stage.fighterScale} position-z={stage.camera.ringZ}>
          <Fighter
            getFighter={() => sim.state.current.fighters?.[0] ?? null}
            isFrozen={isFrozen}
            fallbackColor={PS1.cyan}
            air={air}
            floorAt={floorAt}
          />
          <Fighter
            getFighter={() => sim.state.current.fighters?.[1] ?? null}
            isFrozen={isFrozen}
            fallbackColor={PS1.hot}
            air={air}
            floorAt={floorAt}
          />

          <HitSparks sim={sim} floorAt={floorAt} />
        </group>
      </Canvas>

      {/* The critical flash: one hard beat of white, then gone. An overlay
          rather than a light — the era flashed the framebuffer, not the
          scene. Self-expiring against its own deadline, so a paused HUD
          snapshot can never leave it burning over the whole picture. */}
      <CritFlash until={hud?.critFlashUntil ?? 0} />

      <FightHud snapshot={hud} paused={paused || dojoKey !== null} onOpenDojo={handleOpenDojo} />

      <DojoLayer fighter={dojoFighter} onClose={handleCloseDojo} />
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

/** The painted backdrop: gradient, no geometry — the era's skybox, per stage. */
function StageSkyBackdrop({ sky }: { readonly sky: StageSky }): React.ReactElement {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        backgroundImage: [
          `radial-gradient(120% 60% at 50% 74%, ${sky.glow}44 0%, transparent 55%)`,
          `linear-gradient(to bottom, ${sky.high} 0%, ${sky.mid} 55%, ${sky.horizon} 80%, ${sky.mid} 100%)`,
        ].join(', '),
        backgroundBlendMode: 'screen, normal',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `repeating-linear-gradient(0deg, rgba(0,0,0,${sky.dither}) 0 1px, transparent 1px 3px)`,
        }}
      />
    </div>
  )
}

/**
 * The original venue: a stone court, a tree line and a shrine, all boxes in
 * fog. Nothing here is closer than the fog's near plane, so all of it reads
 * as depth rather than as geometry — exactly the era's set dressing budget.
 */
function ForestCourt({
  sky,
  fogNear,
  fogFar,
}: {
  readonly sky: StageSky
  readonly fogNear: number
  readonly fogFar: number
}): React.ReactElement {
  const fogColor = sky.mid
  const materials = useMemo(() => {
    const fog = { fogColor, fogNear, fogFar }
    return {
      floor: createPs1Material({
        color: '#ffffff',
        map: makeStoneTexture(),
        ...fog,
        // Tile every ~2.2 world units, in world space — the plane's own UVs
        // would stretch one page across the whole court.
        worldUvScale: 1 / 2.2,
      }),
      trunk: createPs1Material({ color: '#233521', ...fog }),
      canopy: createPs1Material({ color: '#1a2c1a', ...fog }),
      shrine: createPs1Material({ color: '#4a3a2a', ...fog }),
    }
  }, [fogColor, fogNear, fogFar])
  const { floor, trunk, canopy, shrine } = materials

  useEffect(
    () => () => {
      for (const material of Object.values(materials)) material.dispose()
    },
    [materials],
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
      <mesh material={floor} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[ARENA_FLOOR_SIZE, ARENA_FLOOR_SIZE]} />
      </mesh>

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
/** How far toward the camera a spark sits, so it draws over the bodies. */
const SPARK_FORWARD = 0.3

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

function HitSparks({
  sim,
  floorAt,
}: {
  readonly sim: ReturnType<typeof useFightSim>
  readonly floorAt: (x: number) => number
}): React.ReactElement {
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
      // Ring units, inside the scaled group with the fighters.
      sprite.position.set(spark.x, spark.y + floorAt(spark.x), SPARK_FORWARD)
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

/**
 * The genre's camera: side-on, dollying with the gap, pushing in on a KO.
 * Rides the stage's floor, so a bout on a raised court is framed at the
 * same waist height as one in the sand. Works in fighter units and
 * multiplies out to the world at the end, so the framing is the venue's
 * fighterScale away from the fighters whatever the venue.
 */
function FightCamera({ sim }: { readonly sim: ReturnType<typeof useFightSim> }): null {
  useFrame(({ camera }, delta) => {
    const state = sim.state.current
    const fighters = state.fighters
    const [left, right] = fighters ?? [null, null]
    const scale = state.stage.fighterScale
    const midX = left && right ? (left.x + right.x) / 2 : 0
    const gap = left && right ? Math.abs(right.x - left.x) : STANCE_X * 2
    // The world floor under the pair, in world units.
    const floor = stageFloorAt(state.stage.line, midX * scale)

    const dramatic = state.phase === 'ko' || state.phase === 'victory'
    const venue = state.stage.camera
    const targetDistance =
      (dramatic ? KO_DISTANCE : CAMERA_DISTANCE_BASE + Math.max(0, gap - CAMERA_GAP_REST) * CAMERA_DISTANCE_PER_GAP) *
      venue.distance
    const targetHeight = dramatic ? KO_HEIGHT : CAMERA_HEIGHT
    // During the intro the camera swings around the pair — the walk-on shot.
    const introSwing =
      state.phase === 'intro' ? Math.sin((1 - state.phaseT / INTRO_SWING_S) * 1.2) * INTRO_SWING : 0

    const ease = Math.min(1, delta * CAMERA_EASE)
    camera.position.x += ((midX + introSwing) * scale - camera.position.x) * ease
    camera.position.y += (floor + targetHeight * scale - camera.position.y) * ease
    camera.position.z += (venue.ringZ + targetDistance * scale - camera.position.z) * ease
    camera.lookAt(midX * scale, floor + CAMERA_LOOK_HEIGHT * scale, venue.ringZ)
    if (camera instanceof THREE.PerspectiveCamera) {
      const fov = CAMERA_FOV * venue.fov
      if (Math.abs(camera.fov - fov) > 0.01) {
        camera.fov = fov
        camera.updateProjectionMatrix()
      }
    }
  })
  return null
}

/** Same contract as the race's: survive context loss, release on unmount. */

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
