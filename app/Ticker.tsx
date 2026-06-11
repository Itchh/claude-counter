'use client'

import { motion } from 'motion/react'
import type { LeaderboardEvent } from '@/types'
import { eventText } from '@/lib/eventText'

function eventColor(event: LeaderboardEvent): string {
  if (event.color) return event.color
  if (event.type === 'new_leader') return '#ff2d95'
  if (event.type === 'milestone') return '#00f0ff'
  return '#5e5e7e'
}

function TickerItems({ events }: { events: ReadonlyArray<LeaderboardEvent> }): React.ReactElement {
  return (
    <>
      {events.map((event) => {
        const color = eventColor(event)
        return (
          <span key={event.id} className="inline-flex items-center whitespace-nowrap">
            <span
              className="[color:var(--ec)] [text-shadow:0_0_8px_var(--es)]"
              style={{ '--ec': color, '--es': `${color}50` } as React.CSSProperties}
            >
              {eventText(event)}
            </span>
            <span className="text-[#2a2a4a] px-6">◆</span>
          </span>
        )
      })}
    </>
  )
}

export function Ticker({ events }: { events: ReadonlyArray<LeaderboardEvent> | undefined }): React.ReactElement {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, delay: 0.4 }}
      className="border-t border-[#1a1a3a] py-2 overflow-hidden text-[clamp(10px,1.2vw,14px)] tracking-[0.08em]"
    >
      {!events || events.length === 0 ? (
        <span className="text-[#3a3a5a] pl-9">
          {'>'} AWAITING EVENTS...
        </span>
      ) : (
        // Items rendered twice so the loop wraps seamlessly: when the first
        // copy has scrolled fully out, the second copy is exactly where the
        // first one started.
        <div
          className="flex w-max animate-ticker-scroll hover:[animation-play-state:paused]"
          aria-hidden={false}
        >
          <TickerItems events={events} />
          <TickerItems
            events={events.map((e) => ({ ...e, id: `${e.id}-dup` }))}
          />
        </div>
      )}
    </motion.div>
  )
}
