#!/usr/bin/env bash
#
# What state is OctiqFlow actually in, and write it down.
#
# This exists because the ways this app breaks are all invisible from a chat
# inside it. The backend can be DOWN with nothing on screen to say so; a restart
# can die halfway and leave no server bootstrapped; the client and the server
# deploy separately, so a fresh page can be calling commands an old binary does
# not have; and a codesign or a folder-permission dialog on the Mac's own screen
# can park the whole install with an empty log. Every one of those looks, from
# in here, like "the app is being weird".
#
# So this asks the machine directly, prints the answers, and APPENDS them to an
# audit log — because the useful question is almost never "what is broken now",
# it is "what changed since it last worked".
#
# It is READ-ONLY. It never restarts, never installs, never signs. Run it as
# often as you like, including from a chat: it cannot be the thing that breaks
# the backend.
#
#   ./scripts/octiq-check.sh            # check, print, append to the audit log
#   ./scripts/octiq-check.sh --quiet    # log only, print nothing (for a cron)
#   ./scripts/octiq-check.sh --log      # show recent audit entries and stop
#
# Exit code: 0 all good · 1 something worth a look · 2 the backend is down.
set -uo pipefail

SERVER_LABEL="com.kyson.octiqflow.server"
RESTART_LABEL="com.kyson.octiqflow.restarter"
HOME_DIR="${HOME}"
OCTIQ_DIR="${HOME_DIR}/.octiqflow"
LOG_DIR="${OCTIQ_DIR}/logs"
AUDIT="${LOG_DIR}/audit.jsonl"
INSTALLED="${OCTIQ_DIR}/bin/octiq-server"
TRIGGER="${OCTIQ_DIR}/restart.request"
PLIST="${HOME_DIR}/Library/LaunchAgents/${SERVER_LABEL}.plist"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILT="${REPO}/src-tauri/target/release/octiq-server"
DIST="${REPO}/web/dist"
UID_NUM="$(id -u)"

QUIET=0
case "${1:-}" in
  --quiet) QUIET=1 ;;
  --log)
    if [[ -f "${AUDIT}" ]]; then tail -n "${2:-20}" "${AUDIT}"; else echo "No audit log yet at ${AUDIT}."; fi
    exit 0
    ;;
  --help|-h)
    sed -n '3,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

WORST=0            # 0 ok · 1 warn · 2 down
FINDINGS=()        # human lines, one per check

# Record one check. `level` is ok | warn | down; the worst one seen decides the
# exit code, so a caller can act on this without parsing anything.
note() {
  local level="$1" name="$2" detail="$3"
  case "${level}" in
    down) [[ ${WORST} -lt 2 ]] && WORST=2 ;;
    warn) [[ ${WORST} -lt 1 ]] && WORST=1 ;;
  esac
  FINDINGS+=("${level}|${name}|${detail}")
}

# Seconds since a file was last written, or "" when it does not exist. `stat -f`
# is the BSD spelling; this script is macOS-only, like the service it checks.
age_of() { [[ -e "$1" ]] && echo $(( $(date +%s) - $(stat -f %m "$1") )) || echo ""; }
mtime_of() { [[ -e "$1" ]] && stat -f %m "$1" || echo ""; }
human_age() {
  local s="${1:-}"
  [[ -z "${s}" ]] && { echo "never"; return; }
  if   [[ ${s} -lt 90    ]]; then echo "${s}s ago"
  elif [[ ${s} -lt 5400  ]]; then echo "$(( s / 60 ))m ago"
  elif [[ ${s} -lt 172800 ]]; then echo "$(( s / 3600 ))h ago"
  else echo "$(( s / 86400 ))d ago"; fi
}

# ── 1. the server job ──────────────────────────────────────────────────────
JOB="$(launchctl print "gui/${UID_NUM}/${SERVER_LABEL}" 2>/dev/null)"
SERVER_PID=""
SERVER_STATE="absent"
LAST_EXIT=""
if [[ -n "${JOB}" ]]; then
  SERVER_PID="$(sed -n 's/^[[:space:]]*pid = \([0-9]*\).*/\1/p' <<< "${JOB}" | head -1)"
  SERVER_STATE="$(sed -n 's/^[[:space:]]*state = \(.*\)/\1/p' <<< "${JOB}" | head -1)"
  LAST_EXIT="$(sed -n 's/^[[:space:]]*last exit code = \(.*\)/\1/p' <<< "${JOB}" | head -1)"
fi

if [[ -z "${JOB}" ]]; then
  note down "service" "${SERVER_LABEL} is not loaded — the backend is not running. Install it from a REAL terminal: ./scripts/install-service.sh"
elif [[ -n "${SERVER_PID}" && "${SERVER_PID}" != "0" ]]; then
  EXIT_NOTE=""
  [[ "${LAST_EXIT}" =~ ^-?[0-9]+$ ]] && EXIT_NOTE=" (last exit ${LAST_EXIT})"
  note ok "service" "up, pid ${SERVER_PID}${EXIT_NOTE}"
else
  note down "service" "loaded but NOT running (state ${SERVER_STATE:-unknown}${LAST_EXIT:+, last exit ${LAST_EXIT}}). See ${LOG_DIR}/server.err.log"
fi

# ── 2. which build is actually live ────────────────────────────────────────
# The running process holds the binary it was started from. A rebuild replaces
# the file on disk but NOT the process, so a fix can be sitting in the tree,
# compiled, installed, and still not be the code answering your calls.
INSTALLED_MTIME="$(mtime_of "${INSTALLED}")"
BUILT_MTIME="$(mtime_of "${BUILT}")"
STARTED=""
if [[ -n "${SERVER_PID}" && "${SERVER_PID}" != "0" ]]; then
  STARTED="$(ps -o lstart= -p "${SERVER_PID}" 2>/dev/null | sed 's/^ *//;s/ *$//')"
  STARTED_EPOCH="$(ps -o lstart= -p "${SERVER_PID}" 2>/dev/null | xargs -I{} date -j -f "%a %b %d %T %Y" "{}" +%s 2>/dev/null)"
  if [[ -n "${INSTALLED_MTIME}" && -n "${STARTED_EPOCH:-}" && ${INSTALLED_MTIME} -gt ${STARTED_EPOCH} ]]; then
    note warn "live build" "the installed binary is NEWER than the running process — it was replaced without a restart, so the running code is stale. touch ${TRIGGER}"
  else
    note ok "live build" "running since ${STARTED:-unknown}"
  fi
fi
if [[ -n "${BUILT_MTIME}" && -n "${INSTALLED_MTIME}" && ${BUILT_MTIME} -gt ${INSTALLED_MTIME} ]]; then
  note warn "installed build" "target/release/octiq-server is newer than the installed copy — built but never shipped ($(human_age "$(age_of "${BUILT}")"))"
elif [[ -z "${INSTALLED_MTIME}" ]]; then
  note warn "installed build" "no binary at ${INSTALLED}"
else
  note ok "installed build" "installed $(human_age "$(age_of "${INSTALLED}")")"
fi

# ── 3. the client half ─────────────────────────────────────────────────────
# web/dist is read off disk at runtime, so it reaches the browser on the next
# reload with no restart — while the backend only changes when the service does.
# A client newer than the server is the documented way to get
# "'<cmd>' is not available from a browser".
DIST_MTIME="$(mtime_of "${DIST}")"
if [[ -z "${DIST_MTIME}" ]]; then
  note warn "client" "no web/dist — nothing to serve. pnpm --dir web build"
elif [[ -n "${INSTALLED_MTIME}" && ${DIST_MTIME} -gt $(( INSTALLED_MTIME + 300 )) ]]; then
  note warn "client" "web/dist is newer than the server binary — the page may call commands this backend does not have. Ship both halves."
else
  note ok "client" "built $(human_age "$(age_of "${DIST}")")"
fi

# ── 4. is anything actually listening ──────────────────────────────────────
BIND="$(plutil -extract EnvironmentVariables.OCTIQ_WEB_BIND raw "${PLIST}" 2>/dev/null || echo "127.0.0.1")"
PORT="$(plutil -extract EnvironmentVariables.OCTIQ_WEB_PORT raw "${PLIST}" 2>/dev/null || echo "1421")"
LISTEN="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | tail -n +2)"
if [[ -z "${LISTEN}" ]]; then
  note down "port" "nothing listening on ${PORT} — the server is not serving. See ${LOG_DIR}/server.err.log"
else
  note ok "port" "listening on ${BIND}:${PORT}"
fi

HTTP=""
if [[ -n "${LISTEN}" ]]; then
  HOST="${BIND}"; [[ "${HOST}" == "0.0.0.0" ]] && HOST="127.0.0.1"
  HTTP="$(curl -sS -m 4 -o /dev/null -w '%{http_code}' "http://${HOST}:${PORT}/" 2>/dev/null)"
  if [[ "${HTTP}" =~ ^(200|204|301|302|401|403)$ ]]; then
    note ok "http" "answers ${HTTP} on http://${HOST}:${PORT}/"
  else
    note warn "http" "no usable answer from http://${HOST}:${PORT}/ (got '${HTTP:-nothing}') — the port is open but the app is not replying"
  fi
fi

# ── 5. the restarter, and any restart that never happened ──────────────────
# Without this second job, `touch ~/.octiqflow/restart.request` does NOTHING —
# and it fails silently, which is the worst way for it to fail.
if launchctl print "gui/${UID_NUM}/${RESTART_LABEL}" >/dev/null 2>&1; then
  note ok "restarter" "${RESTART_LABEL} is loaded and watching ${TRIGGER}"
else
  note warn "restarter" "${RESTART_LABEL} is NOT loaded — touching ${TRIGGER} will do nothing. ./scripts/install-restart-agent.sh"
fi

TRIGGER_AGE="$(age_of "${TRIGGER}")"
RESTART_LOG="${LOG_DIR}/restart.log"
LAST_RESTART="$(tail -n 40 "${RESTART_LOG}" 2>/dev/null | grep -E 'Restart asked for|Restarted|failed|FAILED' | tail -n 1)"
if [[ -n "${TRIGGER_AGE}" && -n "${INSTALLED_MTIME}" && ${TRIGGER_AGE} -lt 900 && $(age_of "${INSTALLED}") -gt ${TRIGGER_AGE} ]]; then
  note warn "restart" "a restart was asked for $(human_age "${TRIGGER_AGE}") and the binary was not reinstalled after it — it may not have run. tail ${RESTART_LOG}"
elif [[ -n "${LAST_RESTART}" ]]; then
  note ok "restart" "last: ${LAST_RESTART}"
else
  note ok "restart" "no restarts recorded"
fi

# ── 6. what the server is holding ──────────────────────────────────────────
# A chat costs ~480 MB: the agent plus its own copy of every MCP server it
# starts. Nine left open overnight held 4.3 GB, which is why the idle reaper
# exists — so this is worth a number rather than a guess.
CHATS=0
CHAT_MB=0
if [[ -n "${SERVER_PID}" && "${SERVER_PID}" != "0" ]]; then
  while read -r rss _; do
    [[ -z "${rss}" ]] && continue
    CHATS=$(( CHATS + 1 ))
    CHAT_MB=$(( CHAT_MB + rss / 1024 ))
  done < <(ps -axo rss=,command= 2>/dev/null | grep -E '(claude|codex)' | grep -vE 'grep|octiq-check' || true)
fi
if [[ ${CHATS} -gt 0 ]]; then
  note ok "agents" "${CHATS} agent process(es), ~${CHAT_MB} MB resident"
else
  note ok "agents" "no agent processes running"
fi

# ── 7. errors the server logged since it started ───────────────────────────
ERR_LOG="${LOG_DIR}/server.err.log"
BAD="$(tail -n 400 "${ERR_LOG}" 2>/dev/null \
  | grep -aiE 'panic|fatal|thread .* panicked|address already in use|permission denied|no such file|failed to' \
  | tail -n 1)"
if [[ -n "${BAD}" ]]; then
  note warn "server log" "a real fault in server.err.log: ${BAD:0:120}"
else
  note ok "server log" "nothing that reads like a fault in the last 400 lines"
fi

# ── print ──────────────────────────────────────────────────────────────────
if [[ ${QUIET} -eq 0 ]]; then
  case ${WORST} in
    0) echo "OctiqFlow: all good." ;;
    1) echo "OctiqFlow: up, with things worth a look." ;;
    2) echo "OctiqFlow: SOMETHING IS DOWN." ;;
  esac
  echo
  for row in "${FINDINGS[@]}"; do
    IFS='|' read -r level name detail <<< "${row}"
    case "${level}" in
      ok)   mark=" ok " ;;
      warn) mark="warn" ;;
      down) mark="DOWN" ;;
    esac
    printf '  [%s] %-16s %s\n' "${mark}" "${name}" "${detail}"
  done
  echo
  echo "  audit log: ${AUDIT}  (./scripts/octiq-check.sh --log)"
fi

# ── append to the audit log ────────────────────────────────────────────────
# JSON, one object per run, so a later question ("when did this start?") is a
# grep rather than a reading. Written through python3 so a log line can never be
# broken by a quote or a newline in something the machine told us.
mkdir -p "${LOG_DIR}"
CHECK_ROWS="$(printf '%s\n' "${FINDINGS[@]}")" \
CHECK_WORST="${WORST}" \
CHECK_PID="${SERVER_PID}" \
CHECK_HTTP="${HTTP}" \
CHECK_PORT="${PORT}" \
CHECK_BIND="${BIND}" \
CHECK_CHATS="${CHATS}" \
CHECK_CHAT_MB="${CHAT_MB}" \
CHECK_AUDIT="${AUDIT}" \
python3 - <<'PY'
import datetime, json, os

rows = []
for line in os.environ.get("CHECK_ROWS", "").splitlines():
    if not line.strip():
        continue
    level, name, detail = line.split("|", 2)
    rows.append({"level": level, "check": name, "detail": detail})

worst = int(os.environ.get("CHECK_WORST") or 0)
entry = {
    "at": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
    "verdict": ["ok", "warn", "down"][worst],
    "pid": os.environ.get("CHECK_PID") or None,
    "bind": os.environ.get("CHECK_BIND") or None,
    "port": os.environ.get("CHECK_PORT") or None,
    "http": os.environ.get("CHECK_HTTP") or None,
    "agents": int(os.environ.get("CHECK_CHATS") or 0),
    "agent_mb": int(os.environ.get("CHECK_CHAT_MB") or 0),
    "checks": rows,
}
with open(os.environ["CHECK_AUDIT"], "a", encoding="utf-8") as fh:
    fh.write(json.dumps(entry) + "\n")
PY

exit ${WORST}
