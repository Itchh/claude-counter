'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { useQuery } from 'convex/react'
import * as THREE from 'three'
import { api } from '../../../../convex/_generated/api'
import { Track } from './Track'
import { Racer } from './Racer'
import { CameraDirector, type ActiveShot } from './CameraDirector'
import { RaceHud } from './RaceHud'
import { useRaceSim, type SimRacer } from './useRaceSim'
import { TRACK_LENGTH } from './circuit'
import { setJitterAspect } from './Ps1Material'
import { PS1 } from '../../ps1/theme'
import type { ChannelProps } from '../ChannelRegistry'

// CH 01. Karts driven by live burn rate, laps accumulating all day.
//
// Rendering is deliberately low resolution and scaled up by the browser: the
// console output to 320x240 and the pixel grid is half the aesthetic. It also
// means eight karts and a full circuit cost almost nothing on an office TV.

const INTERNAL_HEIGHT = 288
const HUD_REFRESH_MS = 500

export function RaceScene({ isLive }: ChannelProps): React.ReactElement {
  const race = useQuery(api.scoring.getRace, { period: 'day' })
  const sim = useRaceSim({ racers: race?.racers, trackLength: TRACK_LENGTH })

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

  useEffect(() => {
    if (!isLive) return
    const id = setInterval(() => {
      setHudRacers(
        [...(sim.racers.current ?? [])]
          .sort((a, b) => b.lap + b.t - (a.lap + a.t))
          .map((racer) => ({ ...racer })),
      )
    }, HUD_REFRESH_MS)
    return () => clearInterval(id)
  }, [isLive, sim.racers])

  const racerCount = race?.racers.length ?? 0

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%', background: PS1.void }}>
      <Canvas
        // dpr 1 and a fixed low internal height keep the pixel grid visible.
        dpr={1}
        flat
        gl={{ antialias: false, powerPreference: 'low-power' }}
        camera={{ fov: 68, near: 0.5, far: 240, position: [0, 40, 40] }}
        style={{ height: '100%', width: '100%', imageRendering: 'pixelated' }}
        resize={{ scroll: false }}
        onCreated={({ gl }) => {
          gl.setClearColor(new THREE.Color(PS1.void))
        }}
      >
        <SimDriver sim={sim} isLive={isLive} />
        {/* Fog lives in the PS1 shader's own uniforms, not three's fog system —
            these materials don't consume scene fog. Kept in sync in Ps1Material. */}
        <Track />
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
            />
          )
        })}
        <CameraDirector racersRef={sim.racers} onShotChange={handleShotChange} />
        <ResolutionLock height={INTERNAL_HEIGHT} />
      </Canvas>

      <RaceHud racers={hudRacers} isEmpty={racerCount === 0} activeShot={activeShot} />
    </div>
  )
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
