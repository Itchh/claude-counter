#!/bin/bash
set -euo pipefail

REPO_URL="https://github.com/Itchh/claude-counter.git"
INSTALL_DIR="$HOME/.local/share/claude-leaderboard-reporter"
REPORTER_DIR="$INSTALL_DIR/reporter"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This installer is macOS-only (the reporter runs as a launchd agent)."
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git not found. Install Xcode Command Line Tools with: xcode-select --install"
  exit 1
fi

# Install bun if missing.
if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.bun/bin/bun" ]; then
  echo "Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

# Ensure bun is on PATH for this session.
if ! command -v bun >/dev/null 2>&1; then
  export PATH="$HOME/.bun/bin:$PATH"
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun installation failed. Try installing manually from https://bun.sh then re-run."
  exit 1
fi

# Clone or update the repo.
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating existing install at $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --ff-only --quiet
else
  echo "Cloning repo to $INSTALL_DIR..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
fi

cd "$REPORTER_DIR"
echo "Installing dependencies..."
bun install --silent

echo "Launching setup..."
exec bun setup.ts
