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

# Stopping and starting are not two commands, they are one command and a wait.
#
# `bootout` returns before launchd has finished releasing the label, so a
# `bootstrap` fired straight after it can lose the race and fail with
# "Bootstrap failed: 5: Input/output error". Under `set -e` that ends the
# script with the OLD server already stopped and the new one never started —
# the backend is simply down, and the one line of output does not say so. So:
# wait for the label to actually go, then retry a few times.
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true

for _ in 1 2 3 4 5 6 7 8 9 10; do
  launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 || break
  sleep 0.5
done

started=""
for attempt in 1 2 3 4 5; do
  if launchctl bootstrap "gui/$(id -u)" "${PLIST}" 2>/dev/null; then
    started="yes"
    break
  fi
  echo "  bootstrap attempt ${attempt} failed, waiting for launchd…"
  sleep 1
done

if [[ -z "${started}" ]]; then
  echo
  echo "Could not start ${LABEL}. THE BACKEND IS NOT RUNNING." >&2
  echo "Try:  launchctl bootstrap gui/$(id -u) ${PLIST}" >&2
  exit 1
fi

# Started is not the same as listening. A binary that dies on startup leaves
# launchd happy and the port shut, and the next thing anyone does is wonder why
# the page will not load.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
if ! lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo
  echo "${LABEL} was started but nothing is listening on ${PORT}." >&2
  echo "The log will say why:  tail ${LOG_DIR}/server.err.log" >&2
  exit 1
fi

echo
echo "Installed ${LABEL}, bound to ${BIND}:${PORT}."
echo "  logs:    ${LOG_DIR}/server.log"
echo "  stop:    launchctl bootout gui/$(id -u)/${LABEL}"
echo "  remove:  $0 --uninstall"
echo
# The server is already listening by this point — the wait above saw to that —
# so the URL can simply be read out of the log rather than promised for later.
echo "Open:"
grep 'OctiqFlow: http' "${LOG_DIR}/server.log" | tail -1 | sed 's/^\[web\] OctiqFlow: /  /'
