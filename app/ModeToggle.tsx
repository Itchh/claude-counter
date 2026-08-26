'use client'

import { motion } from 'motion/react'
import { useMode } from './ModeProvider'

const ACTIVE_COLOR = '#ff2d95'
const IDLE_COLOR = '#5e5e7e'

export function ModeToggle(): React.ReactElement {
  const { mode, toggleMode } = useMode()
  const isLeon = mode === 'leon'

  return (
    <button
      type="button"
      onClick={toggleMode}
      aria-pressed={isLeon}
      title="Toggle Leon mode"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        background: 'transparent',
        border: `1px solid ${isLeon ? ACTIVE_COLOR : '#1a1a3a'}`,
        color: isLeon ? ACTIVE_COLOR : IDLE_COLOR,
        font: 'inherit',
        fontSize: 'clamp(9px, 1vw, 12px)',
        letterSpacing: '0.2em',
        padding: '5px 10px',
        cursor: 'default',
        textShadow: isLeon ? `0 0 10px ${ACTIVE_COLOR}80` : 'none',
      }}
    >
      <span
        style={{
          width: '22px',
          height: '10px',
          border: `1px solid ${isLeon ? ACTIVE_COLOR : '#2a2a4a'}`,
          display: 'inline-flex',
          alignItems: 'center',
          padding: '1px',
          justifyContent: isLeon ? 'flex-end' : 'flex-start',
        }}
      >
        <motion.span
          layout
          transition={{ type: 'spring', stiffness: 500, damping: 32 }}
          style={{
            width: '6px',
            height: '6px',
            background: isLeon ? ACTIVE_COLOR : IDLE_COLOR,
            boxShadow: isLeon ? `0 0 6px ${ACTIVE_COLOR}` : 'none',
          }}
        />
      </span>
      LEON MODE
    </button>
  )
}
