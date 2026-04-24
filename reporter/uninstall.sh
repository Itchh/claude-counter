#!/bin/bash
set -euo pipefail

LABEL="com.leaderboard.reporter"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
CACHE_PATH="$HOME/.leaderboard-reporter.cache.json"
ERROR_FLAG_PATH="$HOME/.leaderboard-reporter.error"
CONFIG_PATH="$HOME/.leaderboard-reporter.json"
LOG_PATH="$HOME/Library/Logs/leaderboard-reporter.log"
INSTALL_DIR="$HOME/.local/share/claude-leaderboard-reporter"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Uninstaller is macOS-only (the reporter is a launchd agent)."
  exit 1
fi

UID_NUM="$(id -u)"

echo "Stopping launchd agent..."
/bin/launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true

removed=()
for path in "$PLIST_PATH" "$CACHE_PATH" "$ERROR_FLAG_PATH" "$CONFIG_PATH" "$LOG_PATH"; do
  if [ -e "$path" ]; then
    rm -f "$path"
    removed+=("$path")
  fi
done

if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  removed+=("$INSTALL_DIR")
fi

echo ""
echo "Uninstalled."
if [ ${#removed[@]} -gt 0 ]; then
  echo ""
  echo "Removed:"
  for path in "${removed[@]}"; do
    echo "  $path"
  done
else
  echo "Nothing to remove — reporter wasn't installed."
fi
echo ""
