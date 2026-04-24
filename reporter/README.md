# Claude leaderboard reporter

Reports your local Claude Code token usage to the Season One leaderboard.

Runs as a macOS launchd background agent — starts on login, auto-restarts if
it crashes, and is throttled by macOS to stay out of the way of foreground
work.

## Install (macOS)

Paste this into a terminal — nothing else needs to be installed first:

```
curl -fsSL https://raw.githubusercontent.com/Itchh/claude-counter/master/reporter/install.sh | bash
```

The installer checks for git and bun (installing bun if missing), clones the
repo to `~/.local/share/claude-leaderboard-reporter`, and runs setup. Setup
will prompt for your display name, the leaderboard URL, and the shared
secret, then register the launchd agent and start reporting immediately.

## Uninstall (macOS)

Paste this into a terminal to fully wipe the reporter — agent, cloned repo,
config, cache, and logs:

```
curl -fsSL https://raw.githubusercontent.com/Itchh/claude-counter/master/reporter/uninstall.sh | bash
```

Safe to re-run; it skips anything that's already gone.

## Day-to-day

```
bun logs       # tail the log
bun restart    # restart the agent
bun remove     # stop and remove the agent (keeps config)
```

(Run these from inside `~/.local/share/claude-leaderboard-reporter/reporter`
or use the full paths shown in the install output.)

Config lives at `~/.leaderboard-reporter.json` (chmod 600). Delete it to
fully reset.

## Updates

The reporter checks for updates on startup and every hour: it does a
`git pull --ff-only` in its install dir, and if new commits arrived it exits
so launchd respawns it running the new code. You won't need to do anything
once the installer has been run.

## Manual install

If you want to clone it somewhere specific and drive it yourself:

```
git clone https://github.com/Itchh/claude-counter.git
cd claude-counter/reporter
bun install
bun setup.ts
```

## Requirements

- macOS (launchd is mac-only). Linux/Windows users can still run the reporter
  directly with `bun index.ts`, but they'll need to keep a terminal open and
  auto-update/launchd features won't apply.
- [bun](https://bun.sh) (the installer will fetch it for you)
- Claude Code must have been used at least once so that
  `~/.config/claude/projects/` or `~/.claude/projects/` exists with session
  files.

## How it stays light

- **mtime+size cache** — once a session file is closed, its tokens are
  cached in `~/.leaderboard-reporter.cache.json`. Subsequent scans skip it
  entirely. Only actively-growing files are re-read.
- **Streaming reads** — files are parsed line-by-line via `readline`, never
  loaded into memory in full.
- **launchd tuning** — `ProcessType=Background`, `Nice=10`, `LowPriorityIO`
  tell macOS to throttle this process aggressively while you're doing
  foreground work.
- **Memory ceiling** — if RSS ever exceeds 200MB the process exits cleanly
  and launchd restarts it fresh.
- **Scan mutex** — concurrent scans are skipped rather than piling up.
- **Schema drift detection** — if Claude Code's JSONL format ever changes
  and our parser stops yielding token data, the reporter logs a warning and
  flags its report.
