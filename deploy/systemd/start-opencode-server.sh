#!/usr/bin/env bash
set -euo pipefail

# systemd does not inherit the developer's interactive shell credentials.
# Load the existing 9Router credential without copying it into the repository.
source /home/developer/.profile

if [[ -z "${NINEROUTER_KEY:-}" ]]; then
  echo "NINEROUTER_KEY is not configured" >&2
  exit 1
fi

export OPENAI_API_KEY="$NINEROUTER_KEY"

exec /usr/local/bin/opencode serve --hostname 127.0.0.1 --port 4096
