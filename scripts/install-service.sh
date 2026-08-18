#!/usr/bin/env bash
#
# Install the OctiqFlow backend as a launchd user agent.
#
# It starts at login, restarts if it dies, and needs no window — so agents keep
# working with the app closed. It does NOT survive the lid closing: the Mac
# sleeps and everything on it sleeps too. That is a property of the machine,
# not of this service.
#
#   ./scripts/install-service.sh            # loopback only (for a tunnel)
#   ./scripts/install-service.sh 0.0.0.0    # reachable on your network
#
# Undo with:  ./scripts/install-service.sh --uninstall
set -euo pipefail

LABEL="com.kyson.octiqflow.server"
HOME_DIR="${HOME}"
INSTALL_DIR="${HOME_DIR}/.octiqflow/bin"
LOG_DIR="${HOME_DIR}/.octiqflow/logs"
PLIST="${HOME_DIR}/Library/LaunchAgents/${LABEL}.plist"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
  rm -f "${PLIST}"
  echo "Removed ${LABEL}. The binary is still at ${INSTALL_DIR}/octiq-server."
  exit 0
fi

BIND="${1:-127.0.0.1}"
PORT="${OCTIQ_WEB_PORT:-1421}"

BUILT="${REPO}/src-tauri/target/release/octiq-server"
if [[ ! -x "${BUILT}" ]]; then
  echo "Building the server first…"
  (cd "${REPO}/src-tauri" && cargo build --release --bin octiq-server)
fi

mkdir -p "${INSTALL_DIR}" "${LOG_DIR}" "$(dirname "${PLIST}")"

# Copied rather than pointed at, so a `cargo clean` or a rebuild mid-session
# cannot pull the binary out from under a running service.
cp "${BUILT}" "${INSTALL_DIR}/octiq-server"

# PATH matters: launchd starts with a bare one, and the agents are found
# through it. The login shell fixes this up for the agent processes themselves,
# but the server looks up `claude` and `codex` to report what is installed.
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
    <string>${INSTALL_DIR}/octiq-server</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>OCTIQ_WEB</key>
    <string>1</string>
    <key>OCTIQ_WEB_BIND</key>
    <string>${BIND}</string>
    <key>OCTIQ_WEB_PORT</key>
    <string>${PORT}</string>
    <key>PATH</key>
    <string>${HOME_DIR}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>SHELL</key>
    <string>${SHELL:-/bin/zsh}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/server.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/server.err.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "${PLIST}"

echo
echo "Installed ${LABEL}, bound to ${BIND}:${PORT}."
echo "  logs:    ${LOG_DIR}/server.log"
echo "  stop:    launchctl bootout gui/$(id -u)/${LABEL}"
echo "  remove:  $0 --uninstall"
echo
echo "Give it a moment, then the URL with your token is in the log:"
echo "  grep 'OctiqFlow v2' ${LOG_DIR}/server.log"
