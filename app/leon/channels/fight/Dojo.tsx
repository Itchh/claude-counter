'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { AnimatePresence, motion } from 'motion/react'
import { useMutation } from 'convex/react'
import * as THREE from 'three'
import { api } from '@/convex/_generated/api'
import { DEFAULT_LIVERY_ID, FIGHTER_COUNT, LIVERIES, PAINTS } from '@/lib/livery'
import { saveErrorMessage } from '@/lib/saveError'
import { ARCADE, FONTS, UI_TYPE, toPowerStats } from '../../ps1/theme'
import { SCALED_CHROME, scaledViewport } from '../../ps1/hudScale'
import { DPad } from '../../ps1/DPad'
import { createPs1Material } from '../race/Ps1Material'
import { FighterModel, type FighterAir, type FighterPose } from './Fighter'
import { FIGHTERS, fighterFor } from './fighters'
import { COURT_SKY, STAGES } from './stages'
import { makeStoneTexture } from './stoneTexture'

// The dojo: the fight's select screen, and the paint shop's twin.
// Opened by clicking a name plate on the HUD, and it holds the bout while
// it is open.
//
// One picture and three decisions, in the same steel frame and the same
// two colours as the car's: the fighter stands on the court's stone at the
// full width of the window in their guard, turning on a turntable; around
// them sit the owner's spec in lemon, the gi pattern in lemon, a row of
// paint and the cobalt d-pad. Left and right change the fighter, up and
// down the pattern, the number keys the paint, Enter saves.
//
// The fighter on the turntable is the one who walks out: same baked
// sculpt, same skeleton, same shader, same gi, drawn by the same
// FighterModel. It costs a second WebGL context for as long as the window
// is open, which is why the canvas mounts with the window rather than
// living under it.

/** How fast the turntable turns when nobody is dragging it, in rad/s. */
const TURNTABLE_SPEED = 0.5
/** Radians of turn per pixel of drag. */
const DRAG_SENSITIVITY = 0.012

/** Pre-zoom pixels — see SCALED_CHROME. */
const WINDOW_WIDTH_PX = 760
const PICTURE_HEIGHT_PX = 360
const TITLE_ROW_PX = 40
const SWATCH_PX = 22

/** A front three-quarter view, at chest height, looking slightly down. */
const CAMERA = {
  fov: 30,
  position: [0, 1.35, 4.2] as const,
  target: new THREE.Vector3(0, 0.95, 0),
} as const

const FLOOR_SIZE = 40
/** The court's air, close in: the fighter is four metres from the lens. */
const DOJO_AIR: FighterAir = { fogColor: COURT_SKY.mid, fogNear: 6, fogFar: 18 }

/** Buttons do not inherit the cabinet's face — the UA sheet resets them. */
const BUTTON_FONT = { font: 'inherit' } as const

export interface DojoFighter {
  readonly key: string
  readonly name: string
  /** The fighter they are drawn as now — see fighterOf. */
  readonly index: number
  /** The fighter they chose, or null if they are still on the hashed one. */
  readonly fighter: number | null
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

/** The court's flagstones under the turntable, fogged into the court's sky. */
function DojoFloor(): React.ReactElement {
  const material = useMemo(
    () =>
      createPs1Material({
        color: '#ffffff',
        map: makeStoneTexture(),
        fogColor: DOJO_AIR.fogColor,
        fogNear: DOJO_AIR.fogNear,
        fogFar: DOJO_AIR.fogFar,
        worldUvScale: 1 / 2.2,
        ambient: 0.7,
      }),
    [],
  )
  useEffect(() => () => material.dispose(), [material])
  return (
    <mesh material={material} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[FLOOR_SIZE, FLOOR_SIZE]} />
    </mesh>
  )
}

/**
 * The turntable. Auto-turns, and hands over to the pointer while it is
 * down — a fighter you cannot stop turning is one whose back you can never
 * look at, and a pattern on a gi has a back.
 */
function Turntable({
  index,
  color,
  paint,
  livery,
  yawRef,
  draggingRef,
}: {
  readonly index: number
  readonly color: string
  readonly paint: string
  readonly livery: string
  readonly yawRef: React.RefObject<number>
  readonly draggingRef: React.RefObject<boolean>
}): React.ReactElement {
  const groupRef = useRef<THREE.Group>(null)
  const elapsed = useRef(0)

  useFrame((_, delta) => {
    const group = groupRef.current
    if (!group) return
    const dt = Math.min(delta, 0.1)
    elapsed.current += dt
    if (!draggingRef.current) {
      yawRef.current += dt * TURNTABLE_SPEED
    }
    group.rotation.y = yawRef.current
  })

  // The guard stance, held: the pose the fighter waits in between blows.
  const getPose = (): FighterPose => ({ action: 'idle', actionT: elapsed.current, clip: null, frozen: false })

  return (
    <group ref={groupRef}>
      <FighterModel index={index} color={color} paint={paint} livery={livery} air={DOJO_AIR} getPose={getPose} />
    </group>
  )
}

export function Dojo({
  fighter: owner,
  onClose,
}: {
  readonly fighter: DojoFighter
  readonly onClose: () => void
}): React.ReactElement {
  const setFighterLivery = useMutation(api.livery.setFighterLivery)
  const [index, setIndex] = useState(owner.fighter ?? owner.index)
  const [paint, setPaint] = useState(owner.paint ?? PAINTS[owner.index % PAINTS.length].hex)
  const [livery, setPattern] = useState(owner.livery ?? DEFAULT_LIVERY_ID)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const yawRef = useRef(0.5)
  const draggingRef = useRef(false)
  const dragStart = useRef<{ readonly x: number; readonly yaw: number } | null>(null)

  const liveryIndex = Math.max(0, LIVERIES.findIndex((option) => option.id === livery))
  const liveryName = LIVERIES[liveryIndex]?.name ?? 'Plain'
  const spec = fighterFor(index)
  const stats = toPowerStats(owner.score, owner.velocity)

  const stepFighter = useCallback((delta: number): void => {
    setIndex((current) => cycle(current, delta, FIGHTER_COUNT))
  }, [])
  const stepLivery = useCallback((delta: number): void => {
    setPattern((current) => {
      const at = Math.max(0, LIVERIES.findIndex((option) => option.id === current))
      return LIVERIES[cycle(at, delta, LIVERIES.length)].id
    })
  }, [])

  const handleApply = useCallback(async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      // The mutation writes whoever is signed in; the fighter shown is only
      // ever the one the session belongs to.
      await setFighterLivery({ paint, livery, fighter: index })
      onClose()
    } catch (cause) {
      // Never silent: the window stays open with the reason on the bar,
      // because a gi that quietly did not save is worse than one that
      // failed.
      console.error('Could not save the fighter livery', cause)
      setError(saveErrorMessage(cause, 'fighter'))
      setSaving(false)
    }
  }, [saving, setFighterLivery, paint, livery, index, onClose])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      let handled = true
      switch (event.key) {
        case 'Escape':
          onClose()
          break
        case 'ArrowLeft':
          stepFighter(-1)
          break
        case 'ArrowRight':
          stepFighter(1)
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
      // Capture, and stopped dead: the cabinet counts the number keys and
      // the fight listens for arrows, and the topmost surface wins.
      event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, stepFighter, stepLivery, handleApply])

  const prompt = error ?? (saving ? 'Saving…' : null)

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      role="dialog"
      aria-label={`Select fighter — ${owner.name}`}
      style={{
        // Fixed to the viewport, not to the ring: in the stacked layout the
        // channel is a band with its overflow clipped, and a dialog inside
        // it would lose its head and its buttons.
        position: 'fixed',
        inset: 0,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...SCALED_CHROME,
      }}
    >
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(4,4,10,0.82)' }} />

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
            Select fighter {index + 1}
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
            Bout held
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
            // The court's own sky behind the stone, so the fighter on the
            // turntable is lit and fogged as they are in the ring.
            background: `linear-gradient(to bottom, ${COURT_SKY.high} 0%, ${COURT_SKY.mid} 50%, ${COURT_SKY.horizon} 72%, ${COURT_SKY.mid} 100%)`,
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
            camera={{ fov: CAMERA.fov, near: 0.3, far: 60, position: [...CAMERA.position] }}
            style={{ height: '100%', width: '100%', imageRendering: 'pixelated' }}
            resize={{ scroll: false }}
            onCreated={({ camera, gl }) => {
              camera.lookAt(CAMERA.target)
              gl.setClearColor(new THREE.Color(COURT_SKY.mid), 0)
            }}
          >
            {/* Two boundaries, so the floor is up while a sculpt is still
                loading and swapping fighters never blanks the picture. */}
            <Suspense fallback={null}>
              <DojoFloor />
            </Suspense>
            <Suspense fallback={null}>
              <Turntable
                index={index}
                color={owner.color}
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
              {owner.name}
            </span>
            <span className="grg-lemon" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.body}px` }}>
              {spec.name} · {index + 1} of {FIGHTERS.length}
            </span>
            <span className="grg-lemon" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.body}px` }}>
              {spec.note}
            </span>
            <span className="grg-lemon" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.body}px` }}>
              Level: {stats.level} · {STAGES.length} stages
            </span>
          </div>

          {/* The gi pattern, as the big word in the corner. */}
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
              Gi pattern
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
                Gi 1–{PAINTS.length}
              </span>
              <div style={{ display: 'flex', gap: '4px' }}>
                {PAINTS.map((option, at) => {
                  const chosen = option.hex === paint
                  return (
                    <button
                      key={option.id}
                      type="button"
                      title={`${at + 1} — ${option.name}`}
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
                left: 'Previous fighter',
                right: 'Next fighter',
                up: 'Previous pattern',
                down: 'Next pattern',
              }}
              onLeft={() => stepFighter(-1)}
              onRight={() => stepFighter(1)}
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
              <span>Left/right: fighter</span>
              <span>Up/down: pattern</span>
              <span>1–{PAINTS.length}: gi</span>
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

/** Mounted by the fight scene so the window can fade in and out. */
export function DojoLayer({
  fighter,
  onClose,
}: {
  readonly fighter: DojoFighter | null
  readonly onClose: () => void
}): React.ReactElement {
  return (
    <AnimatePresence>
      {fighter !== null && <Dojo key={fighter.key} fighter={fighter} onClose={onClose} />}
    </AnimatePresence>
  )
}
