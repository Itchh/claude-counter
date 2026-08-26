'use client'

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import type { LeaderboardEvent } from '@/types'
import { eventText } from '@/lib/eventText'
import { PS1 } from './ps1/theme'

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
            className="ps1-plate"
            style={{
              background: PS1.panel,
              border: `2px solid ${toast.color}`,
              boxShadow: `0 0 12px ${toast.color}40, inset 2px 2px 0 0 ${PS1.bevelLight}, inset -2px -2px 0 0 ${PS1.bevelDark}`,
              color: toast.color,
              textShadow: `0 0 8px ${toast.color}60`,
              padding: '10px 18px',
              fontSize: 'clamp(10px, 1.2vw, 14px)',
              fontFamily:
                "ui-monospace, 'Cascadia Code', 'Courier New', Courier, monospace",
            }}
          >
            {toast.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
