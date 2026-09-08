// The four things somebody standing in front of the screen might want to do to
// the reporter on their own machine. Ordered as the two things people actually
// walk up wanting — join, or leave — with the day-to-day maintenance
// underneath. The install command is also the update command, which is worth
// saying out loud: people re-run it expecting to be told off and are instead
// brought up to date.

const REPO_RAW_BASE = 'https://raw.githubusercontent.com/Itchh/claude-counter/master/reporter'
const REPORTER_DIR = '~/.local/share/claude-leaderboard-reporter/reporter'

export type CommandTone = 'go' | 'neutral' | 'stop'

export interface ReporterCommand {
  readonly id: string
  readonly label: string
  readonly hint: string
  readonly command: string
  readonly tone: CommandTone
}

export const REPORTER_COMMANDS: ReadonlyArray<ReporterCommand> = [
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
