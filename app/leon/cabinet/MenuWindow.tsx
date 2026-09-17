'use client'

import { useEffect, useState } from 'react'
import { ARCADE, FONTS, GT, PS1, UI_TYPE } from '../ps1/theme'
import { REPORTER_COMMANDS, type CommandTone, type ReporterCommand } from './reporterCommands'
import { gameInfo, type CabinetScreen } from './games'

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
      { keys: ['G'], label: 'Game', detail: 'Flick to the next cartridge without visiting the shelf.' },
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
  fontFamily: FONTS.body,
  fontSize: `${UI_TYPE.prose}px`,
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
        fontFamily: FONTS.body,
        fontSize: `${UI_TYPE.body}px`,
        minWidth: '34px',
        height: '34px',
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
        <span className="gt-label" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.body}px`, color }}>
          {entry.label}
        </span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="gt-label"
          style={{
            height: '36px',
            padding: '0 14px',
            border: 'none',
            background: copied ? color : '#2c2c34',
            color: copied ? '#000' : ARCADE.silver,
            fontFamily: FONTS.body,
            fontSize: `${UI_TYPE.caption}px`,
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
          fontSize: `${UI_TYPE.prose}px`,
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

interface MenuWindowProps {
  /** What the screen is showing: a game, or the shelf itself. */
  readonly screen: CabinetScreen
  readonly onBackToShelf: () => void
  /** Whether the broadcast's sound is armed. */
  readonly audioOn: boolean
  readonly onToggleAudio: () => void
}

/** The two options share one button treatment; this is it. */
function optionStyle(isOn: boolean): React.CSSProperties {
  return {
    textAlign: 'left',
    border: 'none',
    padding: '12px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
    background: isOn ? '#2c2c34' : ARCADE.ground,
    boxShadow: isOn
      ? `inset 0 0 0 2px ${ARCADE.amber}, 2px 2px 0 ${ARCADE.outline}`
      : `inset 2px 2px 0 0 ${GT.metalHi}, inset -2px -2px 0 0 ${GT.metalLo}`,
  }
}

/**
 * Sound. It used to be a chip on the race HUD, which put a setting in the
 * instrument cluster and cost a corner of the picture to say something that
 * is set once. Here it is a menu item — and a click here is still the user
 * gesture the browser needs before it will play anything.
 */
function SoundSelect({
  audioOn,
  onToggleAudio,
}: Pick<MenuWindowProps, 'audioOn' | 'onToggleAudio'>): React.ReactElement {
  const options = [
    { on: false, name: 'Sound off', blurb: 'The broadcast runs silent.' },
    { on: true, name: 'Sound on', blurb: 'Engines and the crowd, from the car the camera is on.' },
  ] as const
  return (
    <section style={{ background: ARCADE.groundDeep, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <span className="gt-label" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.heading}px`, color: ARCADE.label }}>
        Sound
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
        {options.map((option) => {
          const isOn = option.on === audioOn
          return (
            <button
              key={option.name}
              type="button"
              aria-pressed={isOn}
              onClick={() => {
                if (!isOn) onToggleAudio()
              }}
              style={optionStyle(isOn)}
            >
              <span
                className="gt-label"
                style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.body}px`, color: isOn ? ARCADE.amber : ARCADE.value }}
              >
                {isOn ? '\u25B8 ' : ''}
                {option.name}
              </span>
              <span style={PROSE}>{option.blurb}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

/**
 * The way to another game is the shelf, not a list: the menu names what is
 * in the machine and offers to put it back. The library itself lives in
 * games.ts, and the shelf draws it.
 */
function ShelfRow({ screen, onBackToShelf }: Pick<MenuWindowProps, 'screen' | 'onBackToShelf'>): React.ReactElement {
  const current = screen !== 'shelf' ? gameInfo(screen) : null
  return (
    <section style={{ background: ARCADE.groundDeep, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <span className="gt-label" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.heading}px`, color: ARCADE.label }}>
        Game
      </span>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: '10px' }}>
        <div style={{ ...optionStyle(true), flex: 1, cursor: 'default' }}>
          <span
            className="gt-label"
            style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.body}px`, color: ARCADE.amber }}
          >
            {current ? `▸ ${current.name}` : '▸ The Shelf'}
          </span>
          <span style={PROSE}>
            {current ? current.blurb : 'Browsing the library.'}
          </span>
        </div>
        {current !== null && (
          <button
            type="button"
            onClick={onBackToShelf}
            style={{ ...optionStyle(false), flex: 1, justifyContent: 'center' }}
          >
            <span
              className="gt-label"
              style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.body}px`, color: ARCADE.value }}
            >
              Back to Shelf
            </span>
            <span style={PROSE}>Put the cartridge back and pick another game.</span>
          </button>
        )}
      </div>
    </section>
  )
}

export function MenuWindow({ screen, onBackToShelf, audioOn, onToggleAudio }: MenuWindowProps): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', background: ARCADE.rule }}>
      <ShelfRow screen={screen} onBackToShelf={onBackToShelf} />
      <SoundSelect audioOn={audioOn} onToggleAudio={onToggleAudio} />
      <MenuColumns />
    </div>
  )
}

function MenuColumns(): React.ReactElement {
  return (
    <div className="cab-menu-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px', background: ARCADE.rule }}>
      <section style={{ background: ARCADE.groundDeep, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <span className="gt-label" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.heading}px`, color: ARCADE.label }}>
          Controls
        </span>
        {CONTROL_GROUPS.map((group) => (
          <div key={group.title} style={{ display: 'flex', flexDirection: 'column', gap: '9px' }}>
            <span className="arc-caption" style={{ fontSize: `${UI_TYPE.caption}px` }}>
              {group.title}
            </span>
            {group.entries.map((entry) => (
              <div key={entry.label} style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                <span style={{ display: 'flex', gap: '3px', minWidth: '150px', flexWrap: 'wrap' }}>
                  {entry.keys.map((glyph) => (
                    <KeyCap key={`${entry.label}-${glyph}`} glyph={glyph} />
                  ))}
                </span>
                <span style={{ flex: 1 }}>
                  <span
                    className="gt-label"
                    style={{ display: 'block', fontFamily: FONTS.body, fontSize: `${UI_TYPE.body}px`, color: ARCADE.value }}
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
          <span className="gt-label" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.heading}px`, color: ARCADE.label }}>
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
