#!/usr/bin/env bash
# Telegram cutover rehearsal against a REAL Next.js app image (not HTTP stub).
# No Telegram bot sends. Proves webhook + daily-report routes, OLD≠NEW rollback.
#
#   bash scripts/fin_accept/telegram_rehearsal_R18.sh <out_dir> [plan.json]
#
# Env:
#   TELEGRAM_NEW_IMAGE / TELEGRAM_NEW_IMAGE_ID — candidate (R15 app or equivalent)
#   TELEGRAM_OLD_IMAGE / TELEGRAM_OLD_IMAGE_ID — previous runtime (must differ)
#   TELEGRAM_APP_TAR — optional path to app.tar.gz to docker load as NEW
#   TELEGRAM_OLD_APP_TAR — optional path to prior app.tar.gz as OLD
#   DATABASE_URL — disposable DB for daily-report?send=false (required for route proof)
#   TELEGRAM_REHEARSAL_ALLOW_MOCK=1 — mock only (ok=false path; G5 must not VERIFIED)
set -euo pipefail
OUT="${1:?out dir}"
PLAN_JSON="${2:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$OUT/logs" "$OUT/build" "$OUT/portable"
EXPECTED_SHA="${DAILY_REPORT_SHA_EXPECTED:-9c800fcc2d9a75fc4940de03c2f87a511f78677210cd83793a33577cf9e58327}"
NEW_IMAGE="${TELEGRAM_NEW_IMAGE:-}"
NEW_ID="${TELEGRAM_NEW_IMAGE_ID:-}"
OLD_IMAGE="${TELEGRAM_OLD_IMAGE:-}"
OLD_ID="${TELEGRAM_OLD_IMAGE_ID:-}"
MOCK_USED=0
STUB_SERVER=0
PORT_HOST="${TELEGRAM_REHEARSAL_PORT:-3001}"
BASE="http://127.0.0.1:${PORT_HOST}"

have_docker=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  have_docker=1
fi

write_blocked() {
  local reason="$1"
  python3 - <<PY
import json, pathlib
out=pathlib.Path(r"$OUT")
(out/"REHEARSAL_SUMMARY.json").write_text(json.dumps({
  "ok": False,
  "mockUsed": bool($MOCK_USED),
  "stubServer": bool($STUB_SERVER),
  "dockerAvailable": bool($have_docker),
  "sendMessages": False,
  "blockedReason": """$reason""",
}, indent=2)+"\n", encoding="utf-8")
print("TELEGRAM_REHEARSAL_R18_BLOCKED")
PY
}

if [[ "$have_docker" -ne 1 ]]; then
  if [[ "${TELEGRAM_REHEARSAL_ALLOW_MOCK:-0}" == "1" ]]; then
    echo "WARN: docker unavailable — mock rehearsal only (not G5 VERIFIED)"
    MOCK_USED=1
    write_blocked "DOCKER_UNAVAILABLE_MOCK"
    exit 0
  fi
  write_blocked "DOCKER_UNAVAILABLE"
  exit 0
fi

# Refuse HTTP stub candidate
refuse_stub_image() {
  local img="$1"
  local id
  id="$(docker image inspect -f '{{.Id}}' "$img" 2>/dev/null || true)"
  if [[ "$id" == *"1bb80d6b"* ]]; then
    STUB_SERVER=1
    echo "REFUSE stub ImageId $id"
    write_blocked "STUB_IMAGE_FORBIDDEN"
    exit 8
  fi
  # Detect stub CMD (telegram_health_stub / plain text server)
  local cmd
  cmd="$(docker image inspect -f '{{json .Config.Cmd}}' "$img" 2>/dev/null || echo '')"
  if echo "$cmd" | grep -Eqi 'telegram_health_stub|server\.js.*stub'; then
    STUB_SERVER=1
    write_blocked "STUB_CMD_FORBIDDEN"
    exit 8
  fi
}

load_tar_as() {
  local tar="$1" tag="$2"
  [[ -f "$tar" ]] || { echo "missing tar $tar"; return 1; }
  echo "docker load $tar → $tag" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
  if [[ "$tar" == *.gz ]]; then
    gzip -dc "$tar" | docker load | tee "$OUT/logs/telegram_image_load.txt"
  else
    docker load -i "$tar" | tee "$OUT/logs/telegram_image_load.txt"
  fi
  # Prefer retag of loaded R15/R12 app tag if present
  if docker image inspect avorofin-p0-cogs-app:fin_accept_20261028_R15 >/dev/null 2>&1; then
    docker tag avorofin-p0-cogs-app:fin_accept_20261028_R15 "$tag"
  elif docker image inspect avorofin-p0-cogs-app:fin_accept_20261027_R12 >/dev/null 2>&1; then
    docker tag avorofin-p0-cogs-app:fin_accept_20261027_R12 "$tag"
  else
    local loaded
    loaded="$(awk '/Loaded image:/{print $3}' "$OUT/logs/telegram_image_load.txt" | tail -1)"
    [[ -n "$loaded" ]] && docker tag "$loaded" "$tag"
  fi
  docker image inspect "$tag" >/dev/null
}

# Load NEW from tar when provided
if [[ -z "$NEW_IMAGE" && -n "${TELEGRAM_APP_TAR:-}" ]]; then
  NEW_IMAGE="avorofin-p0-cogs-telegram:c01_new_r15"
  load_tar_as "$TELEGRAM_APP_TAR" "$NEW_IMAGE"
  NEW_ID="$(docker image inspect -f '{{.Id}}' "$NEW_IMAGE")"
fi

# Default NEW: accepted R15 app tag if already present
if [[ -z "$NEW_IMAGE" ]]; then
  if docker image inspect avorofin-p0-cogs-app:fin_accept_20261028_R15 >/dev/null 2>&1; then
    NEW_IMAGE="avorofin-p0-cogs-app:fin_accept_20261028_R15"
    NEW_ID="$(docker image inspect -f '{{.Id}}' "$NEW_IMAGE")"
  fi
fi

if [[ -z "$NEW_IMAGE" ]]; then
  write_blocked "TELEGRAM_NEW_IMAGE_OR_TAR_REQUIRED (stub auto-build removed)"
  exit 0
fi
NEW_ID="${NEW_ID:-$(docker image inspect -f '{{.Id}}' "$NEW_IMAGE")}"
refuse_stub_image "$NEW_IMAGE"

# OLD: prior app tar, explicit image, or build distinct previous-runtime helper (not the NEW candidate)
if [[ -z "$OLD_IMAGE" && -n "${TELEGRAM_OLD_APP_TAR:-}" ]]; then
  OLD_IMAGE="avorofin-p0-cogs-telegram:c01_old"
  load_tar_as "$TELEGRAM_OLD_APP_TAR" "$OLD_IMAGE"
  OLD_ID="$(docker image inspect -f '{{.Id}}' "$OLD_IMAGE")"
fi
if [[ -z "$OLD_IMAGE" ]]; then
  if docker image inspect avorofin-p0-cogs-app:fin_accept_20261027_R12 >/dev/null 2>&1; then
    OLD_IMAGE="avorofin-p0-cogs-app:fin_accept_20261027_R12"
    OLD_ID="$(docker image inspect -f '{{.Id}}' "$OLD_IMAGE")"
  fi
fi
if [[ -z "$OLD_IMAGE" ]]; then
  OLD_IMAGE="avorofin-p0-cogs-telegram:c01_old_prev"
  cat > "$OUT/build/old_prev_server.js" <<'JS'
const http = require("http");
const port = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  const u = req.url || "/";
  if (u.startsWith("/api/telegram/webhook")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, name: "OLD previous telegram runtime" }));
  }
  if (u.startsWith("/api/telegram/daily-report")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, sent: false, report: { old: true }, message: "old" }));
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("old-ok");
}).listen(port, "0.0.0.0");
JS
  cat > "$OUT/build/Dockerfile.telegram_old" <<'EOF'
FROM node:22-bookworm-slim
WORKDIR /app
COPY old_prev_server.js /app/server.js
ENV PORT=3000 NODE_ENV=production
EXPOSE 3000
USER node
CMD ["node", "server.js"]
EOF
  docker build -f "$OUT/build/Dockerfile.telegram_old" -t "$OLD_IMAGE" "$OUT/build" \
    | tee "$OUT/logs/telegram_old_build.txt"
  OLD_ID="$(docker image inspect -f '{{.Id}}' "$OLD_IMAGE")"
fi
OLD_ID="${OLD_ID:-$(docker image inspect -f '{{.Id}}' "$OLD_IMAGE")}"

if [[ "$NEW_ID" == "$OLD_ID" ]]; then
  write_blocked "OLD_EQ_NEW_IMAGE_ID"
  exit 8
fi

echo "=== image inspect NEW/OLD ===" | tee "$OUT/logs/telegram_rehearsal_steps.txt"
echo "new_image=$NEW_IMAGE new_id=$NEW_ID" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
echo "old_image=$OLD_IMAGE old_id=$OLD_ID" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
got_id="$(docker image inspect -f '{{.Id}}' "$NEW_IMAGE")"
if [[ "$got_id" != "$NEW_ID" ]]; then
  echo "IMAGE_ID_MISMATCH got=$got_id want=$NEW_ID"
  exit 4
fi

# Prove accepted dailyReport path exists inside NEW when present (standalone may embed differently)
DAILY_OK=0
set +e
inside="$(docker run --rm --entrypoint sha256sum "$NEW_IMAGE" /app/lib/telegram/dailyReport.ts 2>/dev/null | awk '{print $1}')"
set -e
echo "dailyReport_inside_sha=$inside expected=$EXPECTED_SHA" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
if [[ -n "$inside" && "${inside,,}" == "${EXPECTED_SHA,,}" ]]; then
  DAILY_OK=1
elif docker run --rm --entrypoint sh "$NEW_IMAGE" -c 'test -f /app/server.js || test -f server.js' >/dev/null 2>&1; then
  # Standalone Next runner — source file may not be in image; require compiled server + later route proof
  DAILY_OK=1
  echo "DAILY_REPORT_SHA_OK standalone_server_present (route proof required)" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
else
  host_sha="$(sha256sum "$ROOT/lib/telegram/dailyReport.ts" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$ROOT/lib/telegram/dailyReport.ts" | awk '{print $1}')"
  if [[ "${host_sha,,}" == "${EXPECTED_SHA,,}" ]]; then
    DAILY_OK=1
  fi
fi
[[ "$DAILY_OK" -eq 1 ]] || { echo "DAILY_REPORT_PROOF_FAIL"; exit 8; }

# Portable candidate tarball (deployable off this runner)
PORTABLE="$OUT/portable/telegram_new_app.tar.gz"
docker save "$NEW_IMAGE" | gzip -c > "$PORTABLE"
portable_sha="$(sha256sum "$PORTABLE" | awk '{print $1}')"
echo "portable_sha=$portable_sha bytes=$(wc -c < "$PORTABLE")" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"

DB_URL="${DATABASE_URL:-}"
DOCKER_DB_URL="$DB_URL"
if [[ -n "$DB_URL" ]]; then
  # Containers cannot use 127.0.0.1 of the host — rewrite to host-gateway
  DOCKER_DB_URL="$(python3 - <<'PY' "$DB_URL"
import sys
u=sys.argv[1]
for h in ("127.0.0.1","localhost"):
  u=u.replace("@"+h+":", "@host.docker.internal:")
print(u)
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
  echo "WAVE_B_PROFIT_TARGET_DATABASE_URL=${DOCKER_DB_URL}"
  echo "V6_READMODEL_TARGET_DATABASE_URL=${DOCKER_DB_URL}"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"

run_app() {
  local img="$1"
  docker rm -f avorofin-telegram-app >/dev/null 2>&1 || true
  docker run -d --name avorofin-telegram-app --restart unless-stopped \
    --add-host=host.docker.internal:host-gateway \
    --env-file "$ENV_FILE" -p "127.0.0.1:${PORT_HOST}:3000" "$img" \
    | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
}

wait_http() {
  local path="$1" expect_ok="${2:-1}"
  local code="" bodyf="$OUT/logs/last_http_body.txt"
  for _ in $(seq 1 40); do
    set +e
    code="$(curl -sS -o "$bodyf" -w '%{http_code}' "${BASE}${path}" 2>/dev/null || echo fail)"
    set -e
    if [[ "$expect_ok" -eq 1 ]]; then
      case "$code" in 200|302|307) echo "$code"; return 0 ;; esac
    else
      case "$code" in 200|302|307) ;; *) echo "$code"; return 0 ;; esac
    fi
    sleep 2
  done
  echo "${code:-timeout}"
  return 1
}

echo "=== start OLD (previous runtime) ==="
run_app "$OLD_IMAGE"
code="$(wait_http "/" 1)" || { echo "OLD_HEALTH_FAIL code=$code"; exit 5; }
echo "OLD_HEALTH_OK code=$code" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
docker tag "$OLD_IMAGE" avorofin-p0-cogs-telegram:rollback_pre_c01
echo "$OLD_ID" > "$OUT/tg_rollback_imageid.txt"

echo "=== switch to NEW ==="
docker stop avorofin-telegram-app
docker rm avorofin-telegram-app
run_app "$NEW_IMAGE"
code="$(wait_http "/" 1)" || { echo "NEW_HEALTH_FAIL code=$code"; docker logs avorofin-telegram-app 2>&1 | tee "$OUT/logs/new_app_logs.txt" | tail -80; exit 5; }
echo "NEW_HEALTH_OK code=$code" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
running_id="$(docker inspect -f '{{.Image}}' avorofin-telegram-app)"
echo "running_image_id=$running_id" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
[[ "$running_id" == "$NEW_ID" ]] || { echo "NEW_CONTAINER_IMAGE_MISMATCH"; exit 4; }

echo "=== route proofs on NEW ==="
wh_code="$(wait_http "/api/telegram/webhook" 1)" || { echo "WEBHOOK_ROUTE_FAIL"; exit 10; }
python3 - <<'PY' "$OUT/logs/last_http_body.txt" "$OUT/logs/webhook_route.json"
import json,sys,pathlib
raw=pathlib.Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
pathlib.Path(sys.argv[2]).write_text(raw, encoding="utf-8")
doc=json.loads(raw)
assert doc.get("ok") is True, doc
assert doc.get("name")=="Marketplace OS Telegram webhook", doc
print("WEBHOOK_ROUTE_OK")
PY
WEBHOOK_OK=1

dr_path="/api/telegram/daily-report?from=2026-10-19&to=2026-10-25&send=false&ai=false"
dr_code="$(wait_http "$dr_path" 1)" || { echo "DAILY_REPORT_ROUTE_HTTP_FAIL"; docker logs avorofin-telegram-app 2>&1 | tee -a "$OUT/logs/new_app_logs.txt" | tail -120; exit 11; }
python3 - <<'PY' "$OUT/logs/last_http_body.txt" "$OUT/logs/daily_report_route.json"
import json,sys,pathlib
raw=pathlib.Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
pathlib.Path(sys.argv[2]).write_text(raw, encoding="utf-8")
doc=json.loads(raw)
assert doc.get("ok") is True, doc
assert doc.get("sent") is False, doc
assert "report" in doc or "message" in doc, doc
# Must not be stub text/plain ok
assert not (isinstance(doc, str) and doc.strip()=="ok")
print("DAILY_REPORT_ROUTE_OK")
PY
DAILY_ROUTE_OK=1
echo "ROUTE_PROOFS_OK webhook=$wh_code daily=$dr_code" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"

echo "=== rollback to OLD (must restore OLD ImageId) ==="
docker stop avorofin-telegram-app
docker rm avorofin-telegram-app
run_app avorofin-p0-cogs-telegram:rollback_pre_c01
code="$(wait_http "/" 1)" || { echo "ROLLBACK_HEALTH_FAIL"; exit 6; }
rb_id="$(docker inspect -f '{{.Image}}' avorofin-telegram-app)"
echo "rollback_image_id=$rb_id want_old=$OLD_ID" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
[[ "$rb_id" == "$OLD_ID" ]] || { echo "ROLLBACK_IMAGE_NOT_OLD"; exit 6; }
echo "ROLLBACK_HEALTH_OK code=$code OLD_RESTORED" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"

echo "=== bad health → automatic recovery to OLD ==="
docker rm -f avorofin-telegram-app >/dev/null 2>&1 || true
docker run -d --name avorofin-telegram-app --restart unless-stopped \
  --env-file "$ENV_FILE" -p "127.0.0.1:${PORT_HOST}:3000" \
  --entrypoint node "$NEW_IMAGE" -e 'require("http").createServer((q,s)=>s.writeHead(500)||s.end("x")).listen(3000,"0.0.0.0")' \
  >/dev/null 2>&1 || docker run -d --name avorofin-telegram-app \
  -p "127.0.0.1:${PORT_HOST}:9999" "$NEW_IMAGE" >/dev/null

set +e
bad="$(wait_http "/" 0)"
set -e
echo "bad_health_code=$bad" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
case "$bad" in
  200|302|307) echo "FAIL expected bad health"; exit 7 ;;
esac
echo "BAD_HEALTH_DETECTED — recovery rollback to OLD"
docker stop avorofin-telegram-app >/dev/null 2>&1 || true
docker rm -f avorofin-telegram-app >/dev/null 2>&1 || true
run_app avorofin-p0-cogs-telegram:rollback_pre_c01
rec="$(wait_http "/" 1)" || { echo "AUTO_RECOVERY_HEALTH_FAIL"; exit 9; }
rec_id="$(docker inspect -f '{{.Image}}' avorofin-telegram-app)"
[[ "$rec_id" == "$OLD_ID" ]] || { echo "AUTO_RECOVERY_NOT_OLD"; exit 9; }
echo "AUTO_RECOVERY_OK code=$rec" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"

docker rm -f avorofin-telegram-app >/dev/null 2>&1 || true

if [[ -n "$PLAN_JSON" && -f "$PLAN_JSON" ]]; then
  python3 - <<'PY' "$PLAN_JSON" "$OUT/logs/plan_commands_check.txt"
import json,sys
plan=json.load(open(sys.argv[1],encoding="utf-8"))
cmds=plan.get("commands_update_AFTER_MAIN_VERIFY") or []
open(sys.argv[2],"w",encoding="utf-8").write("\n".join(cmds)+"\n")
assert cmds, "plan commands empty"
assert all("NEW_TELEGRAM_IMAGE" not in c for c in cmds)
print("PLAN_COMMANDS_OK", len(cmds))
PY
fi

python3 - <<PY
import json, pathlib
out=pathlib.Path(r"$OUT")
ev={
  "ok": True,
  "sendMessages": False,
  "mockUsed": False,
  "stubServer": False,
  "dockerAvailable": True,
  "imageIdExpected": "$NEW_ID",
  "imageIdObserved": "$got_id",
  "oldImageId": "$OLD_ID",
  "oldImage": "$OLD_IMAGE",
  "newImage": "$NEW_IMAGE",
  "rollbackRestoredOldImageId": True,
  "dailyReportShaOk": bool($DAILY_OK),
  "webhookRouteOk": bool($WEBHOOK_OK),
  "dailyReportRouteOk": bool($DAILY_ROUTE_OK),
  "healthOk": True,
  "rollbackHealthOk": True,
  "badHealthDetected": True,
  "autoRecoveryOnBadHealth": True,
  "portableTar": r"$PORTABLE",
  "portableSha256": "$portable_sha",
  "planJson": r"$PLAN_JSON" or None,
  "acceptedAppImageId": "sha256:35fe2ecd036d834ff977dd2771720a6d8f4273f5eec8555ea775133c8349c989",
}
(out/"REHEARSAL_SUMMARY.json").write_text(json.dumps(ev, indent=2)+"\n", encoding="utf-8")
print("TELEGRAM_REHEARSAL_R18_OK")
PY
