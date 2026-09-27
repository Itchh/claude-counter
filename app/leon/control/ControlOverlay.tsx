'use client'

import { useEffect } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ARCADE, FONTS, GT, PS1, PS1_TYPE } from '../ps1/theme'
import { SCALED_SURFACE } from '../ps1/hudScale'
import { NITRO_MAX_SECONDS } from '@/lib/nitro'
import { KEY_HINTS } from './useControlInput'
import type { ControlGame, NitroState } from './types'
import type { Me } from './useMe'

// The wheel, on the picture.
//
// Three states, all at the foot of the frame where none of the HUDs keep
// anything: signed in and your car is out there → one button; you have the
// wheel → the key hints, the nitro, and the way back; somebody else has
// theirs → their name on a chip, so the room knows the car is being driven.
// Signed out → nothing at all. A wall screen must never nag.

const OUTLINE = '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000'
const INK_SMALL = { textShadow: `${OUTLINE}, 2px 2px 0 rgba(0,0,0,0.92)` } as const
const INK_LARGE = { textShadow: `${OUTLINE}, 3px 3px 0 rgba(0,0,0,0.92)` } as const

/** T takes the wheel. Free: the cabinet has L, M, G; the camera has WASDQEC. */
const TAKE_KEY = 't'

const NITRO_BAR_WIDTH_PX = 160
const NITRO_BAR_HEIGHT_PX = 10

const GAME_NOUN: Readonly<Record<ControlGame, string>> = {
  race: 'the wheel',
  fight: 'the fight',
  dogfight: 'the stick',
}

export interface RemoteDriver {
  readonly racerKey: string
  readonly name: string
  readonly holderName: string
}

interface ControlOverlayProps {
  readonly game: ControlGame
  readonly me: Me | null | undefined
  /** Whether the signed-in driver's own entity is on this screen right now. */
  readonly canDrive: boolean
  readonly driving: boolean
  readonly taking: boolean
  readonly error: string | null
  readonly onTake: () => void
  readonly onRelease: () => void
  /** Sampled slowly by the scene — the bar does not need frame rate. */
  readonly nitro: NitroState | null
  /** Other people driving on this screen, for the chips. */
  readonly remoteDrivers: ReadonlyArray<RemoteDriver>
  /** Race: the record hot lap on this circuit, if anybody has set one. */
  readonly record: { readonly name: string; readonly label: string } | null
  /** The fight: a human waits for the next card. */
  readonly waitingForBout?: boolean
}

function Chip({ children, color }: { readonly children: React.ReactNode; readonly color: string }): React.ReactElement {
  return (
    <span
      className="gt-label"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        padding: '4px 10px',
        fontFamily: FONTS.hud,
        fontSize: `${PS1_TYPE.label}px`,
        letterSpacing: '0.14em',
        color,
        background: 'rgba(0,0,0,0.72)',
        boxShadow: `inset 0 0 0 1px ${color}, 2px 2px 0 #000`,
        ...INK_SMALL,
      }}
    >
      {children}
    </span>
  )
}

function KeyCap({ glyph }: { readonly glyph: string }): React.ReactElement {
  return (
    <span
      className="gt-label"
      style={{
        fontFamily: FONTS.hud,
        fontSize: `${PS1_TYPE.micro}px`,
        padding: '3px 6px',
        color: ARCADE.value,
        background: '#2c2c34',
        boxShadow: `inset 1px 1px 0 0 ${GT.metalHi}, inset -1px -1px 0 0 ${GT.metalLo}, 2px 2px 0 #000`,
      }}
    >
      {glyph}
    </span>
  )
}

function NitroBar({ nitro }: { readonly nitro: NitroState }): React.ReactElement {
  const fraction = Math.max(0, Math.min(1, nitro.charge / NITRO_MAX_SECONDS))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      <span
        className="gt-label"
        style={{ fontFamily: FONTS.hud, fontSize: `${PS1_TYPE.label}px`, color: ARCADE.label, ...INK_SMALL }}
      >
        Nitro
      </span>
      <span
        aria-label={`Nitro ${Math.round(nitro.charge)} seconds`}
        style={{
          position: 'relative',
          width: `${NITRO_BAR_WIDTH_PX}px`,
          height: `${NITRO_BAR_HEIGHT_PX}px`,
          background: GT.lcdBed,
          boxShadow: `inset 0 0 0 1px #000, 2px 2px 0 #000`,
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${fraction * 100}%`,
            background: nitro.lit ? ARCADE.value : GT.lcd,
            transition: 'width 120ms linear',
          }}
        />
      </span>
      <span
        className="gt-label"
        style={{ fontFamily: FONTS.hud, fontSize: `${PS1_TYPE.label}px`, color: nitro.lit ? ARCADE.value : ARCADE.telemetry, ...INK_SMALL, fontVariantNumeric: 'tabular-nums' }}
      >
        {nitro.charge.toFixed(1)}s
      </span>
    </div>
  )
}

export function ControlOverlay({
  game,
  me,
  canDrive,
  driving,
  taking,
  error,
  onTake,
  onRelease,
  nitro,
  remoteDrivers,
  record,
  waitingForBout = false,
}: ControlOverlayProps): React.ReactElement | null {
  const signedIn = me !== null && me !== undefined
  const offer = signedIn && canDrive && !driving

  // T is the keyboard's version of the button. Only while the offer stands.
  useEffect(() => {
    if (!offer) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
      if (event.key.toLowerCase() !== TAKE_KEY) return
      const target = event.target
      if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.isContentEditable)) return
      event.preventDefault()
      onTake()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [offer, onTake])

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 3,
        pointerEvents: 'none',
        ...SCALED_SURFACE,
      }}
    >
      {/* Other people's cars, named. Top-left under the HUD's own corner. */}
      {remoteDrivers.length > 0 && (
        <div style={{ position: 'absolute', left: '18px', bottom: '92px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {remoteDrivers.map((driver) => (
            <Chip key={driver.racerKey} color={PS1.gold}>
              ◉ {driver.holderName.toUpperCase()} IS DRIVING
            </Chip>
          ))}
        </div>
      )}

      <div
        style={{
          position: 'absolute',
          left: '50%',
          bottom: '18px',
          transform: 'translateX(-50%)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '8px',
        }}
      >
        <AnimatePresence mode="wait">
          {offer && (
            <motion.div
              key="offer"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.18 }}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px' }}
            >
              <button
                type="button"
                onClick={onTake}
                disabled={taking}
                className="gt-label arc-button"
                style={{
                  pointerEvents: 'auto',
                  border: 'none',
                  padding: '10px 18px',
                  fontSize: `${PS1_TYPE.body + 2}px`,
                  background: 'rgba(5, 5, 5, 0.85)',
                  boxShadow: `inset 0 0 0 2px ${ARCADE.amber}, 3px 3px 0 #000`,
                }}
              >
                {taking ? 'Taking…' : `Take ${GAME_NOUN[game]}`}
              </button>
              <span
                className="gt-label"
                style={{ fontFamily: FONTS.hud, fontSize: `${PS1_TYPE.micro}px`, color: GT.valueDim, ...INK_SMALL }}
              >
                or press T
              </span>
              {error !== null && (
                <span className="gt-label" style={{ fontFamily: FONTS.hud, fontSize: `${PS1_TYPE.micro}px`, color: PS1.red, ...INK_SMALL }}>
                  {error}
                </span>
              )}
            </motion.div>
          )}

          {driving && (
            <motion.div
              key="driving"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.18 }}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}
            >
              <span
                className="gt-label"
                style={{
                  fontFamily: FONTS.body,
                  fontSize: `${PS1_TYPE.title}px`,
                  letterSpacing: '0.16em',
                  color: waitingForBout ? ARCADE.silver : ARCADE.amber,
                  ...INK_LARGE,
                }}
              >
                {waitingForBout ? 'You are on the next card' : `You have ${GAME_NOUN[game]}`}
              </span>
              {game === 'race' && nitro !== null && <NitroBar nitro={nitro} />}
              <div style={{ display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
                {KEY_HINTS[game].map(([glyph, label]) => (
                  <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <KeyCap glyph={glyph} />
                    <span className="gt-label" style={{ fontFamily: FONTS.hud, fontSize: `${PS1_TYPE.micro}px`, color: GT.valueDim, ...INK_SMALL }}>
                      {label}
                    </span>
                  </span>
                ))}
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <KeyCap glyph="Esc" />
                  <button
                    type="button"
                    onClick={onRelease}
                    className="gt-label"
                    style={{
                      pointerEvents: 'auto',
                      border: 'none',
                      background: 'none',
                      padding: 0,
                      fontFamily: FONTS.hud,
                      fontSize: `${PS1_TYPE.micro}px`,
                      color: ARCADE.value,
                      ...INK_SMALL,
                    }}
                  >
                    Hand back
                  </button>
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {record !== null && (
          <span
            className="gt-label"
            style={{ fontFamily: FONTS.hud, fontSize: `${PS1_TYPE.micro}px`, color: GT.valueDim, ...INK_SMALL }}
          >
            HOT LAP · {record.name.toUpperCase()} {record.label}
          </span>
        )}
      </div>
    </div>
  )
}
