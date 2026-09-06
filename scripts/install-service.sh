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
#   ./scripts/install-service.sh 0.0.0.0    # network bind; needs Cloudflare Access config
#
# Undo with:  ./scripts/install-service.sh --uninstall
set -euo pipefail

LABEL="${OCTIQ_SERVICE_LABEL:-com.kyson.octiqflow.server}"
HOME_DIR="${HOME}"
SERVICE_HOME="${OCTIQ_SERVICE_HOME:-${HOME_DIR}/.octiqflow}"
INSTALL_DIR="${SERVICE_HOME}/bin"
LOG_DIR="${SERVICE_HOME}/logs"
ENV_FILE="${OCTIQOS_ENV_FILE:-${SERVICE_HOME}/octiqos.env}"
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
PROFILE_DIR="${OCTIQ_PROFILE_DIR:-}"

BUILT="${REPO}/src-tauri/target/release/octiq-server"
# The installed binary is copied out of target/, so an existing release file
# says nothing about whether it reflects this checkout. Always rebuild before
# replacing a service; otherwise a frontend/source edit can look deployed while
# launchd quietly keeps running yesterday's server.
echo "Building the server…"
(cd "${REPO}/src-tauri" && cargo build --release --bin octiq-server)

# The browser bundle is served directly from web/dist. Building it as part of
# installation keeps a frontend edit and backend restart from deploying a
# mismatched protocol by accident.
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required to build the browser client before installation." >&2
  exit 1
fi
echo "Building the browser client…"
(cd "${REPO}/web" && pnpm build)

mkdir -p "${INSTALL_DIR}" "${LOG_DIR}" "$(dirname "${PLIST}")"

# OctiqOS operational state has a database credential, while the existing
# launchd plist is intentionally readable enough to diagnose. Keep that secret
# in a 0600 file and have a tiny local wrapper export it just before exec.
# Supplying OCTIQOS_DATABASE_URL or OCTIQOS_INGEST_TOKEN on install creates or
# updates the file. An ordinary reinstall preserves it, so rebuilding the
# server does not require a database or webhook secret to pass through the
# shell again.
INSTALL_DATABASE_URL="${OCTIQOS_DATABASE_URL:-}"
INSTALL_PM_CWD="${OCTIQOS_PM_CWD:-}"
INSTALL_INGEST_TOKEN="${OCTIQOS_INGEST_TOKEN:-}"
INSTALL_CLAUDE_API_KEY="${OCTIQOS_CLAUDE_API_KEY:-}"
INSTALL_DEEPSEEK_API_KEY="${OCTIQOS_DEEPSEEK_API_KEY:-}"
INSTALL_IMAGE_API_KEY="${OCTIQOS_IMAGE_API_KEY:-}"
INSTALL_IMAGE_MODEL="${OCTIQOS_IMAGE_MODEL:-}"
INSTALL_AVATAR_PROVIDER="${OCTIQOS_AVATAR_PROVIDER:-}"
INSTALL_HIGGSFIELD_MODEL="${OCTIQOS_HIGGSFIELD_MODEL:-}"
INSTALL_HIGGSFIELD_BIN="${OCTIQOS_HIGGSFIELD_BIN:-}"
if [[ -f "${ENV_FILE}" ]]; then
  set +u
  source "${ENV_FILE}"
  set -u
fi
if [[ -n "${INSTALL_DATABASE_URL}" ]]; then
  DATABASE_URL="${INSTALL_DATABASE_URL}"
fi
if [[ -n "${INSTALL_PM_CWD}" ]]; then
  OCTIQOS_PM_CWD="${INSTALL_PM_CWD}"
fi
if [[ -n "${INSTALL_INGEST_TOKEN}" ]]; then
  if [[ "${#INSTALL_INGEST_TOKEN}" -lt 32 ]]; then
    echo "OCTIQOS_INGEST_TOKEN must be at least 32 characters." >&2
    exit 1
  fi
  OCTIQOS_INGEST_TOKEN="${INSTALL_INGEST_TOKEN}"
fi
# Preserve existing provider settings on reinstall; explicitly supplied settings win.
[[ -z "${INSTALL_CLAUDE_API_KEY}" ]] || OCTIQOS_CLAUDE_API_KEY="${INSTALL_CLAUDE_API_KEY}"
[[ -z "${INSTALL_DEEPSEEK_API_KEY}" ]] || OCTIQOS_DEEPSEEK_API_KEY="${INSTALL_DEEPSEEK_API_KEY}"
[[ -z "${INSTALL_IMAGE_API_KEY}" ]] || OCTIQOS_IMAGE_API_KEY="${INSTALL_IMAGE_API_KEY}"
[[ -z "${INSTALL_IMAGE_MODEL}" ]] || OCTIQOS_IMAGE_MODEL="${INSTALL_IMAGE_MODEL}"
[[ -z "${INSTALL_AVATAR_PROVIDER}" ]] || OCTIQOS_AVATAR_PROVIDER="${INSTALL_AVATAR_PROVIDER}"
[[ -z "${INSTALL_HIGGSFIELD_MODEL}" ]] || OCTIQOS_HIGGSFIELD_MODEL="${INSTALL_HIGGSFIELD_MODEL}"
[[ -z "${INSTALL_HIGGSFIELD_BIN}" ]] || OCTIQOS_HIGGSFIELD_BIN="${INSTALL_HIGGSFIELD_BIN}"
if [[ -n "${DATABASE_URL:-}" || -n "${OCTIQOS_PM_CWD:-}" || -n "${OCTIQOS_INGEST_TOKEN:-}" || -n "${OCTIQOS_CLAUDE_API_KEY:-}" || -n "${OCTIQOS_DEEPSEEK_API_KEY:-}" || -n "${OCTIQOS_IMAGE_API_KEY:-}" || -n "${OCTIQOS_AVATAR_PROVIDER:-}" || -n "${OCTIQOS_HIGGSFIELD_MODEL:-}" || -n "${OCTIQOS_HIGGSFIELD_BIN:-}" ]]; then
  mkdir -p "$(dirname "${ENV_FILE}")"
  umask 077
  {
    [[ -z "${DATABASE_URL:-}" ]] || printf 'DATABASE_URL=%q\n' "${DATABASE_URL}"
    printf 'OCTIQOS_PM_CWD=%q\n' "${OCTIQOS_PM_CWD:-${REPO}}"
    [[ -z "${OCTIQOS_INGEST_TOKEN:-}" ]] || printf 'OCTIQOS_INGEST_TOKEN=%q\n' "${OCTIQOS_INGEST_TOKEN}"
    [[ -z "${OCTIQOS_CLAUDE_API_KEY:-}" ]] || printf 'OCTIQOS_CLAUDE_API_KEY=%q\n' "${OCTIQOS_CLAUDE_API_KEY}"
    [[ -z "${OCTIQOS_DEEPSEEK_API_KEY:-}" ]] || printf 'OCTIQOS_DEEPSEEK_API_KEY=%q\n' "${OCTIQOS_DEEPSEEK_API_KEY}"
    [[ -z "${OCTIQOS_IMAGE_API_KEY:-}" ]] || printf 'OCTIQOS_IMAGE_API_KEY=%q\n' "${OCTIQOS_IMAGE_API_KEY}"
    [[ -z "${OCTIQOS_IMAGE_MODEL:-}" ]] || printf 'OCTIQOS_IMAGE_MODEL=%q\n' "${OCTIQOS_IMAGE_MODEL}"
    [[ -z "${OCTIQOS_AVATAR_PROVIDER:-}" ]] || printf 'OCTIQOS_AVATAR_PROVIDER=%q\n' "${OCTIQOS_AVATAR_PROVIDER}"
    [[ -z "${OCTIQOS_HIGGSFIELD_MODEL:-}" ]] || printf 'OCTIQOS_HIGGSFIELD_MODEL=%q\n' "${OCTIQOS_HIGGSFIELD_MODEL}"
    [[ -z "${OCTIQOS_HIGGSFIELD_BIN:-}" ]] || printf 'OCTIQOS_HIGGSFIELD_BIN=%q\n' "${OCTIQOS_HIGGSFIELD_BIN}"
  } > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
fi

# Copied rather than pointed at, so a `cargo clean` or a rebuild mid-session
# cannot pull the binary out from under a running service.
cp "${BUILT}" "${INSTALL_DIR}/octiq-server"

RUNNER="${INSTALL_DIR}/run-octiq-server"
cat > "${RUNNER}" <<RUNNER_EOF
#!/bin/zsh
set -euo pipefail
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  source "${ENV_FILE}"
  set +a
  export OCTIQOS_REQUIRE_DATABASE=1
fi
exec "${INSTALL_DIR}/octiq-server"
RUNNER_EOF
chmod 700 "${RUNNER}"

# Sign it, so macOS stops asking for the same folder after every build.
#
# A privacy prompt ("… would like to access files in your Downloads folder") is
# remembered against the binary's code signature. Cargo leaves an AD-HOC one,
# which is a hash of the contents — so every rebuild is a different program to
# macOS, the old grant does not apply, and the prompt comes back. Worse, the
# prompt is attributed to this process rather than to `claude`, because TCC
# blames the RESPONSIBLE process, and a launchd job is the responsible process
# for everything it spawns. Answered on a desktop nobody is watching, it stalls
# a chat with no card and nothing in the log.
#
# `--identifier` is pinned deliberately: cargo's default identifier carries a
# hash (`octiq_server-759ccb88730a5c8d`) and the grant is keyed on the
# identifier as well as the signer.
#
# Best-effort. There is no signing identity on a fresh machine and this must
# not stop an install — an ad-hoc binary works fine, it just asks more often.
SIGN_ID="${OCTIQ_SIGN_ID:-optiqFlow}"
if security find-identity -p codesigning 2>/dev/null | grep -q "\"${SIGN_ID}\""; then
  codesign --force --sign "${SIGN_ID}" \
    --identifier net.pandaworks.octiqflow.server \
    "${INSTALL_DIR}/octiq-server" >/dev/null 2>&1 &&
    echo "Signed as ${SIGN_ID}." ||
    echo "Could not sign; carrying on unsigned." >&2
else
  echo "No '${SIGN_ID}' signing identity — leaving the binary ad-hoc signed." >&2
  echo "  (macOS will re-ask for folder access after every rebuild.)" >&2
fi

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
    <string>${RUNNER}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>OCTIQ_WEB</key>
    <string>1</string>
    <key>OCTIQ_WEB_BIND</key>
    <string>${BIND}</string>
    <key>OCTIQ_WEB_PORT</key>
    <string>${PORT}</string>
    <key>OCTIQ_PROFILE_DIR</key>
    <string>${PROFILE_DIR}</string>
    <key>PATH</key>
    <string>${HOME_DIR}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>SHELL</key>
    <string>${SHELL:-/bin/zsh}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>

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
if [[ -f "${ENV_FILE}" ]]; then
  echo "  OctiqOS store: configured"
else
  echo "  OctiqOS store: not configured (pass OCTIQOS_DATABASE_URL when installing)"
fi
echo "  stop:    launchctl bootout gui/$(id -u)/${LABEL}"
echo "  remove:  $0 --uninstall"
echo
# The server is already listening by this point — the wait above saw to that —
# so the URL can simply be read out of the log rather than promised for later.
echo "Open:"
grep 'OctiqFlow: http' "${LOG_DIR}/server.log" | tail -1 | sed 's/^\[web\] OctiqFlow: /  /'
