'use client'

import { useEffect, useState } from 'react'
import { ARCADE, FONTS, GT, PS1 } from '../ps1/theme'
import { REPORTER_COMMANDS, type CommandTone, type ReporterCommand } from './reporterCommands'

// Everything the cabinet knows how to tell a person, in one place.
//
// Both halves of this used to be permanent furniture on a live picture: the
// key prompts ran along the foot of the deck, and the reporter commands hid in
// a corner panel. Between them they still never said what WASD did. Folding
// them into a window returns the corners to the race, gives the instructions
// room to be sentences rather than glyphs, and puts them somewhere a person
// deliberately goes — which is also the only moment they are reading rather
// than watching.

const COPIED_RESET_MS = 1600

const TONE_COLOR: Readonly<Record<CommandTone, string>> = {
  go: PS1.green,
  neutral: GT.label,
  stop: PS1.red,
}

interface ControlEntry {
  readonly keys: ReadonlyArray<string>
  readonly label: string
  readonly detail: string
}

interface ControlGroup {
  readonly title: string
  readonly entries: ReadonlyArray<ControlEntry>
}

const CONTROL_GROUPS: ReadonlyArray<ControlGroup> = [
  {
    title: 'Cabinet',
    entries: [
      { keys: ['L'], label: 'Leaderboard', detail: 'Open the board over the race. Same as the button.' },
      { keys: ['M'], label: 'Menu', detail: 'This window.' },
      { keys: ['Esc'], label: 'Close', detail: 'Close whichever window is open and resume the broadcast.' },
      { keys: ['1–9'], label: 'Player', detail: 'Ride with a driver by their place in the order. Same digit again hands the camera back.' },
    ],
  },
  {
    title: 'Race camera',
    entries: [
      { keys: ['W', 'A', 'S', 'D'], label: 'Free camera', detail: 'The first press detaches from the automatic director.' },
      { keys: ['Q', 'E'], label: 'Rise / drop', detail: 'Move the free camera vertically.' },
      { keys: ['Shift'], label: 'Fast', detail: 'Hold while moving to cover ground.' },
      { keys: ['C'], label: 'Resume broadcast', detail: 'Hand the camera back to the director.' },
      { keys: ['Drag'], label: 'Orbit', detail: 'Pointer drag orbits whoever the camera is following; a click picks a car.' },
    ],
  },
]

/** Prose inside console chrome. Deliberately not `gt-label`, which is
 *  uppercase and unwrappable — right for an instrument label, wrong for a
 *  sentence. */
const PROSE: React.CSSProperties = {
  display: 'block',
  fontFamily: FONTS.hud,
  fontSize: '13px',
  lineHeight: 1.6,
  letterSpacing: '0.03em',
  color: GT.valueDim,
  textTransform: 'none',
  whiteSpace: 'normal',
  margin: 0,
}

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

function KeyCap({ glyph }: { readonly glyph: string }): React.ReactElement {
  return (
    <span
      className="gt-label"
      style={{
        fontFamily: FONTS.hud,
        fontSize: '14px',
        minWidth: '30px',
        height: '30px',
        padding: '0 8px',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: ARCADE.value,
        background: '#2c2c34',
        boxShadow: `inset 2px 2px 0 0 ${GT.metalHi}, inset -2px -2px 0 0 ${GT.metalLo}`,
      }}
    >
      {glyph}
    </span>
  )
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
    <div style={{ borderLeft: `4px solid ${color}`, paddingLeft: '14px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
        <span className="gt-label" style={{ fontFamily: FONTS.hud, fontSize: '15px', color }}>
          {entry.label}
        </span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="gt-label"
          style={{
            height: '32px',
            padding: '0 14px',
            border: 'none',
            background: copied ? color : '#2c2c34',
            color: copied ? '#000' : ARCADE.silver,
            fontFamily: FONTS.hud,
            fontSize: '12px',
            letterSpacing: '0.14em',
            boxShadow: copied ? 'none' : `inset 2px 2px 0 0 ${GT.metalHi}, inset -2px -2px 0 0 ${GT.metalLo}`,
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
          fontFamily: FONTS.hud,
          fontSize: '13px',
          lineHeight: 1.5,
          color: ARCADE.telemetry,
          background: ARCADE.telemetryBed,
          padding: '7px 10px',
          wordBreak: 'break-all',
        }}
      >
        {entry.command}
      </code>

      <span style={PROSE}>{entry.hint}</span>
    </div>
  )
}

export function MenuWindow(): React.ReactElement {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px', background: ARCADE.rule }}>
      <section style={{ background: ARCADE.groundDeep, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <span className="gt-label" style={{ fontFamily: FONTS.hud, fontSize: '15px', color: ARCADE.label }}>
          Controls
        </span>
        {CONTROL_GROUPS.map((group) => (
          <div key={group.title} style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
            <span className="arc-caption" style={{ fontSize: '12px' }}>
              {group.title}
            </span>
            {group.entries.map((entry) => (
              <div key={entry.label} style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                <span style={{ display: 'flex', gap: '3px', minWidth: '128px' }}>
                  {entry.keys.map((glyph) => (
                    <KeyCap key={`${entry.label}-${glyph}`} glyph={glyph} />
                  ))}
                </span>
                <span style={{ flex: 1 }}>
                  <span
                    className="gt-label"
                    style={{ display: 'block', fontFamily: FONTS.hud, fontSize: '15px', color: ARCADE.value }}
                  >
                    {entry.label}
                  </span>
                  <span style={PROSE}>{entry.detail}</span>
                </span>
              </div>
            ))}
          </div>
        ))}
      </section>

      <section style={{ background: ARCADE.groundDeep, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div>
          <span className="gt-label" style={{ fontFamily: FONTS.hud, fontSize: '15px', color: ARCADE.label }}>
            Get on the board
          </span>
          <span style={{ ...PROSE, marginTop: '6px' }}>
            Run the install on your own Mac. A background agent reads your Claude Code sessions and
            reports totals — nothing here runs anything for you, the command is copied and you paste
            it yourself.
          </span>
        </div>
        {REPORTER_COMMANDS.map((entry) => (
          <CommandRow key={entry.id} entry={entry} />
        ))}
      </section>
    </div>
  )
}
