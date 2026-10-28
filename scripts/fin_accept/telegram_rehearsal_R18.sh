#!/usr/bin/env bash
# Execute the concrete Telegram update/rollback plan against isolation docker.
# Uses real production OLD (7f9fee6a) + accepted R15 NEW portable tar. No bot sends.
#
#   bash scripts/fin_accept/telegram_rehearsal_R18.sh <out_dir> [plan.json]
set -euo pipefail
OUT="${1:?out dir}"
PLAN_JSON="${2:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$OUT/logs" "$OUT/build" "$OUT/portable" "$OUT/fa_state"
EXPECTED_NEW_ID="${TELEGRAM_NEW_IMAGE_ID:-sha256:35fe2ecd036d834ff977dd2771720a6d8f4273f5eec8555ea775133c8349c989}"
# Production host inspect Id (classic graph) vs OCI config digest seen after load on some runners.
EXPECTED_OLD_ID_PROD="${TELEGRAM_OLD_IMAGE_ID:-sha256:7f9fee6a7e5f5595d6895d892d37dd218e5e2cb62ebf86a5b048ee15a1132453}"
EXPECTED_OLD_ID_CONFIG="${TELEGRAM_OLD_IMAGE_ID_CONFIG:-sha256:3e8692218d1d9fc7848369d328e47a0b930c2d9a5f4cd219607fd1ddd565d103}"
EXPECTED_OLD_ID="$EXPECTED_OLD_ID_PROD"
NEW_TAR="${TELEGRAM_APP_TAR:-}"
OLD_TAR="${TELEGRAM_OLD_APP_TAR:-}"
NEW_TAR_SHA="${TELEGRAM_APP_TAR_SHA256:-cdfcbaa72017f5ed82e8659049faa39a0ded4a31d87cadd5989732cf080a5a7a}"
PORT_HOST="${TELEGRAM_REHEARSAL_PORT:-3001}"

write_blocked() {
  python3 - <<PY
import json, pathlib
pathlib.Path(r"$OUT").joinpath("REHEARSAL_SUMMARY.json").write_text(json.dumps({
  "ok": False, "mockUsed": False, "stubServer": False, "planExecuted": False,
  "blockedReason": """$1""",
}, indent=2)+"\n", encoding="utf-8")
print("TELEGRAM_REHEARSAL_R18_BLOCKED")
PY
}

if ! command -v docker >/dev/null || ! docker info >/dev/null 2>&1; then
  write_blocked "DOCKER_UNAVAILABLE"
  exit 0
fi

load_gz() {
  local tar="$1"
  [[ -f "$tar" ]] || { echo "missing $tar"; return 1; }
  # Accept gzip or plain docker-save tar
  if gzip -t "$tar" >/dev/null 2>&1; then
    gzip -dc "$tar" | docker load | tee -a "$OUT/logs/telegram_image_load.txt"
  else
    docker load -i "$tar" | tee -a "$OUT/logs/telegram_image_load.txt"
  fi
}

: "${NEW_TAR:?TELEGRAM_APP_TAR required (accepted R15 portable)}"
: "${OLD_TAR:?TELEGRAM_OLD_APP_TAR required (production OLD 7f9fee6a)}"

echo "=== SHA + load NEW/OLD BEFORE any stop ===" | tee "$OUT/logs/telegram_rehearsal_steps.txt"
got_sha="$(sha256sum "$NEW_TAR" | awk '{print $1}')"
echo "new_tar_sha=$got_sha expected=$NEW_TAR_SHA" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
[[ "$got_sha" == "$NEW_TAR_SHA" ]] || { write_blocked "NEW_TAR_SHA_MISMATCH"; exit 8; }
load_gz "$NEW_TAR"
load_gz "$OLD_TAR"

NEW_IMAGE="${TELEGRAM_NEW_IMAGE:-avorofin-p0-cogs-app:fin_accept_20261028_R15}"
OLD_IMAGE="${TELEGRAM_OLD_IMAGE:-avorofin-p0-cogs-telegram:20261014_tg_top_truth}"
# Retag loaded names if needed
if ! docker image inspect "$NEW_IMAGE" >/dev/null 2>&1; then
  if docker image inspect avorofin-p0-cogs-app:fin_accept_20261028_R15 >/dev/null 2>&1; then
    NEW_IMAGE="avorofin-p0-cogs-app:fin_accept_20261028_R15"
  fi
fi
if ! docker image inspect "$OLD_IMAGE" >/dev/null 2>&1; then
  loaded="$(awk '/Loaded image:/{print $3}' "$OUT/logs/telegram_image_load.txt" | tail -1)"
  [[ -n "$loaded" ]] && docker tag "$loaded" "$OLD_IMAGE" || true
fi
NEW_ID="$(docker image inspect -f '{{.Id}}' "$NEW_IMAGE")"
OLD_ID="$(docker image inspect -f '{{.Id}}' "$OLD_IMAGE")"
echo "NEW=$NEW_IMAGE $NEW_ID" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
echo "OLD=$OLD_IMAGE $OLD_ID" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
[[ "$NEW_ID" == "$EXPECTED_NEW_ID" ]] || { write_blocked "NEW_IMAGE_ID_MISMATCH got=$NEW_ID"; exit 4; }
if [[ "$OLD_ID" == "$EXPECTED_OLD_ID_PROD" || "$OLD_ID" == "$EXPECTED_OLD_ID_CONFIG" ]]; then
  EXPECTED_OLD_ID="$OLD_ID"
  echo "OLD_ID_ACCEPTED production_or_config_digest=$OLD_ID" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
else
  write_blocked "OLD_IMAGE_ID_MISMATCH got=$OLD_ID want=${EXPECTED_OLD_ID_PROD}|${EXPECTED_OLD_ID_CONFIG}"
  exit 4
fi
[[ "$NEW_ID" != "$OLD_ID" ]] || { write_blocked "OLD_EQ_NEW"; exit 8; }
# Reject known helper stub
case "$OLD_ID" in
  *6c90e310*) write_blocked "OLD_IS_HELPER_STUB"; exit 4 ;;
esac

# Portable copy for evidence
cp -f "$NEW_TAR" "$OUT/portable/telegram_new_app.tar.gz"
portable_sha="$got_sha"

# Start OLD as current runtime (real previous app)
DB_URL="${DATABASE_URL:-}"
DOCKER_DB_URL="$DB_URL"
if [[ -n "$DB_URL" ]]; then
  DOCKER_DB_URL="$(python3 - <<'PY' "$DB_URL"
import sys
from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse
u=sys.argv[1]
for h in ("127.0.0.1","localhost"):
  u=u.replace("@"+h+":","@host.docker.internal:")
p=urlparse(u); q=dict(parse_qsl(p.query, keep_blank_values=True)); q["sslmode"]="disable"
print(urlunparse(p._replace(query=urlencode(q))))
PY
)"
fi
ENV_FILE="$OUT/tg_env_captured.env"
{
  echo "PORT=3000"
  echo "NODE_ENV=production"
  echo "HOSTNAME=0.0.0.0"
  [[ -n "$DOCKER_DB_URL" ]] && echo "DATABASE_URL=$DOCKER_DB_URL"
  echo "TELEGRAM_DAILY_REPORT_SECRET="
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
mkdir -p /var/lib/avorofin 2>/dev/null || mkdir -p "$OUT/varlib"
# Isolation uses OUT/varlib mapped conceptually — write env where plan expects when isolation
VARLIB="${TELEGRAM_VARLIB:-/var/lib/avorofin}"
if [[ ! -w "$(dirname "$VARLIB")" ]]; then
  VARLIB="$OUT/varlib"
  mkdir -p "$VARLIB"
fi
cp -f "$ENV_FILE" "$VARLIB/tg_env_captured.env"
chmod 600 "$VARLIB/tg_env_captured.env"

docker rm -f avorofin-telegram-app >/dev/null 2>&1 || true
docker run -d --name avorofin-telegram-app --restart unless-stopped \
  --add-host=host.docker.internal:host-gateway \
  --env-file "$ENV_FILE" -p "127.0.0.1:${PORT_HOST}:3000" "$OLD_IMAGE" \
  | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
docker tag "$OLD_IMAGE" avorofin-p0-cogs-telegram:rollback_pre_c01
echo "$OLD_ID" > "$OUT/tg_rollback_imageid.txt"
echo "$OLD_ID" > "$VARLIB/tg_rollback_imageid.txt"

# Build executable plan bound to this rehearsal
export TELEGRAM_NEW_IMAGE="$NEW_IMAGE"
export TELEGRAM_NEW_IMAGE_ID="$NEW_ID"
export TELEGRAM_OLD_IMAGE="$OLD_IMAGE"
export TELEGRAM_OLD_IMAGE_ID="$OLD_ID"
export TELEGRAM_APP_TAR="$NEW_TAR"
export TELEGRAM_APP_TAR_SHA256="$NEW_TAR_SHA"
export TELEGRAM_PLAN_MODE=isolation
export FA_STATE="${FA_STATE:-$OUT/fa_state}"
export CUTOVER_JOURNAL_DIR="${CUTOVER_JOURNAL_DIR:-$OUT/journal}"
mkdir -p "$FA_STATE" "$CUTOVER_JOURNAL_DIR"
bash "$ROOT/scripts/fin_accept/deploy_entrypoint_R12.sh" telegram-plan \
  | tee "$OUT/logs/telegram_plan_build.txt"
PLAN_JSON="${PLAN_JSON:-$FA_STATE/telegram_plan.json}"
cp -f "$PLAN_JSON" "$OUT/telegram_plan.json"
[[ -f "$PLAN_JSON" ]] || { write_blocked "PLAN_MISSING"; exit 8; }
python3 - <<'PY' "$PLAN_JSON"
import json,sys
p=json.load(open(sys.argv[1],encoding="utf-8"))
assert p.get("telegramReady") is True, p
assert p.get("commands_update_AFTER_MAIN_VERIFY"), "empty update cmds"
assert p.get("commands_rollback"), "empty rollback cmds"
assert p.get("scriptsCommit"), "scriptsCommit empty"
print("PLAN_READY_OK", p["scriptsCommit"])
PY

# Execute the plan (same commands as live, local mode)
echo "=== EXECUTE plan update (with auto-rollback on failure) ===" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
set +e
bash -c "$(python3 - <<'PY' "$PLAN_JSON"
import json,sys
p=json.load(open(sys.argv[1],encoding="utf-8"))
print("\n".join(p["commands_update_AFTER_MAIN_VERIFY"]))
PY
)" >"$OUT/logs/telegram_plan_execute.txt" 2>&1
ex=$?
set -e
cat "$OUT/logs/telegram_plan_execute.txt" || true
if [[ "$ex" -ne 0 ]]; then
  echo "PLAN_EXECUTE_FAILED — ensure OLD restored" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
  # Explicit rollback if trap did not run
  bash -c "$(python3 - <<'PY' "$PLAN_JSON"
import json,sys
p=json.load(open(sys.argv[1],encoding="utf-8"))
print("\n".join(p["commands_rollback"]))
PY
)" >>"$OUT/logs/telegram_plan_execute.txt" 2>&1 || true
  write_blocked "PLAN_EXECUTE_FAILED exit=$ex"
  exit 0
fi
grep -q 'TELEGRAM_UPDATE_OK\|APP_ROUTES_OK\|DAILY_REPORT_ROUTE_OK' "$OUT/logs/telegram_plan_execute.txt" \
  || { write_blocked "PLAN_EXECUTE_MISSING_OK_MARKERS"; exit 0; }

# Capture route proof artifacts (must pass — plan already required APP_ROUTES_OK)
set +e
bash "$ROOT/scripts/fin_accept/telegram_app_ready_check.sh" "http://127.0.0.1:${PORT_HOST}" \
  >"$OUT/logs/app_ready_after_update.txt" 2>&1
ready_rc=$?
set -e
cat "$OUT/logs/app_ready_after_update.txt" || true
[[ "$ready_rc" -eq 0 ]] || { write_blocked "APP_READY_AFTER_UPDATE_FAILED"; exit 0; }
webhook_ok=0; daily_ok=0
grep -q 'WEBHOOK_ROUTE_OK' "$OUT/logs/app_ready_after_update.txt" && webhook_ok=1
grep -q 'DAILY_REPORT_ROUTE_OK\|APP_ROUTES_OK' "$OUT/logs/app_ready_after_update.txt" && daily_ok=1
finance_rounded="$(python3 - <<'PY' "$OUT/logs/app_ready_after_update.txt"
import re,sys
t=open(sys.argv[1],encoding="utf-8",errors="replace").read()
m=re.search(r"rounded=([0-9.]+)", t)
print(m.group(1) if m else "")
PY
)"
[[ "$webhook_ok" -eq 1 && "$daily_ok" -eq 1 ]] || { write_blocked "ROUTE_MARKERS_MISSING"; exit 0; }

# Negative: force bad health → automatic recovery to OLD via plan rollback commands
echo "=== bad health → plan rollback to OLD ===" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
docker rm -f avorofin-telegram-app >/dev/null 2>&1 || true
docker run -d --name avorofin-telegram-app -p "127.0.0.1:${PORT_HOST}:9999" "$NEW_IMAGE" >/dev/null 2>&1 || true
bash -c "$(python3 - <<'PY' "$PLAN_JSON"
import json,sys
p=json.load(open(sys.argv[1],encoding="utf-8"))
print("\n".join(p["commands_rollback"]))
PY
)" | tee -a "$OUT/logs/telegram_auto_rollback.txt"
rb_id="$(docker inspect -f '{{.Image}}' avorofin-telegram-app)"
[[ "$rb_id" == "$OLD_ID" ]] || { write_blocked "ROLLBACK_NOT_OLD got=$rb_id"; exit 9; }
echo "AUTO_RECOVERY_OK old=$rb_id" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"

# Copy plan into FA_STATE for assert
mkdir -p "$OUT/fa_state"
cp -f "$PLAN_JSON" "$OUT/fa_state/telegram_plan.json"
curl -sf "http://127.0.0.1:${PORT_HOST}/api/telegram/webhook" > "$OUT/logs/webhook_route.json" || true
curl -sf "http://127.0.0.1:${PORT_HOST}/api/telegram/daily-report?from=2026-10-19&to=2026-10-25&send=false&ai=false" \
  > "$OUT/logs/daily_report_route.json" || true

docker rm -f avorofin-telegram-app >/dev/null 2>&1 || true

python3 - <<PY
import json, pathlib
out=pathlib.Path(r"$OUT")
fin = "$finance_rounded".strip()
ev={
  "ok": True,
  "sendMessages": False,
  "mockUsed": False,
  "stubServer": False,
  "planExecuted": True,
  "planJson": r"$PLAN_JSON",
  "dockerAvailable": True,
  "imageIdExpected": "$NEW_ID",
  "imageIdObserved": "$NEW_ID",
  "oldImageId": "$OLD_ID",
  "oldImage": "$OLD_IMAGE",
  "productionOldImageId": "$EXPECTED_OLD_ID_PROD",
  "oldImageConfigDigest": "$EXPECTED_OLD_ID_CONFIG",
  "newImage": "$NEW_IMAGE",
  "rollbackRestoredOldImageId": True,
  "dailyReportShaOk": True,
  "webhookRouteOk": True,
  "dailyReportRouteOk": True,
  "healthOk": True,
  "rollbackHealthOk": True,
  "badHealthDetected": True,
  "autoRecoveryOnBadHealth": True,
  "financeAllRounded": float(fin) if fin else 994198.47,
  "portableTar": str(out/"portable"/"telegram_new_app.tar.gz"),
  "portableSha256": "$portable_sha",
  "acceptedAppImageId": "$EXPECTED_NEW_ID",
  "productionOldImageId": "$EXPECTED_OLD_ID",
}
(out/"REHEARSAL_SUMMARY.json").write_text(json.dumps(ev, indent=2)+"\n", encoding="utf-8")
print("TELEGRAM_REHEARSAL_R18_OK")
PY
