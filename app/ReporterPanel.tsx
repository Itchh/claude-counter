'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'

const REPO_RAW_BASE =
  'https://raw.githubusercontent.com/Itchh/claude-counter/master/reporter'
const REPORTER_DIR = '~/.local/share/claude-leaderboard-reporter/reporter'

const COPIED_RESET_MS = 1600

type Tone = 'primary' | 'neutral' | 'danger'

type ReporterCommand = {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly command: string
  readonly tone: Tone
}

const COMMANDS: readonly ReporterCommand[] = [
  {
    id: 'deploy',
    label: 'RE-DEPLOY REPORTER',
    hint: 'Reinstalls / updates the agent. Safe to re-run any time.',
    command: `curl -fsSL ${REPO_RAW_BASE}/install.sh | bash`,
    tone: 'primary',
  },
  {
    id: 'restart',
    label: 'RESTART AGENT',
    hint: 'Bounce the launchd agent without reinstalling.',
    command: `cd ${REPORTER_DIR} && bun restart`,
    tone: 'neutral',
  },
  {
    id: 'logs',
    label: 'TAIL LOGS',
    hint: 'Watch what the reporter is actually doing.',
    command: `cd ${REPORTER_DIR} && bun logs`,
    tone: 'neutral',
  },
  {
    id: 'uninstall',
    label: 'UNINSTALL',
    hint: 'Stops the agent and removes config, cache, and logs.',
    command: `curl -fsSL ${REPO_RAW_BASE}/uninstall.sh | bash`,
    tone: 'danger',
  },
]

const TONE_COLOR: Record<Tone, string> = {
  primary: '#ff2d95',
  neutral: '#00f0ff',
  danger: '#ff5e2d',
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch (error) {
    console.error('Clipboard write failed', error)
    return false
  }
}

function CommandRow({ entry }: { entry: ReporterCommand }): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const color = TONE_COLOR[entry.tone]

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), COPIED_RESET_MS)
    return () => clearTimeout(id)
  }, [copied])

  const handleCopy = async (): Promise<void> => {
    const ok = await copyToClipboard(entry.command)
    if (ok) setCopied(true)
  }

  return (
    <div
      style={{
        borderTop: '1px solid #1a1a3a',
        padding: '12px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
        <span style={{ color, fontSize: '12px', letterSpacing: '0.12em' }}>{entry.label}</span>
        <button
          type="button"
          onClick={handleCopy}
          style={{
            background: copied ? `${color}22` : 'transparent',
            border: `1px solid ${copied ? color : '#2a2a4a'}`,
            color: copied ? color : '#7a7a9e',
            font: 'inherit',
            fontSize: '10px',
            letterSpacing: '0.14em',
            padding: '4px 10px',
            cursor: 'pointer',
          }}
        >
          {copied ? 'COPIED' : 'COPY'}
        </button>
      </div>
      <code
        style={{
          color: '#8a8ab0',
          fontSize: '11px',
          lineHeight: 1.5,
          wordBreak: 'break-all',
          background: '#0c0c18',
          border: '1px solid #15152c',
          padding: '8px 10px',
        }}
      >
        {entry.command}
      </code>
      <span style={{ color: '#4a4a6a', fontSize: '10px', letterSpacing: '0.06em' }}>{entry.hint}</span>
    </div>
  )
}

export function ReporterPanel(): React.ReactElement {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="Reporter maintenance commands"
        style={{
          position: 'fixed',
          top: '16px',
          right: '16px',
          zIndex: 60,
          background: open ? 'rgba(255, 45, 149, 0.14)' : 'rgba(8, 8, 15, 0.8)',
          border: `1px solid ${open ? '#ff2d95' : '#2a2a4a'}`,
          color: open ? '#ff2d95' : '#7a7a9e',
          fontFamily: 'inherit',
          fontSize: '11px',
          letterSpacing: '0.16em',
          padding: '7px 12px',
          cursor: 'pointer',
        }}
      >
        ⟳ REPORTER
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
              style={{
                position: 'fixed',
                inset: 0,
                zIndex: 55,
                background: 'rgba(4, 4, 10, 0.6)',
              }}
            />
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.18 }}
              style={{
                position: 'fixed',
                top: '56px',
                right: '16px',
                zIndex: 60,
                width: 'min(420px, calc(100vw - 32px))',
                maxHeight: 'calc(100vh - 88px)',
                overflowY: 'auto',
                background: '#08080f',
                border: '1px solid #2a2a4a',
                boxShadow: '0 0 24px rgba(255, 45, 149, 0.18)',
                padding: '16px 18px 18px',
                fontFamily:
                  "ui-monospace, 'Cascadia Code', 'Courier New', Courier, monospace",
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#c0c0e0', fontSize: '12px', letterSpacing: '0.18em' }}>
                  REPORTER MAINTENANCE
                </span>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#5e5e7e',
                    font: 'inherit',
                    fontSize: '13px',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  ✕
                </button>
              </div>
              <p style={{ color: '#4a4a6a', fontSize: '10px', lineHeight: 1.6, margin: '8px 0 4px', letterSpacing: '0.06em' }}>
                Run these in a terminal on the Mac that reports. Browsers can&apos;t
                execute local scripts, so copy and paste.
              </p>
              {COMMANDS.map((entry) => (
                <CommandRow key={entry.id} entry={entry} />
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  )
}
