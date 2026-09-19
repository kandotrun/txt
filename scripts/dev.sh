#!/usr/bin/env bash
# Start a clean local development server for txt.
#
# Why this exists: `wrangler dev` caches the asset manifest at boot. Rebuilding
# the web bundle while it runs leaves the ASSETS binding serving stale hashed
# filenames (observed as a 500 on `/`). Rebuilding first and then booting the
# server avoids the mismatch entirely. Stopping an old instance by port is also
# required, because two dev servers would fight over the same D1 state.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${TXT_DEV_PORT:-8799}"
STATE=".wrangler/dev-state"

# Stop any previous instance bound to this port (ignore "nothing found").
if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)"
  if [ -n "$PIDS" ]; then
    echo "$PIDS" | while read -r pid; do
      kill "$pid" 2>/dev/null || true
    done
    sleep 1
  fi
fi

npm run build:web
npx wrangler d1 migrations apply txt --local --persist-to "$STATE" --config config/wrangler.dev.jsonc >/dev/null

echo "starting txt dev server on http://localhost:${PORT}"
exec npx wrangler dev --config config/wrangler.dev.jsonc --port "$PORT" --persist-to "$STATE"
