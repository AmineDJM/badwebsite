#!/usr/bin/env bash
set -euo pipefail

DATA_FOLDER="${DATA_FOLDER:-/data}"
SCRAPER_PORT="${SCRAPER_INTERNAL_PORT:-8081}"
SCRAPER_CONCURRENCY="${SCRAPER_CONCURRENCY:-2}"
SCRAPER_BROWSER_POOL_SIZE="${SCRAPER_BROWSER_POOL_SIZE:-0}"

mkdir -p "$DATA_FOLDER"

SCRAPER_ARGS=(-web -addr "127.0.0.1:${SCRAPER_PORT}" -data-folder "$DATA_FOLDER" -c "$SCRAPER_CONCURRENCY")
# Only needed if you paste several individual static proxy IPs (see README):
# the engine binds one proxy per browser instance for that browser's whole
# lifetime, round-robin across the list, so with the default pool size only
# the first 1-2 proxies in a longer list would ever actually be used.
if [ "$SCRAPER_BROWSER_POOL_SIZE" -gt 0 ] 2>/dev/null; then
  SCRAPER_ARGS+=(-browser-pool-size "$SCRAPER_BROWSER_POOL_SIZE")
fi

echo "[entrypoint] starting scraper engine on 127.0.0.1:${SCRAPER_PORT} (data: ${DATA_FOLDER}, concurrency: ${SCRAPER_CONCURRENCY}, browser-pool-size: ${SCRAPER_BROWSER_POOL_SIZE})"
google-maps-scraper "${SCRAPER_ARGS[@]}" &
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
