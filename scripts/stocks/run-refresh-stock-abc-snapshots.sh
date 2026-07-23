#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT="/opt/avorofin"
IMAGE="avorofin-stock-abc-worker:latest"
LOCK_FILE="/tmp/avorofin-stock-abc-snapshot.lock"
LOG_DIR="$PROJECT/server-logs"
LOG_FILE="$LOG_DIR/stock-abc-snapshot.log"

mkdir -p "$LOG_DIR"
cd "$PROJECT"

exec 9>"$LOCK_FILE"

if ! flock -n 9; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) snapshot refresh already running" >> "$LOG_FILE"
  exit 0
fi

APP_CONTAINER="$(docker compose ps -q app 2>/dev/null || true)"

if [[ -z "$APP_CONTAINER" ]]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR app container not found" >> "$LOG_FILE"
  exit 1
fi

ENV_FILE="$(mktemp /tmp/avorofin-stock-abc-env.XXXXXX)"
chmod 600 "$ENV_FILE"

cleanup() {
  rm -f "$ENV_FILE"
}
trap cleanup EXIT

docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
  "$APP_CONTAINER" > "$ENV_FILE"

{
  echo "============================================================"
  echo "UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "TASK: refresh stock ABC snapshots"

  docker run --rm \
    --network host \
    --memory 6g \
    --cpus 3 \
    --env-file "$ENV_FILE" \
    "$IMAGE" \
    node --import tsx scripts/stocks/refreshStockAbcSnapshots.ts

  echo "RESULT: STOCK_ABC_SNAPSHOTS_REFRESHED"
} >> "$LOG_FILE" 2>&1
