#!/usr/bin/env bash
set -euo pipefail

DATA_FOLDER="${DATA_FOLDER:-/data}"
SCRAPER_PORT="${SCRAPER_INTERNAL_PORT:-8081}"

mkdir -p "$DATA_FOLDER"

echo "[entrypoint] starting scraper engine on 127.0.0.1:${SCRAPER_PORT} (data: ${DATA_FOLDER})"
google-maps-scraper -web -addr "127.0.0.1:${SCRAPER_PORT}" -data-folder "$DATA_FOLDER" &
SCRAPER_PID=$!

echo "[entrypoint] starting management UI on :${PORT:-3000}"
node /app/server/server.js &
NODE_PID=$!

shutdown() {
  echo "[entrypoint] shutting down..."
  kill -TERM "$SCRAPER_PID" "$NODE_PID" 2>/dev/null || true
  wait "$SCRAPER_PID" 2>/dev/null || true
  wait "$NODE_PID" 2>/dev/null || true
  exit 0
}
trap shutdown SIGTERM SIGINT

# Exit (and let the container restart) if either process dies unexpectedly.
wait -n "$SCRAPER_PID" "$NODE_PID"
EXIT_CODE=$?
echo "[entrypoint] a child process exited (code ${EXIT_CODE}), stopping the other one"
kill -TERM "$SCRAPER_PID" "$NODE_PID" 2>/dev/null || true
exit "$EXIT_CODE"
