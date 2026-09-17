'use client'

import { motion } from 'motion/react'
import { ARCADE, FONTS, UI_TYPE } from '../ps1/theme'
import { scaledViewport } from '../ps1/hudScale'

// The cabinet has exactly one window shape.
//
// Leaderboard and menu are the same object at the same size, so the race
// behind is occluded by exactly as much either way and there is only one modal
// idiom in the whole product. The backdrop is a fade rather than a blackout on
// purpose: the race keeps running underneath and stays legible through it,
// which is what tells the room the screen is still alive while somebody stands
// in front of it reading an install command.
//
// In the stacked layout the same window is drawn inline: no backdrop, no
// floating frame, no close button — the tab row above it is the way between
// windows — just the header and a scrolling body filling whatever is under
// the race.

const WINDOW_WIDTH_PX = 880

interface WindowProps {
  readonly title: string
  readonly subtitle?: string
  readonly onClose: () => void
  /** Controls that belong to the window's own header, left of the close button. */
  readonly header?: React.ReactNode
  /** Draw as a panel filling its parent rather than as a floating dialog. */
  readonly inline?: boolean
  readonly children: React.ReactNode
}

function WindowHeader({
  title,
  subtitle,
  header,
  onClose,
  inline,
}: Omit<WindowProps, 'children'>): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '18px',
        padding: inline ? '12px 14px' : '14px 18px',
        borderBottom: `2px solid ${ARCADE.rule}`,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          className="gt-label"
          style={{
            fontFamily: FONTS.body,
            fontSize: `${UI_TYPE.title}px`,
            letterSpacing: '0.12em',
            color: ARCADE.value,
          }}
        >
          {title}
        </div>
        {subtitle !== undefined && (
          <span className="arc-caption" style={{ fontSize: `${UI_TYPE.caption}px`, color: ARCADE.grey }}>
            {subtitle}
          </span>
        )}
      </div>

      {(header !== undefined || !inline) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {header}
          {!inline && (
            <button
              type="button"
              onClick={onClose}
              className="gt-label"
              style={{
                height: '44px',
                padding: '0 18px',
                border: 'none',
                background: ARCADE.amber,
                color: '#000',
                fontFamily: FONTS.body,
                fontSize: `${UI_TYPE.body}px`,
                letterSpacing: '0.14em',
              }}
            >
              Close — Esc
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function Window(props: WindowProps): React.ReactElement {
  const { title, onClose, inline = false, children } = props

  if (inline) {
    return (
      <section
        aria-label={title}
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}
      >
        <WindowHeader {...props} />
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{children}</div>
      </section>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.14 }}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '84px 32px 32px',
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
          // inside a zoomed layer a raw vw is too wide by the zoom. See
          // scaledViewport.
          width: `min(${WINDOW_WIDTH_PX}px, ${scaledViewport('vw', 64)})`,
          maxHeight: scaledViewport('vh', 116),
          background: ARCADE.ground,
          boxShadow: `inset 0 0 0 2px ${ARCADE.rule}, 8px 8px 0 rgba(0, 0, 0, 0.75)`,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <WindowHeader {...props} />
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{children}</div>
      </motion.div>
    </motion.div>
  )
}
