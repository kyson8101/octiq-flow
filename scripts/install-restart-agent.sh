#!/usr/bin/env bash
#
# Install the restart helper as a launchd job of its own.
#
# See restart-agent.sh for why the restart cannot run inside the process tree
# it is restarting. This puts it in a separate job, watching one file:
#
#     touch ~/.octiqflow/restart.request     # ping
#     tail -f ~/.octiqflow/logs/restart.log  # watch
#
# Install once. It survives reboots, and it does not need reinstalling when the
# server is rebuilt — only when this repo MOVES, since the path is baked in
# below (launchd jobs start with a bare environment and no idea where anything
# is).
#
# Undo with:  ./scripts/install-restart-agent.sh --uninstall
set -euo pipefail

LABEL="com.kyson.octiqflow.restarter"
HOME_DIR="${HOME}"
PLIST="${HOME_DIR}/Library/LaunchAgents/${LABEL}.plist"
TRIGGER="${HOME_DIR}/.octiqflow/restart.request"
LOG_DIR="${HOME_DIR}/.octiqflow/logs"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "${PLIST}"
  echo "Removed ${LABEL}."
  exit 0
fi

mkdir -p "${LOG_DIR}" "$(dirname "${TRIGGER}")" "$(dirname "${PLIST}")"

# WatchPaths wants the parent directory to exist, and fires on create, write and
# delete. It does NOT need the file itself to be there — which is the resting
# state, since the helper deletes it as the first thing it does.
cat > "${PLIST}" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${REPO}/scripts/restart-agent.sh</string>
  </array>

  <key>WatchPaths</key>
  <array>
    <string>${TRIGGER}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>OCTIQ_REPO</key>
    <string>${REPO}</string>
    <key>PATH</key>
    <string>${HOME_DIR}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <!-- Fired by a file change, never at load: booting this job must not restart
       the backend, or every login would. -->
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <false/>
  <!-- launchd's floor is 10s anyway. Said out loud so it is clear that two
       touches in quick succession are one restart, not two. -->
  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/restarter.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/restarter.err.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "${PLIST}"

echo "Installed ${LABEL}, watching ${TRIGGER}."
echo
echo "Restart the backend from anywhere — including from inside an OctiqFlow chat:"
echo "  touch ${TRIGGER}"
echo
echo "  log:     ${LOG_DIR}/restart.log"
echo "  remove:  $0 --uninstall"
