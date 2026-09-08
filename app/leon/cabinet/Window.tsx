'use client'

import { motion } from 'motion/react'
import { ARCADE, FONTS } from '../ps1/theme'
import { scaledViewport } from '../ps1/hudScale'

// The cabinet has exactly one window shape.
//
// Leaderboard and menu are the same object at the same size, so the race
// behind is occluded by exactly as much either way and there is only one modal
// idiom in the whole product. The backdrop is a fade rather than a blackout on
// purpose: the race keeps running underneath and stays legible through it,
// which is what tells the room the screen is still alive while somebody stands
// in front of it reading an install command.

const WINDOW_WIDTH_PX = 880

interface WindowProps {
  readonly title: string
  readonly subtitle?: string
  readonly onClose: () => void
  /** Controls that belong to the window's own header, left of the close button. */
  readonly header?: React.ReactNode
  readonly children: React.ReactNode
}

export function Window({
  title,
  subtitle,
  onClose,
  header,
  children,
}: WindowProps): React.ReactElement {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.14 }}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 90,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '88px 32px 32px',
      }}
    >
      <div
        onClick={onClose}
        style={{ position: 'absolute', inset: 0, background: 'rgba(4, 4, 8, 0.62)' }}
      />

      <motion.div
        role="dialog"
        aria-label={title}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 6 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
        style={{
          position: 'relative',
          // The frame, not the contents, is what has to fit the screen — and
          // inside a zoomed layer a raw vw is 35% too wide. See scaledViewport.
          width: `min(${WINDOW_WIDTH_PX}px, ${scaledViewport('vw', 80)})`,
          maxHeight: scaledViewport('vh', 140),
          background: ARCADE.ground,
          boxShadow: `inset 0 0 0 2px ${ARCADE.rule}, 8px 8px 0 rgba(0, 0, 0, 0.75)`,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '18px',
            padding: '14px 18px',
            borderBottom: `2px solid ${ARCADE.rule}`,
          }}
        >
          <div>
            <div
              className="gt-label"
              style={{
                fontFamily: FONTS.hud,
                fontSize: '26px',
                letterSpacing: '0.12em',
                color: ARCADE.value,
              }}
            >
              {title}
            </div>
            {subtitle !== undefined && (
              <span className="arc-caption" style={{ fontSize: '12px', color: ARCADE.grey }}>
                {subtitle}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {header}
            <button
              type="button"
              onClick={onClose}
              className="gt-label"
              style={{
                height: '40px',
                padding: '0 18px',
                border: 'none',
                background: ARCADE.amber,
                color: '#000',
                fontFamily: FONTS.hud,
                fontSize: '14px',
                letterSpacing: '0.14em',
              }}
            >
              Close — Esc
            </button>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{children}</div>
      </motion.div>
    </motion.div>
  )
}
