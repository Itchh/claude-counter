'use client'

import { ARCADE, FONTS, GT, UI_TYPE } from '../ps1/theme'
import { REPORTER_COMMANDS } from './reporterCommands'
import { CommandRow } from './MenuWindow'
import { useMe } from '../control/useMe'

// What the arcade's "Set up / Sign in" row opens: the reporter commands, and
// nothing else. The full menu also carries them, under the controls; this
// is the same rows without the detour, for the person who walked up to the
// machine wanting to get on the board.

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

export function SetupWindow(): React.ReactElement {
  const me = useMe()
  return (
    <section
      className="cab-window-body"
      style={{ background: ARCADE.groundDeep, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '16px' }}
    >
      {me ? (
        <div style={{ padding: '10px 14px', boxShadow: `inset 0 0 0 2px ${ARCADE.rule}`, borderLeft: `4px solid ${ARCADE.amber}` }}>
          <span className="gt-label" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.body}px`, color: ARCADE.value }}>
            You are on the board as {me.name}
          </span>
          <span style={{ ...PROSE, marginTop: '4px' }}>
            The reporter is installed and vouching for you. Re-run Install to update it; Account has your devices and your day.
          </span>
        </div>
      ) : null}
      <div>
        <span className="gt-label" style={{ fontFamily: FONTS.body, fontSize: `${UI_TYPE.heading}px`, color: ARCADE.label }}>
          Get on the board
        </span>
        <span style={{ ...PROSE, marginTop: '6px' }}>
          macOS only for now. Run the install on your own Mac: a background agent reads your local
          Claude Code session logs and reports token totals — only the totals — to this board.
          Nothing here runs anything for you; the command is copied and you paste it yourself.
          Signing in is the second command; the reporter vouches for you.
        </span>
      </div>
      {REPORTER_COMMANDS.map((entry) => (
        <CommandRow key={entry.id} entry={entry} />
      ))}
    </section>
  )
}
