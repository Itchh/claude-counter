'use client'

import { motion } from 'motion/react'
import { CHANNELS, channelNumber } from './ChannelRegistry'
import { GT } from '../ps1/theme'
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
      <span className="gt-ident" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span
          className="gt-label"
          style={{
            fontSize: 'clamp(10px, 1.1vw, 13px)',
            color: GT.label,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          CH {channelNumber(index)}
        </span>
        <span
          className="gt-label"
          style={{ fontSize: 'clamp(9px, 1vw, 12px)', color: GT.value }}
        >
          {name}
        </span>
      </span>

      <div
        style={{
          width: '92px',
          height: '3px',
          background: '#05050a',
          boxShadow: 'inset 1px 1px 0 0 #000',
        }}
      >
        <motion.div
          key={cycleKey}
          initial={{ width: '100%' }}
          animate={{ width: '0%' }}
          transition={{ duration: dwellSeconds, ease: 'linear' }}
          style={{ height: '100%', background: GT.label, opacity: 0.7 }}
        />
      </div>

      <span
        className="gt-label"
        style={{ fontSize: '8px', color: GT.valueDim, letterSpacing: '0.18em' }}
      >
        ←/→ or 1–{CHANNELS.length}
      </span>
    </div>
  )
}
