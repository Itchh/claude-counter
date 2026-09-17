'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { createPs1Material, setJitterAspect } from '../channels/race/Ps1Material'
import { ARCADE, FONTS, GT, PS1_TYPE } from '../ps1/theme'
import { SCALED_SURFACE } from '../ps1/hudScale'
import { GAMES, type CabinetGame, type GameInfo } from './games'

// The shelf: where the cabinet's library lives. A low-poly bookcase with one
// cartridge per game, face out; hovering lifts the cart off the board the way
// a hand would, clicking slots it into the machine. It is a menu, but drawn
// as furniture — the same argument as the rest of the cabinet, which never
// shows a list where it could show a thing.

const OUTLINE = '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000'
const INK_SMALL = { textShadow: `${OUTLINE}, 2px 2px 0 rgba(0,0,0,0.92)` } as const

/** The room's own light: no fog reaches the shelf, so the ranges sit far out. */
const ROOM_FOG = { color: '#141018', near: 30, far: 60 } as const

const WOOD_FACE = '#6a4a2e'
const WOOD_DARK = '#43301d'
const WOOD_BACK = '#2c2014'

const CART_WIDTH = 0.85
const CART_HEIGHT = 1.0
const CART_DEPTH = 0.22
/** How far a hovered cart rises off the board, and leans out. */
const HOVER_LIFT = 0.3
const HOVER_OUT = 0.16

interface ShelfSceneProps {
  readonly currentGame: CabinetGame | null
  readonly onPick: (game: CabinetGame) => void
  /** False while the shelf is hidden behind a game, which parks its loop. */
  readonly isLive: boolean
}

function roomMaterial(color: string, emissive = 0): THREE.ShaderMaterial {
  return createPs1Material({
    color,
    fogColor: ROOM_FOG.color,
    fogNear: ROOM_FOG.near,
    fogFar: ROOM_FOG.far,
    emissive,
    ambient: 0.5,
  })
}

/**
 * The label sticker, drawn at 96 texels: the game's accent band, its name in
 * hard white caps, and a bar of fake screenshot noise — every cartridge label
 * of the period, essentially.
 */
function makeLabelTexture(game: GameInfo): THREE.CanvasTexture {
  const width = 96
  const height = 112
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx) {
    // Sticker ground.
    ctx.fillStyle = '#e8e4da'
    ctx.fillRect(0, 0, width, height)
    // Accent band across the head.
    ctx.fillStyle = game.accent
    ctx.fillRect(0, 0, width, 26)
    // The "screenshot": banded noise in the accent's family.
    ctx.fillStyle = '#1a1a22'
    ctx.fillRect(8, 34, width - 16, 42)
    for (let i = 0; i < 26; i++) {
      const x = 10 + ((i * 13) % (width - 22))
      const y = 37 + ((i * 7) % 36)
      ctx.fillStyle = i % 3 === 0 ? game.accent : i % 3 === 1 ? '#e8e8f0' : '#4a4a5a'
      ctx.fillRect(x, y, 4, 3)
    }
    // The name, hard caps, wrapped by word.
    ctx.fillStyle = '#1a1a22'
    ctx.font = 'bold 11px monospace'
    ctx.textAlign = 'center'
    const words = game.name.toUpperCase().split(' ')
    const lines: string[] = []
    let line = ''
    for (const word of words) {
      const next = line === '' ? word : `${line} ${word}`
      if (next.length > 12 && line !== '') {
        lines.push(line)
        line = word
      } else {
        line = next
      }
    }
    if (line !== '') lines.push(line)
    lines.forEach((text, index) => {
      ctx.fillText(text, width / 2, 90 + index * 11, width - 10)
    })
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  return texture
}

function Cartridge({
  game,
  position,
  isCurrent,
  isHovered,
  onHover,
  onPick,
}: {
  readonly game: GameInfo
  readonly position: readonly [number, number, number]
  readonly isCurrent: boolean
  readonly isHovered: boolean
  readonly onHover: (id: CabinetGame | null) => void
  readonly onPick: (id: CabinetGame) => void
}): React.ReactElement {
  const group = useRef<THREE.Group>(null)
  const materials = useMemo(
    () => ({
      shell: roomMaterial(game.shell),
      notch: roomMaterial('#2c2c34'),
      label: createPs1Material({
        color: '#ffffff',
        map: makeLabelTexture(game),
        fogColor: ROOM_FOG.color,
        fogNear: ROOM_FOG.near,
        fogFar: ROOM_FOG.far,
        ambient: 0.65,
      }),
      lamp: roomMaterial(ARCADE.amber, 0.9),
    }),
    [game],
  )

  useFrame((state, delta) => {
    const cart = group.current
    if (!cart) return
    const targetY = position[1] + (isHovered ? HOVER_LIFT : 0)
    const targetZ = position[2] + (isHovered ? HOVER_OUT : 0)
    const ease = Math.min(1, delta * 10)
    cart.position.y += (targetY - cart.position.y) * ease
    cart.position.z += (targetZ - cart.position.z) * ease
    // A lifted cart rocks gently in the hand.
    const targetTilt = isHovered ? Math.sin(state.clock.elapsedTime * 3) * 0.06 : 0
    cart.rotation.z += (targetTilt - cart.rotation.z) * ease
  })

  return (
    <group
      ref={group}
      position={[position[0], position[1], position[2]]}
      onPointerOver={(event) => {
        event.stopPropagation()
        onHover(game.id)
      }}
      onPointerOut={() => onHover(null)}
      onClick={(event) => {
        event.stopPropagation()
        onPick(game.id)
      }}
    >
      {/* Shell. */}
      <mesh material={materials.shell} position={[0, CART_HEIGHT / 2, 0]}>
        <boxGeometry args={[CART_WIDTH, CART_HEIGHT, CART_DEPTH]} />
      </mesh>
      {/* Grip notch across the head. */}
      <mesh material={materials.notch} position={[0, CART_HEIGHT - 0.05, 0]}>
        <boxGeometry args={[CART_WIDTH * 0.7, 0.1, CART_DEPTH + 0.02]} />
      </mesh>
      {/* Label sticker, proud of the face. */}
      <mesh material={materials.label} position={[0, CART_HEIGHT * 0.47, CART_DEPTH / 2 + 0.006]}>
        <planeGeometry args={[CART_WIDTH * 0.82, CART_HEIGHT * 0.78]} />
      </mesh>
      {/* The cart in the machine right now gets the little power lamp. */}
      {isCurrent && (
        <mesh material={materials.lamp} position={[0, -0.09, CART_DEPTH / 2]}>
          <boxGeometry args={[0.14, 0.05, 0.05]} />
        </mesh>
      )}
    </group>
  )
}

function ShelfUnit(): React.ReactElement {
  const face = useMemo(() => roomMaterial(WOOD_FACE), [])
  const dark = useMemo(() => roomMaterial(WOOD_DARK), [])
  const back = useMemo(() => roomMaterial(WOOD_BACK), [])
  const card = useMemo(() => roomMaterial('#3a3a46'), [])
  return (
    <group>
      {/* Back panel. */}
      <mesh material={back} position={[0, 1.55, -0.62]}>
        <boxGeometry args={[5.2, 3.3, 0.12]} />
      </mesh>
      {/* Boards: the carts stand on the middle one. */}
      <mesh material={face} position={[0, 0.98, -0.05]}>
        <boxGeometry args={[5.2, 0.12, 1.15]} />
      </mesh>
      <mesh material={face} position={[0, 2.62, -0.05]}>
        <boxGeometry args={[5.2, 0.12, 1.15]} />
      </mesh>
      <mesh material={face} position={[0, 0.2, -0.05]}>
        <boxGeometry args={[5.2, 0.12, 1.15]} />
      </mesh>
      {/* Cheeks. */}
      <mesh material={dark} position={[-2.66, 1.55, -0.05]}>
        <boxGeometry args={[0.14, 3.3, 1.15]} />
      </mesh>
      <mesh material={dark} position={[2.66, 1.55, -0.05]}>
        <boxGeometry args={[0.14, 3.3, 1.15]} />
      </mesh>

      {/* Set dressing on the top board: a cart lying flat, spine out, and a
          memory card — somebody lives here. */}
      <mesh material={dark} position={[-1.7, 2.8, -0.1]} rotation={[0, 0.3, 0]}>
        <boxGeometry args={[CART_WIDTH, CART_DEPTH, CART_HEIGHT]} />
      </mesh>
      <mesh material={card} position={[1.9, 2.75, 0.1]} rotation={[0, -0.4, 0]}>
        <boxGeometry args={[0.3, 0.12, 0.42]} />
      </mesh>
    </group>
  )
}

/** The pixel grid — same contract as the channels' own locks. */
const SHELF_INTERNAL_HEIGHT = 300

function ShelfResolutionLock({ height }: { readonly height: number }): null {
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

/** The room breathes very slightly; a locked-off frame reads as a still. */
function ShelfCamera(): null {
  useFrame(({ camera, clock }) => {
    camera.position.set(
      Math.sin(clock.elapsedTime * 0.3) * 0.08,
      1.7 + Math.sin(clock.elapsedTime * 0.22) * 0.04,
      3.4,
    )
    camera.lookAt(0, 1.5, 0)
  })
  return null
}

export function ShelfScene({ currentGame, onPick, isLive }: ShelfSceneProps): React.ReactElement {
  const [hovered, setHovered] = useState<CabinetGame | null>(null)
  const handleHover = useCallback((id: CabinetGame | null): void => setHovered(id), [])

  const hoveredGame = hovered !== null ? GAMES.find((game) => game.id === hovered) : undefined
  const slotSpacing = 1.55
  const firstSlot = -slotSpacing

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      {/* The room: a lamp-lit wall, drawn not rendered. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 0,
          backgroundImage: [
            `radial-gradient(90% 70% at 50% 42%, #3a2c3a55 0%, transparent 60%)`,
            `linear-gradient(to bottom, #0c0a12 0%, #1c1420 55%, #0c0a10 100%)`,
          ].join(', '),
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage:
              'repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0 1px, transparent 1px 3px)',
          }}
        />
      </div>

      <Canvas
        // The shelf stays mounted once visited so its WebGL context survives,
        // but fiber's loop does not care about visibility: left on "always"
        // the cartridges, the camera drift and the resolution lock all keep
        // running behind whichever game is on screen. "never" parks the loop
        // without touching the context, and picking the shelf resumes it.
        frameloop={isLive ? 'always' : 'never'}
        dpr={1}
        flat
        gl={{ antialias: false, powerPreference: 'low-power', alpha: true }}
        camera={{ fov: 46, near: 0.2, far: 30, position: [0, 1.7, 3.4] }}
        style={{
          position: 'relative',
          zIndex: 1,
          height: '100%',
          width: '100%',
          imageRendering: 'pixelated',
        }}
        resize={{ scroll: false }}
        onCreated={({ gl }) => {
          gl.setClearColor(new THREE.Color(ROOM_FOG.color), 0)
        }}
      >
        <ShelfResolutionLock height={SHELF_INTERNAL_HEIGHT} />
        <ShelfCamera />
        <ShelfUnit />
        {GAMES.map((game, index) => (
          <Cartridge
            key={game.id}
            game={game}
            position={[firstSlot + index * slotSpacing, 1.06, 0.05]}
            isCurrent={game.id === currentGame}
            isHovered={hovered === game.id}
            onHover={handleHover}
            onPick={onPick}
          />
        ))}
      </Canvas>

      {/* --- Chrome --- */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 2,
          pointerEvents: 'none',
          fontFamily: FONTS.hud,
          ...SCALED_SURFACE,
        }}
      >
        <div style={{ position: 'absolute', top: '14px', left: '18px' }}>
          <span
            className="gt-label"
            style={{ fontSize: `${PS1_TYPE.title}px`, color: GT.label, ...INK_SMALL }}
          >
            The Shelf
          </span>
          <span
            className="gt-label"
            style={{
              display: 'block',
              fontSize: `${PS1_TYPE.micro}px`,
              color: GT.valueDim,
              marginTop: '2px',
              ...INK_SMALL,
            }}
          >
            Pick a cartridge
          </span>
        </div>

        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: '24px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '5px',
            minHeight: '58px',
          }}
        >
          {hoveredGame ? (
            <>
              <span
                className="gt-label"
                style={{ fontSize: `${PS1_TYPE.title}px`, color: ARCADE.value, ...INK_SMALL }}
              >
                {hoveredGame.name}
              </span>
              <span
                className="gt-label"
                style={{ fontSize: `${PS1_TYPE.micro}px`, color: GT.valueDim, ...INK_SMALL }}
              >
                {hoveredGame.blurb}
              </span>
              <span
                className="gt-label"
                style={{
                  fontSize: `${PS1_TYPE.micro}px`,
                  color: ARCADE.amber,
                  animation: 'blink 1.2s step-end infinite',
                  ...INK_SMALL,
                }}
              >
                Click to play
              </span>
            </>
          ) : (
            <span
              className="gt-label"
              style={{ fontSize: `${PS1_TYPE.micro}px`, color: GT.valueDim, ...INK_SMALL }}
            >
              Hover a cartridge
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
