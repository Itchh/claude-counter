'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ComponentType } from 'react'
import { CHANNELS, channelAt, type ChannelProps } from './ChannelRegistry'
import { ChannelBug } from './ChannelBug'
import { NavigationProvider, useNavigationState } from '../ps1/navigation'
import {
  ControlHintBar,
  ControlHintsProvider,
  useControlHints,
  type ControlHint,
} from '../ps1/ControlHints'
import { PS1 } from '../ps1/theme'

// The deck is the console: it owns which channel is live, how long it rests
// there, and the wipe between them. Channels themselves know nothing about
// scheduling — they only receive `isLive` so they can idle when off-screen.

/** How long a manual jump suppresses auto-rotation. */
const MANUAL_OVERRIDE_MS = 3 * 60_000
const WIPE_MS = 620

type LoadedChannels = Record<string, ComponentType<ChannelProps>>

export function ChannelDeck(): React.ReactElement {
  const [index, setIndex] = useState(0)
  const [loaded, setLoaded] = useState<LoadedChannels>({})
  const [wipeKey, setWipeKey] = useState(0)
  const overrideUntil = useRef(0)

  const channel = channelAt(index)

  /**
   * Any deliberate input defers auto-rotation. Moving the cursor counts: the
   * screen flicking channels while someone is reading a row is the single
   * most obvious way this could feel broken.
   */
  const noteInteraction = useCallback((): void => {
    overrideUntil.current = Date.now() + MANUAL_OVERRIDE_MS
  }, [])

  const goTo = useCallback((next: number, manual: boolean): void => {
    if (manual) overrideUntil.current = Date.now() + MANUAL_OVERRIDE_MS
    setIndex(((next % CHANNELS.length) + CHANNELS.length) % CHANNELS.length)
    setWipeKey((key) => key + 1)
  }, [])

  // Load the live channel's module, and warm the next one so a flick never
  // lands on a loading state.
  //
  // `loaded` is deliberately NOT a dependency: this effect sets it, so
  // depending on it would re-run the effect on every successful load and spin
  // forever. Guarding against duplicate work is `requested` instead, which is
  // a ref and so never itself triggers a render.
  const requested = useRef<Set<string>>(new Set())

  useEffect(() => {
    // No `cancelled` flag here, deliberately. This effect re-runs on every
    // flick, and a cleanup that abandoned the in-flight import would drop the
    // incoming channel's own load while `requested` still marked it as done —
    // wedging it on the tuning card forever. A channel module is immutable and
    // tiny to keep, so letting a late resolve land is strictly better.
    const warm = async (target: number): Promise<void> => {
      const entry = channelAt(target)
      if (requested.current.has(entry.id)) return
      requested.current.add(entry.id)
      try {
        const component = await entry.load()
        setLoaded((current) =>
          current[entry.id] ? current : { ...current, [entry.id]: component },
        )
      } catch (error) {
        // Allow a retry on the next flick rather than wedging the channel.
        requested.current.delete(entry.id)
        console.error(`Channel "${entry.id}" failed to load:`, error)
      }
    }
    void warm(index)
    void warm(index + 1)
  }, [index])

  useEffect(() => {
    const id = setTimeout(() => {
      if (Date.now() < overrideUntil.current) return
      goTo(index + 1, false)
    }, channel.dwellMs)
    return () => clearTimeout(id)
  }, [index, channel.dwellMs, goTo])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowRight') goTo(index + 1, true)
      else if (event.key === 'ArrowLeft') goTo(index - 1, true)
      else if (/^[1-9]$/.test(event.key)) {
        const target = Number(event.key) - 1
        if (target < CHANNELS.length) goTo(target, true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, goTo])

  const Live = loaded[channel.id]

  const dwellSeconds = useMemo(() => channel.dwellMs / 1000, [channel.dwellMs])

  return (
    <ControlHintsProvider>
      <NavigationProvider resetKey={channel.id} onInteract={noteInteraction}>
        <div style={{ position: 'relative', height: '100%', width: '100%', overflow: 'hidden' }}>
          <DeckContents
            channelId={channel.id}
            channelName={channel.name}
            index={index}
            dwellSeconds={dwellSeconds}
            wipeKey={wipeKey}
            Live={Live}
          />
        </div>
      </NavigationProvider>
    </ControlHintsProvider>
  )
}

/**
 * Everything that needs to sit *inside* the providers. Split out purely so it
 * can read navigation state with a hook — the deck itself renders the
 * provider, so it cannot.
 */
function DeckContents({
  channelId,
  channelName,
  index,
  dwellSeconds,
  wipeKey,
  Live,
}: {
  readonly channelId: string
  readonly channelName: string
  readonly index: number
  readonly dwellSeconds: number
  readonly wipeKey: number
  readonly Live: ComponentType<ChannelProps> | undefined
}): React.ReactElement {
  return (
    <>
      <AnimatePresence mode="wait">
        <motion.div
          key={channelId}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          style={{ position: 'absolute', inset: 0 }}
        >
          {Live ? <Live isLive /> : <ChannelTuning name={channelName} />}
        </motion.div>
      </AnimatePresence>

      <ChannelWipe wipeKey={wipeKey} />
      <ChannelBug
        index={index}
        name={channelName}
        dwellSeconds={dwellSeconds}
        cycleKey={wipeKey}
      />

      <DeckHints />

      {/* Bottom-left is the only corner no channel claims: CH 01 keeps its
          lap counter bottom-right, CH 02 its status bar across the foot. */}
      <div
        style={{
          position: 'absolute',
          left: '28px',
          bottom: '22px',
          zIndex: 84,
          pointerEvents: 'none',
        }}
      >
        <ControlHintBar />
      </div>
    </>
  )
}

/**
 * The cabinet's own prompts. Channel switching is always available; the
 * cursor prompts appear as they become true, so the strip never advertises a
 * key that would currently do nothing.
 */
function DeckHints(): null {
  const { hasFocus, hasExpanded } = useNavigationState()

  const hints = useMemo<ReadonlyArray<ControlHint>>(() => {
    const base: ControlHint[] = [
      { id: 'channel', key: 'dpad', axis: 'horizontal', label: 'Channel' },
      { id: 'move', key: 'dpad', axis: 'vertical', label: 'Move' },
    ]
    if (hasFocus) {
      base.push({
        id: 'select',
        key: 'enter',
        label: hasExpanded ? 'Close' : 'Select',
      })
      base.push({ id: 'back', key: 'esc', label: 'Back' })
    }
    return base
  }, [hasFocus, hasExpanded])

  useControlHints('deck', hints)
  return null
}

/**
 * The flick itself: a bright band sweeping down, a burst of static, and a
 * horizontal roll — a channel change on a CRT, not a crossfade.
 */
function ChannelWipe({ wipeKey }: { wipeKey: number }): React.ReactElement {
  return (
    <AnimatePresence>
      <motion.div
        key={wipeKey}
        initial={{ opacity: 1 }}
        animate={{ opacity: 0 }}
        transition={{ duration: WIPE_MS / 1000, ease: 'easeOut' }}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 90,
          pointerEvents: 'none',
        }}
      >
        <motion.div
          initial={{ y: '-100%' }}
          animate={{ y: '100%' }}
          transition={{ duration: WIPE_MS / 1000, ease: 'linear' }}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            height: '34%',
            background: `linear-gradient(to bottom, transparent, ${PS1.cyan}22 40%, ${PS1.text}66 50%, ${PS1.cyan}22 60%, transparent)`,
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            opacity: 0.5,
            backgroundImage:
              'repeating-linear-gradient(0deg, rgba(255,255,255,0.07) 0 1px, transparent 1px 3px)',
          }}
        />
      </motion.div>
    </AnimatePresence>
  )
}

/** Shown only if a channel module hasn't resolved yet. */
function ChannelTuning({ name }: { name: string }): React.ReactElement {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: PS1.void,
      }}
    >
      <span
        className="ps1-plate"
        style={{ color: PS1.textDim, fontSize: 'clamp(10px, 1.2vw, 14px)' }}
      >
        <span style={{ animation: 'blink 1.2s step-end infinite' }}>_</span> Tuning {name}
      </span>
    </div>
  )
}
