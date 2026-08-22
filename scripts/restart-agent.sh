#!/usr/bin/env bash
#
# Restart the OctiqFlow backend from OUTSIDE it.
#
# The problem this exists for: an agent chat is a grandchild of the server it
# would restart —
#
#     install-service.sh  ←  zsh  ←  claude -p  ←  octiq-server
#
# — so the `launchctl bootout` in the middle of that script kills the shell
# running the script. The old server stops, the new one is never bootstrapped,
# and the backend is simply DOWN, with the one line that would have said so
# dying along with the shell.
#
# So the restart is moved into a launchd job of its own. Booting out the
# octiqflow job cannot touch this one — different label, different process
# tree — and it runs to the end whether or not whoever asked for it is still
# alive. Nothing keeps the ASKING chat alive; that is not possible, since it
# is a child of the thing being restarted. What this buys is that the restart
# always finishes.
#
# Ping it by touching the trigger file:
#
#     touch ~/.octiqflow/restart.request
#
# Watched by launchd (WatchPaths), so the touch is the whole interface — no
# port, no daemon of ours, nothing to authenticate.
set -uo pipefail

TRIGGER="${HOME}/.octiqflow/restart.request"
LOG="${HOME}/.octiqflow/logs/restart.log"
LABEL="com.kyson.octiqflow.server"
REPO="${OCTIQ_REPO:-}"

mkdir -p "$(dirname "${LOG}")"
say() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "${LOG}"; }

# launchd fires this on ANY change to the trigger — including the `rm` below.
# That echo is the loop this would otherwise spin in, and it is broken here:
# on the second firing the file is already gone, so there is nothing to do.
if [[ ! -e "${TRIGGER}" ]]; then
  exit 0
fi
rm -f "${TRIGGER}"

if [[ -z "${REPO}" || ! -x "${REPO}/scripts/install-service.sh" ]]; then
  say "No repo to restart from (OCTIQ_REPO=${REPO:-unset}). Re-run install-restart-agent.sh."
  exit 1
fi

# Keep whatever the service is currently bound to. Re-reading it rather than
# defaulting means a server deliberately put on 0.0.0.0 for the network does
# not quietly come back on loopback only.
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
BIND="$(plutil -extract EnvironmentVariables.OCTIQ_WEB_BIND raw "${PLIST}" 2>/dev/null || echo '127.0.0.1')"

say "Restart asked for. Rebinding to ${BIND}, from ${REPO}."
if "${REPO}/scripts/install-service.sh" "${BIND}" >> "${LOG}" 2>&1; then
  say "Backend is up."
else
  say "RESTART FAILED — the backend may be down. See above, and ${HOME}/.octiqflow/logs/server.err.log."
  exit 1
fi
