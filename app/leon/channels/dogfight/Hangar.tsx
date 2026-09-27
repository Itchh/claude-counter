'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { useTexture } from '@react-three/drei'
import { AnimatePresence, motion } from 'motion/react'
import { useMutation } from 'convex/react'
import * as THREE from 'three'
import { api } from '@/convex/_generated/api'
import { AIRFRAME_COUNT, DEFAULT_LIVERY_ID, LIVERIES, PAINTS } from '@/lib/livery'
import { saveErrorMessage } from '@/lib/saveError'
import { ARCADE, FONTS, UI_TYPE, toPowerStats } from '../../ps1/theme'
import { SCALED_CHROME, scaledViewport } from '../../ps1/hudScale'
import { DPad } from '../../ps1/DPad'
import { configurePs1Texture, createPs1Material } from '../race/Ps1Material'
import { Airframe, type SpinBox } from './Airframe'
import { AIRFRAMES, airframeFor } from './airframes'
import { THEATRE_FOG_FAR, THEATRE_FOG_NEAR, THEATRE_SKY } from './theatre'

// The hangar: the dogfight's select screen, and the paint shop's twin.
// Opened by clicking a pilot on the roster, and it holds the patrol while
// it is open.
//
// One picture and three decisions, in the same steel frame and the same two
// colours as the car's: the aircraft stands on the apron at the full width
// of the window and turns on its wheels, airscrew ticking over; around it
// sit the pilot's spec in lemon, the markings in lemon, a row of paint and
// the cobalt d-pad. Left and right change the type, up and down the
// pattern, the number keys the paint, Enter saves.
//
// The aircraft on the apron is the one that flies: same baked model, same
// shader, same paint and pattern, drawn by the same Airframe. It costs a
// second WebGL context for as long as the window is open, which is why the
// canvas mounts with the window rather than living under it.

/** How fast the turntable turns when nobody is dragging it, in rad/s. */
const TURNTABLE_SPEED = 0.45
/** Radians of turn per pixel of drag. */
const DRAG_SENSITIVITY = 0.012
/** The airscrew, ticking over on the apron. */
const IDLE_PROP_RATE = 16

/** Pre-zoom pixels — see SCALED_CHROME. */
const WINDOW_WIDTH_PX = 760
const PICTURE_HEIGHT_PX = 360
const TITLE_ROW_PX = 40
const SWATCH_PX = 22

/** A front three-quarter view, looking slightly down at the apron. */
const CAMERA = {
  fov: 30,
  position: [0, 1.05, 4.6] as const,
  target: new THREE.Vector3(0, 0.05, 0),
} as const

const APRON_SIZE = 60
const APRON_UV_SCALE = 0.5
const CONCRETE_URL = '/ps1/textures/concrete.png'
/** The aircraft sits on its wheels: its centreline this far above the apron. */
const REST_HEIGHT = 0.42

/** Buttons do not inherit the cabinet's face — the UA sheet resets them. */
const BUTTON_FONT = { font: 'inherit' } as const

export interface HangarPilot {
  readonly key: string
  readonly name: string
  /** The airframe they fly now — see airframeOf. */
  readonly index: number
  /** The airframe they chose, or null if they are still on the hashed one. */
  readonly airframe: number | null
  readonly color: string
  readonly paint: string | null
  readonly livery: string | null
  readonly score: number
  /** Tokens per minute, for the spec block's rate line. */
  readonly velocity: number
}

function cycle(value: number, delta: number, length: number): number {
  return (((value + delta) % length) + length) % length
}

/** The concrete under the wheels, fogged into the same sky as the patrol. */
function Apron(): React.ReactElement {
  const concrete = useTexture(CONCRETE_URL)
  const material = useMemo(() => {
    concrete.wrapS = THREE.RepeatWrapping
    concrete.wrapT = THREE.RepeatWrapping
    return createPs1Material({
      color: '#ffffff',
      map: configurePs1Texture(concrete, { distant: true }),
      worldUvScale: APRON_UV_SCALE,
      fogColor: THEATRE_SKY.horizon,
      fogNear: THEATRE_FOG_NEAR * 0.3,
      fogFar: THEATRE_FOG_FAR * 0.3,
      ambient: 0.7,
    })
  }, [concrete])
  useEffect(() => () => material.dispose(), [material])
  return (
    <mesh material={material} rotation={[-Math.PI / 2, 0, 0]} position={[0, -REST_HEIGHT, 0]}>
      <planeGeometry args={[APRON_SIZE, APRON_SIZE]} />
    </mesh>
  )
}

/**
 * The turntable. Auto-turns, and hands over to the pointer while it is down
 * — an aircraft you cannot stop turning is one whose far wing you can never
 * look at, and half the patterns in the book are about what happens over
 * the spine.
 */
function Turntable({
  airframe,
  color,
  paint,
  livery,
  yawRef,
  draggingRef,
}: {
  readonly airframe: number
  readonly color: string
  readonly paint: string
  readonly livery: string
  readonly yawRef: React.RefObject<number>
  readonly draggingRef: React.RefObject<boolean>
}): React.ReactElement {
  const groupRef = useRef<THREE.Group>(null)
  const spinBox = useMemo<SpinBox>(() => ({ rate: IDLE_PROP_RATE }), [])

  useFrame((_, delta) => {
    const group = groupRef.current
    if (!group) return
    if (!draggingRef.current) {
      yawRef.current += Math.min(delta, 0.1) * TURNTABLE_SPEED
    }
    group.rotation.y = yawRef.current
  })

  return (
    <group ref={groupRef}>
      <Airframe index={airframe} color={color} paint={paint} livery={livery} spinBox={spinBox} />
    </group>
  )
}

export function Hangar({
  pilot,
  onClose,
}: {
  readonly pilot: HangarPilot
  readonly onClose: () => void
}): React.ReactElement {
  const setPlaneLivery = useMutation(api.livery.setPlaneLivery)
  const [airframe, setAirframe] = useState(pilot.airframe ?? pilot.index)
  const [paint, setPaint] = useState(pilot.paint ?? PAINTS[pilot.index % PAINTS.length].hex)
  const [livery, setPattern] = useState(pilot.livery ?? DEFAULT_LIVERY_ID)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const yawRef = useRef(0.7)
  const draggingRef = useRef(false)
  const dragStart = useRef<{ readonly x: number; readonly yaw: number } | null>(null)

  const liveryIndex = Math.max(0, LIVERIES.findIndex((option) => option.id === livery))
  const liveryName = LIVERIES[liveryIndex]?.name ?? 'Plain'
  const type = airframeFor(airframe)
  const stats = toPowerStats(pilot.score, pilot.velocity)

  const stepAirframe = useCallback((delta: number): void => {
    setAirframe((current) => cycle(current, delta, AIRFRAME_COUNT))
  }, [])
  const stepLivery = useCallback((delta: number): void => {
    setPattern((current) => {
      const index = Math.max(0, LIVERIES.findIndex((option) => option.id === current))
      return LIVERIES[cycle(index, delta, LIVERIES.length)].id
    })
  }, [])

  const handleApply = useCallback(async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await setPlaneLivery({ paint, livery, airframe })
      onClose()
    } catch (cause) {
      // Never silent: the window stays open with the reason on the bar,
      // because markings that quietly did not save are worse than markings
      // that failed.
      console.error('Could not save the plane markings', cause)
      setError(saveErrorMessage(cause, 'plane'))
      setSaving(false)
    }
  }, [saving, setPlaneLivery, paint, livery, airframe, onClose])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      let handled = true
      switch (event.key) {
        case 'Escape':
          onClose()
          break
        case 'ArrowLeft':
          stepAirframe(-1)
          break
        case 'ArrowRight':
          stepAirframe(1)
          break
        case 'ArrowUp':
          stepLivery(-1)
          break
        case 'ArrowDown':
          stepLivery(1)
          break
        case 'Enter':
          void handleApply()
          break
        default: {
          const digit = Number.parseInt(event.key, 10)
          if (Number.isInteger(digit) && digit >= 1 && digit <= PAINTS.length) {
            setPaint(PAINTS[digit - 1].hex)
          } else {
            handled = false
          }
        }
      }
      if (!handled) return
      event.preventDefault()
      // Capture, and stopped dead: the cabinet counts the number keys, and
      // the topmost surface wins.
      event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, stepAirframe, stepLivery, handleApply])

  const prompt = error ?? (saving ? 'Saving…' : null)

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      role="dialog"
      aria-label={`Select aircraft — ${pilot.name}`}
      style={{
        // Fixed to the viewport, not to the patrol: in the stacked layout the
        // channel is a band with its overflow clipped, and a dialog inside it
        // would lose its head and its buttons.
        position: 'fixed',
        inset: 0,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...SCALED_CHROME,
      }}
    >
      <div
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, background: 'rgba(4,4,10,0.82)' }}
      />

      <motion.div
        className="grg-frame"
        initial={{ y: 18, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 18, opacity: 0 }}
        transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
        style={{
          position: 'relative',
          width: `${WINDOW_WIDTH_PX}px`,
          maxWidth: '94%',
          maxHeight: scaledViewport('vh', 32),
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          padding: '10px 14px 14px',
          overflowY: 'auto',
        }}
      >
        <div
          style={{
            position: 'relative',
            height: `${TITLE_ROW_PX}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span className="grg-title" style={{ fontFamily: FONTS.codec, fontSize: `${UI_TYPE.title}px` }}>
            Select aircraft {airframe + 1}
          </span>
          <span
            className="gt-label"
            style={{
              position: 'absolute',
              right: '4px',
              fontFamily: FONTS.hud,
              fontSize: `${UI_TYPE.caption}px`,
              color: ARCADE.amber,
              animation: 'blink 1.4s step-end infinite',
            }}
          >
            Patrol held
          </span>
        </div>

        {/* The picture, at the window's full width. */}
        <div
          className="grg-bezel"
          style={{
            position: 'relative',
            flex: '0 0 auto',
            height: `${PICTURE_HEIGHT_PX}px`,
            overflow: 'hidden',
            touchAction: 'none',
            // The theatre's own sky behind the apron, so the plane on the
            // turntable is lit and fogged as it is on patrol.
            background: `linear-gradient(to bottom, ${THEATRE_SKY.high} 0%, ${THEATRE_SKY.mid} 45%, ${THEATRE_SKY.horizon} 70%, ${THEATRE_SKY.horizon} 100%)`,
          }}
          onPointerDown={(event) => {
            // Buttons over the picture are theirs; the turntable takes the rest.
            if ((event.target as HTMLElement).closest('button')) return
            draggingRef.current = true
            dragStart.current = { x: event.clientX, yaw: yawRef.current }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const start = dragStart.current
            if (!draggingRef.current || start === null) return
            yawRef.current = start.yaw + (event.clientX - start.x) * DRAG_SENSITIVITY
          }}
          onPointerUp={() => {
            draggingRef.current = false
            dragStart.current = null
          }}
          onPointerCancel={() => {
            draggingRef.current = false
            dragStart.current = null
          }}
        >
          <Canvas
            dpr={1}
            flat
            gl={{ antialias: false, powerPreference: 'low-power', alpha: true }}
            camera={{ fov: CAMERA.fov, near: 0.3, far: 80, position: [...CAMERA.position] }}
            style={{ height: '100%', width: '100%', imageRendering: 'pixelated' }}
            resize={{ scroll: false }}
            onCreated={({ camera, gl }) => {
              camera.lookAt(CAMERA.target)
              gl.setClearColor(new THREE.Color(THEATRE_SKY.mid), 0)
            }}
          >
            {/* Two boundaries, so the apron is up while a type is still
                loading and swapping aircraft never blanks the picture. */}
            <Suspense fallback={null}>
              <Apron />
            </Suspense>
            <Suspense fallback={null}>
              <Turntable
                airframe={airframe}
                color={pilot.color}
                paint={paint}
                livery={livery}
                yawRef={yawRef}
                draggingRef={draggingRef}
              />
            </Suspense>
          </Canvas>

          {/* The spec block. */}
          <div
            style={{
              position: 'absolute',
              left: '14px',
              top: '12px',
              display: 'flex',
              flexDirection: 'column',
              gap: '3px',
              pointerEvents: 'none',
            }}
          >
            <span className="grg-lemon" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.heading}px` }}>
              {pilot.name}
            </span>
            <span className="grg-lemon" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.body}px` }}>
              {type.name} · {airframe + 1} of {AIRFRAMES.length}
            </span>
            <span className="grg-lemon" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.body}px` }}>
              {type.note}
            </span>
            <span className="grg-lemon" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.body}px` }}>
              Level: {stats.level} · {stats.power} hp
            </span>
          </div>

          {/* The markings, as the big word in the corner. */}
          <div
            style={{
              position: 'absolute',
              left: '14px',
              bottom: '12px',
              display: 'flex',
              flexDirection: 'column',
              gap: '2px',
              pointerEvents: 'none',
            }}
          >
            <span className="grg-lemon" style={{ fontFamily: FONTS.hud, fontSize: `${UI_TYPE.caption}px` }}>
              Markings
            </span>
            <span className="grg-lemon-lg" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.title}px` }}>
              {liveryName}
            </span>
          </div>

          {/* Paint and the d-pad. */}
          <div
            style={{
              position: 'absolute',
              right: '14px',
              bottom: '10px',
              display: 'flex',
              alignItems: 'flex-end',
              gap: '14px',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', paddingBottom: '8px' }}>
              <span className="grg-lemon" style={{ fontFamily: FONTS.hud, fontSize: `${UI_TYPE.caption}px` }}>
                Paint 1–{PAINTS.length}
              </span>
              <div style={{ display: 'flex', gap: '4px' }}>
                {PAINTS.map((option, index) => {
                  const chosen = option.hex === paint
                  return (
                    <button
                      key={option.id}
                      type="button"
                      title={`${index + 1} — ${option.name}`}
                      aria-label={option.name}
                      aria-pressed={chosen}
                      onClick={() => setPaint(option.hex)}
                      className={chosen ? 'grg-swatch grg-swatch-on' : 'grg-swatch'}
                      style={{ width: `${SWATCH_PX}px`, height: `${SWATCH_PX}px`, background: option.hex }}
                    />
                  )
                })}
              </div>
            </div>
            <DPad
              labels={{
                left: 'Previous aircraft',
                right: 'Next aircraft',
                up: 'Previous markings',
                down: 'Next markings',
              }}
              onLeft={() => stepAirframe(-1)}
              onRight={() => stepAirframe(1)}
              onUp={() => stepLivery(-1)}
              onDown={() => stepLivery(1)}
            />
          </div>
        </div>

        {/* The prompt bar: what the buttons do, or why the save failed. */}
        <div
          className="grg-prompt"
          role={error === null ? undefined : 'alert'}
          style={{
            fontFamily: FONTS.hud,
            fontSize: `${UI_TYPE.caption}px`,
            padding: '7px 12px',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: '18px',
            ...(error === null ? {} : { whiteSpace: 'normal', lineHeight: 1.4 }),
          }}
        >
          {prompt !== null ? (
            <span>{prompt}</span>
          ) : (
            <>
              <span>Left/right: aircraft</span>
              <span>Up/down: markings</span>
              <span>1–{PAINTS.length}: paint</span>
              <button
                type="button"
                onClick={() => void handleApply()}
                className="arc-button"
                style={{ ...BUTTON_FONT, background: 'none', border: 'none', padding: 0 }}
              >
                Enter: save
              </button>
              <button
                type="button"
                onClick={onClose}
                className="arc-button"
                style={{ ...BUTTON_FONT, background: 'none', border: 'none', padding: 0 }}
              >
                Esc: back
              </button>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}

/** Mounted by the dogfight scene so the window can fade in and out. */
export function HangarLayer({
  pilot,
  onClose,
}: {
  readonly pilot: HangarPilot | null
  readonly onClose: () => void
}): React.ReactElement {
  return (
    <AnimatePresence>
      {pilot !== null && <Hangar key={pilot.key} pilot={pilot} onClose={onClose} />}
    </AnimatePresence>
  )
}
