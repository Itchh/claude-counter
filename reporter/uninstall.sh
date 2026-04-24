#!/bin/bash
set -euo pipefail

LABEL="com.leaderboard.reporter"
INSTALL_DIR="$HOME/.local/share/claude-leaderboard-reporter"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
CONFIG_PATH="$HOME/.leaderboard-reporter.json"
CACHE_PATH="$HOME/.leaderboard-reporter.cache.json"
ERROR_FLAG_PATH="$HOME/.leaderboard-reporter.error"
LOG_PATH="$HOME/Library/Logs/leaderboard-reporter.log"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This uninstaller is macOS-only."
  exit 1
fi

UID_NUM="$(id -u)"

echo "Stopping launch agent..."
launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true

echo "Removing files..."
for target in "$PLIST_PATH" "$CONFIG_PATH" "$CACHE_PATH" "$ERROR_FLAG_PATH" "$LOG_PATH"; do
  if [ -e "$target" ]; then
    rm -f "$target"
    echo "  removed $target"
  fi
done

if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  echo "  removed $INSTALL_DIR"
fi

echo ""
echo "Uninstalled."
echo "Reinstall any time with:"
echo "  curl -fsSL https://raw.githubusercontent.com/Itchh/claude-counter/master/reporter/install.sh | bash"
