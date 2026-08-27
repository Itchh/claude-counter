'use client'

import { motion } from 'motion/react'
import type { LeaderboardEvent } from '@/types'
import { eventText } from '@/lib/eventText'
import { PS1 } from './ps1/theme'
import { useNavItem } from './ps1/navigation'

/** How many events the opened ticker lists. Beyond this it stops being a
 *  glance and starts being a log. */
const EXPANDED_EVENT_COUNT = 8

function eventColor(event: LeaderboardEvent): string {
  if (event.color) return event.color
  if (event.type === 'new_leader') return PS1.hot
  if (event.type === 'milestone') return PS1.cyan
  return PS1.textDim
}

function TickerItems({ events }: { events: ReadonlyArray<LeaderboardEvent> }): React.ReactElement {
  return (
    <>
      {events.map((event) => {
        const color = eventColor(event)
        return (
          <span
            key={event.id}
            style={{ display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap' }}
          >
            <span style={{ color, textShadow: `0 0 8px ${color}50` }}>
              {eventText(event)}
            </span>
            <span style={{ color: PS1.bevelLight, padding: '0 24px' }}>◆</span>
          </span>
        )
      })}
    </>
  )
}

export function Ticker({ events }: { events: ReadonlyArray<LeaderboardEvent> | undefined }): React.ReactElement {
  const nav = useNavItem('ticker')

  return (
    <motion.div
      ref={nav.ref}
      onClick={nav.focus}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, delay: 0.4 }}
      className={['ps1-panel-inset', 'ps1-plate', 'ps1-cursor', nav.isFocused ? 'ps1-cursor-on' : '']
        .filter(Boolean)
        .join(' ')}
      style={{
        position: 'relative',
        zIndex: 2,
        margin: '10px 28px 0',
        padding: '6px 0',
        overflow: 'hidden',
        fontSize: 'clamp(9px, 1.1vw, 13px)',
      }}
    >
      {!events || events.length === 0 ? (
        <span style={{ color: PS1.textFaint, paddingLeft: '36px' }}>
          {'>'} Awaiting events…
        </span>
      ) : nav.isExpanded ? (
        // Opened: the crawl stops and becomes a list. A scrolling ticker is
        // unreadable the moment you actually want to read it — the whole
        // reason to open one is to make it hold still.
        <ExpandedTicker events={events} />
      ) : (
        // Items rendered twice so the loop wraps seamlessly: when the first
        // copy has scrolled fully out, the second copy is exactly where the
        // first one started.
        <div
          style={{
            display: 'flex',
            width: 'max-content',
            animation: 'tickerScroll 40s linear infinite',
          }}
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

/** The ticker held still: newest first, one event per line. */
function ExpandedTicker({
  events,
}: {
  readonly events: ReadonlyArray<LeaderboardEvent>
}): React.ReactElement {
  return (
    <motion.div
      initial={{ height: 0 }}
      animate={{ height: 'auto' }}
      exit={{ height: 0 }}
      transition={{ duration: 0.16, ease: 'linear' }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
        padding: '2px 28px',
        overflow: 'hidden',
      }}
    >
      {events.slice(0, EXPANDED_EVENT_COUNT).map((event) => {
        const color = eventColor(event)
        return (
          <span
            key={event.id}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: '10px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            <span style={{ color: PS1.bevelLight, flex: '0 0 auto' }}>◆</span>
            <span style={{ color, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {eventText(event)}
            </span>
          </span>
        )
      })}
    </motion.div>
  )
}
