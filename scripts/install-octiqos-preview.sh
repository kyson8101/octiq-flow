#!/usr/bin/env bash
#
# Install OctiqOS as an isolated local preview. It intentionally has its own
# launchd label, port, state profile, logs, and private environment file, so it
# cannot stop or overwrite the production OctiqFlow V2 service on port 1421.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_DIR="${HOME}"
SERVICE_HOME="${OCTIQ_OS_SERVICE_HOME:-${HOME_DIR}/.octiqos-preview}"
PORT="${OCTIQ_OS_PORT:-1422}"

if [[ "${PORT}" == "1421" ]]; then
  echo "Refusing port 1421: it belongs to the production OctiqFlow service." >&2
  exit 1
fi

exec env \
  OCTIQ_SERVICE_LABEL="com.kyson.octiqos.preview" \
  OCTIQ_SERVICE_HOME="${SERVICE_HOME}" \
  OCTIQOS_ENV_FILE="${SERVICE_HOME}/octiqos.env" \
  OCTIQ_PROFILE_DIR="${SERVICE_HOME}/profile" \
  OCTIQ_WEB_PORT="${PORT}" \
  "${ROOT_DIR}/scripts/install-service.sh" "$@"
