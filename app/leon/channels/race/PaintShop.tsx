'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { AnimatePresence, motion } from 'motion/react'
import { useMutation } from 'convex/react'
import * as THREE from 'three'
import { api } from '@/convex/_generated/api'
import { CHASSIS_COUNT, DEFAULT_LIVERY_ID, LIVERIES, PAINTS } from '@/lib/livery'
import { saveErrorMessage } from '@/lib/saveError'
import { ARCADE, FONTS, GARAGE, UI_TYPE, toPowerStats } from '../../ps1/theme'
import { SCALED_CHROME, scaledViewport } from '../../ps1/hudScale'
import { Garage } from './Garage'
import { Kart, type MotionBox } from './Kart'

// The select screen. Opened by clicking a driver on the tower or the podium,
// and it holds the race while it is open.
//
// One picture and three decisions. The car stands in a workshop at the full
// width of the window and turns on a turntable; around the picture, in the
// register of the late-90s touring car games, sit the driver's spec in lemon,
// the livery in lemon, a row of paint, and a cobalt d-pad. Left and right
// change the car, up and down the livery, the number keys the paint, Enter
// saves — and the bar under the picture says exactly that, because the
// screen's whole manner is that it tells you what the buttons do.
//
// The car on the turntable is the same car that is out on the circuit: same
// chassis from the pack, same shader, same paint and same pattern, drawn by
// the same component. Faking it with a picture would defeat the point of the
// screen, which is to let someone see what they are about to be driving.
//
// It costs a second WebGL context for as long as it is open. That is the one
// real price here, and it is why the canvas is mounted with the window rather
// than kept alive underneath it — the browser rations contexts, and the race
// must never lose its own to a paint job.

/** How fast the turntable turns when nobody is dragging it, in rad/s. */
const TURNTABLE_SPEED = 0.55
/** Radians of turn per pixel of drag. */
const DRAG_SENSITIVITY = 0.012

/** Pre-zoom pixels — see SCALED_CHROME. */
const WINDOW_WIDTH_PX = 760
const PICTURE_HEIGHT_PX = 360
const TITLE_ROW_PX = 40
const SWATCH_PX = 22
const DPAD_PX = 100
const HUB_PX = 42
const ARROW_HIT_PX = 30

/** A front three-quarter view, looking slightly down at the turntable. */
const CAMERA = {
  fov: 32,
  position: [0, 1.15, 5.4] as const,
  target: new THREE.Vector3(0, 0.55, -0.2),
} as const

/** Buttons do not inherit the cabinet's face — the UA sheet resets them. */
const BUTTON_FONT = { font: 'inherit' } as const

export interface PaintShopDriver {
  readonly key: string
  readonly name: string
  /** The chassis they are drawn in now — see chassisOf. */
  readonly index: number
  /** The chassis they chose, or null if they are still on the hashed one. */
  readonly chassis: number | null
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

/**
 * The turntable. Auto-turns, and hands over to the pointer while it is down —
 * a car you cannot stop turning is a car whose far side you can never look at,
 * and half the patterns in the book are about what happens over the roof.
 */
function Turntable({
  chassis,
  color,
  paint,
  livery,
  yawRef,
  draggingRef,
}: {
  readonly chassis: number
  readonly color: string
  readonly paint: string
  readonly livery: string
  readonly yawRef: React.RefObject<number>
  readonly draggingRef: React.RefObject<boolean>
}): React.ReactElement {
  const groupRef = useRef<THREE.Group>(null)
  // The car reads its speed from a mutable box on the track. Here it is
  // stationary, so the wheels stand still and the body sits at rest height.
  const speedBox = useMemo<MotionBox>(() => ({ value: 0, steer: 0 }), [])

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
      <Kart
        index={chassis}
        color={color}
        paint={paint}
        livery={livery}
        speedBox={speedBox}
        isActive={false}
      />
    </group>
  )
}

/** The cobalt cross: four arrows around a steel hub, each a real button. */
function DPad({
  onLeft,
  onRight,
  onUp,
  onDown,
}: {
  readonly onLeft: () => void
  readonly onRight: () => void
  readonly onUp: () => void
  readonly onDown: () => void
}): React.ReactElement {
  const hit = { width: `${ARROW_HIT_PX}px`, height: `${ARROW_HIT_PX}px` } as const
  return (
    <div style={{ position: 'relative', width: `${DPAD_PX}px`, height: `${DPAD_PX}px`, flex: '0 0 auto' }}>
      <div
        className="grg-hub"
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: `${HUB_PX}px`,
          height: `${HUB_PX}px`,
          transform: 'translate(-50%, -50%)',
        }}
      />
      <button
        type="button"
        aria-label="Previous car"
        className="grg-arrow grg-arrow-left"
        style={{ ...hit, left: 0, top: '50%', transform: 'translateY(-50%)' }}
        onClick={onLeft}
      />
      <button
        type="button"
        aria-label="Next car"
        className="grg-arrow grg-arrow-right"
        style={{ ...hit, right: 0, top: '50%', transform: 'translateY(-50%)' }}
        onClick={onRight}
      />
      <button
        type="button"
        aria-label="Previous livery"
        className="grg-arrow grg-arrow-up"
        style={{ ...hit, top: 0, left: '50%', transform: 'translateX(-50%)' }}
        onClick={onUp}
      />
      <button
        type="button"
        aria-label="Next livery"
        className="grg-arrow grg-arrow-down"
        style={{ ...hit, bottom: 0, left: '50%', transform: 'translateX(-50%)' }}
        onClick={onDown}
      />
    </div>
  )
}

export function PaintShop({
  driver,
  onClose,
}: {
  readonly driver: PaintShopDriver
  readonly onClose: () => void
}): React.ReactElement {
  const setLivery = useMutation(api.livery.setLivery)
  const [chassis, setChassis] = useState(driver.chassis ?? driver.index)
  const [paint, setPaint] = useState(driver.paint ?? PAINTS[driver.index % PAINTS.length].hex)
  const [livery, setPattern] = useState(driver.livery ?? DEFAULT_LIVERY_ID)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const yawRef = useRef(0.6)
  const draggingRef = useRef(false)
  const dragStart = useRef<{ readonly x: number; readonly yaw: number } | null>(null)

  const liveryIndex = Math.max(0, LIVERIES.findIndex((option) => option.id === livery))
  const liveryName = LIVERIES[liveryIndex]?.name ?? 'Plain'
  const stats = toPowerStats(driver.score, driver.velocity)

  const stepChassis = useCallback((delta: number): void => {
    setChassis((current) => cycle(current, delta, CHASSIS_COUNT))
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
      // The mutation writes whoever is signed in; the driver shown is only
      // ever the one the session belongs to.
      await setLivery({ paint, livery, chassis })
      onClose()
    } catch (cause) {
      // Never silent: the window stays open with the reason on the bar,
      // because a paint job that quietly did not save is worse than one that
      // failed.
      console.error('Could not save the livery', cause)
      setError(saveErrorMessage(cause, 'car'))
      setSaving(false)
    }
  }, [saving, setLivery, paint, livery, chassis, onClose])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      let handled = true
      switch (event.key) {
        case 'Escape':
          onClose()
          break
        case 'ArrowLeft':
          stepChassis(-1)
          break
        case 'ArrowRight':
          stepChassis(1)
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
      // Capture, and stopped dead: the cabinet counts the number keys and the
      // race channel listens for arrows, and the topmost surface wins.
      event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, stepChassis, stepLivery, handleApply])

  const prompt = error ?? (saving ? 'Saving…' : null)

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      role="dialog"
      aria-label={`Select car — ${driver.name}`}
      style={{
        // Fixed to the viewport, not to the race: in the stacked layout the
        // race is a band with its overflow clipped, and a dialog inside it
        // lost its head and its buttons. Over a full-screen race the two are
        // the same box.
        position: 'fixed',
        inset: 0,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // The same zoom as the HUD it opens from, so the shop reads at the
        // size of the tower row that was clicked. Sizes below are pre-zoom.
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
          // The frame fits the screen; on a short one the picture scrolls.
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
            Select car {chassis + 1}
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
            Race held
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
            gl={{ antialias: false, powerPreference: 'low-power', alpha: false }}
            camera={{ fov: CAMERA.fov, near: 0.3, far: 60, position: [...CAMERA.position] }}
            style={{ height: '100%', width: '100%', imageRendering: 'pixelated' }}
            resize={{ scroll: false }}
            onCreated={({ camera, gl }) => {
              camera.lookAt(CAMERA.target)
              gl.setClearColor(GARAGE.bezel)
            }}
          >
            {/* Two boundaries, so the room is up while a car is still loading
                and swapping chassis never blanks the wall. */}
            <Suspense fallback={null}>
              <Garage />
            </Suspense>
            <Suspense fallback={null}>
              <Turntable
                chassis={chassis}
                color={driver.color}
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
              {driver.name}
            </span>
            <span className="grg-lemon" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.body}px` }}>
              Car: {chassis + 1} of {CHASSIS_COUNT}
            </span>
            <span className="grg-lemon" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.body}px` }}>
              Level: {stats.level}
            </span>
            <span className="grg-lemon" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.body}px` }}>
              {stats.power} bhp, {stats.speed} rpm
            </span>
          </div>

          {/* The livery, as the big word in the corner. */}
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
              Livery
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
              onLeft={() => stepChassis(-1)}
              onRight={() => stepChassis(1)}
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
              <span>Left/right: car</span>
              <span>Up/down: livery</span>
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

/** Mounted by the race channel so the window can fade in and out. */
export function PaintShopLayer({
  driver,
  onClose,
}: {
  readonly driver: PaintShopDriver | null
  readonly onClose: () => void
}): React.ReactElement {
  return (
    <AnimatePresence>
      {driver !== null && <PaintShop key={driver.key} driver={driver} onClose={onClose} />}
    </AnimatePresence>
  )
}
