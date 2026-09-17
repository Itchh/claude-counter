'use client'

import { useEffect, useRef, useState } from 'react'

// The loading bar, as the machine's own. It sits between pressing start and
// the shelf, and it is the one thing on the boot screen that is telling the
// truth about what the cabinet is doing.
//
// Three things make a loader read as period rather than as a progress
// indicator from a web page. It is built from discrete blocks, because a
// console drew one block per chunk read and could not draw half of one. It
// stalls: the blocks arrive in a rush and then stop dead at a stage boundary
// while the next thing is found, which is what a disc actually sounded like.
// And it names what it is doing, because these screens always did — a bar on
// its own is a shrug, a bar over READING DISC is a machine reporting in.
//
// The last block is real. Everything before it is a schedule, but the bar
// will not draw the final block while `hold` is true, so the screen genuinely
// cannot be left until the cabinet's first round-trip has landed — which is
// the whole reason there is a gate here at all. If that round-trip never
// arrives the bar gives up after HOLD_LIMIT_MS and lets the cabinet show its
// own empty state, because a boot screen that never ends is worse than a
// leaderboard with nobody on it.

/** Blocks in the track. Chunky enough that each one is a visible event. */
const SEGMENTS = 28
/** Milliseconds per block within a stage. */
const STEP_MS = 38
/** The dead stop at a stage boundary. */
const STALL_MS = 210
/** How long the full bar is held before the screen wipes. */
const SETTLE_MS = 300
/** How long the last block waits on real work before giving up on it. */
const HOLD_LIMIT_MS = 6000

interface Stage {
  readonly label: string
  /** The block this stage finishes on. */
  readonly through: number
}

const STAGES: ReadonlyArray<Stage> = [
  { label: 'READING DISC', through: 8 },
  { label: 'DECOMPRESSING', through: 16 },
  { label: 'BUILDING GRID', through: 23 },
  { label: 'SPINNING UP', through: SEGMENTS },
]

const BOUNDARIES = new Set(STAGES.map((stage) => stage.through))

function stageLabel(filled: number): string {
  const stage = STAGES.find((candidate) => filled < candidate.through)
  return (stage ?? STAGES[STAGES.length - 1]).label
}

export interface LoadingBarProps {
  /** The game's key colour. The filled blocks are cut from it. */
  readonly accent: string
  /** True while real work is outstanding — parks the bar on its last block. */
  readonly hold?: boolean
  /** Fired once the bar is full and has been held for a beat. */
  readonly onComplete: () => void
}

export function LoadingBar({ accent, hold = false, onComplete }: LoadingBarProps): React.ReactElement {
  const [filled, setFilled] = useState(0)
  const [waiting, setWaiting] = useState(false)

  // Both read through refs so the timer is started once and never restarted:
  // `hold` flips the moment data lands, and a timer that rebuilt itself on
  // that would drop whichever step was in flight.
  const holdRef = useRef(hold)
  holdRef.current = hold
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let progress = 0
    let parkedSince: number | null = null

    const step = (): void => {
      if (cancelled) return

      // The last block: drawn only once the real work is in, or once the wait
      // has gone on long enough that it plainly is not coming.
      if (progress === SEGMENTS - 1 && holdRef.current) {
        parkedSince ??= Date.now()
        if (Date.now() - parkedSince < HOLD_LIMIT_MS) {
          setWaiting(true)
          timer = setTimeout(step, STEP_MS)
          return
        }
        console.warn('Boot: first query did not land in time, opening the cabinet anyway')
      }

      setWaiting(false)
      progress += 1
      setFilled(progress)

      if (progress >= SEGMENTS) {
        timer = setTimeout(() => {
          if (!cancelled) onCompleteRef.current()
        }, SETTLE_MS)
        return
      }
      timer = setTimeout(step, BOUNDARIES.has(progress) ? STALL_MS : STEP_MS)
    }

    timer = setTimeout(step, STEP_MS)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])

  const percent = Math.round((filled / SEGMENTS) * 100)
  const label = waiting ? 'WAITING FOR DISC' : stageLabel(filled)

  return (
    <div
      role="progressbar"
      aria-label="Loading"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${label} ${percent}%`}
      style={{
        width: 'min(520px, 62vw)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'clamp(6px, 0.9vh, 10px)',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          display: 'flex',
          gap: '2px',
          padding: '3px',
          height: 'clamp(16px, 2.2vh, 24px)',
          background: 'rgba(0, 0, 0, 0.55)',
          boxShadow: 'inset 0 0 0 2px rgba(255, 255, 255, 0.82)',
        }}
      >
        {Array.from({ length: SEGMENTS }, (_, index) => {
          const lit = index < filled
          // The block that has just landed reads white — the head of the
          // read, which is what gives the fill its direction at a glance.
          const head = lit && index === filled - 1 && filled < SEGMENTS
          return (
            <span
              key={index}
              style={{
                flex: 1,
                background: head ? '#ffffff' : lit ? accent : 'rgba(255, 255, 255, 0.07)',
              }}
            />
          )
        })}
      </div>

      <div
        aria-hidden="true"
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: '12px',
          fontSize: 'clamp(11px, 1.15vw, 15px)',
          letterSpacing: '0.18em',
          color: '#ffffff',
        }}
      >
        {/* titleBlink is the card's own keyframe, declared by the card this
            bar is always drawn inside — the same blink the start prompt uses. */}
        <span style={{ animation: waiting ? 'titleBlink 1.05s steps(1, end) infinite' : 'none' }}>
          {label}
        </span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{percent}%</span>
      </div>
    </div>
  )
}
