'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { AnimatePresence, motion } from 'motion/react'
import { useMutation } from 'convex/react'
import * as THREE from 'three'
import { api } from '@/convex/_generated/api'
import { LIVERIES, PAINTS, DEFAULT_LIVERY_ID } from '@/lib/livery'
import { fmtTokensShort } from '@/lib/formatters'
import { ARCADE, PS1, PS1_TYPE } from '../../ps1/theme'
import { Kart, type MotionBox } from './Kart'

// The paint shop. Opened by clicking a driver on the tower, and it holds the
// race while it is open.
//
// One object and two decisions. The car turns on a turntable at the full width
// of the window, and paint and livery sit underneath it — nothing else does,
// because nothing else about a driver is theirs to set. Transmission and
// engine note belong to the era's select screen, not to a leaderboard.
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

const OUTLINE = '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000'
const INK = { textShadow: `${OUTLINE}, 2px 2px 0 rgba(0,0,0,0.92)` } as const
const RED_BEVEL = { textShadow: `1px 1px 0 ${ARCADE.labelShadow}, ${OUTLINE}` } as const

export interface PaintShopDriver {
  readonly key: string
  readonly name: string
  /** Grid position, which is what picks the chassis. See carModelFor. */
  readonly index: number
  readonly color: string
  readonly paint: string | null
  readonly livery: string | null
  readonly score: number
}

/**
 * The turntable. Auto-turns, and hands over to the pointer while it is down —
 * a car you cannot stop turning is a car whose far side you can never look at,
 * and half the patterns in the book are about what happens over the roof.
 */
function Turntable({
  driver,
  paint,
  livery,
  yawRef,
  draggingRef,
}: {
  readonly driver: PaintShopDriver
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
    <group ref={groupRef} position={[0, -0.34, 0]}>
      <Kart
        index={driver.index}
        color={driver.color}
        paint={paint}
        livery={livery}
        speedBox={speedBox}
        isActive={false}
      />
    </group>
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
  const [paint, setPaint] = useState(driver.paint ?? PAINTS[driver.index % PAINTS.length].hex)
  const [livery, setPattern] = useState(driver.livery ?? DEFAULT_LIVERY_ID)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const yawRef = useRef(0.6)
  const draggingRef = useRef(false)
  const dragStart = useRef<{ readonly x: number; readonly yaw: number } | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    // Capture, for the same reason the cabinet's own Escape is captured: the
    // race channel listens for keys too, and the topmost surface wins.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const handleApply = useCallback(async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await setLivery({ key: driver.key, paint, livery })
      onClose()
    } catch (cause) {
      // Never silent: the window stays open with the reason on it, because a
      // paint job that quietly did not save is worse than one that failed.
      setError(cause instanceof Error ? cause.message : 'Could not save')
      setSaving(false)
    }
  }, [setLivery, driver.key, paint, livery, onClose])

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      role="dialog"
      aria-label={`Paint shop — ${driver.name}`}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, background: 'rgba(4,4,10,0.82)' }}
      />

      <motion.div
        initial={{ y: 18, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 18, opacity: 0 }}
        transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
        style={{
          position: 'relative',
          width: '560px',
          maxWidth: '92%',
          background: ARCADE.ground,
          border: `2px solid ${ARCADE.rule}`,
          boxShadow: '0 0 0 1px #000, 0 18px 0 rgba(0,0,0,0.5)',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '9px 14px',
            borderBottom: `2px solid ${ARCADE.rule}`,
          }}
        >
          <span style={{ display: 'flex', alignItems: 'baseline', gap: '12px' }}>
            <span className="gt-label" style={{ fontSize: '13px', color: ARCADE.label, ...RED_BEVEL }}>
              Paint shop
            </span>
            <span className="gt-label" style={{ fontSize: '19px', color: paint, ...INK }}>
              {driver.name}
            </span>
            <span className="gt-label" style={{ fontSize: `${PS1_TYPE.micro}px`, color: ARCADE.grey }}>
              {fmtTokensShort(driver.score)} tokens
            </span>
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span
              className="gt-label"
              style={{ fontSize: '11px', color: ARCADE.amber, animation: 'blink 1.4s step-end infinite' }}
            >
              Race held
            </span>
            <button
              type="button"
              onClick={onClose}
              className="gt-label"
              style={{
                background: 'none',
                border: `1px solid ${ARCADE.rule}`,
                color: ARCADE.silver,
                fontSize: '11px',
                padding: '2px 8px',
              }}
            >
              Esc
            </button>
          </span>
        </div>

        {/* The turntable, at the window's full width. */}
        <div
          style={{
            position: 'relative',
            height: '250px',
            background: ARCADE.groundDeep,
            borderBottom: `2px solid ${ARCADE.rule}`,
            touchAction: 'none',
          }}
          onPointerDown={(event) => {
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
            camera={{ fov: 30, near: 0.5, far: 40, position: [0, 1.0, 3.9] }}
            style={{ height: '100%', width: '100%', imageRendering: 'pixelated' }}
            resize={{ scroll: false }}
            onCreated={({ camera }) => camera.lookAt(0, 0.32, 0)}
          >
            <Suspense fallback={null}>
              <Turntable
                driver={driver}
                paint={paint}
                livery={livery}
                yawRef={yawRef}
                draggingRef={draggingRef}
              />
            </Suspense>
          </Canvas>

          <span
            className="gt-label"
            style={{
              position: 'absolute',
              right: '12px',
              bottom: '8px',
              fontSize: '10px',
              color: ARCADE.grey,
              pointerEvents: 'none',
            }}
          >
            Drag to turn
          </span>
        </div>

        <div style={{ padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div>
            <span className="gt-label" style={{ fontSize: '12px', color: ARCADE.label, ...RED_BEVEL }}>
              Paint
            </span>
            <div style={{ display: 'flex', gap: '6px', marginTop: '7px' }}>
              {PAINTS.map((option) => {
                const chosen = option.hex === paint
                return (
                  <button
                    key={option.id}
                    type="button"
                    title={option.name}
                    aria-label={option.name}
                    aria-pressed={chosen}
                    onClick={() => setPaint(option.hex)}
                    style={{
                      flex: 1,
                      height: '30px',
                      background: option.hex,
                      border: chosen ? '2px solid #fff' : `1px solid ${ARCADE.rule}`,
                      boxShadow: chosen
                        ? `0 0 0 2px ${option.hex}`
                        : 'inset -3px -3px 0 0 rgba(0,0,0,0.4)',
                      padding: 0,
                    }}
                  />
                )
              })}
            </div>
          </div>

          <div>
            <span className="gt-label" style={{ fontSize: '12px', color: ARCADE.label, ...RED_BEVEL }}>
              Livery
            </span>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: '6px',
                marginTop: '7px',
              }}
            >
              {LIVERIES.map((option) => {
                const chosen = option.id === livery
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={chosen}
                    onClick={() => setPattern(option.id)}
                    style={{
                      background: chosen ? '#160606' : ARCADE.groundDeep,
                      border: chosen ? `2px solid ${ARCADE.label}` : `1px solid ${ARCADE.rule}`,
                      padding: '6px 8px',
                      textAlign: 'left',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '2px',
                    }}
                  >
                    <span
                      className="gt-label"
                      style={{ fontSize: '12px', color: chosen ? ARCADE.value : ARCADE.silver }}
                    >
                      {option.name}
                    </span>
                    <span className="gt-label" style={{ fontSize: '9px', color: ARCADE.grey }}>
                      {option.note}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {error !== null && (
            // Wrapped, and allowed to be as tall as it needs to be. A backend
            // error is a sentence, not a label, and `.gt-label` holds every
            // line on one line — which put the reason off the side of the
            // window, exactly where nobody would read it.
            <span
              role="alert"
              className="gt-label"
              style={{
                fontSize: '11px',
                color: PS1.hot,
                whiteSpace: 'normal',
                lineHeight: 1.5,
                textTransform: 'none',
                letterSpacing: '0.02em',
              }}
            >
              {error}
            </span>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button
              type="button"
              onClick={onClose}
              className="gt-label"
              style={{
                background: ARCADE.groundDeep,
                border: `1px solid ${ARCADE.rule}`,
                color: ARCADE.grey,
                fontSize: '11px',
                padding: '8px 16px',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleApply()}
              disabled={saving}
              className="gt-label"
              style={{
                background: ARCADE.label,
                border: '1px solid #000',
                color: '#fff',
                fontSize: '11px',
                padding: '8px 20px',
                opacity: saving ? 0.6 : 1,
                ...RED_BEVEL,
              }}
            >
              {saving ? 'Saving…' : 'Apply — green flag'}
            </button>
          </div>
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
