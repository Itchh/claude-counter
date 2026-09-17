'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { createFlagTexture } from './flagTexture'
import { createCloudBandDataUrl } from './cloudBand'
import { LoadingBar } from './LoadingBar'
import { NewGenreMark } from './NewGenreMark'
import { skyGradient, type TitleSpec } from './titleSpecs'
import { PS1 } from './theme'

// One title card, two jobs.
//
// As a `gate` it is the cabinet's boot screen: fixed over everything, holding
// until someone presses a key, which is also the user gesture the browser
// wants before any of this makes a sound.
//
// Pressing start does not open the cabinet directly: the gate runs its
// loading bar first, which is both the period-correct beat between a start
// button and a game, and the moment the first Convex round-trip is allowed to
// land before anyone sees a board. See LoadingBar.
//
// As an `attract` it is a game's own start screen, shown inside the channel
// when that game comes up. It cannot block there — the deck rotates on a
// timer and a card waiting for input would stall the whole rotation — so it
// holds for a beat and wipes itself, with any key cutting it short.

export type TitleCardMode = 'gate' | 'attract'

/**
 * Longest the cloth bake will wait on the display face before going ahead
 * with whatever the canvas can reach. A gate that waits forever is a product
 * that never starts.
 */
const FONT_WAIT_MS = 4000
const MINIMUM_HOLD_MS = 1100
const ATTRACT_HOLD_MS = 2000
const DISMISS_MS = 520
const FLAG_WIDTH = 4.6
const FLAG_HEIGHT = 3.45
const FLAG_SEGMENTS_X = 40
const FLAG_SEGMENTS_Y = 30
const CODEC_FAMILY = '"MGS1 Codec", monospace'

const FLAG_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying float vShade;

  void main() {
    vUv = uv;
    vec3 pos = position;

    // Two ripples of different wavelength travelling across the cloth, damped
    // towards the left and right edges so it reads as pinned rather than
    // floating free.
    float edge = 1.0 - pow(abs(pos.x) / (${(FLAG_WIDTH / 2).toFixed(2)}), 3.0);
    float wave =
      sin(pos.x * 1.9 + uTime * 2.1) * 0.30 +
      sin(pos.x * 3.7 - pos.y * 1.1 + uTime * 3.0) * 0.13 +
      sin(pos.y * 2.3 + uTime * 1.3) * 0.06;
    pos.z += wave * edge;

    // Vertex lighting the way the hardware did it: no normals, just the slope
    // of the surface turned straight into a brightness.
    float slope =
      cos(pos.x * 1.9 + uTime * 2.1) * 1.9 * 0.30 +
      cos(pos.x * 3.7 - pos.y * 1.1 + uTime * 3.0) * 3.7 * 0.13;
    vShade = clamp(0.86 + slope * 0.24, 0.58, 1.24);

    vec4 clip = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);

    // Integer vertex snapping — the console had no subpixel precision, and the
    // resulting jitter along the field edges is the signature of the era.
    float grid = 180.0;
    clip.xy = floor(clip.xy / clip.w * grid) / grid * clip.w;
    gl_Position = clip;
  }
`

const FLAG_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying float vShade;

  void main() {
    vec3 colour = texture2D(uMap, vUv).rgb * vShade;
    // 15-bit colour: five bits a channel, so the banding is real, not filtered.
    colour = floor(colour * 31.0 + 0.5) / 31.0;
    gl_FragColor = vec4(colour, 1.0);
  }
`

function Flag({ texture }: { readonly texture: THREE.Texture }): React.ReactElement {
  const materialRef = useRef<THREE.ShaderMaterial>(null)
  const meshRef = useRef<THREE.Mesh>(null)

  const uniforms = useMemo(
    () => ({ uTime: { value: 0 }, uMap: { value: texture } }),
    [texture],
  )

  useFrame((_state, delta) => {
    if (materialRef.current !== null) {
      materialRef.current.uniforms.uTime.value += delta
    }
    if (meshRef.current !== null) {
      const time = uniforms.uTime.value
      meshRef.current.rotation.y = Math.sin(time * 0.42) * 0.07
      meshRef.current.rotation.z = Math.sin(time * 0.31) * 0.018
    }
  })

  return (
    <mesh ref={meshRef}>
      <planeGeometry args={[FLAG_WIDTH, FLAG_HEIGHT, FLAG_SEGMENTS_X, FLAG_SEGMENTS_Y]} />
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={FLAG_VERTEX_SHADER}
        fragmentShader={FLAG_FRAGMENT_SHADER}
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}

export interface TitleCardProps {
  readonly spec: TitleSpec
  /** `gate` waits for input; `attract` dismisses itself after a beat. */
  readonly mode?: TitleCardMode
  /** How long an attract card holds before wiping. Ignored by a gate. */
  readonly holdMs?: number
  /** True while the cabinet behind the gate is still loading. Gate only. */
  readonly loading?: boolean
  /** Fired once the card has finished wiping out. */
  readonly onDismissed?: () => void
}

export function TitleCard({
  spec,
  mode = 'gate',
  holdMs = ATTRACT_HOLD_MS,
  loading = false,
  onDismissed,
}: TitleCardProps): React.ReactElement | null {
  const [texture, setTexture] = useState<THREE.Texture | null>(null)
  const [cloudUrl, setCloudUrl] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)
  const [booting, setBooting] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [gone, setGone] = useState(false)

  const isGate = mode === 'gate'

  // Bake both bitmaps once, and only after the display face has actually
  // arrived: a canvas drawn before the font loads bakes the fallback for good.
  //
  // Waiting for a font is the right thing to do and must never be the reason
  // nothing happens. This screen is the first thing anybody sees and it has
  // no way to report a fault, so both halves of the wait are now bounded:
  // the font wait races a timeout, and the bake itself is inside the `try`.
  // Left outside it, a throw in `createFlagTexture` rejected this promise and
  // stranded the gate on NOW LOADING with nothing on screen to say why.
  useEffect(() => {
    let cancelled = false
    const bake = async (): Promise<void> => {
      try {
        await Promise.race([
          (async () => {
            await document.fonts.load(`112px ${CODEC_FAMILY}`)
            await document.fonts.ready
          })(),
          new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS)),
        ])
      } catch (error) {
        console.warn('Title card: display face did not load, baking fallback', error)
      }
      if (cancelled) return
      try {
        setTexture(createFlagTexture(CODEC_FAMILY, spec))
        setCloudUrl(createCloudBandDataUrl())
      } catch (error) {
        // Nothing to fall back to but the sky and the wordmark, which is
        // still a title screen. Silence here would be a blank boot.
        console.error('Title card: could not bake the cloth', error)
        setTexture(new THREE.Texture())
      }
    }
    void bake()
    return () => {
      cancelled = true
    }
  }, [spec])

  useEffect(() => {
    const id = setTimeout(() => setArmed(true), isGate ? MINIMUM_HOLD_MS : 0)
    return () => clearTimeout(id)
  }, [isGate])

  const ready = armed && texture !== null

  // A gate waits to be dismissed. An attract card starts its own clock the
  // moment the cloth is up, so a slow bake never shortens it to nothing.
  useEffect(() => {
    if (isGate || !ready || dismissing) return
    const id = setTimeout(() => setDismissing(true), holdMs)
    return () => clearTimeout(id)
  }, [isGate, ready, dismissing, holdMs])

  // A gate hands the press to the loading bar; an attract card has nothing to
  // load, so the same press cuts straight to the wipe.
  useEffect(() => {
    if (!ready || booting || dismissing) return
    const start = (): void => {
      if (isGate) setBooting(true)
      else setDismissing(true)
    }
    window.addEventListener('keydown', start)
    window.addEventListener('pointerdown', start)
    return () => {
      window.removeEventListener('keydown', start)
      window.removeEventListener('pointerdown', start)
    }
  }, [isGate, ready, booting, dismissing])

  const handleLoaded = useCallback((): void => setDismissing(true), [])

  useEffect(() => {
    if (!dismissing) return
    const id = setTimeout(() => {
      setGone(true)
      onDismissed?.()
    }, DISMISS_MS)
    return () => clearTimeout(id)
  }, [dismissing, onDismissed])

  useEffect(() => {
    return () => {
      texture?.dispose()
    }
  }, [texture])

  if (gone) return null

  return (
    <div
      role={isGate ? 'button' : 'presentation'}
      tabIndex={isGate ? 0 : -1}
      aria-label={isGate ? 'Press start' : undefined}
      aria-hidden={isGate ? undefined : 'true'}
      style={{
        position: isGate ? 'fixed' : 'absolute',
        inset: 0,
        zIndex: isGate ? 300 : 120,
        overflow: 'hidden',
        cursor: 'none',
        // An attract card sits over a live scene, so it must not let a click
        // meant for the cabinet land on the game beneath it mid-wipe.
        pointerEvents: dismissing ? 'none' : 'auto',
        background: skyGradient(spec),
        opacity: dismissing ? 0 : 1,
        transition: `opacity ${DISMISS_MS}ms steps(6, end)`,
      }}
    >
      {cloudUrl !== null ? (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: '16%',
            height: '20%',
            backgroundImage: `url(${cloudUrl})`,
            backgroundSize: '50% 100%',
            backgroundRepeat: 'repeat-x',
            imageRendering: 'pixelated',
            opacity: 0.9,
            animation: 'titleCloudDrift 34s linear infinite',
          }}
        />
      ) : null}

      <div
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, opacity: ready ? 1 : 0, transition: 'opacity 400ms linear' }}
      >
        <Canvas
          camera={{ position: [0, 0, 5.15], fov: 48 }}
          dpr={1}
          gl={{ antialias: false, alpha: true }}
          style={{ position: 'absolute', inset: 0 }}
        >
          {texture !== null ? <Flag texture={texture} /> : null}
        </Canvas>
      </div>

      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          transform: 'translateY(13%)',
          gap: 'clamp(10px, 1.7vh, 22px)',
          textAlign: 'center',
          fontFamily: 'var(--font-ps1-codec)',
          textShadow: '2px 2px 0 rgba(0,0,0,0.85)',
        }}
      >
        {booting ? (
          // Same slot the prompt occupied, so the press swaps one line for
          // another rather than moving the lockup under it.
          <LoadingBar accent={spec.accent} hold={loading} onComplete={handleLoaded} />
        ) : (
          <div
            style={{
              fontSize: 'clamp(16px, 2.2vw, 30px)',
              letterSpacing: '0.22em',
              color: '#ffffff',
              animation: ready ? 'titleBlink 1.05s steps(1, end) infinite' : 'none',
              opacity: ready ? 1 : 0.55,
            }}
          >
            {isGate ? (ready ? 'PRESS START BUTTON' : 'NOW LOADING') : spec.subtitle}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'clamp(8px, 1vw, 16px)',
            fontSize: 'clamp(18px, 3vw, 42px)',
            letterSpacing: '0.04em',
            color: spec.accent,
            textTransform: 'lowercase',
            filter: 'drop-shadow(2px 2px 0 rgba(0,0,0,0.85))',
          }}
        >
          <NewGenreMark size="clamp(20px, 3.2vw, 44px)" />
          <span>new genre</span>
        </div>

        <div
          style={{
            fontSize: 'clamp(12px, 1.2vw, 16px)',
            letterSpacing: '0.16em',
            color: '#ffffff',
            lineHeight: 1.9,
          }}
        >
          <div>TM&amp;© 2025 2026 NEW GENRE LTD.</div>
          <div>ALL RIGHTS RESERVED</div>
        </div>
      </div>

      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'repeating-linear-gradient(0deg, rgba(0,0,0,0.22) 0 1px, transparent 1px 3px)',
          mixBlendMode: 'multiply',
          color: PS1.void,
        }}
      />

      <style>{`
        @keyframes titleBlink {
          0%, 55% { opacity: 1; }
          56%, 100% { opacity: 0; }
        }
        @keyframes titleCloudDrift {
          from { background-position: 0 0; }
          to { background-position: 100% 0; }
        }
      `}</style>
    </div>
  )
}
