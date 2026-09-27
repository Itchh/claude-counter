'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import { useCachedQuery } from '@/lib/useCachedQuery'
import * as THREE from 'three'
import { ContextGuard } from '../../ps1/ContextGuard'
import { api } from '../../../../convex/_generated/api'
import { configurePs1Texture, createPs1Material, setJitterAspect } from '../race/Ps1Material'
import type { RacerState } from '../race/types'
import { Plane, makeSmokeTexture } from './Plane'
import { Gunfire } from './Gunfire'
import { Landscape } from './Landscape'
import { HangarLayer, type HangarPilot } from './Hangar'
import { airframeOf } from './airframes'
import { Airframe, preloadAirframes, type SpinBox } from './Airframe'
import { Flipbook, getExplosionSheet } from '../../ps1/flipbook'
import { DogfightHud, Gunsight, type DogfightHudSnapshot, type HudSubject } from './DogfightHud'
import {
  SKYBOX,
  THEATRE_FOG_FAR,
  THEATRE_INTERNAL_HEIGHT,
  THEATRE_SKY,
} from './theatre'
import { CRASH_SETTLE_S, useDogfightSim, WRECK_LIFE_S, type SimPlane, type WreckRecord } from './useDogfightSim'
import { FONTS, GT, PS1, PS1_TYPE } from '../../ps1/theme'
import type { DogfightChannelProps } from './DogfightChannel'
import { useMe } from '../../control/useMe'
import { useDrive } from '../../control/useDrive'
import { ControlOverlay, type RemoteDriver } from '../../control/ControlOverlay'
import { isRemoteLive, type DogfightPose } from '../../control/types'
import { fillRoster } from '@/lib/cpuRoster'

// CH 03: the dogfight. A squadron of teammates wheeling over the fields of
// Kent — airframe from the day's score, throttle and gunnery from the live
// burn, deadeye criticals to keep the sky honest. See useDogfightSim for the
// rules; this file is the theatre, the camera and the wiring.

const HUD_REFRESH_MS = 250
/** Kills this close together count as one multikill. */
const MULTIKILL_WINDOW_MS = 8000
/** Bursts this close together count as one combo. */
const COMBO_GAP_MS = 1600
/**
 * The smallest patrol the channel will fly. A thinner roster is padded with
 * CPU pilots from lib/cpuRoster — browser-only bots that never reach Convex.
 */
const MIN_DOGFIGHT_FIELD = 4

// Every type warmed as soon as the module loads, so the first scramble is
// not eight planes popping in one by one as their models arrive.
preloadAirframes()

/** The wide shot: a slow orbit of the whole box. */
const WIDE_ORBIT_RADIUS = 34
const WIDE_ORBIT_HEIGHT = 15
const WIDE_ORBIT_RATE = 0.045
/** The chase: behind and above the star of the moment. */
const CHASE_BACK = 6.5
const CHASE_UP = 1.8
/**
 * The fall: the same chase, stood off a little and lifted, so the ground
 * coming up is in the frame with the plane rather than under it.
 */
const FALL_BACK = 8.5
const FALL_UP = 3.2
/** The settle: a slow drift round the impact, the way a replay camera sits. */
const SETTLE_RADIUS = 9
const SETTLE_HEIGHT = 4
const SETTLE_DRIFT_RATE = 0.22
/** The eye rises off the wreck with the smoke over the settle. */
const SETTLE_LOOK_RISE = 1.4

export function DogfightScene({ isLive, paused = false }: DogfightChannelProps): React.ReactElement {
  // Whose hangar is open, if anyone's. Held here rather than in the HUD so
  // the window can stop the simulation: the patrol and the window are
  // siblings, and only their parent can hold one for the other — the same
  // arrangement as the race and its paint shop.
  const [hangarKey, setHangarKey] = useState<string | null>(null)
  const sightRef = useRef<HTMLDivElement>(null)
  // Whose tail the camera is on, chosen from the roster by click or by the
  // number keys — the race's "ride with a driver", for the squadron. The
  // same pick again hands the camera back to the director.
  const [followKey, setFollowKey] = useState<string | null>(null)
  const toggleFollow = useCallback((pilotKey: string): void => {
    setFollowKey((current) => (current === pilotKey ? null : pilotKey))
  }, [])
  const running = isLive && !paused && hangarKey === null

  // Today's grid, and the month's behind it: a grid that waits for someone
  // to burn tokens today is empty most mornings, and an empty grid shows
  // nobody the game. The day wins whenever it has a field; the month is
  // the attract mode.
  const today = useCachedQuery('race:day', api.scoring.getRace, { period: 'day' })
  const todayHasField = today !== undefined && today.racers.length >= 2
  const month = useCachedQuery('race:month', api.scoring.getRace, todayHasField ? 'skip' : { period: 'month' })
  const race = todayHasField ? today : (month ?? today)
  // The patrol as flown: the real roster, padded with CPU pilots once the
  // query has resolved. Not before — bots that scramble and then land as the
  // real field loads read as a glitch, not a game.
  const roster = useMemo(
    () => (race === undefined ? undefined : fillRoster(race.racers, MIN_DOGFIGHT_FIELD)),
    [race],
  )
  const me = useMe()
  const drive = useDrive<DogfightPose>('dogfight', me)
  const sim = useDogfightSim(roster, drive.link)

  // Development only: the live sim on the window, so a browser session can
  // read positions and headings straight off it instead of guessing from
  // stills. Never in production — nothing should be reachable from outside.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return
    const scope = globalThis as typeof globalThis & { dogfightSim?: typeof sim }
    scope.dogfightSim = sim
    return () => {
      delete scope.dogfightSim
    }
  }, [sim])

  // 1–9 ride with the pilot at that place in the roster, as the HUD lists
  // it. Bubble phase, after the cabinet's own capture handler; nothing is
  // done while a window is up or a field has the keys.
  useEffect(() => {
    if (!running) return
    const onKey = (event: KeyboardEvent): void => {
      if (!/^[1-9]$/.test(event.key) || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return
      const ranked = [...sim.planes.current].sort((a, b) => a.rank - b.rank)
      const pick = ranked[Number(event.key) - 1]
      if (!pick) return
      event.preventDefault()
      toggleFollow(pick.key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, sim, toggleFollow])
  const [contextEpoch, setContextEpoch] = useState(0)
  const [hud, setHud] = useState<DogfightHudSnapshot | null>(null)

  // The roster by key, for whoever needs a pilot's record at frame rate —
  // the gunfire asking which airframe carries which guns.
  const pilotsByKey = useMemo(() => {
    const byKey = new Map<string, RacerState>()
    for (const racer of roster ?? []) byKey.set(racer.key, racer)
    return byKey
  }, [roster])
  const getPilot = useCallback(
    (key: string): RacerState | null => pilotsByKey.get(key) ?? null,
    [pilotsByKey],
  )

  // The pilot the hangar is for, resolved from the live query rather than
  // copied into state — markings saved there come back through the same
  // subscription, so the window redraws from the record it just wrote.
  const hangarPilot = useMemo<HangarPilot | null>(() => {
    if (hangarKey === null) return null
    const racer = pilotsByKey.get(hangarKey)
    if (!racer) return null
    return {
      key: racer.key,
      name: racer.name,
      index: airframeOf(racer.key, racer.airframe),
      // Coalesced, not passed through: until the backend carrying these
      // fields is deployed the query returns them absent, and absent has to
      // read as "never opened the hangar" rather than as a paint.
      airframe: racer.airframe ?? null,
      color: racer.color ?? PS1.cyan,
      paint: racer.planePaint ?? null,
      livery: racer.planeLivery ?? null,
      score: racer.score,
      velocity: racer.velocityTokensPerMin,
    }
  }, [hangarKey, pilotsByKey])
  const closeHangar = useCallback((): void => setHangarKey(null), [])
  // Only your own plane opens: setPlaneLivery writes to whoever is signed
  // in, so a hangar opened on someone else's would repaint yours.
  const myKey = me?.key ?? null
  const openHangar = useCallback(
    (pilotKey: string): void => {
      if (myKey !== null && pilotKey === myKey) setHangarKey(pilotKey)
    },
    [myKey],
  )
  const canDrive = me !== null && me !== undefined && (race?.racers.some((racer) => racer.key === me.key) ?? false)
  const [remoteDrivers, setRemoteDrivers] = useState<ReadonlyArray<RemoteDriver>>([])
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => {
      const now = Date.now()
      const drivers: RemoteDriver[] = []
      for (const [racerKey, remote] of drive.link.remotes) {
        if (!isRemoteLive(remote, now)) continue
        const racer = roster?.find((candidate) => candidate.key === racerKey)
        drivers.push({ racerKey, name: racer?.name ?? racerKey, holderName: remote.holderName })
      }
      setRemoteDrivers((current) =>
        current.length === drivers.length && current.every((d, i) => d.racerKey === drivers[i].racerKey)
          ? current
          : drivers,
      )
    }, HUD_REFRESH_MS)
    return () => clearInterval(id)
  }, [running, drive.link, roster])

  // The score block's bookkeeping, sampled with the HUD rather than kept in
  // the sim: kill timestamps per pilot for the multikill, and the run of
  // bursts per pilot for the combo. Presentation, so it lives with the
  // presentation.
  const killLog = useRef(new Map<string, { count: number; times: number[] }>())
  const comboLog = useRef(new Map<string, { combo: number; lastAt: number; crit: boolean }>())
  const lastTracerSeen = useRef(0)

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => {
      const now = Date.now()
      const star = sim.star.current
      const drivenKey = drive.driving ? (me?.key ?? null) : null
      const starPlane =
        star && now < star.until
          ? (sim.planes.current.find((plane) => plane.key === star.key) ?? null)
          : null

      for (const plane of sim.planes.current) {
        const log = killLog.current.get(plane.key) ?? { count: plane.kills, times: [] }
        if (plane.kills > log.count) log.times.push(now)
        log.count = plane.kills
        log.times = log.times.filter((at) => now - at < MULTIKILL_WINDOW_MS)
        killLog.current.set(plane.key, log)
      }
      for (const tracer of sim.tracers.current) {
        if (tracer.id <= lastTracerSeen.current) continue
        lastTracerSeen.current = tracer.id
        const run = comboLog.current.get(tracer.attackerKey) ?? { combo: 0, lastAt: 0, crit: false }
        run.combo = tracer.at - run.lastAt < COMBO_GAP_MS ? run.combo + 1 : 1
        run.lastAt = tracer.at
        run.crit = tracer.crit
        comboLog.current.set(tracer.attackerKey, run)
      }

      // Whose numbers the block shows: the piloted plane if someone is
      // flying, else the camera's subject, else the leader — the block is
      // never blank while anyone is up.
      const focus =
        (drivenKey !== null ? sim.planes.current.find((plane) => plane.key === drivenKey) : undefined) ??
        (followKey !== null ? sim.planes.current.find((plane) => plane.key === followKey) : undefined) ??
        starPlane ??
        [...sim.planes.current].sort((a, b) => a.rank - b.rank)[0] ??
        null
      const subject: HudSubject | null = focus
        ? {
            key: focus.key,
            name: focus.name,
            rank: focus.rank,
            score: focus.score,
            hpFrac: focus.hp / focus.maxHp,
            kills: focus.kills,
            mode: focus.mode,
            speed: focus.speed,
            altitude: focus.y,
            multikill: killLog.current.get(focus.key)?.times.length ?? 0,
            lastKillAt: killLog.current.get(focus.key)?.times.at(-1) ?? 0,
            combo: comboLog.current.get(focus.key)?.combo ?? 0,
            lastHitAt: comboLog.current.get(focus.key)?.lastAt ?? 0,
            lastHitCrit: comboLog.current.get(focus.key)?.crit ?? false,
          }
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
        subject,
      })
    }, HUD_REFRESH_MS)
    return () => clearInterval(id)
  }, [running, sim, drive.driving, me, followKey])

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
        <ContextGuard label="Dogfight" onRestored={() => setContextEpoch((epoch) => epoch + 1)} />
        <DriveTicker drive={drive} sim={sim} isLive={running} />
        <SimDriver sim={sim} isLive={running} />
        <ResolutionLock height={THEATRE_INTERNAL_HEIGHT} />
        <PatrolCamera sim={sim} drivenKey={drive.driving ? (me?.key ?? null) : null} followKey={followKey} />
        <TargetSight sim={sim} drivenKey={drive.driving ? (me?.key ?? null) : null} followKey={followKey} element={sightRef} />

        <SkyDome />
        <Landscape />

        {/* One plane per pilot on the roster, keyed by the pilot: the
            identity is React's, the flying is the sim's. */}
        {(roster ?? []).map((racer) => (
          <Plane
            key={racer.key}
            pilot={racer}
            getPlane={() => sim.planes.current.find((plane) => plane.key === racer.key) ?? null}
          />
        ))}

        <Gunfire sim={sim} getPilot={getPilot} />
        <Blasts sim={sim} />
        <CrashFx sim={sim} />
        <Wrecks sim={sim} getPilot={getPilot} />
      </Canvas>

      {/* The gunsight, placed by TargetSight every frame over the subject's
          quarry. Hidden until there is one; a sight with nothing under it is
          a question mark on the screen. */}
      <div
        ref={sightRef}
        aria-hidden
        style={{ position: 'absolute', left: 0, top: 0, zIndex: 3, pointerEvents: 'none', display: 'none', transform: 'translate(-50%, -50%)' }}
      >
        <Gunsight />
        <span
          className="gt-label"
          data-sight-name
          style={{ display: 'block', textAlign: 'center', marginTop: '2px', fontFamily: FONTS.hud, fontSize: `${PS1_TYPE.micro}px`, color: GT.label, letterSpacing: '0.1em', textShadow: '1px 1px 0 #000' }}
        />
      </div>
      <DogfightHud snapshot={hud} paused={paused || hangarKey !== null} onOpenHangar={openHangar} followKey={followKey} onFollow={toggleFollow} myKey={me?.key ?? null} />
      <HangarLayer pilot={hangarPilot} onClose={closeHangar} />

      <ControlOverlay
        game="dogfight"
        me={me}
        canDrive={canDrive && running}
        driving={drive.driving}
        taking={drive.taking}
        error={drive.error}
        onTake={() => void drive.take()}
        onRelease={() => void drive.release()}
        nitro={null}
        remoteDrivers={remoteDrivers}
        record={null}
      />
    </div>
  )
}

// --- Theatre -----------------------------------------------------------------

/**
 * The painted sky behind the canvas. The dome covers it once the skybox has
 * streamed in; until then, and on the frame the context is lost, this is
 * what shows through the transparent canvas rather than the void.
 */
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
 * The sky and its clouds: a downloaded skybox cut to a console page (see
 * scripts/bakeSkybox.mjs), hung on the camera so it never gets nearer, and
 * drawn first with no depth so everything else paints over it. Unlit and
 * unfogged — it is the light and the fog. The era's other sky was a fixed
 * backdrop; this one at least turns with the camera.
 */
function SkyDome(): React.ReactElement {
  const { scene } = useGLTF(SKYBOX.modelUrl)
  const groupRef = useRef<THREE.Group>(null)

  const surface = useMemo(() => {
    let geometry: THREE.BufferGeometry | null = null
    let map: THREE.Texture | null = null
    scene.traverse((child) => {
      if (geometry !== null || !(child instanceof THREE.Mesh)) return
      geometry = child.geometry
      const source = Array.isArray(child.material) ? child.material[0] : child.material
      if (source instanceof THREE.MeshStandardMaterial) map = source.map
    })
    return { geometry, map }
  }, [scene])

  const material = useMemo(() => {
    const built = createPs1Material({
      color: '#ffffff',
      map: surface.map ? configurePs1Texture(surface.map) : undefined,
      tint: 0,
      // Full ambient is no lighting at all; the fog is pushed past anything
      // the cube can reach.
      ambient: 1,
      fogColor: THEATRE_SKY.mid,
      fogNear: SKYBOX.radius * 100,
      fogFar: SKYBOX.radius * 200,
      side: THREE.DoubleSide,
    })
    built.depthWrite = false
    built.depthTest = false
    // Twelve triangles the size of the screen: the affine warp the other
    // surfaces wear would bend the clouds into a fold across the middle of
    // every face. The era subdivided its skies to hide exactly this; a
    // perspective-correct read on a cube this coarse is cheaper and reads
    // the same. Own uniform, so the circuits' shared dial is untouched.
    built.uniforms.uAffine = { value: 0 }
    return built
  }, [surface.map])

  useEffect(() => () => material.dispose(), [material])

  useFrame(({ camera }) => {
    groupRef.current?.position.copy(camera.position)
  })

  if (!surface.geometry) return <group />

  return (
    <group ref={groupRef} scale={SKYBOX.radius} renderOrder={-1}>
      <mesh geometry={surface.geometry} material={material} renderOrder={-1} frustumCulled={false} />
    </group>
  )
}

useGLTF.preload(SKYBOX.modelUrl)

// --- FX ----------------------------------------------------------------------

const BLAST_LIFE_MS = 300
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

/** The hit: a starburst on the airframe where a burst lands. The crash is CrashFx's. */
function Blasts({ sim }: { readonly sim: ReturnType<typeof useDogfightSim> }): React.ReactElement {
  const sprites = useRef<Array<THREE.Sprite | null>>([])
  const materials = useMemo(
    () =>
      Array.from(
        { length: BLAST_POOL },
        () =>
          new THREE.SpriteMaterial({
            map: makeBlastTexture('#ffd24d'),
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            transparent: true,
          }),
      ),
    [],
  )
  useEffect(
    () => () => {
      for (const material of materials) {
        material.map?.dispose()
        material.dispose()
      }
    },
    [materials],
  )

  useFrame(() => {
    const now = Date.now()
    const live = sim.blasts.current.filter((blast) => now - blast.at < BLAST_LIFE_MS)
    for (let i = 0; i < BLAST_POOL; i++) {
      const sprite = sprites.current[i]
      if (!sprite) continue
      const blast = live[i]
      if (!blast) {
        sprite.visible = false
        continue
      }
      const age = (now - blast.at) / BLAST_LIFE_MS
      sprite.visible = true
      sprite.position.set(blast.x, blast.y, blast.z)
      sprite.scale.setScalar(0.6 + age * 1.6)
      materials[i].opacity = 1 - age
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
          material={materials[index]}
        />
      ))}
    </group>
  )
}

// --- The crash ---------------------------------------------------------------

/**
 * World size of the explosion book at impact. The planes are 2.2 long; the
 * fireball has to read as bigger than the thing that made it.
 */
const EXPLOSION_SIZE = 7
/**
 * A second book over the first, larger and a beat later. The sheet has no
 * smoke-only read, so scale comes from layering: the late book's fireball
 * blooms out of the first one's smoke, and the two together read as one
 * event with depth rather than one sprite.
 */
const EXPLOSION_ECHO_SCALE = 1.4
const EXPLOSION_ECHO_DELAY_S = 0.15
/** Two books a crash, two crashes at once. */
const EXPLOSION_POOL = 4
/**
 * The sheet paints its fireball below centre (baseY is at 0.68 of the
 * frame) with the smoke above; lifting the sprite by this fraction of its
 * size sits the fire on the ground and the smoke over it.
 */
const EXPLOSION_LIFT = 0.18

interface QueuedExplosion {
  readonly position: THREE.Vector3
  readonly size: number
  delay: number
}

/**
 * The impact, from the shared flipbook: every crash in the cabinet is the
 * same drawing. Triggered off the sim's wreck records, so the fire, the
 * wreck and the camera's settle all happen at the one place.
 */
function CrashFx({ sim }: { readonly sim: ReturnType<typeof useDogfightSim> }): React.ReactElement {
  const books = useMemo(
    () =>
      Array.from({ length: EXPLOSION_POOL }, () => {
        const book = new Flipbook(getExplosionSheet(), EXPLOSION_SIZE)
        // A sprite at the edge of the frame is exactly where a crash tends
        // to be; the culler's bounds for a scaled sprite are not to be trusted.
        book.sprite.frustumCulled = false
        return book
      }),
    [],
  )
  useEffect(
    () => () => {
      for (const book of books) book.dispose()
    },
    [books],
  )
  const seenWreck = useRef(0)
  const queue = useRef<QueuedExplosion[]>([])

  useFrame((_, delta) => {
    for (const wreck of sim.wrecks.current) {
      if (wreck.id <= seenWreck.current) continue
      seenWreck.current = wreck.id
      queue.current.push(
        {
          position: new THREE.Vector3(wreck.x, wreck.y + EXPLOSION_SIZE * EXPLOSION_LIFT, wreck.z),
          size: EXPLOSION_SIZE,
          delay: 0,
        },
        {
          position: new THREE.Vector3(
            wreck.x,
            wreck.y + EXPLOSION_SIZE * EXPLOSION_ECHO_SCALE * EXPLOSION_LIFT,
            wreck.z,
          ),
          size: EXPLOSION_SIZE * EXPLOSION_ECHO_SCALE,
          delay: EXPLOSION_ECHO_DELAY_S,
        },
      )
    }

    for (const book of books) book.update(delta)

    // Books whose beat has come take the first idle sprite. Nothing idle
    // means three crashes in one second; the fourth waits a frame or two,
    // which nobody will see.
    const waiting: QueuedExplosion[] = []
    for (const queued of queue.current) {
      queued.delay -= delta
      if (queued.delay > 0) {
        waiting.push(queued)
        continue
      }
      const idle = books.find((book) => !book.isPlaying)
      if (!idle) {
        waiting.push(queued)
        continue
      }
      idle.play(queued.position)
      idle.sprite.scale.setScalar(queued.size)
    }
    queue.current = waiting
  })

  return (
    <group>
      {books.map((book, index) => (
        // Keyed by pool slot: the books are made once and never reorder.
        <primitive key={index} object={book.sprite} />
      ))}
    </group>
  )
}

// --- The wreck ---------------------------------------------------------------

/**
 * How many wrecks lie on the fields at once. A fourth inside eight seconds
 * takes the oldest one's place; the sky does not often manage that.
 */
const WRECK_POOL = 3
/** Crushed flat: the fuselage on its belly, wings spread. */
const WRECK_FLATTEN = 0.35
/** Nose into the turf, one wing dug in. Radians. */
const WRECK_PITCH = 0.14
const WRECK_ROLL = 0.22
/** How deep the belly sits below the crash altitude. */
const WRECK_SINK = 0.3
/** Seconds over which the ground takes the wreck at the end of its life. */
const WRECK_FADE_S = 1.2
/** Charred: the paint gone, the page dark, lit by almost nothing. */
const WRECK_CHAR = '#1a1816'
const WRECK_AMBIENT = 0.35
/** An airscrew that will not turn again. */
const WRECK_SPIN_RATE = 0

/** The trickle: fewer, slower, bigger puffs than the fall's. */
const WRECK_SMOKE_POOL = 5
const WRECK_SMOKE_LIFE_MS = 2200
const WRECK_SMOKE_INTERVAL_S = 0.5
const WRECK_SMOKE_RISE = 1.8
const WRECK_SMOKE_SCALE = 0.7
const WRECK_SMOKE_GROWTH = 1.4

interface WreckSlot {
  readonly wreck: WreckRecord
  /** The type, read off the pilot's record when the plane went in. */
  readonly airframe: number
}

/**
 * Whatever is left. Each wreck is the plane's own model — same type, drawn
 * by the same Airframe — crushed flat and charred, with a trickle of smoke
 * off it, left where it fell for WRECK_LIFE_S and then let into the ground.
 * A pool of slots rather than one per plane: a wreck is rare and brief, and
 * eight spare airframes waiting for one is a lot of geometry for nothing.
 */
function Wrecks({
  sim,
  getPilot,
}: {
  readonly sim: ReturnType<typeof useDogfightSim>
  readonly getPilot: (key: string) => RacerState | null
}): React.ReactElement {
  const [slots, setSlots] = useState<ReadonlyArray<WreckSlot | null>>(() =>
    Array.from({ length: WRECK_POOL }, () => null),
  )
  const seenWreck = useRef(0)

  // A wreck is a React event, not a frame one: the model has to mount. The
  // frame loop only notices the new record; the slot is chosen here.
  useFrame(() => {
    const now = Date.now()
    for (const wreck of sim.wrecks.current) {
      if (wreck.id <= seenWreck.current) continue
      seenWreck.current = wreck.id
      const pilot = getPilot(wreck.key)
      const slot: WreckSlot = { wreck, airframe: airframeOf(wreck.key, pilot?.airframe) }
      setSlots((current) => {
        const next = [...current]
        const free = next.findIndex(
          (candidate) => candidate === null || now - candidate.wreck.at > WRECK_LIFE_S * 1000,
        )
        if (free >= 0) {
          next[free] = slot
          return next
        }
        // Every slot is still burning: the oldest gives way.
        let oldest = 0
        for (let index = 1; index < next.length; index++) {
          if ((next[index]?.wreck.at ?? 0) < (next[oldest]?.wreck.at ?? 0)) oldest = index
        }
        next[oldest] = slot
        return next
      })
    }
  })

  return (
    <group>
      {slots.map((slot, index) =>
        slot ? <Wreck key={slot.wreck.id} slot={slot} /> : <group key={`empty-${index}`} />,
      )}
    </group>
  )
}

interface WreckPuff {
  bornAt: number
  x: number
  y: number
  z: number
}

function Wreck({ slot }: { readonly slot: WreckSlot }): React.ReactElement {
  const root = useRef<THREE.Group>(null)
  const spinBox = useMemo<SpinBox>(() => ({ rate: WRECK_SPIN_RATE }), [])
  const charred = useRef(false)
  const smokeSprites = useRef<Array<THREE.Sprite | null>>([])
  const puffs = useRef<WreckPuff[]>(
    Array.from({ length: WRECK_SMOKE_POOL }, () => ({ bornAt: 0, x: 0, y: 0, z: 0 })),
  )
  const nextPuff = useRef(0)
  const sinceDrop = useRef(WRECK_SMOKE_INTERVAL_S)
  const smokeMaterials = useMemo(() => {
    const map = makeSmokeTexture()
    return Array.from(
      { length: WRECK_SMOKE_POOL },
      () => new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false }),
    )
  }, [])
  useEffect(
    () => () => {
      smokeMaterials[0]?.map?.dispose()
      for (const material of smokeMaterials) material.dispose()
    },
    [smokeMaterials],
  )

  useFrame((_, delta) => {
    const group = root.current
    if (!group) return
    const now = Date.now()
    const age = (now - slot.wreck.at) / 1000
    const remaining = WRECK_LIFE_S - age
    const gone = remaining <= 0
    group.visible = !gone

    if (!gone) {
      // Charring is done here rather than on mount because the model
      // arrives through Suspense: the first frame it has materials is the
      // first frame it can be darkened. Airframe owns the materials and
      // writes the paint uniforms itself; the char is written over them.
      if (!charred.current) {
        let found = false
        group.traverse((child) => {
          if (!(child instanceof THREE.Mesh) || !(child.material instanceof THREE.ShaderMaterial)) return
          found = true
          const { uColor, uTint, uEmissive, uAmbient, uPaintMix, uLivery } = child.material.uniforms
          if (uColor) (uColor.value as THREE.Color).set(WRECK_CHAR)
          if (uTint) uTint.value = 1
          if (uEmissive) uEmissive.value = 0
          if (uAmbient) uAmbient.value = WRECK_AMBIENT
          if (uPaintMix) uPaintMix.value = 0
          if (uLivery) uLivery.value = 0
        })
        charred.current = found
      }

      // Into the ground over the last second of its life.
      const fade = remaining < WRECK_FADE_S ? 1 - remaining / WRECK_FADE_S : 0
      group.position.set(slot.wreck.x, slot.wreck.y - WRECK_SINK - fade * 1.2, slot.wreck.z)
      group.rotation.order = 'YXZ'
      group.rotation.y = slot.wreck.heading
      group.rotation.x = WRECK_PITCH
      group.rotation.z = WRECK_ROLL
      group.scale.set(1, WRECK_FLATTEN, 1)

      // The trickle, until the ground starts taking it.
      if (fade === 0) {
        sinceDrop.current += delta
        if (sinceDrop.current >= WRECK_SMOKE_INTERVAL_S) {
          sinceDrop.current = 0
          const puff = puffs.current[nextPuff.current]
          puff.bornAt = now
          puff.x = slot.wreck.x
          puff.y = slot.wreck.y + 0.3
          puff.z = slot.wreck.z
          nextPuff.current = (nextPuff.current + 1) % WRECK_SMOKE_POOL
        }
      }
    }

    for (let i = 0; i < WRECK_SMOKE_POOL; i++) {
      const sprite = smokeSprites.current[i]
      if (!sprite) continue
      const puff = puffs.current[i]
      const puffAge = now - puff.bornAt
      if (puff.bornAt === 0 || puffAge > WRECK_SMOKE_LIFE_MS) {
        sprite.visible = false
        continue
      }
      const life = puffAge / WRECK_SMOKE_LIFE_MS
      sprite.visible = true
      sprite.position.set(puff.x, puff.y + life * WRECK_SMOKE_RISE, puff.z)
      sprite.scale.setScalar(WRECK_SMOKE_SCALE + life * WRECK_SMOKE_GROWTH)
      smokeMaterials[i].opacity = 1 - life
    }
  })

  return (
    <>
      <group ref={root} visible={false}>
        <Suspense fallback={null}>
          {/* Bare: no paint, no markings — it is about to be charred over. */}
          <Airframe index={slot.airframe} color={WRECK_CHAR} paint={null} livery={null} spinBox={spinBox} />
        </Suspense>
      </group>
      <group>
        {Array.from({ length: WRECK_SMOKE_POOL }, (_, index) => (
          <sprite
            key={index}
            ref={(sprite) => {
              smokeSprites.current[index] = sprite
            }}
            visible={false}
            material={smokeMaterials[index]}
          />
        ))}
      </group>
    </>
  )
}

// --- Wiring ------------------------------------------------------------------

/** Polls the pad and publishes the piloted plane's pose. */
function DriveTicker({
  drive,
  sim,
  isLive,
}: {
  readonly drive: ReturnType<typeof useDrive<DogfightPose>>
  readonly sim: ReturnType<typeof useDogfightSim>
  readonly isLive: boolean
}): null {
  useFrame((_, delta) => {
    if (!isLive) return
    drive.tick(delta, () => {
      const key = drive.link.drivenKey
      const plane = key ? sim.planes.current.find((candidate) => candidate.key === key) : undefined
      if (!plane) return null
      return {
        game: 'dogfight',
        x: plane.x,
        y: plane.y,
        z: plane.z,
        heading: plane.heading,
        pitch: plane.pitch,
        bank: plane.bank,
        speed: plane.speed,
        mode: plane.mode,
        hp: plane.hp,
        kills: plane.kills,
        firing: drive.link.input.fire,
      }
    })
  })
  return null
}

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

/** The crash shot, once the camera's subject has been hit. */
interface CrashShot {
  readonly key: string
  /** Following the plane down, or settled on where it went in. */
  phase: 'fall' | 'settle'
  /** The last place the plane was seen; becomes the impact point. */
  readonly spot: THREE.Vector3
  /** Seconds into the settle, and where round the spot the eye stands. */
  settleT: number
  drift: number
}

/**
 * Two shots and a blend: a slow wide orbit of the whole patrol, and a chase
 * of whoever the simulation has flagged as the moment — an attacker on a
 * tail, or a plane going down.
 *
 * And the third, which is the one worth watching. When the subject is hit
 * the camera stays with it — not the star's few seconds but the whole fall,
 * stood off and lifted so the fields come up into the frame — and when the
 * plane is in it settles on the spot for CRASH_SETTLE_S, drifting slowly
 * round the smoke the way a replay camera sits on a wreck, before the
 * director has it back. The shot is never cut mid-fall: the star may lapse,
 * the sky may produce a fresh chase, and the eye stays on the plane until
 * it has hit the ground. Only a pilot taking the stick, or a viewer picking
 * a different tail, overrides it — those are people, not the director.
 */
function PatrolCamera({
  sim,
  drivenKey,
  followKey,
}: {
  readonly sim: ReturnType<typeof useDogfightSim>
  /** A piloted plane owns the camera for as long as it is piloted. */
  readonly drivenKey: string | null
  /** A pilot picked from the roster; the camera takes their tail. */
  readonly followKey: string | null
}): null {
  const orbitAngle = useRef(0)
  const desired = useMemo(() => new THREE.Vector3(), [])
  const look = useMemo(() => new THREE.Vector3(), [])
  const crash = useRef<CrashShot | null>(null)

  useFrame(({ camera }, delta) => {
    orbitAngle.current += WIDE_ORBIT_RATE * delta

    const star = sim.star.current
    const piloted =
      drivenKey !== null
        ? (sim.planes.current.find((plane) => plane.key === drivenKey && plane.mode !== 'respawn') ?? null)
        : null
    const followed =
      followKey !== null
        ? (sim.planes.current.find((plane) => plane.key === followKey && plane.mode !== 'respawn') ?? null)
        : null
    const directed =
      star && Date.now() < star.until
        ? (sim.planes.current.find(
            (plane) => plane.key === star.key && plane.mode !== 'respawn',
          ) ?? null)
        : null
    const subject: SimPlane | null = piloted ?? followed ?? directed

    // A person's choice ends the crash shot; nothing else does.
    const chosen = piloted ?? followed
    if (crash.current && chosen && chosen.key !== crash.current.key) crash.current = null

    if (!crash.current && subject && subject.mode === 'down') {
      crash.current = {
        key: subject.key,
        phase: 'fall',
        spot: new THREE.Vector3(subject.x, subject.y, subject.z),
        settleT: 0,
        drift: Math.atan2(camera.position.z - subject.z, camera.position.x - subject.x),
      }
    }

    const shot = crash.current
    if (shot) {
      const falling = sim.planes.current.find((plane) => plane.key === shot.key && plane.mode === 'down') ?? null
      if (shot.phase === 'fall' && falling) {
        shot.spot.set(falling.x, falling.y, falling.z)
        desired.set(
          falling.x - Math.sin(falling.heading) * FALL_BACK,
          Math.max(2.2, falling.y + FALL_UP),
          falling.z - Math.cos(falling.heading) * FALL_BACK,
        )
        look.copy(shot.spot)
      } else {
        if (shot.phase === 'fall') {
          // The plane is in. The eye keeps standing where it was — the
          // drift picks up from the camera's own bearing, so there is no
          // swing at the moment of impact.
          shot.phase = 'settle'
          shot.drift = Math.atan2(camera.position.z - shot.spot.z, camera.position.x - shot.spot.x)
        }
        shot.settleT += delta
        shot.drift += SETTLE_DRIFT_RATE * delta
        desired.set(
          shot.spot.x + Math.cos(shot.drift) * SETTLE_RADIUS,
          shot.spot.y + SETTLE_HEIGHT,
          shot.spot.z + Math.sin(shot.drift) * SETTLE_RADIUS,
        )
        look.set(
          shot.spot.x,
          shot.spot.y + (shot.settleT / CRASH_SETTLE_S) * SETTLE_LOOK_RISE,
          shot.spot.z,
        )
        if (shot.settleT >= CRASH_SETTLE_S) crash.current = null
      }
    } else if (subject) {
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


/**
 * Pins the gunsight to the plane the subject is chasing. The subject is the
 * HUD's: the piloted plane, else the camera's star, else the leader. Their
 * quarry is projected through the camera every frame and the sight's DOM
 * node moved to it — imperatively, because a React state update per frame
 * is exactly the kind of cost the HUD's 250ms tick was chosen to avoid.
 * Off-screen or behind the lens, the sight is hidden rather than clamped
 * to the edge: an edge marker is a different instrument.
 */
function TargetSight({
  sim,
  drivenKey,
  followKey,
  element,
}: {
  readonly sim: ReturnType<typeof useDogfightSim>
  readonly drivenKey: string | null
  readonly followKey: string | null
  readonly element: React.RefObject<HTMLDivElement | null>
}): null {
  const projected = useMemo(() => new THREE.Vector3(), [])
  const shownFor = useRef<string | null>(null)

  useFrame(({ camera }) => {
    const node = element.current
    if (!node) return
    const planes = sim.planes.current
    const now = Date.now()
    const star = sim.star.current
    const subject =
      (drivenKey !== null ? planes.find((plane) => plane.key === drivenKey) : undefined) ??
      (followKey !== null ? planes.find((plane) => plane.key === followKey) : undefined) ??
      (star && now < star.until ? planes.find((plane) => plane.key === star.key) : undefined) ??
      [...planes].sort((a, b) => a.rank - b.rank)[0] ??
      null
    const quarry =
      subject && subject.mode === 'pursuit' && subject.targetKey !== null
        ? (planes.find((plane) => plane.key === subject.targetKey) ?? null)
        : null
    if (!quarry || quarry.mode === 'down' || quarry.mode === 'respawn') {
      if (node.style.display !== 'none') node.style.display = 'none'
      shownFor.current = null
      return
    }
    projected.set(quarry.x, quarry.y, quarry.z).project(camera)
    const onScreen = projected.z < 1 && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1
    if (!onScreen) {
      if (node.style.display !== 'none') node.style.display = 'none'
      return
    }
    node.style.display = 'block'
    node.style.left = `${((projected.x + 1) / 2) * 100}%`
    node.style.top = `${((1 - projected.y) / 2) * 100}%`
    if (shownFor.current !== quarry.key) {
      shownFor.current = quarry.key
      const label = node.querySelector<HTMLElement>('[data-sight-name]')
      if (label) label.textContent = quarry.name.toUpperCase()
    }
  })
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
