#!/bin/sh
set -eu
# Use the browser's environment hostname, including its allocated port. Explicit
# nonempty values also prevent getEnv() falling back to a source .env build URL.
cat >> /usr/share/nginx/html/performanceV2/env-config.js <<'EOF'
window.__ENV__.VITE_API_BASE_URL = window.location.origin;
window.__ENV__.VITE_SSO_BASE_URL = window.location.origin + '/sso';
window.__ENV__.VITE_SIGNALR_BASE_URL = window.location.origin + '/core';
EOF
