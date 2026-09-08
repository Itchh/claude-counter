'use client'

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import type { LeaderboardEvent } from '@/types'
import { eventText } from '@/lib/eventText'
import { ARCADE, PS1 } from './ps1/theme'

const TOAST_DURATION_MS = 6_000
const MAX_VISIBLE_TOASTS = 3

interface Toast {
  id: string
  text: string
  color: string
}

export function Toasts({ events }: { events: ReadonlyArray<LeaderboardEvent> | undefined }): React.ReactElement {
  const [toasts, setToasts] = useState<ReadonlyArray<Toast>>([])
  // Events that existed when the page loaded shouldn't toast — only ones that
  // arrive while watching. Seeding `seen` on the first payload handles that
  // without relying on client/server clocks agreeing.
  const seenIds = useRef<Set<string> | null>(null)

  useEffect(() => {
    if (!events) return

    if (seenIds.current === null) {
      seenIds.current = new Set(events.map((e) => e.id))
      return
    }

    const fresh = events.filter(
      (e) =>
        !seenIds.current?.has(e.id) &&
        (e.type === 'milestone' || e.type === 'new_leader'),
    )
    if (fresh.length === 0) return

    for (const event of events) {
      seenIds.current.add(event.id)
    }

    const newToasts: ReadonlyArray<Toast> = fresh.map((event) => ({
      id: event.id,
      text: eventText(event),
      color: event.color ?? (event.type === 'new_leader' ? PS1.hot : PS1.cyan),
    }))

    setToasts((current) =>
      [...newToasts, ...current].slice(0, MAX_VISIBLE_TOASTS),
    )

    const timers = newToasts.map((toast) =>
      setTimeout(() => {
        setToasts((current) => current.filter((t) => t.id !== toast.id))
      }, TOAST_DURATION_MS),
    )
    return () => timers.forEach(clearTimeout)
  }, [events])

  return (
    <div
      style={{
        position: 'fixed',
        top: '72px',
        right: '36px',
        zIndex: 110,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        pointerEvents: 'none',
      }}
    >
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, x: 60, scale: 0.95 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 60, transition: { duration: 0.25 } }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            className="arc-inset"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              // The kit frames a panel and lets the ground show through, so
              // the toast is a black plate with a black frame — the event's
              // colour appears once, as a chip, and nowhere else.
              background: ARCADE.groundDeep,
              padding: '10px 18px',
              fontSize: 'clamp(10px, 1.2vw, 14px)',
            }}
          >
            <span
              style={{
                width: '10px',
                height: '10px',
                flex: '0 0 auto',
                background: toast.color,
                boxShadow: `0 0 0 2px ${ARCADE.outline}`,
              }}
            />
            <span className="arc-value" style={{ fontSize: 'inherit' }}>
              {toast.text}
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
