# Claude Code Token Leaderboard

A team scoreboard that tracks how many Claude Code tokens each teammate has
used. A tiny reporter runs silently in the background on every teammate's
Mac, sends token usage to a server, and the leaderboard page displays it
live.

## Install the reporter (teammates)

Paste this into a terminal on your Mac:

```
curl -fsSL https://raw.githubusercontent.com/Itchh/claude-counter/master/reporter/install.sh | bash
```

You'll be asked three things:

- **Display name** — what shows on the leaderboard (your first name is fine)
- **Leaderboard URL** — the Vercel URL (ask the person who set it up)
- **Shared secret** — ask the person who set it up

That's it. From that moment on, the reporter runs in the background on your
Mac, starts itself every time you log in, and auto-pulls any future updates
once an hour. There's nothing to keep open and nothing to babysit.

Want to check it's working? Visit the leaderboard URL in your browser — your
name should appear within a minute.

### Removing it

```
cd ~/.local/share/claude-leaderboard-reporter/reporter
bun remove
```

See [`reporter/README.md`](reporter/README.md) for the full operator guide
(logs, restart, manual install, how it keeps itself quiet, etc.).

## For the admin

This repo contains:

- **`app/`, `lib/`, `types/`** — the Next.js leaderboard web app, deployed
  on Vercel. It polls `/api/leaderboard` every 10 seconds to render live
  rankings.
- **`reporter/`** — the client-side CLI that scans each user's Claude Code
  session files and POSTs stats to `/api/report`.

### Deploying the leaderboard

1. Import the repo into Vercel (auto-detects Next.js — no config needed).
2. Add a Vercel KV / Upstash Redis store via the Storage tab. Vercel will
   inject `KV_URL`, `KV_REST_API_URL`, and `KV_REST_API_TOKEN` env vars
   automatically.
3. In Settings → Environment Variables, add `LEADERBOARD_SECRET` (any
   passphrase — share it with teammates for their reporter setup).
4. Redeploy so the env var takes effect.

### How it works

```
teammates' laptops                Vercel
──────────────────                ──────────────────────────
reporter (launchd agent)    ──→   POST /api/report  ──→  Upstash Redis
scans ~/.claude/projects          (validates LEADERBOARD_SECRET)
every 30s + on file change
                                  GET /api/leaderboard  ←──  browsers
                                  (reads Redis, sorts)       poll every 10s
```

Tokens are counted from the JSONL session files Claude Code writes locally.
No data leaves the machine besides the aggregate numbers.
