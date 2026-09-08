'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { FONTS, ARCADE } from './theme'

// The corner prompt strip: the convention every PS1 menu used to tell you what
// the buttons did, because the console shipped without a manual you'd actually
// read. Slanted bars, a button chip, a verb. Nothing else.
//
// Two rules make it work rather than decorate:
//
//   1. It states only what is live *now*. A hint for a key that does nothing
//      in the current state is worse than no hint, so BACK only appears once
//      there is something to back out of.
//   2. Channels contribute their own hints rather than the bar guessing. A
//      channel knows what it responds to; the cabinet does not.

/** The sprites lifted from the pixel pad/keyboard sheets. */
export type HintKey = 'dpad' | 'enter' | 'esc' | 'digits'

/** Which arms of the d-pad are live, drawn as marks beside the chip. */
export type HintAxis = 'horizontal' | 'vertical'

export interface ControlHint {
  readonly id: string
  readonly key: HintKey
  readonly axis?: HintAxis
  readonly label: string
}

const SPRITES: Record<HintKey, { readonly src: string; readonly width: number; readonly height: number } | null> = {
  // Native pixel dimensions. Rendered 1:1 and never scaled by a fraction —
  // a half-scaled sprite is a blurred sprite.
  dpad: { src: '/ps1/keys/dpad.png', width: 28, height: 28 },
  enter: { src: '/ps1/keys/enter.png', width: 23, height: 16 },
  esc: { src: '/ps1/keys/esc.png', width: 16, height: 16 },
  // The number row has no sprite in the key set, and inventing one badly is
  // worse than drawing it as type — see NumberKeys.
  digits: null,
}

const ROW_HEIGHT = 28

interface ControlHintsValue {
  readonly hints: ReadonlyArray<ControlHint>
  readonly publish: (source: string, hints: ReadonlyArray<ControlHint>) => void
}

const ControlHintsContext = createContext<ControlHintsValue | null>(null)

/**
 * Holds one hint list per source. Sources are merged in insertion order, so
 * the cabinet's own hints sit above whatever the live channel adds.
 */
export function ControlHintsProvider({
  children,
}: {
  readonly children: React.ReactNode
}): React.ReactElement {
  const [bySource, setBySource] = useState<ReadonlyArray<readonly [string, ReadonlyArray<ControlHint>]>>([])

  const publish = useCallback((source: string, hints: ReadonlyArray<ControlHint>): void => {
    setBySource((current) => {
      const existing = current.find(([name]) => name === source)
      // Bail out on an unchanged list: this runs from an effect, and a fresh
      // array identity every render would loop.
      if (existing && sameHints(existing[1], hints)) return current
      const without = current.filter(([name]) => name !== source)
      return hints.length === 0 ? without : [...without, [source, hints] as const]
    })
  }, [])

  const hints = useMemo(() => bySource.flatMap(([, list]) => list), [bySource])
  const value = useMemo(() => ({ hints, publish }), [hints, publish])

  return <ControlHintsContext.Provider value={value}>{children}</ControlHintsContext.Provider>
}

function sameHints(a: ReadonlyArray<ControlHint>, b: ReadonlyArray<ControlHint>): boolean {
  if (a.length !== b.length) return false
  return a.every((hint, index) => {
    const other = b[index]
    return (
      hint.id === other.id &&
      hint.key === other.key &&
      hint.axis === other.axis &&
      hint.label === other.label
    )
  })
}

/**
 * Publishes a hint list for as long as the calling component is mounted, and
 * withdraws it on unmount so a channel's hints leave with the channel.
 *
 * `hints` must be referentially stable — wrap it in `useMemo` at the call
 * site. That is deliberate rather than papered over here: an unstable array
 * would make the effect withdraw and republish on every render, and each of
 * those is a state change that renders again. Keeping the requirement visible
 * at the call site is cheaper than a ref dance that hides it.
 */
export function useControlHints(source: string, hints: ReadonlyArray<ControlHint>): void {
  const context = useContext(ControlHintsContext)
  const publish = context?.publish

  useEffect(() => {
    if (!publish) return
    publish(source, hints)
    return () => publish(source, [])
  }, [publish, source, hints])
}

/** The strip itself. Absolutely positioned; the cabinet decides the corner. */
export function ControlHintBar(): React.ReactElement | null {
  const context = useContext(ControlHintsContext)
  const hints = context?.hints ?? []
  if (hints.length === 0) return null

  return (
    <div
      className="ps1-type"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: '3px',
        pointerEvents: 'none',
      }}
    >
      {hints.map((hint) => (
        <HintRow key={hint.id} hint={hint} />
      ))}
    </div>
  )
}

function HintRow({ hint }: { readonly hint: ControlHint }): React.ReactElement {
  const sprite = SPRITES[hint.key]
  return (
    <div
      className="ps1-hint-bar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        height: `${ROW_HEIGHT}px`,
        padding: '0 16px 0 10px',
      }}
    >
      {/* The slant is on the bar; the contents are counter-slanted so glyphs
          stay upright. Skewed pixel art is mush. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', transform: 'skewX(12deg)' }}>
        {sprite ? (
          <img
            src={sprite.src}
            alt=""
            width={sprite.width}
            height={sprite.height}
            style={{ imageRendering: 'pixelated', display: 'block' }}
          />
        ) : (
          <NumberKeys />
        )}
        {hint.axis && <AxisMarks axis={hint.axis} />}
        <span
          style={{
            fontFamily: FONTS.hud,
            fontSize: '13px',
            letterSpacing: '0.08em',
            color: ARCADE.value,
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
          }}
        >
          {hint.label}
        </span>
      </div>
    </div>
  )
}

/**
 * The number row, drawn rather than sprited: two stamped keys with an ellipsis
 * between them, which is how a cabinet's own overlay would have printed a
 * range of buttons it had no room to show one by one.
 */
function NumberKeys(): React.ReactElement {
  const key: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    fontFamily: FONTS.hud,
    fontSize: '11px',
    lineHeight: 1,
    color: ARCADE.value,
    background: '#16161c',
    boxShadow: 'inset 1px 1px 0 0 #55555f, inset -1px -1px 0 0 #0a0a0e',
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
      <span style={key}>1</span>
      <span style={{ ...key, width: 'auto', background: 'none', boxShadow: 'none' }}>–</span>
      <span style={key}>9</span>
    </span>
  )
}

/**
 * Which way the pad is live. Drawn as CSS triangles rather than typed as
 * arrow characters: the bitmap faces have no guaranteed arrow glyph, and a
 * missing glyph renders as a box.
 */
function AxisMarks({ axis }: { readonly axis: HintAxis }): React.ReactElement {
  const size = 4
  const bar = {
    width: 0,
    height: 0,
    borderTop: `${size}px solid transparent`,
    borderBottom: `${size}px solid transparent`,
  } as const

  if (axis === 'horizontal') {
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
        <span style={{ ...bar, borderRight: `${size}px solid ${ARCADE.amber}` }} />
        <span style={{ ...bar, borderLeft: `${size}px solid ${ARCADE.amber}` }} />
      </span>
    )
  }
  return (
    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
      <span
        style={{
          width: 0,
          height: 0,
          borderLeft: `${size}px solid transparent`,
          borderRight: `${size}px solid transparent`,
          borderBottom: `${size}px solid ${ARCADE.amber}`,
        }}
      />
      <span
        style={{
          width: 0,
          height: 0,
          borderLeft: `${size}px solid transparent`,
          borderRight: `${size}px solid transparent`,
          borderTop: `${size}px solid ${ARCADE.amber}`,
        }}
      />
    </span>
  )
}
