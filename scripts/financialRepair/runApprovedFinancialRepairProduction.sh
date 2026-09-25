#!/usr/bin/env bash
# Future production host wrapper for owner-approved Ozon historical financial repair.
# DO NOT RUN NOW. No placeholders. No Stage1B. Production execution requires separate owner approval.
set -euo pipefail

die() { echo "FATAL: $*" >&2; exit 1; }
log() { echo "$*"; }

: "${OWNER_APPROVAL_FILE:?}"
: "${OWNER_APPROVAL_SHA256:?}"
: "${SOURCE_MANIFEST:?}"
: "${STATUS_MANIFEST:?}"
: "${SNAPSHOT_MANIFEST:?}"
: "${V2_MANIFEST:?}"
: "${APP_SWAP_SPEC:?}"
: "${OPERATION_ID:?}"
: "${SOURCE_BACKFILL_MANIFEST_SHA256:?}"
: "${STATUS_ONLY_MANIFEST_SHA256:?}"
: "${SNAPSHOT_TARGET_MANIFEST_SHA256:?}"
: "${V2_TARGET_MANIFEST_SHA256:?}"
: "${APP_SWAP_SPEC_SHA256:?}"
: "${PRE_DEPLOY_APP_IMAGE:?}"
: "${CANDIDATE_APP_IMAGE:?}"
: "${REPAIR_RUNNER_IMAGE:?}"
: "${APP_IMAGE_TAR:?}"
: "${APP_IMAGE_TAR_SHA256:?}"
: "${REPAIR_RUNNER_IMAGE_TAR:?}"
: "${REPAIR_RUNNER_IMAGE_TAR_SHA256:?}"
: "${ROLLBACK_APP_IMAGE:?}"

WORKDIR="${WORKDIR:-$(pwd)}"
OUT_DIR="${OUT_DIR:-$WORKDIR/out}"
MANIFEST_DIR="${MANIFEST_DIR:-$WORKDIR/manifests}"
SECRET_ENV_FILE=""
PRIOR_STATES_FILE="$OUT_DIR/PRIOR_CONTAINER_STATES.json"
PREPARE_CACHE_SHA=""
STAMP="$(date -u +%Y%m%d_%H%M%S)"
ROLLBACK_NAME="avorofin-app-pre-repair-${STAMP}"

mkdir -p "$OUT_DIR" "$MANIFEST_DIR"

sha_file() { sha256sum "$1" | awk '{print $1}'; }

cleanup() {
  local ec=$?
  if [[ -n "${SECRET_ENV_FILE}" && -f "${SECRET_ENV_FILE}" ]]; then
    shred -u "${SECRET_ENV_FILE}" 2>/dev/null || rm -f "${SECRET_ENV_FILE}"
  fi
  exit "$ec"
}
trap cleanup EXIT INT TERM

extract_secrets_from_running_app() {
  # Exact production secret source: Config.Env of running avorofin-app (proven by APP swap inspect).
  # Never echo values. Mode 600 temp file for docker --env-file.
  SECRET_ENV_FILE="$(mktemp /tmp/avorofin-repair-env.XXXXXX)"
  chmod 600 "$SECRET_ENV_FILE"
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' avorofin-app > "$SECRET_ENV_FILE"
  # Ensure required keys exist without printing values
  grep -q '^DATABASE_URL=' "$SECRET_ENV_FILE" || die "DATABASE_URL missing from APP env"
  log "SECRET_ENV_EXTRACTED=YES KEYS=$(grep -c '=' "$SECRET_ENV_FILE" || true)"
}

record_prior_states() {
  python3 - <<'PY' > "$PRIOR_STATES_FILE"
import json, subprocess
names = [
  "avorofin-app",
  "avorofin-profit-readmodel-worker",
  "avorofin-v6-period-readmodel-worker",
  "avorofin-dashboard-period-snapshot-worker",
  "avorofin-stock-planning-snapshot-worker",
]
out = []
for n in names:
  try:
    raw = subprocess.check_output(["docker","inspect",n], text=True)
    o = json.loads(raw)[0]
    out.append({
      "name": n,
      "running": o["State"]["Running"],
      "status": o["State"]["Status"],
      "image": o.get("Image"),
      "startedAt": o["State"].get("StartedAt"),
      "restartCount": o["RestartCount"],
    })
  except Exception as e:
    out.append({"name": n, "running": False, "error": str(e)})
print(json.dumps({"CURRENT_TASK_DATABASE_WRITE":"NO","containers":out}, indent=2))
PY
}

swap_candidate_app() {
  # Derived from FINANCIAL_REPAIR_APP_SWAP_SPEC.json (network=host, restart=unless-stopped,
  # entrypoint=docker-entrypoint.sh, cmd=node server.js, user=nextjs, no mounts).
  local spec_image
  spec_image="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["Image"])' "$APP_SWAP_SPEC")"
  test "$(docker inspect -f '{{.Image}}' avorofin-app)" = "$PRE_DEPLOY_APP_IMAGE" || die "pre-deploy image mismatch before swap"
  test "$spec_image" = "$PRE_DEPLOY_APP_IMAGE" || die "swap spec image != pre-deploy baseline"

  docker stop avorofin-app
  docker rename avorofin-app "$ROLLBACK_NAME"

  # Recreate equivalently from swap spec + candidate image + env-file (secrets not in package).
  docker create \
    --name avorofin-app \
    --network host \
    --restart unless-stopped \
    --user nextjs \
    --workdir /app \
    --env-file "$SECRET_ENV_FILE" \
    --entrypoint docker-entrypoint.sh \
    "$CANDIDATE_APP_IMAGE" \
    node server.js \
    || die "docker create candidate APP failed"

  docker start avorofin-app || die "docker start candidate APP failed"
  sleep 15
  test "$(docker inspect -f '{{.State.Status}}' avorofin-app)" = "running" || die "candidate APP not running"
  test "$(docker inspect -f '{{.Image}}' avorofin-app)" = "$CANDIDATE_APP_IMAGE" || die "mutation-time APP image mismatch"
  log "CANDIDATE_APP_SWAP=PASS IMAGE=$CANDIDATE_APP_IMAGE"
}

rollback_app_code_only() {
  log "ROLLBACK_APP_CODE_ONLY begin"
  docker stop avorofin-app || true
  docker rm avorofin-app || true
  docker rename "$ROLLBACK_NAME" avorofin-app || die "rollback rename failed"
  docker start avorofin-app || die "rollback start failed"
  test "$(docker inspect -f '{{.Image}}' avorofin-app)" = "$ROLLBACK_APP_IMAGE" || die "rollback image mismatch"
  log "ROLLBACK_APP_CODE_ONLY=PASS"
  log "NOTE: do not delete correctly imported historical Ozon source on code rollback"
}

# ---------- 1 PRE ----------
log "=== 1 PRE: approval + manifests + tar SHAs ==="
test -f "$OWNER_APPROVAL_FILE" || die "missing owner approval"
test "$(sha_file "$OWNER_APPROVAL_FILE")" = "$OWNER_APPROVAL_SHA256" || die "owner approval sha mismatch"
test "$(sha_file "$SOURCE_MANIFEST")" = "$SOURCE_BACKFILL_MANIFEST_SHA256" || die "source manifest sha"
test "$(sha_file "$STATUS_MANIFEST")" = "$STATUS_ONLY_MANIFEST_SHA256" || die "status manifest sha"
test "$(sha_file "$SNAPSHOT_MANIFEST")" = "$SNAPSHOT_TARGET_MANIFEST_SHA256" || die "snapshot manifest sha"
test "$(sha_file "$V2_MANIFEST")" = "$V2_TARGET_MANIFEST_SHA256" || die "v2 manifest sha"
test "$(sha_file "$APP_SWAP_SPEC")" = "$APP_SWAP_SPEC_SHA256" || die "app swap spec sha"
test "$SOURCE_BACKFILL_MANIFEST_SHA256" != "6f11a0d69daf2497e0bc6872bab67ded248c3196c08f22cfc31bba69565bf647" || die "stale banned hash"
test "$(sha_file "$APP_IMAGE_TAR")" = "$APP_IMAGE_TAR_SHA256" || die "APP tar sha mismatch"
test "$(sha_file "$REPAIR_RUNNER_IMAGE_TAR")" = "$REPAIR_RUNNER_IMAGE_TAR_SHA256" || die "repair-runner tar sha mismatch"

# ---------- 2 load images ----------
log "=== 2 docker load APP + repair-runner ==="
test "$(sha_file "$APP_IMAGE_TAR")" = "$APP_IMAGE_TAR_SHA256" || die "APP tar sha mismatch (recheck)"
test "$(sha_file "$REPAIR_RUNNER_IMAGE_TAR")" = "$REPAIR_RUNNER_IMAGE_TAR_SHA256" || die "runner tar sha mismatch (recheck)"
docker load -i "$APP_IMAGE_TAR"
docker load -i "$REPAIR_RUNNER_IMAGE_TAR"
test "$(docker image inspect -f '{{.Id}}' "$CANDIDATE_APP_IMAGE")" = "$CANDIDATE_APP_IMAGE" || die "loaded APP Id != approval"
test "$(docker image inspect -f '{{.Id}}' "$REPAIR_RUNNER_IMAGE")" = "$REPAIR_RUNNER_IMAGE" || die "loaded runner Id != approval"

# ---------- 3 pre-deploy rebind ----------
log "=== 3 pre-deploy baseline APP ==="
test "$(docker inspect -f '{{.Image}}' avorofin-app)" = "$PRE_DEPLOY_APP_IMAGE" || die "pre-deploy APP drift"
record_prior_states
extract_secrets_from_running_app

# ---------- 4 deploy candidate ----------
log "=== 4 exact candidate APP create/swap ==="
swap_candidate_app

# ---------- 5 canary ----------
log "=== 5 immediate candidate safety canary ==="
sleep 10
test "$(docker inspect -f '{{.State.Status}}' avorofin-app)" = "running" || die "canary status"
test "$(docker inspect -f '{{.State.OOMKilled}}' avorofin-app)" = "false" || die "canary OOM"

# ---------- 6 PREPARE (live read-only) ----------
log "=== 6 PREPARE live (Ozon+DB read-only; no writes) ==="
docker run --rm \
  --name "avorofin-repair-prepare-${STAMP}" \
  --network host \
  --env-file "$SECRET_ENV_FILE" \
  -v "$MANIFEST_DIR:/manifests:ro" \
  -v "$OUT_DIR:/out" \
  -v "$OWNER_APPROVAL_FILE:/approval/OWNER_APPROVAL.txt:ro" \
  "$REPAIR_RUNNER_IMAGE" \
  --mode=PREPARE \
  --prepareLive=1 \
  --sourceManifest=/manifests/source.json \
  --statusManifest=/manifests/status.json \
  --snapshotManifest=/manifests/snapshot.json \
  --v2Manifest=/manifests/v2.json \
  --approvalFile=/approval/OWNER_APPROVAL.txt \
  --approvalSha256="$OWNER_APPROVAL_SHA256" \
  --prepareCacheOut=/out/prepare-cache \
  --outDir=/out \
  || die "PREPARE failed"

PREPARE_CACHE_SHA="$(cat "$OUT_DIR/prepare-cache/PREPARE_CACHE.sha256.txt" | tr -d '\r\n')"
test -n "$PREPARE_CACHE_SHA" || die "missing runtime PREPARE_CACHE_SHA"
log "PREPARE_CACHE_SHA256=${PREPARE_CACHE_SHA}"

# ---------- 7 quiesce maintenance window B ----------
log "=== 7 QUIESCE APP + financial workers ==="
for c in avorofin-app avorofin-profit-readmodel-worker avorofin-v6-period-readmodel-worker avorofin-dashboard-period-snapshot-worker; do
  docker stop "$c"
  test "$(docker inspect -f '{{.State.Status}}' "$c")" = "exited" || die "failed stop $c"
done
# stock remains running (STOCK_PLANNING only) — re-verify env
STOCK_FORMULA="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' avorofin-stock-planning-snapshot-worker | grep '^DASHBOARD_SNAPSHOT_FORMULA_VERSIONS=' | cut -d= -f2-)"
test -n "$STOCK_FORMULA" || die "stock formula env missing"
test "$STOCK_FORMULA" = "STOCK_PLANNING_SNAPSHOT_V3" || die "stock formula restriction drifted: $STOCK_FORMULA"

# ---------- 8 EXECUTE_FROM_CACHE ----------
log "=== 8 EXECUTE_FROM_CACHE (zero Ozon network) ==="
docker run --rm \
  --name "avorofin-repair-execute-${STAMP}" \
  --network host \
  --env-file "$SECRET_ENV_FILE" \
  -e EXECUTE_FROM_CACHE_OZON_NETWORK_CALL_COUNT_MAX=0 \
  -v "$MANIFEST_DIR:/manifests:ro" \
  -v "$OUT_DIR:/out" \
  -v "$OUT_DIR/prepare-cache:/cache:ro" \
  -v "$OWNER_APPROVAL_FILE:/approval/OWNER_APPROVAL.txt:ro" \
  "$REPAIR_RUNNER_IMAGE" \
  --mode=EXECUTE_FROM_CACHE \
  --operationId="$OPERATION_ID" \
  --approvalBindingSha256="$OWNER_APPROVAL_SHA256" \
  --approvalFile=/approval/OWNER_APPROVAL.txt \
  --sourceBackfillManifestSha256="$SOURCE_BACKFILL_MANIFEST_SHA256" \
  --statusOnlyManifestSha256="$STATUS_ONLY_MANIFEST_SHA256" \
  --snapshotTargetManifestSha256="$SNAPSHOT_TARGET_MANIFEST_SHA256" \
  --v2TargetManifestSha256="$V2_TARGET_MANIFEST_SHA256" \
  --expectedPreDeployAppImageSha256="$PRE_DEPLOY_APP_IMAGE" \
  --expectedCandidateAppImageSha256="$CANDIDATE_APP_IMAGE" \
  --expectedRepairRunnerImageSha256="$REPAIR_RUNNER_IMAGE" \
  --mutationTimeAppImageSha256="$CANDIDATE_APP_IMAGE" \
  --sourceBackfillTargetCount=78 \
  --statusStandaloneTargetCount=10 \
  --snapshotPostBatchDeleteCount=35 \
  --snapshotPostBatchRequeueCount=35 \
  --v2NumericMutationTargetCount=2 \
  --executeMarker=OWNER_EXECUTE_OZON_HISTORICAL_FINANCIAL_REPAIR_V1 \
  --prepareCacheManifestSha256="$PREPARE_CACHE_SHA" \
  --sourceManifest=/manifests/source.json \
  --statusManifest=/manifests/status.json \
  --snapshotManifest=/manifests/snapshot.json \
  --v2Manifest=/manifests/v2.json \
  --prepareCache=/cache/PREPARE_CACHE.json \
  --prepareCacheManifest=/cache/PREPARE_CACHE.sha256.txt \
  --outDir=/out \
  || die "EXECUTE failed"

OPERATION_STARTED_AT="$(python3 -c 'import json; print(json.load(open("'"$OUT_DIR"'/EXECUTE_FROM_CACHE_RESULT.json")).get("operationStartedAt",""))')"
test -n "$OPERATION_STARTED_AT" || die "missing operationStartedAt from EXECUTE result"

# ---------- 9 VERIFY ----------
log "=== 9 VERIFY post-state ==="
docker run --rm \
  --network host \
  --env-file "$SECRET_ENV_FILE" \
  -v "$MANIFEST_DIR:/manifests:ro" \
  -v "$OUT_DIR:/out" \
  -v "$OUT_DIR/prepare-cache:/cache:ro" \
  "$REPAIR_RUNNER_IMAGE" \
  --mode=VERIFY \
  --sourceManifest=/manifests/source.json \
  --statusManifest=/manifests/status.json \
  --snapshotManifest=/manifests/snapshot.json \
  --v2Manifest=/manifests/v2.json \
  --prepareCache=/cache/PREPARE_CACHE.json \
  --operationStartedAt="${OPERATION_STARTED_AT}" \
  --outDir=/out \
  || die "VERIFY failed"

# ---------- 10 restore ----------
log "=== 10 RESTORE exact prior-running containers ==="
python3 - <<PY
import json, subprocess, sys
prior=json.load(open("$PRIOR_STATES_FILE"))["containers"]
want=["avorofin-app","avorofin-profit-readmodel-worker","avorofin-v6-period-readmodel-worker","avorofin-dashboard-period-snapshot-worker"]
for n in want:
  row=next(x for x in prior if x["name"]==n)
  if row.get("running"):
    subprocess.check_call(["docker","start",n])
    st=subprocess.check_output(["docker","inspect","-f","{{.State.Status}}",n], text=True).strip()
    if st!="running":
      sys.exit(f"restore failed {n}")
print("RESTORE=PASS")
PY

# one active instance per role
for c in avorofin-app avorofin-profit-readmodel-worker avorofin-v6-period-readmodel-worker avorofin-dashboard-period-snapshot-worker; do
  n="$(docker ps -q -f name=^/${c}$ | wc -l | tr -d ' ')"
  test "$n" = "1" || die "expected exactly one running $c got $n"
done

# ---------- 11 telegram send=false marker + stability ----------
log "=== 11 Telegram send=false + stability >=300s ==="
echo "TELEGRAM_SEND=false" > "$OUT_DIR/TELEGRAM_SEND_FALSE.txt"
sleep 300
test "$(docker inspect -f '{{.State.Status}}' avorofin-app)" = "running" || die "stability APP"
test "$(docker inspect -f '{{.State.OOMKilled}}' avorofin-app)" = "false" || die "stability OOM"

log "FINAL_MARKERS"
log "PRODUCTION_MUTATION_COMPLETED_UNDER_OWNER_APPROVAL=YES"
log "STAGE1B=NO"
log "STOP"
# Rollback path available via: ROLLBACK_APP=1 invoking rollback_app_code_only — not auto.
if [[ "${FORCE_ROLLBACK_AFTER:-0}" = "1" ]]; then
  rollback_app_code_only
fi
