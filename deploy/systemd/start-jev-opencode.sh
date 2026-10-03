#!/usr/bin/env bash
set -euo pipefail

windows_gateway="$(/usr/sbin/ip route show default | /usr/bin/awk 'NR == 1 { print $3 }')"
if [[ -z "$windows_gateway" ]]; then
  echo "Could not discover the WSL host gateway" >&2
  exit 1
fi

export PORT=8791
export UPSTREAM_BASE_URL="http://${windows_gateway}:20128/v1"
export JEV_CLIENT=opencode
export JEV_LOG_FILE=/home/developer/.jev-gateway/opencode.log

exec /home/developer/.nvm/versions/node/v24.21.0/bin/node \
  /home/developer/.npm-global/lib/node_modules/jev-gateway/dist/index.js
