# Claude leaderboard reporter

Reports your local Claude Code token usage to the Season One leaderboard.

## Setup

```
cd reporter
bun install
bun index.ts
```

First run prompts for your name and the leaderboard URL, then starts reporting.

## Requirements

Node.js 18 or later. Claude Code must have been used at least once so that
`~/.config/claude/projects/` or `~/.claude/projects/` exists with session files.

## Auto-start on macOS

Keep it running in a terminal tab, or set up launchd — the script will print
instructions for this on first run.
