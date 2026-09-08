'use client'

import { motion } from 'motion/react'
import { channelNumber } from './ChannelRegistry'
import { ARCADE } from '../ps1/theme'
import { SCALED_CHROME } from '../ps1/hudScale'

// The corner ident, borrowed wholesale from broadcast television: channel
// number, channel name, and a dwell bar that quietly tells the room how long
// until it flicks.

interface ChannelBugProps {
  readonly index: number
  readonly name: string
  readonly dwellSeconds: number
  /** Changes on every flick, restarting the dwell bar. */
  readonly cycleKey: number
}

export function ChannelBug({
  index,
  name,
  dwellSeconds,
  cycleKey,
}: ChannelBugProps): React.ReactElement {
  return (
    <div
      style={{
        position: 'absolute',
        top: '14px',
        right: '18px',
        zIndex: 80,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: '4px',
        ...SCALED_CHROME,
      }}
    >
      {/* Cut like the idents on the picture itself, so the cabinet's own
          chrome and the channel's chrome are drawn in one hand. */}
      {/* Red label, white value — the kit's label/value pair, doing the
          same job the broadcast ident always did. */}
      <span className="arc-inset" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 10px' }}>
        <span className="arc-label" style={{ fontSize: 'clamp(10px, 1.1vw, 13px)' }}>
          CH {channelNumber(index)}
        </span>
        <span className="arc-label-plain" style={{ fontSize: 'clamp(9px, 1vw, 12px)' }}>
          {name}
        </span>
      </span>

      <div
        style={{
          width: '92px',
          height: '3px',
          background: ARCADE.groundDeep,
          boxShadow: `0 0 0 2px ${ARCADE.outline}`,
        }}
      >
        <motion.div
          key={cycleKey}
          initial={{ width: '100%' }}
          animate={{ width: '0%' }}
          transition={{ duration: dwellSeconds, ease: 'linear' }}
          style={{ height: '100%', background: ARCADE.amber }}
        />
      </div>

      <span className="arc-meta" style={{ fontSize: '8px', letterSpacing: '0.18em' }}>
        ←/→ channel · 1–9 player
      </span>
    </div>
  )
}
