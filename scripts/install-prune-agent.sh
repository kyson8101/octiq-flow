#!/usr/bin/env bash
# Install once from a real terminal; never cleans anything at installation.
set -euo pipefail
LABEL="com.kyson.octiqflow.prune-target"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/.octiqflow/logs"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" == --uninstall && $# == 1 ]]; then
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed ${LABEL}."
  exit 0
fi
[[ $# == 0 ]] || { echo "Usage: $0 [--uninstall]" >&2; exit 2; }
# Paths are XML text, never shell code. Escape even uncommon checkout names.
xml() { /usr/bin/perl -e '$s=shift; $s =~ s/&/&amp;/g; $s =~ s/</&lt;/g; $s =~ s/>/&gt;/g; print $s' "$1"; }
mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string>
    <string>$(xml "$REPO/scripts/prune-target.sh")</string>
    <string>--worktrees</string>
  </array>
  <key>StartCalendarInterval</key><dict>
    <key>Hour</key><integer>4</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><false/>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key><string>$(xml "$LOG_DIR/prune-target.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG_DIR/prune-target.log")</string>
</dict></plist>
PLIST_EOF
plutil -lint "$PLIST"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed ${LABEL}: daily at 04:30; stale own-crate caches only (2 days)."
echo "Log: ${LOG_DIR}/prune-target.log"
echo "Remove: $0 --uninstall"
