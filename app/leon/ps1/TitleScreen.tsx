'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { createFlagTexture } from './flagTexture'
import { createCloudBandDataUrl } from './cloudBand'
import { NewGenreMark } from './NewGenreMark'
import { PS1 } from './theme'

// The attract screen. It is a real gate, not decoration: the cabinet behind it
// is mounted and warming its first Convex round-trip while this sits on top, so
// nothing is ever seen half-populated, and the race only appears once someone
// has actually pressed something.

const MINIMUM_HOLD_MS = 1100
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
    // resulting jitter along the checker edges is the signature of the era.
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

export function TitleScreen(): React.ReactElement | null {
  const [texture, setTexture] = useState<THREE.Texture | null>(null)
  const [cloudUrl, setCloudUrl] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [gone, setGone] = useState(false)

  // Bake both bitmaps once, and only after the display face has actually
  // arrived: a canvas drawn before the font loads bakes the fallback for good.
  useEffect(() => {
    let cancelled = false
    const bake = async (): Promise<void> => {
      try {
        await document.fonts.load(`112px ${CODEC_FAMILY}`)
        await document.fonts.ready
      } catch (error) {
        console.warn('Title screen: display face did not load, baking fallback', error)
      }
      if (cancelled) return
      setTexture(createFlagTexture(CODEC_FAMILY))
      setCloudUrl(createCloudBandDataUrl())
    }
    void bake()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const id = setTimeout(() => setArmed(true), MINIMUM_HOLD_MS)
    return () => clearTimeout(id)
  }, [])

  const ready = armed && texture !== null

  useEffect(() => {
    if (!ready || dismissing) return
    const start = (): void => setDismissing(true)
    window.addEventListener('keydown', start)
    window.addEventListener('pointerdown', start)
    return () => {
      window.removeEventListener('keydown', start)
      window.removeEventListener('pointerdown', start)
    }
  }, [ready, dismissing])

  useEffect(() => {
    if (!dismissing) return
    const id = setTimeout(() => setGone(true), DISMISS_MS)
    return () => clearTimeout(id)
  }, [dismissing])

  useEffect(() => {
    return () => {
      texture?.dispose()
    }
  }, [texture])

  if (gone) return null

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Press start"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 300,
        overflow: 'hidden',
        cursor: 'none',
        background: `linear-gradient(to bottom, #0a1f8c 0%, #123ac4 46%, #1a5ae0 62%, #08122e 74%, #050a1c 100%)`,
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
        <div
          style={{
            fontSize: 'clamp(14px, 2.2vw, 30px)',
            letterSpacing: '0.22em',
            color: '#ffffff',
            animation: ready ? 'titleBlink 1.05s steps(1, end) infinite' : 'none',
            opacity: ready ? 1 : 0.55,
          }}
        >
          {ready ? 'PRESS START BUTTON' : 'NOW LOADING'}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'clamp(8px, 1vw, 16px)',
            fontSize: 'clamp(18px, 3vw, 42px)',
            letterSpacing: '0.04em',
            color: '#c8121f',
            textTransform: 'lowercase',
            filter: 'drop-shadow(2px 2px 0 rgba(0,0,0,0.85))',
          }}
        >
          <NewGenreMark size="clamp(20px, 3.2vw, 44px)" />
          <span>new genre</span>
        </div>

        <div
          style={{
            fontSize: 'clamp(9px, 1.2vw, 16px)',
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
