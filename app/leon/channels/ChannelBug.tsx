'use client'

import { motion } from 'motion/react'
import { CHANNELS, channelNumber } from './ChannelRegistry'
import { PS1 } from '../ps1/theme'

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
      }}
    >
      <div
        className="ps1-panel"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '4px 9px',
        }}
      >
        <span
          className="ps1-plate"
          style={{
            fontSize: 'clamp(9px, 1vw, 12px)',
            color: PS1.gold,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          CH {channelNumber(index)}
        </span>
        <span
          className="ps1-plate"
          style={{ fontSize: 'clamp(8px, 0.9vw, 11px)', color: PS1.textDim }}
        >
          {name}
        </span>
      </div>

      <div
        style={{
          width: '92px',
          height: '3px',
          background: PS1.panelDeep,
          boxShadow: 'inset 1px 1px 0 0 #0a0a18',
        }}
      >
        <motion.div
          key={cycleKey}
          initial={{ width: '100%' }}
          animate={{ width: '0%' }}
          transition={{ duration: dwellSeconds, ease: 'linear' }}
          style={{ height: '100%', background: PS1.cyan, opacity: 0.55 }}
        />
      </div>

      <span
        className="ps1-plate"
        style={{ fontSize: '7px', color: PS1.textFaint, letterSpacing: '0.18em' }}
      >
        ←/→ or 1–{CHANNELS.length}
      </span>
    </div>
  )
}
