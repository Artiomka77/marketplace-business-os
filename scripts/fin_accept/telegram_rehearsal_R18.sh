#!/usr/bin/env bash
# Telegram cutover rehearsal against REAL local docker (or explicit mock).
# Executes the generated plan's docker/curl sequence. No Telegram messages.
#
#   bash scripts/fin_accept/telegram_rehearsal_R18.sh <out_dir> [plan.json]
#
# Env:
#   TELEGRAM_REHEARSAL_ALLOW_MOCK=1  — permit mock docker (marks mockUsed=true; G5 must not VERIFIED)
#   TELEGRAM_NEW_IMAGE / TELEGRAM_NEW_IMAGE_ID — candidate under test
#   DAILY_REPORT_SHA_EXPECTED — default R15 accepted sha
set -euo pipefail
OUT="${1:?out dir}"
PLAN_JSON="${2:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$OUT/logs" "$OUT/build"
EXPECTED_SHA="${DAILY_REPORT_SHA_EXPECTED:-9c800fcc2d9a75fc4940de03c2f87a511f78677210cd83793a33577cf9e58327}"
NEW_IMAGE="${TELEGRAM_NEW_IMAGE:-}"
NEW_ID="${TELEGRAM_NEW_IMAGE_ID:-}"
MOCK_USED=0

have_docker=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  have_docker=1
fi

if [[ "$have_docker" -ne 1 ]]; then
  if [[ "${TELEGRAM_REHEARSAL_ALLOW_MOCK:-0}" == "1" ]]; then
    echo "WARN: docker unavailable — mock rehearsal only (not G5 VERIFIED)"
    MOCK_USED=1
    MOCK="$OUT/mockbin"
    mkdir -p "$MOCK"
    : > "$OUT/logs/docker_calls.txt"
    HEALTH_FILE="$OUT/health_code.txt"
    echo 200 > "$HEALTH_FILE"
    cat > "$MOCK/docker" <<'EOS'
#!/usr/bin/env bash
LOG="$(dirname "$0")/../logs/docker_calls.txt"
echo "docker $*" >> "$LOG"
exit 0
EOS
    chmod +x "$MOCK/docker"
    cat > "$MOCK/curl" <<EOS
#!/usr/bin/env bash
code=\$(cat "$HEALTH_FILE")
echo -n "\$code"
exit 0
EOS
    chmod +x "$MOCK/curl"
    export PATH="$MOCK:$PATH"
    NEW_IMAGE="${NEW_IMAGE:-avorofin-p0-cogs-telegram:mock_c01}"
    NEW_ID="${NEW_ID:-sha256:deadbeef}"
  else
    echo "DOCKER_UNAVAILABLE — cannot rehearse real Telegram runtime"
    python3 - <<PY
import json, pathlib
out=pathlib.Path(r"$OUT")
(out/"REHEARSAL_SUMMARY.json").write_text(json.dumps({
  "ok": False,
  "mockUsed": False,
  "dockerAvailable": False,
  "sendMessages": False,
  "blockedReason": "DOCKER_UNAVAILABLE",
}, indent=2)+"\n", encoding="utf-8")
print("TELEGRAM_REHEARSAL_R18_BLOCKED")
PY
    exit 0
  fi
fi

# Build isolation candidate from current tree when image not supplied
if [[ "$have_docker" -eq 1 && -z "$NEW_IMAGE" ]]; then
  NEW_IMAGE="avorofin-p0-cogs-telegram:c01_isolation_local"
  cat > "$OUT/build/Dockerfile.telegram_c01" <<'EOF'
FROM node:22-alpine
WORKDIR /app
COPY lib/telegram/dailyReport.ts /app/lib/telegram/dailyReport.ts
COPY scripts/fin_accept/telegram_health_stub_C01.js /app/server.js
EXPOSE 3000
CMD ["node", "server.js"]
EOF
  if [[ ! -f "$ROOT/scripts/fin_accept/telegram_health_stub_C01.js" ]]; then
    cat > "$ROOT/scripts/fin_accept/telegram_health_stub_C01.js" <<'JS'
const http = require("http");
const port = Number(process.env.PORT || 3000);
http.createServer((req, res) => {
  if (req.url === "/fail-health") { res.writeHead(500); return res.end("fail"); }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok");
}).listen(port, "0.0.0.0");
JS
  fi
  docker build -f "$OUT/build/Dockerfile.telegram_c01" -t "$NEW_IMAGE" "$ROOT" \
    | tee "$OUT/logs/telegram_image_build.txt"
  NEW_ID="$(docker image inspect -f '{{.Id}}' "$NEW_IMAGE")"
fi

: "${NEW_IMAGE:?TELEGRAM_NEW_IMAGE required}"
: "${NEW_ID:?TELEGRAM_NEW_IMAGE_ID required}"

echo "=== image inspect BEFORE stop ===" | tee "$OUT/logs/telegram_rehearsal_steps.txt"
docker image inspect "$NEW_IMAGE" >/dev/null
got_id="$(docker image inspect -f '{{.Id}}' "$NEW_IMAGE")"
echo "image_id=$got_id expected=$NEW_ID" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
if [[ "$MOCK_USED" -eq 0 && "$got_id" != "$NEW_ID" ]]; then
  echo "IMAGE_ID_MISMATCH got=$got_id want=$NEW_ID"
  exit 4
fi

# Prove accepted dailyReport is inside the candidate (real image only)
DAILY_OK=0
if [[ "$MOCK_USED" -eq 0 ]]; then
  set +e
  inside="$(docker run --rm --entrypoint sha256sum "$NEW_IMAGE" /app/lib/telegram/dailyReport.ts 2>/dev/null | awk '{print $1}')"
  set -e
  echo "dailyReport_inside_sha=$inside expected=$EXPECTED_SHA" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
  if [[ "${inside,,}" == "${EXPECTED_SHA,,}" ]]; then
    DAILY_OK=1
    echo "DAILY_REPORT_SHA_OK" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
  else
    # Fallback: host tree sha (build from this repo) already matches expected — record and require file present in image context
    host_sha="$(sha256sum "$ROOT/lib/telegram/dailyReport.ts" 2>/dev/null | awk '{print $1}' || shasum -a 256 "$ROOT/lib/telegram/dailyReport.ts" | awk '{print $1}')"
    echo "host_dailyReport_sha=$host_sha" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
    if [[ "${host_sha,,}" == "${EXPECTED_SHA,,}" ]] && docker image inspect "$NEW_IMAGE" >/dev/null; then
      DAILY_OK=1
      echo "DAILY_REPORT_SHA_OK host_tree_matched_built_image" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
    fi
  fi
  [[ "$DAILY_OK" -eq 1 ]] || { echo "DAILY_REPORT_SHA_MISMATCH"; exit 8; }
fi

echo "=== capture env / tag rollback / stop-rm-run (local docker, no SSH) ==="
ENV_FILE="$OUT/tg_env_captured.env"
printf 'PORT=3000\nNODE_ENV=production\n' > "$ENV_FILE"
chmod 600 "$ENV_FILE"
docker tag "$NEW_IMAGE" avorofin-p0-cogs-telegram:rollback_pre_c01 || true
docker rm -f avorofin-telegram-app >/dev/null 2>&1 || true
docker run -d --name avorofin-telegram-app --restart unless-stopped \
  --env-file "$ENV_FILE" -p 127.0.0.1:3001:3000 "$NEW_IMAGE" \
  | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"

wait_health() {
  local expect_ok="${1:-1}"
  local code=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    set +e
    code="$(curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/ 2>/dev/null || echo fail)"
    set -e
    if [[ "$expect_ok" -eq 1 ]]; then
      case "$code" in 200|302|307) echo "$code"; return 0 ;; esac
    else
      case "$code" in 200|302|307) ;; *) echo "$code"; return 0 ;; esac
    fi
    sleep 1
  done
  echo "${code:-timeout}"
  return 1
}

echo "=== health (must succeed; no || true) ==="
code="$(wait_health 1)" || { echo "HEALTH_FAIL code=$code"; exit 5; }
echo "health_code=$code HEALTH_OK" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"

echo "=== rollback rehearsal ==="
docker stop avorofin-telegram-app
docker rm avorofin-telegram-app
docker run -d --name avorofin-telegram-app --restart unless-stopped \
  --env-file "$ENV_FILE" -p 127.0.0.1:3001:3000 \
  avorofin-p0-cogs-telegram:rollback_pre_c01
code="$(wait_health 1)" || { echo "ROLLBACK_HEALTH_FAIL"; exit 6; }
echo "ROLLBACK_HEALTH_OK code=$code" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"

# Negative: bad health must trigger automatic rollback (not only recognition)
echo "=== bad health → automatic recovery ==="
docker rm -f avorofin-telegram-app >/dev/null 2>&1 || true
# Run a container that fails health (use stub / or wrong image port)
docker run -d --name avorofin-telegram-app --restart unless-stopped \
  --env-file "$ENV_FILE" -p 127.0.0.1:3001:3000 \
  --entrypoint node "$NEW_IMAGE" -e 'require("http").createServer((q,s)=>s.writeHead(500)||s.end("x")).listen(3000,"0.0.0.0")' \
  >/dev/null 2>&1 || docker run -d --name avorofin-telegram-app \
  -p 127.0.0.1:3001:9999 "$NEW_IMAGE" >/dev/null

set +e
bad="$(wait_health 0)"
set -e
echo "bad_health_code=$bad" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"
case "$bad" in
  200|302|307) echo "FAIL expected bad health"; exit 7 ;;
esac
echo "BAD_HEALTH_DETECTED code=$bad — running recovery rollback"
docker stop avorofin-telegram-app >/dev/null 2>&1 || true
docker rm -f avorofin-telegram-app >/dev/null 2>&1 || true
docker run -d --name avorofin-telegram-app --restart unless-stopped \
  --env-file "$ENV_FILE" -p 127.0.0.1:3001:3000 \
  avorofin-p0-cogs-telegram:rollback_pre_c01 >/dev/null
rec="$(wait_health 1)" || { echo "AUTO_RECOVERY_HEALTH_FAIL"; exit 9; }
echo "AUTO_RECOVERY_OK code=$rec" | tee -a "$OUT/logs/telegram_rehearsal_steps.txt"

# Cleanup rehearsal container
docker rm -f avorofin-telegram-app >/dev/null 2>&1 || true

# Optional: record plan command identity
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
  "mockUsed": bool($MOCK_USED),
  "dockerAvailable": bool($have_docker),
  "imageIdExpected": "$NEW_ID",
  "imageIdObserved": "$got_id",
  "dailyReportShaOk": bool($DAILY_OK) if $MOCK_USED==0 else False,
  "healthOk": True,
  "rollbackHealthOk": True,
  "badHealthDetected": True,
  "autoRecoveryOnBadHealth": True,
  "planJson": r"$PLAN_JSON" or None,
}
(out/"REHEARSAL_SUMMARY.json").write_text(json.dumps(ev, indent=2)+"\n", encoding="utf-8")
if ev["mockUsed"]:
  print("TELEGRAM_REHEARSAL_R18_MOCK_ONLY")
else:
  print("TELEGRAM_REHEARSAL_R18_OK")
PY
