'use client'

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import type { LeaderboardEvent } from '@/types'
import { eventText } from '@/lib/eventText'

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
      color: event.color ?? (event.type === 'new_leader' ? '#ff2d95' : '#00f0ff'),
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
    <div className="fixed top-[72px] right-9 z-[110] flex flex-col gap-2 pointer-events-none">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, x: 60, scale: 0.95 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 60, transition: { duration: 0.25 } }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            className="bg-[#12122a] border border-[var(--tc)] [box-shadow:0_0_12px_var(--ts1),0_0_30px_var(--ts2)] text-[var(--tc)] [text-shadow:0_0_8px_var(--tsh)] px-[18px] py-[10px] text-[clamp(11px,1.3vw,15px)] tracking-[0.08em] font-mono"
            style={{
              '--tc': toast.color,
              '--ts1': `${toast.color}40`,
              '--ts2': `${toast.color}20`,
              '--tsh': `${toast.color}60`,
            } as React.CSSProperties}
          >
            {toast.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}
