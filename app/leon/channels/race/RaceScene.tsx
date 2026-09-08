'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useQuery } from 'convex/react'
import * as THREE from 'three'
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
import { RacerFx } from './RacerFx'
import { RaceAudio } from './RaceAudio'
import { ParkedCars } from './ParkedCars'
import { useRaceSim, type SimRacer } from './useRaceSim'
import { CircuitProvider, useCircuitFor } from './CircuitContext'
import { RACE_WINDOW_MS, TRACKS, trackForRaceWindow } from './tracks/registry'
import { setJitterAspect } from './Ps1Material'
import { PS1 } from '../../ps1/theme'
import { useInteractionSignal } from '../../ps1/navigation'
import type { ChannelProps } from '../ChannelRegistry'

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

export function RaceScene({ isLive }: ChannelProps): React.ReactElement {
  const race = useQuery(api.scoring.getRace, { period: 'day' })
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
  const sim = useRaceSim({
    racers: race?.racers,
    trackLength: circuit.length,
    // The circuit teaches the simulation about its own corners. Without these
    // the field still races, it just races on rails — see UseRaceSimOptions.
    curvatureAt: circuit.curvatureAt,
    laneOffset: circuit.laneOffset,
    roadHalfWidth: circuit.halfWidth,
  })

  // The HUD is React and must not re-render at frame rate, so it samples the
  // sim on a slow interval instead. Positions on screen stay at 60fps; the
  // numbers beside them tick at 2fps, which is more than the eye needs.
  const [hudRacers, setHudRacers] = useState<ReadonlyArray<SimRacer>>([])
  // Which camera shot is live, so the HUD can name whose POV we're watching.
  // Updated only on a cut (every 7-12s), never per frame.
  const [activeShot, setActiveShot] = useState<ActiveShot | null>(null)
  // Sound is opt-in. False until someone clicks the speaker chip, and the
  // click itself is the user gesture the browser demands before audio.
  const [audioOn, setAudioOn] = useState(false)

  const handleToggleAudio = useCallback((): void => {
    setAudioOn((current) => !current)
  }, [])

  const handleShotChange = useCallback((shot: ActiveShot): void => {
    setActiveShot(shot)
  }, [])

  const handleSelectRacer = useCallback((racerKey: string): void => {
    // A click that arrives at the end of a drag was the viewer looking around,
    // not choosing a car. Latching there would yank the camera mid-gesture.
    if (controls.current.pointerTravel > CLICK_TRAVEL_PX) return
    followRacer(controls.current, racerKey)
  }, [])

  const handleReleaseCamera = useCallback((): void => {
    releaseToAuto(controls.current)
  }, [])

  const handleContextRestored = useCallback((): void => {
    setContextEpoch((epoch) => epoch + 1)
  }, [])

  useEffect(() => {
    if (!isLive) return
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
  }, [isLive, sim.racers])

  const racerCount = race?.racers.length ?? 0

  return (
    <CircuitProvider circuit={circuit}>
      <div style={{ position: 'relative', height: '100%', width: '100%', background: PS1.void }}>
        <RaceSky sky={track.sky} />

        <Canvas
          key={contextEpoch}
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
          <ContextGuard onRestored={handleContextRestored} />
          <SimDriver sim={sim} isLive={isLive} />
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
              const racer = race?.racers[index]
              if (!racer) return null
              return (
                <Racer
                  key={racer.key}
                  index={index}
                  racersRef={sim.racers}
                  color={racer.color ?? PS1.cyan}
                  isActive={racer.isActive}
                  onSelect={() => handleSelectRacer(racer.key)}
                />
              )
            })}
          </Suspense>

          {/* Flame and tyre smoke for the whole grid. Outside the cars'
              Suspense boundary on purpose: it needs no assets, so it should
              not be held back by one that has not loaded. */}
          <RacerFx racersRef={sim.racers} enabled={isLive} />

          {/* The unraced half of the pack, parked at the verges, and the
              broadcast sound. Both inside the cars' own Suspense reasoning:
              parked cars load models, so they get a boundary; audio loads
              nothing suspenseful. */}
          <Suspense fallback={null}>
            <ParkedCars />
          </Suspense>
          <RaceAudio racersRef={sim.racers} enabled={isLive && audioOn} />

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
          audioOn={audioOn}
          onToggleAudio={handleToggleAudio}
        />
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
function ContextGuard({ onRestored }: { onRestored: () => void }): null {
  const gl = useThree((state) => state.gl)

  useEffect(() => {
    const canvas = gl.domElement

    const handleLost = (event: Event): void => {
      // Without this the loss is final and the canvas stays black forever.
      event.preventDefault()
      console.warn('Race channel: WebGL context lost — waiting for restore.')
    }
    const handleRestored = (): void => {
      console.warn('Race channel: WebGL context restored — rebuilding scene.')
      onRestored()
    }

    canvas.addEventListener('webglcontextlost', handleLost)
    canvas.addEventListener('webglcontextrestored', handleRestored)

    return () => {
      canvas.removeEventListener('webglcontextlost', handleLost)
      canvas.removeEventListener('webglcontextrestored', handleRestored)
      // Hand the context back now rather than whenever the GC gets to it.
      const lose = gl.getContext().getExtension('WEBGL_lose_context')
      lose?.loseContext()
    }
  }, [gl, onRestored])

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
