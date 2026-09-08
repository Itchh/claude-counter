'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { GT, PS1, PS1_TYPE } from './ps1/theme'
import { SCALED_CHROME, scaledViewport } from './ps1/hudScale'
import { useInteractionSignal } from './ps1/navigation'

// How to get on the board, and how to get off it.
//
// The leaderboard has one hard dependency the screen itself cannot satisfy:
// somebody has to install the reporter on their own machine. Without a way in
// from the picture, that instruction lives in a README nobody standing in
// front of the wall can read — so the cabinet carries it, in the corner, as a
// panel that opens on demand and gets out of the way otherwise.
//
// Nothing here runs anything. The commands are copied to the clipboard and
// pasted into a terminal by the person who wants them, which is the only
// honest way to hand someone a `curl … | bash`: they should see it before it
// runs, and they should run it themselves.

const REPO_RAW_BASE = 'https://raw.githubusercontent.com/Itchh/claude-counter/master/reporter'
const REPORTER_DIR = '~/.local/share/claude-leaderboard-reporter/reporter'

const COPIED_RESET_MS = 1600

type Tone = 'go' | 'neutral' | 'stop'

interface ReporterCommand {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly command: string
  readonly tone: Tone
}

/**
 * Ordered as the two things somebody actually walks up wanting — join, or
 * leave — with the day-to-day maintenance underneath. The install command is
 * also the update command, which is worth saying out loud: people re-run it
 * expecting to be told off and are instead brought up to date.
 */
const COMMANDS: ReadonlyArray<ReporterCommand> = [
  {
    id: 'install',
    label: 'Install',
    hint: 'macOS. Installs the background agent and enters you on the board. Safe to re-run — this is also how you update.',
    command: `curl -fsSL ${REPO_RAW_BASE}/install.sh | bash`,
    tone: 'go',
  },
  {
    id: 'uninstall',
    label: 'Uninstall',
    hint: 'Stops the agent and removes the install directory, config, cache and logs.',
    command: `curl -fsSL ${REPO_RAW_BASE}/uninstall.sh | bash`,
    tone: 'stop',
  },
  {
    id: 'restart',
    label: 'Restart agent',
    hint: 'Bounce it without reinstalling.',
    command: `cd ${REPORTER_DIR} && bun restart`,
    tone: 'neutral',
  },
  {
    id: 'logs',
    label: 'Tail logs',
    hint: 'Watch what the reporter is actually doing.',
    command: `cd ${REPORTER_DIR} && bun logs`,
    tone: 'neutral',
  },
]

const TONE_COLOR: Readonly<Record<Tone, string>> = {
  go: PS1.green,
  neutral: GT.label,
  stop: PS1.red,
}

/**
 * Running text inside the console chrome. Everything else in this cabinet is
 * an instrument label, and the class that styles those is uppercase and
 * unwrappable by design — neither of which a sentence survives.
 */
const PROSE = {
  color: GT.valueDim,
  lineHeight: 1.6,
  letterSpacing: '0.04em',
  whiteSpace: 'normal',
  textTransform: 'none',
} as const

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (error) {
    // Clipboard access is refused outside a secure context and in some
    // embedded webviews. Saying so beats a button that silently does nothing.
    console.error('Clipboard write failed', error)
    return false
  }
}

function CommandRow({ entry }: { readonly entry: ReporterCommand }): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const color = TONE_COLOR[entry.tone]

  useEffect(() => {
    if (!copied && !failed) return
    const id = setTimeout(() => {
      setCopied(false)
      setFailed(false)
    }, COPIED_RESET_MS)
    return () => clearTimeout(id)
  }, [copied, failed])

  const handleCopy = async (): Promise<void> => {
    const ok = await copyToClipboard(entry.command)
    if (ok) setCopied(true)
    else setFailed(true)
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
        padding: '11px 0',
        boxShadow: 'inset 0 1px 0 0 rgba(160, 160, 175, 0.22)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
        <span className="gt-label" style={{ fontSize: `${PS1_TYPE.label}px`, color }}>
          {entry.label}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="gt-label"
          style={{
            background: copied ? `${color}22` : 'transparent',
            border: `1px solid ${copied ? color : 'rgba(160, 160, 175, 0.35)'}`,
            color: copied ? color : GT.valueDim,
            font: 'inherit',
            fontSize: `${PS1_TYPE.micro}px`,
            padding: '3px 9px',
            cursor: 'pointer',
          }}
        >
          {copied ? 'Copied' : failed ? 'Blocked' : 'Copy'}
        </button>
      </div>

      {/* The command is shown, not hidden behind the button. A one-line pipe
          into bash is a reasonable thing to hand someone and an unreasonable
          thing to conceal. */}
      <code
        style={{
          display: 'block',
          fontFamily: "ui-monospace, 'Cascadia Code', 'Courier New', monospace",
          fontSize: `${PS1_TYPE.micro}px`,
          lineHeight: 1.5,
          color: GT.value,
          wordBreak: 'break-all',
          background: '#04040a',
          boxShadow: 'inset 0 0 0 1px rgba(160, 160, 175, 0.22)',
          padding: '7px 9px',
        }}
      >
        {entry.command}
      </code>

      {/* Prose, so deliberately not `gt-label`: that class sets uppercase and
          `white-space: nowrap`, which are right for a one-word instrument
          label and wrong for a sentence — the nowrap ran every hint straight
          off the side of the panel. Caps are for the labels above. */}
      <span style={{ ...PROSE, fontSize: `${PS1_TYPE.micro}px` }}>{entry.hint}</span>
    </div>
  )
}

export function ReporterPanel(): React.ReactElement {
  const [open, setOpen] = useState(false)
  // The deck rotates channels on a timer. Someone reading a shell command off
  // the wall and copying it into a terminal is exactly the case its override
  // exists for — see noteInteraction in ChannelDeck.
  const noteInteraction = useInteractionSignal()

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Swallowed, so the deck's own Escape handler does not also fire and
        // yank the camera back from the viewer in the same keystroke.
        event.stopPropagation()
        setOpen(false)
      }
    }
    // Capture phase for the same reason: the deck listens on window too, and
    // whoever is registered first would otherwise win.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  return (
    <>
      {/* Under the channel bug rather than beside it — the top-right corner
          already belongs to the ident, and two plates on one line would read
          as one confused control. */}
      <div
        style={{
          position: 'absolute',
          top: '92px',
          right: '18px',
          zIndex: 86,
          ...SCALED_CHROME,
        }}
      >
        <button
          type="button"
          onClick={() => {
            noteInteraction()
            setOpen((previous) => !previous)
          }}
          aria-expanded={open}
          aria-label="Reporter install and uninstall instructions"
          className="gt-ident"
          style={{
            border: 'none',
            font: 'inherit',
            cursor: 'pointer',
            boxShadow: `inset 0 1px 0 0 ${open ? PS1.green : 'rgba(255, 176, 32, 0.6)'}`,
          }}
        >
          <span
            className="gt-label"
            style={{
              fontSize: `${PS1_TYPE.micro}px`,
              color: open ? PS1.green : GT.label,
              letterSpacing: '0.16em',
            }}
          >
            {open ? 'Close' : 'Get on the board'}
          </span>
        </button>
      </div>

      <AnimatePresence>
        {open && (
          <>
            {/* Click-away. Also darkens the picture behind the panel, which is
                what makes a small type panel readable over a moving race. */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={() => setOpen(false)}
              style={{ position: 'absolute', inset: 0, zIndex: 85, background: 'rgba(4, 4, 10, 0.72)' }}
            />

            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              style={{
                position: 'absolute',
                top: '130px',
                right: '18px',
                zIndex: 86,
                width: `min(400px, ${scaledViewport('vw', 60)})`,
                maxHeight: scaledViewport('vh', 210),
                overflowY: 'auto',
                padding: '14px 16px 16px',
                background: 'linear-gradient(to bottom, #04040a, #0b1e0e)',
                boxShadow: [
                  'inset 0 1px 0 0 rgba(160, 160, 175, 0.4)',
                  'inset 0 -1px 0 0 rgba(0, 0, 0, 0.9)',
                  '0 8px 0 0 rgba(0, 0, 0, 0.5)',
                ].join(', '),
                ...SCALED_CHROME,
              }}
            >
              <div className="gt-label" style={{ fontSize: `${PS1_TYPE.body}px`, color: GT.value }}>
                Reporter
              </div>
              <p style={{ ...PROSE, margin: '6px 0 4px', fontSize: `${PS1_TYPE.micro}px` }}>
                A background agent on your own Mac reads your local Claude Code usage and
                reports it here. Nothing appears on this board until you install it. Set{' '}
                <code style={{ color: GT.value }}>git config --global user.email</code> first —
                that address is your identity, and it is what merges your counts across
                machines.
              </p>

              {COMMANDS.map((entry) => (
                <CommandRow key={entry.id} entry={entry} />
              ))}

              <div
                className="gt-label"
                style={{
                  marginTop: '10px',
                  fontSize: `${PS1_TYPE.micro}px`,
                  color: GT.valueDim,
                  letterSpacing: '0.14em',
                }}
              >
                Esc to close
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  )
}
