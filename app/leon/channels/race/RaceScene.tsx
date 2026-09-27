'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useMutation, useQuery } from 'convex/react'
import { useCachedQuery } from '@/lib/useCachedQuery'
import * as THREE from 'three'
import { ContextGuard } from '../../ps1/ContextGuard'
import { api } from '../../../../convex/_generated/api'
import { Track } from './Track'
import { Racer } from './Racer'
import { Scenery } from './Scenery'
import { CameraDirector, type ActiveShot } from './CameraDirector'
import {
  createCameraControlState,
  followRacer,
  releaseToAuto,
  CLICK_TRAVEL_PX,
  type CameraControlState,
} from './cameraControls'
import { RaceHud } from './RaceHud'
import { PaintShopLayer, type PaintShopDriver } from './PaintShop'
import { RacerFx } from './RacerFx'
import { SkidMarks } from './SkidMarks'
import { RaceAudio } from './RaceAudio'
import { chassisOf } from './cars'
import { ParkedCars } from './ParkedCars'
import { useRaceSim, type SimRacer } from './useRaceSim'
import { CircuitProvider, useCircuitFor } from './CircuitContext'
import { RACE_WINDOW_MS, TRACKS, trackForRaceWindow } from './tracks/registry'
import { setJitterAspect } from './Ps1Material'
import { PS1 } from '../../ps1/theme'
import { useInteractionSignal } from '../../ps1/navigation'
import type { RaceChannelProps } from './RaceChannel'
import { useMe } from '../../control/useMe'
import { useDrive } from '../../control/useDrive'
import { ControlOverlay, type RemoteDriver } from '../../control/ControlOverlay'
import { isRemoteLive, type GhostSample, type RacePose } from '../../control/types'
import { GhostCar } from './GhostCar'
import { formatLapMs } from '@/lib/eventText'
import { fillRoster, isCpuKey } from '@/lib/cpuRoster'

// CH 01. Karts driven by live burn rate, laps accumulating all day.
//
// Rendering is deliberately low resolution and scaled up by the browser — the
// pixel grid is half the aesthetic, and it also means eight karts and a full
// circuit cost almost nothing on an office TV. How low depends on which
// console the circuit belongs to: see RenderProfile.internalHeight. The
// earlier machine's 240 lines are right for a circuit 70 units across and
// unusable on one that is 450, where a kart on the far side lands on two
// pixels and the race becomes unreadable from the back of the room.

const HUD_REFRESH_MS = 500
/** The nitro bar and the driver chips read at this rate. Plenty. */
const CONTROL_REFRESH_MS = 200
/**
 * The smallest grid the channel will show. A thinner roster is padded with
 * CPU drivers from lib/cpuRoster — browser-only bots that never reach Convex.
 */
const MIN_RACE_FIELD = 4

export function RaceScene({ isLive, paused = false, audioOn = false }: RaceChannelProps): React.ReactElement {
  // Whose paint shop is open, if anyone's. Holding it here rather than in the
  // HUD is what lets the window stop the simulation: the race and the window
  // are siblings, and only their parent can pause one for the other.
  const [setupKey, setSetupKey] = useState<string | null>(null)
  // One flag for "the race should be moving". A window is open over it, so the
  // simulation, the effects and the sound stop together — stopping only some of
  // them is what makes a pause read as a bug.
  //
  // The camera director is deliberately NOT included. It owns where the camera
  // is, not what the cars are doing, and switching it off mid-shot drops the
  // frame it had composed and leaves the scene looking at the circuit from the
  // default position — a pause should freeze the picture, not throw it away.
  // A held camera on stopped cars is a still frame, which is the whole idea.
  // A paint shop window holds the race exactly as a cabinet window does. The
  // two reasons are the same reason: the picture behind an open window is
  // there to be read, not to move on without you.
  const running = isLive && !paused && setupKey === null
  // Today's grid, and the month's behind it: a grid that waits for someone
  // to burn tokens today is empty most mornings, and an empty grid shows
  // nobody the game. The day wins whenever it has a field; the month is
  // the attract mode.
  const today = useCachedQuery('race:day', api.scoring.getRace, { period: 'day' })
  const todayHasField = today !== undefined && today.racers.length >= 2
  const month = useCachedQuery('race:month', api.scoring.getRace, todayHasField ? 'skip' : { period: 'month' })
  const race = todayHasField ? today : (month ?? today)
  // The grid as drawn: the real roster, padded with CPU drivers once the
  // query has resolved. Not before — bots that appear and then vanish as the
  // real field loads read as a glitch, not a game.
  const roster = useMemo(
    () => (race === undefined ? undefined : fillRoster(race.racers, MIN_RACE_FIELD)),
    [race],
  )
  // Viewer camera input. Lives outside React entirely: pointer, wheel and key
  // events all land here, and the director reads it inside useFrame.
  const controls = useRef<CameraControlState>(createCameraControlState())
  const noteInteraction = useInteractionSignal()
  // Bumped when the GPU hands the context back, which remounts the Canvas and
  // rebuilds every buffer and program on the new one. See ContextGuard.
  const [contextEpoch, setContextEpoch] = useState(0)
  // The venue rotates on a fixed clock window — see trackForRaceWindow. The
  // clock ticks in a coarse state variable rather than being read during
  // render, so React sees the venue change as an ordinary state update and
  // the whole scene (circuit, fog, sky, model) swaps in one commit. Checking
  // once a minute is plenty against a twenty-minute window.
  const [raceClock, setRaceClock] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => {
      setRaceClock((previous) => {
        const now = Date.now()
        // Only re-render when the tick crosses a window boundary.
        return Math.floor(now / RACE_WINDOW_MS) === Math.floor(previous / RACE_WINDOW_MS)
          ? previous
          : now
      })
    }, 60_000)
    return () => clearInterval(id)
  }, [])
  // Dev override: `localStorage.setItem('claude-counter:track', '<slug>')`
  // pins the channel to one venue. For checking a freshly baked circuit
  // without waiting for the rotation to reach it; clearing the key restores
  // the schedule on the next reload.
  const pinnedSlug =
    typeof window !== 'undefined' ? window.localStorage.getItem('claude-counter:track') : null
  const track =
    TRACKS.find((candidate) => candidate.slug === pinnedSlug) ??
    trackForRaceWindow(race?.periodKey, raceClock)
  const circuit = useCircuitFor(track)

  // The wheel. Who is signed in, whether their car is on the grid, and the
  // link the simulation reads every frame.
  const me = useMe()
  const drive = useDrive<RacePose>('race', me)
  const canDrive = me !== null && me !== undefined && (race?.racers.some((racer) => racer.key === me.key) ?? false)
  const recordHotLap = useMutation(api.hotlaps.recordHotLap)
  const hotLapBoard = useQuery(api.hotlaps.board, { trackSlug: track.slug })
  const ghost = useQuery(api.hotlaps.myGhost, me ? { trackSlug: track.slug } : 'skip')
  const trackSlugRef = useRef(track.slug)
  trackSlugRef.current = track.slug
  // A completed driven lap goes to the server as a hot lap and a ghost.
  useEffect(() => {
    drive.link.onLap = (lapSeconds: number, samples: ReadonlyArray<GhostSample>): void => {
      // A CPU car cannot be taken, so this should never fire for one — but a
      // bot's lap must never reach the server, so the door is bolted here too.
      if (drive.link.drivenKey !== null && isCpuKey(drive.link.drivenKey)) return
      recordHotLap({ trackSlug: trackSlugRef.current, lapMs: Math.round(lapSeconds * 1000), samples: [...samples] }).catch(
        (cause: unknown) => {
          console.error('Hot lap not recorded', cause)
        },
      )
    }
    return () => {
      drive.link.onLap = null
    }
  }, [drive.link, recordHotLap])

  const sim = useRaceSim({
    racers: roster,
    drive: drive.link,
    trackLength: circuit.length,
    // The circuit teaches the simulation about its own corners. Without these
    // the field still races, it just races on rails — see UseRaceSimOptions.
    curvatureAt: circuit.curvatureAt,
    laneOffset: circuit.laneOffset,
    roadHalfWidth: circuit.halfWidth,
    // ...and about its own barriers. Measured off the loaded model once it
    // mounts (see TrackModel), so until then this reports the nominal width
    // and the field races as it always did.
    corridorAt: circuit.corridorInto,
  })

  // Development only: the live sim on the window for a browser session to
  // read. Never in production.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return
    const scope = globalThis as typeof globalThis & { raceSim?: typeof sim }
    scope.raceSim = sim
    return () => {
      delete scope.raceSim
    }
  }, [sim])

  // The HUD is React and must not re-render at frame rate, so it samples the
  // sim on a slow interval instead. Positions on screen stay at 60fps; the
  // numbers beside them tick at 2fps, which is more than the eye needs.
  const [hudRacers, setHudRacers] = useState<ReadonlyArray<SimRacer>>([])
  // Which camera shot is live, so the HUD can name whose POV we're watching.
  // Updated only on a cut (every 7-12s), never per frame.
  const [activeShot, setActiveShot] = useState<ActiveShot | null>(null)
  const handleShotChange = useCallback((shot: ActiveShot): void => {
    setActiveShot(shot)
  }, [])

  const handleSelectRacer = useCallback((racerKey: string): void => {
    // A click that arrives at the end of a drag was the viewer looking around,
    // not choosing a car. Latching there would yank the camera mid-gesture.
    if (controls.current.pointerTravel > CLICK_TRAVEL_PX) return
    followRacer(controls.current, racerKey)
  }, [])

  // Only your own car opens: setLivery writes to whoever is signed in, so a
  // shop opened on someone else's car would save their choices onto yours.
  const myKey = me?.key ?? null
  const handleOpenSetup = useCallback(
    (racerKey: string): void => {
      if (myKey !== null && racerKey === myKey) setSetupKey(racerKey)
    },
    [myKey],
  )

  const handleCloseSetup = useCallback((): void => {
    setSetupKey(null)
  }, [])

  const handleReleaseCamera = useCallback((): void => {
    releaseToAuto(controls.current)
  }, [])

  // Taking the wheel puts the camera behind your own car; handing it back
  // returns it to the broadcast.
  const handleTake = useCallback((): void => {
    void drive.take().then(() => {
      if (me) followRacer(controls.current, me.key)
    })
  }, [drive, me])
  const handleRelease = useCallback((): void => {
    void drive.release()
    releaseToAuto(controls.current)
  }, [drive])

  // The overlay's slow readouts: nitro, and who else is driving.
  const [nitro, setNitro] = useState({ charge: 0, lit: false })
  const [remoteDrivers, setRemoteDrivers] = useState<ReadonlyArray<RemoteDriver>>([])
  useEffect(() => {
    if (!isLive) return
    const id = setInterval(() => {
      setNitro({ charge: drive.link.nitro.charge, lit: drive.link.nitro.lit })
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
    }, CONTROL_REFRESH_MS)
    return () => clearInterval(id)
  }, [isLive, drive.link, roster])
  const record = hotLapBoard && hotLapBoard.length > 0
    ? { name: hotLapBoard[0].name, label: formatLapMs(hotLapBoard[0].lapMs) }
    : null

  const handleContextRestored = useCallback((): void => {
    setContextEpoch((epoch) => epoch + 1)
  }, [])

  // The number row picks whose car the camera rides.
  //
  // Counted down the position tower exactly as it is drawn, so 1 is whoever
  // the HUD is calling first at that moment — the number on screen and the
  // number under your finger are the same number, which is the only version
  // of this a viewer can use without looking anything up. Pressing the same
  // digit again hands the camera back to the director, so one key both takes
  // and releases a car.
  useEffect(() => {
    if (!running) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (!/^[1-9]$/.test(event.key)) return
      const subject = hudRacers[Number(event.key) - 1]
      if (!subject) return
      event.preventDefault()
      noteInteraction()
      const camera = controls.current
      if (camera.mode === 'follow' && camera.followKey === subject.key) {
        releaseToAuto(camera)
        return
      }
      followRacer(camera, subject.key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, hudRacers, noteInteraction])

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => {
      setHudRacers(
        [...(sim.racers.current ?? [])]
          .sort((a, b) => b.lap + b.t - (a.lap + a.t))
          // The lap-time array is copied, not shared: a shallow spread would
          // hand the HUD the live array the simulation keeps mutating, so a
          // split could appear in a render that was never triggered by it.
          .map((racer) => ({ ...racer, lapTimes: [...racer.lapTimes] })),
      )
    }, HUD_REFRESH_MS)
    return () => clearInterval(id)
  }, [running, sim.racers])

  const racerCount = roster?.length ?? 0

  // The driver the window is for, resolved from the live query rather than
  // copied into state — a paint job saved here comes back through the same
  // subscription, so the window redraws from the record it just wrote.
  const setupDriver = useMemo<PaintShopDriver | null>(() => {
    if (setupKey === null) return null
    const index = race?.racers.findIndex((racer) => racer.key === setupKey) ?? -1
    const racer = index >= 0 ? race?.racers[index] : undefined
    if (!racer) return null
    return {
      key: racer.key,
      name: racer.name,
      index: chassisOf(racer.key, racer.chassis),
      chassis: racer.chassis,
      color: racer.color ?? PS1.cyan,
      paint: racer.paint,
      livery: racer.livery,
      score: racer.score,
      velocity: racer.velocityTokensPerMin,
    }
  }, [setupKey, race])

  return (
    <CircuitProvider circuit={circuit}>
      <div style={{ position: 'relative', height: '100%', width: '100%', background: PS1.void }}>
        <RaceSky sky={track.sky} />

        <Canvas
          key={contextEpoch}
          // A hidden channel stays mounted so its WebGL context survives,
          // but fiber's loop does not care about visibility: left on
          // "always" every visited game keeps drawing at 60fps behind the
          // one on screen. "never" parks the loop without touching the
          // context, and the next switch resumes it on the same frame.
          frameloop={isLive ? 'always' : 'never'}
          // dpr 1 and a fixed low internal height keep the pixel grid visible.
          dpr={1}
          flat
          // Alpha on, and the clear colour left unpainted: the sky is a painted
          // backdrop behind the canvas rather than geometry, exactly as the era
          // did it, and the shader's fog colour is sampled from the same stops.
          gl={{ antialias: false, powerPreference: 'low-power', alpha: true }}
          // Far plane just past where the fog has finished, so nothing ever
          // pops out of existence in clear air — the era's own trick, and the
          // reason its draw distances could be so short.
          camera={{
            fov: 68,
            near: 0.5,
            far: track.fog.far * 1.35,
            position: [0, circuit.radius, circuit.radius],
          }}
          // Positioned, so it stacks above the absolutely-positioned backdrop.
          style={{
            position: 'relative',
            zIndex: 1,
            height: '100%',
            width: '100%',
            imageRendering: 'pixelated',
          }}
          resize={{ scroll: false }}
          onCreated={({ gl }) => {
            gl.setClearColor(new THREE.Color(track.sky.mid), 0)
          }}
        >
          <ContextGuard label="Race" onRestored={handleContextRestored} />
          <DriveTicker drive={drive} sim={sim} isLive={running} controlsRef={controls} />
          <SimDriver sim={sim} isLive={running} />
          {/* Fog lives in the PS1 shader's own uniforms, not three's fog system —
              these materials don't consume scene fog. Kept in sync in Ps1Material.

              Suspended inside the Canvas for the same reason the cars are: an
              imported circuit is a GLB, and a boundary outside the Canvas would
              tear down the WebGL context every time one loaded. */}
          <Suspense fallback={null}>
            <Track />
          </Suspense>
          {/* Trackside furniture. Inside the same boundary as the cars for the
              same reason — its packs suspend while they load. */}
          {track.proceduralScenery ? (
            <Suspense fallback={null}>
              <Scenery />
            </Suspense>
          ) : null}

          {/* The cars suspend while their models and texture pages load, and
              this boundary is what keeps that suspension inside the canvas.
              Without it the nearest boundary is the channel's own, outside the
              Canvas — so every car that loaded tore the whole renderer down and
              built a fresh WebGL context, the browser hit its context ceiling
              within seconds, and the channel went permanently black. */}
          <Suspense fallback={null}>
            {Array.from({ length: racerCount }, (_, index) => {
              const racer = roster?.[index]
              if (!racer) return null
              return (
                <Racer
                  key={racer.key}
                  index={index}
                  chassis={chassisOf(racer.key, racer.chassis)}
                  racersRef={sim.racers}
                  name={racer.name}
                  color={racer.color ?? PS1.cyan}
                  paint={racer.paint}
                  livery={racer.livery}
                  isActive={racer.isActive}
                  onSelect={() => handleSelectRacer(racer.key)}
                />
              )
            })}
          </Suspense>

          {/* Flame and tyre smoke for the whole grid. Outside the cars'
              Suspense boundary on purpose: it needs no assets, so it should
              not be held back by one that has not loaded. */}
          <RacerFx racersRef={sim.racers} fxRef={sim.fx} enabled={running} />
          {/* Rubber left on the road by the whole grid. Same reasoning as the
              effects above: no assets, so no boundary. */}
          <SkidMarks racersRef={sim.racers} enabled={running} />

          {/* Your best lap, replayed under you while you drive. */}
          {drive.driving && ghost && ghost.samples.length > 0 && (
            <GhostCar samples={ghost.samples} racersRef={sim.racers} drivenKey={drive.link.drivenKey} />
          )}

          {/* The unraced half of the pack, parked at the verges, and the
              broadcast sound. Both inside the cars' own Suspense reasoning:
              parked cars load models, so they get a boundary; audio loads
              nothing suspenseful. */}
          <Suspense fallback={null}>
            <ParkedCars />
          </Suspense>
          <RaceAudio racersRef={sim.racers} enabled={running && audioOn} />

          <CameraDirector
            racersRef={sim.racers}
            controlsRef={controls}
            enabled={isLive}
            onShotChange={handleShotChange}
            onInteract={noteInteraction}
          />
            <ResolutionLock height={track.render.internalHeight} />
        </Canvas>

        <RaceHud
          racers={hudRacers}
          racersRef={sim.racers}
          isEmpty={racerCount === 0}
          activeShot={activeShot}
          onReleaseCamera={handleReleaseCamera}
          trackTitle={track.title}
          paused={paused || setupKey !== null}
          onOpenSetup={handleOpenSetup}
        />

        <ControlOverlay
          game="race"
          me={me}
          canDrive={canDrive && running}
          driving={drive.driving}
          taking={drive.taking}
          error={drive.error}
          onTake={handleTake}
          onRelease={handleRelease}
          nitro={nitro}
          remoteDrivers={remoteDrivers}
          record={record}
        />

        <PaintShopLayer driver={setupDriver} onClose={handleCloseSetup} />
      </div>
    </CircuitProvider>
  )
}

/**
 * Keeps the channel alive across a GPU context loss, and gives the context
 * back on the way out.
 *
 * Both halves matter on a screen that runs all day. A browser hands out a
 * limited number of live WebGL contexts and drops the oldest when it runs
 * short, so a deck that flicks between channels for eight hours will
 * eventually have this one killed underneath it — the scene simply goes
 * black, with no error, and never comes back on its own. Releasing the
 * context explicitly on unmount is what stops that queue building in the
 * first place; preventing the default on loss is what allows the browser to
 * hand a context back at all, and remounting on restore is what rebuilds the
 * buffers and programs that died with the old one.
 */

/**
 * The wheel's frame work: polls the pad, publishes the driven car's pose,
 * and keeps the camera from wandering off your own car while you drive.
 */
function DriveTicker({
  drive,
  sim,
  isLive,
  controlsRef,
}: {
  drive: ReturnType<typeof useDrive<RacePose>>
  sim: ReturnType<typeof useRaceSim>
  isLive: boolean
  controlsRef: React.RefObject<CameraControlState>
}): null {
  useFrame((_, delta) => {
    if (!isLive) return
    drive.tick(delta, () => {
      const key = drive.link.drivenKey
      const racer = key ? sim.racers.current?.find((candidate) => candidate.key === key) : undefined
      if (!racer) return null
      return {
        game: 'race',
        t: racer.t,
        lap: racer.lap,
        lateral: racer.lateral,
        yaw: racer.yaw,
        steer: racer.steer,
        speed: racer.speed,
        driftLoad: racer.driftLoad,
        crashTimer: racer.crashTimer,
        crashDuration: racer.crashDuration,
        crashRolls: racer.crashRolls,
        crashSpin: racer.crashSpin,
        bumpCount: racer.bumpCount,
        wallCount: racer.wallCount,
        crashCount: racer.crashCount,
        impactT: racer.impactT,
        impactLateral: racer.impactLateral,
        boosting: drive.link.nitro.lit,
      }
    })
    // The director hands a followed car back to the broadcast after a
    // spell of no camera input. Driving is input.
    if (drive.link.drivenKey !== null && controlsRef.current.mode === 'follow') {
      controlsRef.current.idle = 0
    }
  })
  return null
}

/** Advances the simulation once per frame. Pauses when the channel is off. */
function SimDriver({
  sim,
  isLive,
}: {
  sim: ReturnType<typeof useRaceSim>
  isLive: boolean
}): null {
  useFrame((_, delta) => {
    if (!isLive) return
    sim.step(delta)
  })
  return null
}

/**
 * Renders at a fixed low internal height regardless of the element's real
 * size, letting the browser scale the result up. This is the pixel grid.
 */
function ResolutionLock({ height }: { height: number }): null {
  const applied = useRef(0)

  useFrame(({ gl, size, camera }) => {
    if (process.env.NODE_ENV !== 'production') {
      ;(globalThis as typeof globalThis & { raceCamera?: THREE.Camera }).raceCamera = camera
    }
    const aspect = size.width / size.height
    const targetWidth = Math.round(height * aspect)
    if (applied.current === targetWidth) return
    applied.current = targetWidth

    // Keep the jitter grid square against the new aspect, or the wobble
    // stretches horizontally on a wide screen.
    setJitterAspect(aspect)

    gl.setSize(targetWidth, height, false)
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.aspect = aspect
      camera.updateProjectionMatrix()
    }
  })

  return null
}

/**
 * The painted backdrop. A dusk gradient with a hot horizon and a scanline
 * dither over it — no geometry, no draw calls, and it never moves, which is
 * precisely how a console with no room for a skybox faked one.
 */
function RaceSky({ sky }: { readonly sky: import('./tracks/types').TrackSky }): React.ReactElement {
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 0,
        backgroundImage: [
          // Sun glow, sitting on the horizon line rather than above it.
          `radial-gradient(120% 62% at 50% 78%, ${sky.glow}55 0%, transparent 55%)`,
          `linear-gradient(to bottom, ${sky.high} 0%, ${sky.mid} 52%, ${sky.horizon} 78%, ${sky.mid} 100%)`,
        ].join(', '),
        // The banding is the point: 15-bit output could not hold a smooth
        // gradient, so the ramp was always broken up by a dither like this.
        backgroundBlendMode: 'screen, normal',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            `repeating-linear-gradient(0deg, rgba(0,0,0,${sky.dither}) 0 1px, transparent 1px 3px)`,
        }}
      />
    </div>
  )
}
