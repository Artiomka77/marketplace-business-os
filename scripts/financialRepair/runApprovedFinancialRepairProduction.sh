#!/usr/bin/env bash
# Production host wrapper for the owner-approved Ozon historical financial repair.
#
# The owner approval file is the ONLY authority for security-relevant values. The
# environment supplies paths and nothing else: every hash, image id and count is read
# out of the approval by scripts/financialRepair/resolveProductionWrapperBinding.ts,
# which parses it with the strict whitelist grammar in lib/ozon/ownerApprovalBinding.ts.
# The approval is read as data only: it is never sourced and never interpreted as code.
#
# Phase order (PREPARE runs against the BASELINE app, before anything is swapped):
#   0  single-writer lock
#   1  approval binding + four verified image tars
#   2  swap-spec bindings + live pre-deploy identity
#   3  prior container states + per-container secret env
#   4  PREPARE (live Ozon + DB read-only, zero writes)
#   5  deploy candidates: APP started, v6 + dashboard created but held down
#   6  candidate APP canary
#   7  quiesce APP + the four financial workers
#   8  EXECUTE_FROM_CACHE  <-- pre-mutation gate lives here; phase boundary
#   9  VERIFY_MUTATION_POSTCONDITIONS
#  10  start candidate v6 + dashboard workers, poll exact SUCCESS counts
#  11  restore APP + profit worker
#  12  VERIFY_FINAL_FINANCIAL_OUTPUT
#  13  authenticated July/August canary plan artifact
#  14  deferred Telegram plan artifact (no PASS is ever claimed from a marker)
#  15  stability window + final markers
#
# Failure before the mutation window restores the baseline. Failure after it does NOT
# roll back and writes RESUME_REQUIRED instead: rolling back code after the database
# has been mutated would hide a half-applied repair.
set -Eeuo pipefail

die() { echo "FATAL: $*" >&2; exit 1; }
log() { echo "$*"; }

# ---------- 0 single-writer lock ----------
LOCK_FILE="/tmp/avorofin-financial-repair.lock"
exec 9>"$LOCK_FILE" || die "cannot open $LOCK_FILE"
flock -n 9 || die "another financial repair run holds $LOCK_FILE"
log "SINGLE_WRITER_LOCK=ACQUIRED FILE=$LOCK_FILE"

# ---------- environment: PATHS ONLY ----------
: "${OWNER_APPROVAL_FILE:?path to the owner approval text}"
: "${SOURCE_MANIFEST:?path to OZON_SOURCE_BACKFILL_TARGETS}"
: "${STATUS_MANIFEST:?path to OZON_STATUS_ONLY_REPAIR_TARGETS}"
: "${SNAPSHOT_MANIFEST:?path to SNAPSHOT_POST_BATCH_TARGETS}"
: "${V2_MANIFEST:?path to V2_POST_BATCH_TARGETS}"
: "${APP_SWAP_SPEC:?path to FINANCIAL_REPAIR_APP_SWAP_SPEC.json}"
: "${V6_WORKER_SWAP_SPEC:?path to FINANCIAL_REPAIR_V6_WORKER_SWAP_SPEC.json}"
: "${DASHBOARD_WORKER_SWAP_SPEC:?path to FINANCIAL_REPAIR_DASHBOARD_WORKER_SWAP_SPEC.json}"
: "${APP_IMAGE_TAR:?path to the candidate APP image tar}"
: "${REPAIR_RUNNER_IMAGE_TAR:?path to the financial-repair-runner image tar}"
: "${V6_WORKER_IMAGE_TAR:?path to the v6-period-readmodel-worker image tar}"
: "${DASHBOARD_WORKER_IMAGE_TAR:?path to the dashboard-period-snapshot-worker image tar}"

WORKDIR="${WORKDIR:-$(pwd)}"
OUT_DIR="${OUT_DIR:-$WORKDIR/out}"
BIND_DIR="$OUT_DIR/bind"
CACHE_DIR="$OUT_DIR/prepare-cache"
STAMP="$(date -u +%Y%m%d_%H%M%S)"

APP_CONTAINER="avorofin-app"
PROFIT_CONTAINER="avorofin-profit-readmodel-worker"
V6_CONTAINER="avorofin-v6-period-readmodel-worker"
DASHBOARD_CONTAINER="avorofin-dashboard-period-snapshot-worker"
STOCK_CONTAINER="avorofin-stock-planning-snapshot-worker"
QUIESCE_CONTAINERS=("$APP_CONTAINER" "$PROFIT_CONTAINER" "$V6_CONTAINER" "$DASHBOARD_CONTAINER")

APP_ROLLBACK_NAME="avorofin-app-pre-repair-${STAMP}"
V6_ROLLBACK_NAME="avorofin-v6-worker-pre-repair-${STAMP}"
DASHBOARD_ROLLBACK_NAME="avorofin-dashboard-worker-pre-repair-${STAMP}"

PRIOR_STATES_FILE="$OUT_DIR/PRIOR_CONTAINER_STATES.json"
PRIOR_RUNNING_FILE="$OUT_DIR/PRIOR_RUNNING.txt"
BIND_ENV="$BIND_DIR/OWNER_APPROVAL_RESOLVED.env"
EXECUTE_LOG="$OUT_DIR/EXECUTE_FROM_CACHE.log"

APP_ENV_FILE=""
V6_ENV_FILE=""
DASHBOARD_ENV_FILE=""
SECRET_ENV_FILES=()

# Resolved from the approval in phase 1; pre-declared so the failure trap can never
# trip over `set -u` while it is trying to restore the baseline.
ROLLBACK_APP_IMAGE=""
ROLLBACK_V6_WORKER_IMAGE=""
ROLLBACK_DASHBOARD_WORKER_IMAGE=""

PHASE="INIT"
MUTATION_WINDOW_ENTERED=0
MUTATION_PROVEN_ZERO_WRITES=0
APP_SWAPPED=0
V6_SWAPPED=0
DASHBOARD_SWAPPED=0

for tool in docker flock python3 sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not on PATH: $tool"
done

mkdir -p "$OUT_DIR" "$BIND_DIR" "$CACHE_DIR"
# The repair-runner image runs as uid 1001; every directory it writes to must be
# owned by that uid or the run fails deep inside a container instead of here.
chown -R 1001:1001 "$OUT_DIR" || die "cannot chown $OUT_DIR to the runner uid"

sha_file() { sha256sum "$1" | awk '{print $1}'; }

shred_secret_files() {
  local file
  for file in "${SECRET_ENV_FILES[@]:-}"; do
    [[ -n "$file" && -f "$file" ]] || continue
    if ! shred -u "$file" 2>/dev/null; then
      rm -f "$file"
    fi
  done
}

resolved_get() {
  local key="$1" value
  if ! value="$(grep -m1 -E "^${key}=" "$BIND_ENV")"; then
    die "resolved approval binding has no $key"
  fi
  value="${value#*=}"
  [[ -n "$value" ]] || die "resolved approval binding has an empty $key"
  printf '%s' "$value"
}

spec_get() {
  local file="$1" key="$2" value
  if ! value="$(grep -m1 -E "^${key}=" "$file")"; then
    die "swap spec binding $file has no $key"
  fi
  value="${value#*=}"
  [[ -n "$value" ]] || die "swap spec binding $file has an empty $key"
  printf '%s' "$value"
}

was_running() {
  local name="$1" line
  if ! line="$(grep -m1 -E "^${name}=" "$PRIOR_RUNNING_FILE")"; then
    return 1
  fi
  [[ "${line#*=}" == "true" ]]
}

container_exists() { docker container inspect "$1" >/dev/null 2>&1; }

# ---------- phase-aware failure handling ----------

write_resume_required() {
  local ec="$1"
  cat > "$OUT_DIR/RESUME_REQUIRED.json" <<EOF
{
  "RESUME_REQUIRED": "YES",
  "FAILED_BEFORE_DB_MUTATION": "NO",
  "BASELINE_RESTORED": "NO",
  "phase": "$PHASE",
  "exitCode": $ec,
  "reason": "the mutation window was entered and zero-writes could not be proven; rolling back code now would hide a half-applied repair",
  "operatorNextStep": "inspect $OUT_DIR/EXECUTE_FROM_CACHE_RESULT.json and $EXECUTE_LOG, then resume with the same approval and the same PREPARE cache",
  "doNotDelete": "correctly imported historical Ozon source rows",
  "stamp": "$STAMP"
}
EOF
  echo "RESUME_REQUIRED=YES PHASE=$PHASE BASELINE_RESTORED=NO" >&2
}

restore_role_baseline() {
  local name="$1" rollback="$2" rollback_image="$3" ok=0
  if container_exists "$name"; then
    if ! docker stop "$name"; then echo "ROLLBACK_STOP_FAILED $name" >&2; fi
    if ! docker rm "$name"; then echo "ROLLBACK_RM_FAILED $name" >&2; fi
  fi
  if ! container_exists "$rollback"; then
    echo "ROLLBACK_CONTAINER_MISSING $rollback" >&2
    return 1
  fi
  if ! docker rename "$rollback" "$name"; then
    echo "ROLLBACK_RENAME_FAILED $rollback -> $name" >&2
    return 1
  fi
  if was_running "$name"; then
    if ! docker start "$name"; then
      echo "ROLLBACK_START_FAILED $name" >&2
      return 1
    fi
    if [[ "$(docker inspect -f '{{.Image}}' "$name")" != "$rollback_image" ]]; then
      echo "ROLLBACK_IMAGE_MISMATCH $name" >&2
      return 1
    fi
    ok=1
  else
    ok=1
  fi
  echo "ROLLBACK_ROLE_RESTORED $name running=$(was_running "$name" && echo yes || echo no)"
  return $((1 - ok))
}

restore_baseline_after_prefailure() {
  local ec="$1" failures=0
  echo "RESTORE_BASELINE begin phase=$PHASE" >&2
  if [[ "$APP_SWAPPED" = "1" ]]; then
    restore_role_baseline "$APP_CONTAINER" "$APP_ROLLBACK_NAME" \
      "$ROLLBACK_APP_IMAGE" || failures=$((failures + 1))
  elif was_running "$APP_CONTAINER" && ! docker start "$APP_CONTAINER"; then
    failures=$((failures + 1))
  fi
  if [[ "$V6_SWAPPED" = "1" ]]; then
    restore_role_baseline "$V6_CONTAINER" "$V6_ROLLBACK_NAME" \
      "$ROLLBACK_V6_WORKER_IMAGE" || failures=$((failures + 1))
  elif was_running "$V6_CONTAINER" && ! docker start "$V6_CONTAINER"; then
    failures=$((failures + 1))
  fi
  if [[ "$DASHBOARD_SWAPPED" = "1" ]]; then
    restore_role_baseline "$DASHBOARD_CONTAINER" "$DASHBOARD_ROLLBACK_NAME" \
      "$ROLLBACK_DASHBOARD_WORKER_IMAGE" || failures=$((failures + 1))
  elif was_running "$DASHBOARD_CONTAINER" && ! docker start "$DASHBOARD_CONTAINER"; then
    failures=$((failures + 1))
  fi
  if was_running "$PROFIT_CONTAINER" && ! docker start "$PROFIT_CONTAINER"; then
    failures=$((failures + 1))
  fi
  cat > "$OUT_DIR/BASELINE_RESTORED.json" <<EOF
{
  "FAILED_BEFORE_DB_MUTATION": "YES",
  "BASELINE_RESTORED": "$([[ $failures -eq 0 ]] && echo YES || echo PARTIAL)",
  "RESUME_REQUIRED": "NO",
  "restoreFailures": $failures,
  "phase": "$PHASE",
  "exitCode": $ec,
  "mutationProvenZeroWrites": "$([[ "$MUTATION_PROVEN_ZERO_WRITES" = "1" ]] && echo YES || echo NOT_APPLICABLE)",
  "stamp": "$STAMP"
}
EOF
  echo "FAILED_BEFORE_DB_MUTATION=YES RESTORE_FAILURES=$failures" >&2
}

on_exit() {
  local ec=$?
  trap - EXIT INT TERM
  set +e
  if [[ $ec -eq 0 ]]; then
    shred_secret_files
    exit 0
  fi
  echo "FATAL_EXIT code=$ec phase=$PHASE" >&2
  if [[ "$MUTATION_WINDOW_ENTERED" = "1" && "$MUTATION_PROVEN_ZERO_WRITES" != "1" ]]; then
    write_resume_required "$ec"
  else
    restore_baseline_after_prefailure "$ec"
  fi
  shred_secret_files
  exit "$ec"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------- helpers that talk to docker ----------

load_image_tar() {
  local tar="$1" label="$2" out tag id
  if ! out="$(docker load -i "$tar")"; then
    die "docker load failed for $label"
  fi
  printf '%s\n' "$out" >> "$OUT_DIR/DOCKER_LOAD.log"
  tag="$(printf '%s\n' "$out" | sed -n 's/^Loaded image: //p' | head -n1)"
  if [[ -n "$tag" ]]; then
    if ! id="$(docker image inspect -f '{{.Id}}' "$tag")"; then
      die "docker image inspect failed for $label tag $tag"
    fi
  else
    id="$(printf '%s\n' "$out" | sed -n 's/^Loaded image ID: //p' | head -n1)"
  fi
  [[ "$id" =~ ^sha256:[0-9a-f]{64}$ ]] || die "cannot determine loaded image id for $label"
  printf '%s' "$id"
}

# Writes the container's own Config.Env to a 0600 file for `docker --env-file`.
# Values are never echoed. Runtime-identity keys are dropped because they belong to
# the image being replaced, not to the configuration the owner approved, and the last
# occurrence of a duplicated key wins so the file is deterministic.
extract_container_env() {
  local container="$1" label="$2" file
  file="$(mktemp "/tmp/avorofin-repair-env-${label}.XXXXXX")"
  chmod 600 "$file"
  SECRET_ENV_FILES+=("$file")
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" \
    | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' \
    | grep -vE '^(PATH|HOME|HOSTNAME|NODE_VERSION|YARN_VERSION)=' \
    | awk -F= '{ key=$1; line[key]=$0; if (!(key in seen)) { seen[key]=1; order[++n]=key } }
               END { for (i = 1; i <= n; i++) print line[order[i]] }' \
    > "$file"
  grep -q '^DATABASE_URL=' "$file" || die "DATABASE_URL missing from $container env"
  log "SECRET_ENV_EXTRACTED container=$container KEYS=$(grep -c '=' "$file")"
  printf '%s' "$file"
}

require_container_env() {
  local container="$1" key="$2" expected="$3" observed
  observed="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" \
    | grep -m1 -E "^${key}=" | cut -d= -f2-)"
  [[ -n "$observed" ]] || die "$container has no $key"
  [[ "$observed" == "$expected" ]] || die "$container $key drifted: $observed != $expected"
  log "CONTAINER_ENV_PINNED container=$container $key=$expected"
}

refuse_container_env_key() {
  local container="$1" key="$2"
  if docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" \
    | grep -qE "^${key}="; then
    die "$container must not declare $key"
  fi
}

# ---------- 1 approval binding + four verified image tars ----------
PHASE="APPROVAL_BINDING"
log "=== 1 owner approval binding + four verified image tars ==="

for path in \
  "$OWNER_APPROVAL_FILE" "$SOURCE_MANIFEST" "$STATUS_MANIFEST" "$SNAPSHOT_MANIFEST" \
  "$V2_MANIFEST" "$APP_SWAP_SPEC" "$V6_WORKER_SWAP_SPEC" "$DASHBOARD_WORKER_SWAP_SPEC" \
  "$APP_IMAGE_TAR" "$REPAIR_RUNNER_IMAGE_TAR" "$V6_WORKER_IMAGE_TAR" \
  "$DASHBOARD_WORKER_IMAGE_TAR"; do
  test -f "$path" || die "missing input file: $path"
done

# Bootstrap pin. The authoritative parser ships INSIDE the repair-runner image, so the
# tar has to be trusted before it can be read. Exactly one key is read here with an
# anchored 64-hex grep — enough to pin the parser image, and nothing else. The
# authoritative binding produced by that image is required to agree with it below, so
# this shortcut cannot widen what the run accepts.
bootstrap_pin() {
  local key="$1" line
  if ! line="$(grep -m1 -E "^${key}=[0-9a-f]{64}$" "$OWNER_APPROVAL_FILE")"; then
    die "owner approval does not pin $key as a 64-hex sha256"
  fi
  printf '%s' "${line#*=}"
}
BOOTSTRAP_RUNNER_TAR_SHA="$(bootstrap_pin REPAIR_RUNNER_IMAGE_TAR_SHA256)"
OBSERVED_RUNNER_TAR_SHA="$(sha_file "$REPAIR_RUNNER_IMAGE_TAR")"
test "$OBSERVED_RUNNER_TAR_SHA" = "$BOOTSTRAP_RUNNER_TAR_SHA" \
  || die "repair-runner tar sha mismatch: $OBSERVED_RUNNER_TAR_SHA"
log "REPAIR_RUNNER_TAR_PINNED=YES SHA256=$OBSERVED_RUNNER_TAR_SHA"

REPAIR_RUNNER_IMAGE="$(load_image_tar "$REPAIR_RUNNER_IMAGE_TAR" repair-runner)"

mkdir -p "$BIND_DIR"
chown 1001:1001 "$BIND_DIR" || die "cannot chown $BIND_DIR"
# --network none and no env-file: the parser reads one mounted text file and writes one
# mounted text file. It cannot reach the database, Ozon, or any secret.
docker run --rm \
  --name "avorofin-repair-approval-binding-${STAMP}" \
  --network none \
  -v "$OWNER_APPROVAL_FILE:/approval/OWNER_APPROVAL.txt:ro" \
  -v "$BIND_DIR:/bind" \
  --entrypoint docker-entrypoint.sh \
  "$REPAIR_RUNNER_IMAGE" \
  node --import tsx scripts/financialRepair/resolveProductionWrapperBinding.ts \
    --mode=APPROVAL \
    --approvalFile=/approval/OWNER_APPROVAL.txt \
    --out=/bind/OWNER_APPROVAL_RESOLVED.env \
    --jsonOut=/bind/OWNER_APPROVAL_WRAPPER_BINDING.json \
  || die "owner approval binding failed"
test -s "$BIND_ENV" || die "owner approval binding produced no output"

OWNER_APPROVAL_SHA256="$(resolved_get OWNER_APPROVAL_SHA256)"
OPERATION_ID="$(resolved_get OPERATION_ID)"
EXECUTE_MARKER="$(resolved_get EXECUTE_MARKER)"
PRODUCTION_MUTATION="$(resolved_get PRODUCTION_MUTATION)"

test "$PRODUCTION_MUTATION" = "YES" \
  || die "approval declares PRODUCTION_MUTATION=$PRODUCTION_MUTATION; this wrapper only runs an approved production mutation"

PRE_DEPLOY_APP_IMAGE="$(resolved_get PRE_DEPLOY_CURRENT_APP_IMAGE_SHA256)"
CANDIDATE_APP_IMAGE="$(resolved_get CANDIDATE_APP_IMAGE_SHA256)"
ROLLBACK_APP_IMAGE="$(resolved_get ROLLBACK_APP_IMAGE_SHA256)"
PRE_DEPLOY_V6_WORKER_IMAGE="$(resolved_get PRE_DEPLOY_CURRENT_V6_WORKER_IMAGE_SHA256)"
CANDIDATE_V6_WORKER_IMAGE="$(resolved_get CANDIDATE_V6_WORKER_IMAGE_SHA256)"
ROLLBACK_V6_WORKER_IMAGE="$(resolved_get ROLLBACK_V6_WORKER_IMAGE_SHA256)"
PRE_DEPLOY_DASHBOARD_WORKER_IMAGE="$(resolved_get PRE_DEPLOY_CURRENT_DASHBOARD_WORKER_IMAGE_SHA256)"
CANDIDATE_DASHBOARD_WORKER_IMAGE="$(resolved_get CANDIDATE_DASHBOARD_WORKER_IMAGE_SHA256)"
ROLLBACK_DASHBOARD_WORKER_IMAGE="$(resolved_get ROLLBACK_DASHBOARD_WORKER_IMAGE_SHA256)"

SOURCE_BACKFILL_MANIFEST_SHA256="$(resolved_get SOURCE_BACKFILL_MANIFEST_SHA256)"
STATUS_ONLY_MANIFEST_SHA256="$(resolved_get STATUS_ONLY_MANIFEST_SHA256)"
SNAPSHOT_TARGET_MANIFEST_SHA256="$(resolved_get SNAPSHOT_POST_BATCH_MANIFEST_SHA256)"
V2_TARGET_MANIFEST_SHA256="$(resolved_get V2_POST_BATCH_MANIFEST_SHA256)"

SOURCE_BACKFILL_TARGET_COUNT="$(resolved_get SOURCE_BACKFILL_TARGET_COUNT)"
STATUS_STANDALONE_REPAIR_COUNT="$(resolved_get STATUS_STANDALONE_REPAIR_COUNT)"
SNAPSHOT_POST_BATCH_DELETE_COUNT="$(resolved_get SNAPSHOT_POST_BATCH_DELETE_COUNT)"
SNAPSHOT_POST_BATCH_REQUEUE_COUNT="$(resolved_get SNAPSHOT_POST_BATCH_REQUEUE_COUNT)"
V2_NUMERIC_MUTATION_TARGET_COUNT="$(resolved_get V2_NUMERIC_MUTATION_TARGET_COUNT)"
V6_JOB_SUCCESS_EXPECTED_COUNT="$(resolved_get V6_JOB_SUCCESS_EXPECTED_COUNT)"
SNAPSHOT_JOB_SUCCESS_EXPECTED_COUNT="$(resolved_get SNAPSHOT_JOB_SUCCESS_EXPECTED_COUNT)"

# The authoritative parser must agree with the bootstrap pin, or the shortcut above
# read something the real grammar does not accept.
test "$(resolved_get REPAIR_RUNNER_IMAGE_TAR_SHA256)" = "$BOOTSTRAP_RUNNER_TAR_SHA" \
  || die "bootstrap pin disagrees with the parsed approval on REPAIR_RUNNER_IMAGE_TAR_SHA256"
test "$(resolved_get CANDIDATE_REPAIR_RUNNER_IMAGE_SHA256)" = "$REPAIR_RUNNER_IMAGE" \
  || die "loaded repair-runner image $REPAIR_RUNNER_IMAGE is not the approved image"

# Every remaining file is hashed on disk and compared to the approval. Nothing is
# taken on the operator's word.
verify_file_against_approval() {
  local path="$1" key="$2" observed expected
  observed="$(sha_file "$path")"
  expected="$(resolved_get "$key")"
  test "$observed" = "$expected" || die "$key mismatch for $path: $observed != $expected"
  log "FILE_PINNED $key=$observed path=$path"
}

verify_file_against_approval "$SOURCE_MANIFEST" SOURCE_BACKFILL_MANIFEST_SHA256
verify_file_against_approval "$STATUS_MANIFEST" STATUS_ONLY_MANIFEST_SHA256
verify_file_against_approval "$SNAPSHOT_MANIFEST" SNAPSHOT_POST_BATCH_MANIFEST_SHA256
verify_file_against_approval "$V2_MANIFEST" V2_POST_BATCH_MANIFEST_SHA256
verify_file_against_approval "$APP_SWAP_SPEC" APP_SWAP_SPEC_SHA256
verify_file_against_approval "$V6_WORKER_SWAP_SPEC" V6_WORKER_SWAP_SPEC_SHA256
verify_file_against_approval "$DASHBOARD_WORKER_SWAP_SPEC" DASHBOARD_WORKER_SWAP_SPEC_SHA256
verify_file_against_approval "$APP_IMAGE_TAR" APP_IMAGE_TAR_SHA256
verify_file_against_approval "$V6_WORKER_IMAGE_TAR" V6_WORKER_IMAGE_TAR_SHA256
verify_file_against_approval "$DASHBOARD_WORKER_IMAGE_TAR" DASHBOARD_WORKER_IMAGE_TAR_SHA256

LOADED_APP_IMAGE="$(load_image_tar "$APP_IMAGE_TAR" candidate-app)"
LOADED_V6_WORKER_IMAGE="$(load_image_tar "$V6_WORKER_IMAGE_TAR" v6-period-readmodel-worker)"
LOADED_DASHBOARD_WORKER_IMAGE="$(load_image_tar "$DASHBOARD_WORKER_IMAGE_TAR" dashboard-period-snapshot-worker)"

test "$LOADED_APP_IMAGE" = "$CANDIDATE_APP_IMAGE" || die "loaded APP image != approval"
test "$LOADED_V6_WORKER_IMAGE" = "$CANDIDATE_V6_WORKER_IMAGE" || die "loaded v6 worker image != approval"
test "$LOADED_DASHBOARD_WORKER_IMAGE" = "$CANDIDATE_DASHBOARD_WORKER_IMAGE" \
  || die "loaded dashboard worker image != approval"

log "FOUR_IMAGES_LOADED_AND_PINNED=YES"
log "  APP=$CANDIDATE_APP_IMAGE"
log "  REPAIR_RUNNER=$REPAIR_RUNNER_IMAGE"
log "  V6_WORKER=$CANDIDATE_V6_WORKER_IMAGE"
log "  DASHBOARD_WORKER=$CANDIDATE_DASHBOARD_WORKER_IMAGE"

# ---------- 2 swap-spec bindings + live pre-deploy identity ----------
PHASE="SWAP_SPEC_BINDING"
log "=== 2 swap-spec bindings + live pre-deploy identity ==="

resolve_swap_spec() {
  local spec="$1" name="$2" expected_image="$3" label="$4" dir="$BIND_DIR/spec-$label"
  mkdir -p "$dir"
  chown 1001:1001 "$dir" || die "cannot chown $dir"
  docker run --rm \
    --name "avorofin-repair-swapspec-${label}-${STAMP}" \
    --network none \
    -v "$spec:/spec/SWAP_SPEC.json:ro" \
    -v "$dir:/bind" \
    --entrypoint docker-entrypoint.sh \
    "$REPAIR_RUNNER_IMAGE" \
    node --import tsx scripts/financialRepair/resolveProductionWrapperBinding.ts \
      --mode=SWAP_SPEC \
      --specFile=/spec/SWAP_SPEC.json \
      --expectedName="$name" \
      --expectedImage="$expected_image" \
      --out=/bind/SWAP_SPEC_RESOLVED.env \
    || die "swap spec binding failed for $name"
  test -s "$dir/SWAP_SPEC_RESOLVED.env" || die "swap spec binding produced no output for $name"
  printf '%s' "$dir/SWAP_SPEC_RESOLVED.env"
}

APP_SPEC_ENV="$(resolve_swap_spec "$APP_SWAP_SPEC" "$APP_CONTAINER" "$PRE_DEPLOY_APP_IMAGE" app)"
V6_SPEC_ENV="$(resolve_swap_spec "$V6_WORKER_SWAP_SPEC" "$V6_CONTAINER" "$PRE_DEPLOY_V6_WORKER_IMAGE" v6)"
DASHBOARD_SPEC_ENV="$(resolve_swap_spec "$DASHBOARD_WORKER_SWAP_SPEC" "$DASHBOARD_CONTAINER" \
  "$PRE_DEPLOY_DASHBOARD_WORKER_IMAGE" dashboard)"

require_live_pre_deploy_image() {
  local container="$1" expected="$2" observed
  container_exists "$container" || die "$container does not exist on this host"
  observed="$(docker inspect -f '{{.Image}}' "$container")"
  test "$observed" = "$expected" || die "$container pre-deploy image drift: $observed != $expected"
  log "PRE_DEPLOY_IMAGE_PINNED container=$container image=$expected"
}
require_live_pre_deploy_image "$APP_CONTAINER" "$PRE_DEPLOY_APP_IMAGE"
require_live_pre_deploy_image "$V6_CONTAINER" "$PRE_DEPLOY_V6_WORKER_IMAGE"
require_live_pre_deploy_image "$DASHBOARD_CONTAINER" "$PRE_DEPLOY_DASHBOARD_WORKER_IMAGE"

# The quiesce contract rests on these two env values: the dashboard worker claims the
# financial V4 formula (so it must stop), the stock worker cannot (so it stays up).
require_container_env "$DASHBOARD_CONTAINER" DASHBOARD_SNAPSHOT_FORMULA_VERSIONS \
  "FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1"
require_container_env "$STOCK_CONTAINER" DASHBOARD_SNAPSHOT_FORMULA_VERSIONS \
  "STOCK_PLANNING_SNAPSHOT_V3"
require_container_env "$V6_CONTAINER" V6_READMODEL_WORKER_MODE "queue"
refuse_container_env_key "$V6_CONTAINER" V6_READMODEL_ALLOW_PROD_PERSIST

# ---------- 3 prior container states + per-container secret env ----------
PHASE="PRIOR_STATE_CAPTURE"
log "=== 3 prior container states + per-container secret env ==="

python3 - "$PRIOR_STATES_FILE" "$PRIOR_RUNNING_FILE" <<'PY'
import json, subprocess, sys

states_path, running_path = sys.argv[1], sys.argv[2]
names = [
    "avorofin-app",
    "avorofin-profit-readmodel-worker",
    "avorofin-v6-period-readmodel-worker",
    "avorofin-dashboard-period-snapshot-worker",
    "avorofin-stock-planning-snapshot-worker",
]
rows = []
for name in names:
    try:
        raw = subprocess.check_output(["docker", "inspect", name], text=True)
        obj = json.loads(raw)[0]
        rows.append(
            {
                "name": name,
                "running": obj["State"]["Running"],
                "status": obj["State"]["Status"],
                "image": obj.get("Image"),
                "startedAt": obj["State"].get("StartedAt"),
                "restartCount": obj["RestartCount"],
            }
        )
    except Exception as error:  # a container that is absent is recorded as not running
        rows.append({"name": name, "running": False, "error": str(error)})

with open(states_path, "w", encoding="utf-8") as handle:
    json.dump({"CURRENT_TASK_DATABASE_WRITE": "NO", "containers": rows}, handle, indent=2)
    handle.write("\n")
with open(running_path, "w", encoding="utf-8") as handle:
    for row in rows:
        handle.write(f"{row['name']}={'true' if row.get('running') else 'false'}\n")
print("PRIOR_CONTAINER_STATES=CAPTURED")
PY
test -s "$PRIOR_RUNNING_FILE" || die "prior container state capture produced no output"

for container in "${QUIESCE_CONTAINERS[@]}"; do
  was_running "$container" || die "$container is not running; refusing to start a repair from an unknown baseline"
done

APP_ENV_FILE="$(extract_container_env "$APP_CONTAINER" app)"
V6_ENV_FILE="$(extract_container_env "$V6_CONTAINER" v6)"
DASHBOARD_ENV_FILE="$(extract_container_env "$DASHBOARD_CONTAINER" dashboard)"

# ---------- runner invocation ----------
# The repair-runner image inherits the node entrypoint, which prepends `node` to any
# argument list starting with `-`. The command is therefore always spelled out in full
# so a `--mode=` argument can never be handed to node itself.
MANIFEST_MOUNTS=(
  -v "$SOURCE_MANIFEST:/manifests/source.json:ro"
  -v "$STATUS_MANIFEST:/manifests/status.json:ro"
  -v "$SNAPSHOT_MANIFEST:/manifests/snapshot.json:ro"
  -v "$V2_MANIFEST:/manifests/v2.json:ro"
)
MANIFEST_ARGS=(
  --sourceManifest=/manifests/source.json
  --statusManifest=/manifests/status.json
  --snapshotManifest=/manifests/snapshot.json
  --v2Manifest=/manifests/v2.json
)
RUNNER_ENTRY=(--entrypoint docker-entrypoint.sh)
RUNNER_CMD=(node --import tsx scripts/financialRepair/runOzonHistoricalFinancialRepair.ts)
DRAIN_CMD=(node --import tsx scripts/financialRepair/pollRepairWorkerDrain.ts)

# ---------- 4 PREPARE, against the baseline APP, before anything is swapped ----------
PHASE="PREPARE"
log "=== 4 PREPARE (live Ozon + database read-only; zero writes) ==="

docker run --rm \
  --name "avorofin-repair-prepare-${STAMP}" \
  --network host \
  --env-file "$APP_ENV_FILE" \
  "${MANIFEST_MOUNTS[@]}" \
  -v "$OWNER_APPROVAL_FILE:/approval/OWNER_APPROVAL.txt:ro" \
  -v "$OUT_DIR:/out" \
  "${RUNNER_ENTRY[@]}" \
  "$REPAIR_RUNNER_IMAGE" \
  "${RUNNER_CMD[@]}" \
    --mode=PREPARE \
    --prepareLive=1 \
    "${MANIFEST_ARGS[@]}" \
    --approvalFile=/approval/OWNER_APPROVAL.txt \
    --approvalSha256="$OWNER_APPROVAL_SHA256" \
    --prepareCacheOut=/out/prepare-cache \
    --outDir=/out \
  || die "PREPARE failed"

PREPARE_CACHE_SIDECAR="$CACHE_DIR/PREPARE_CACHE.sha256.txt"
test -s "$CACHE_DIR/PREPARE_CACHE.json" || die "PREPARE wrote no cache"
test -s "$PREPARE_CACHE_SIDECAR" || die "PREPARE wrote no cache sidecar"

# The sidecar's TEXT is the CONTENT sha of PREPARE_CACHE.json, which is the value the
# runner binds on EXECUTE. It is never the sha256 of the sidecar file itself.
PREPARE_CACHE_CONTENT_SHA256="$(tr -d ' \t\r\n' < "$PREPARE_CACHE_SIDECAR")"
[[ "$PREPARE_CACHE_CONTENT_SHA256" =~ ^[0-9a-f]{64}$ ]] \
  || die "PREPARE cache sidecar does not contain a bare sha256"
if [[ "$PREPARE_CACHE_CONTENT_SHA256" == "$(sha_file "$PREPARE_CACHE_SIDECAR")" ]]; then
  die "the sidecar text equals the sidecar file sha; that is the self-accepting binding"
fi
if [[ "$PREPARE_CACHE_CONTENT_SHA256" == "$(sha_file "$CACHE_DIR/PREPARE_CACHE.json")" ]]; then
  die "the sidecar text must be the canonical cache CONTENT sha, not the byte sha of PREPARE_CACHE.json"
fi
log "PREPARE_CACHE_CONTENT_SHA256=$PREPARE_CACHE_CONTENT_SHA256"

# ---------- 5 deploy the candidate containers from their swap specs ----------
PHASE="DEPLOY_CANDIDATES"
log "=== 5 deploy candidate APP + v6 worker + dashboard worker ==="

# The two read-model workers are created but deliberately NOT started: they must stay
# down through the whole mutation window and only drain the requeued jobs afterwards.
swap_role() {
  local spec_env="$1" candidate_image="$2" env_file="$3" rollback_name="$4" start="$5"
  local name restart_name restart_max restart user workdir entrypoint cmd
  name="$(spec_get "$spec_env" NAME)"
  restart_name="$(spec_get "$spec_env" RESTART_POLICY)"
  restart_max="$(spec_get "$spec_env" RESTART_MAX_RETRY)"
  user="$(spec_get "$spec_env" USER)"
  workdir="$(spec_get "$spec_env" WORKING_DIR)"
  entrypoint="$(spec_get "$spec_env" ENTRYPOINT)"
  cmd="$(spec_get "$spec_env" CMD)"

  local -a entrypoint_tokens cmd_tokens
  read -r -a entrypoint_tokens <<< "$entrypoint"
  read -r -a cmd_tokens <<< "$cmd"
  test "${#entrypoint_tokens[@]}" -eq 1 \
    || die "$name swap spec declares a multi-token entrypoint the wrapper cannot reproduce"
  test "${#cmd_tokens[@]}" -ge 1 || die "$name swap spec declares an empty cmd"

  restart="$restart_name"
  if [[ "$restart_name" == "on-failure" && "$restart_max" != "0" ]]; then
    restart="on-failure:${restart_max}"
  fi

  docker stop "$name" || die "cannot stop $name"
  docker rename "$name" "$rollback_name" || die "cannot rename $name to $rollback_name"

  docker create \
    --name "$name" \
    --network "$(spec_get "$spec_env" NETWORK_MODE)" \
    --restart "$restart" \
    --user "$user" \
    --workdir "$workdir" \
    --env-file "$env_file" \
    --entrypoint "${entrypoint_tokens[0]}" \
    "$candidate_image" \
    "${cmd_tokens[@]}" \
    || die "docker create failed for candidate $name"

  if [[ "$start" == "start" ]]; then
    docker start "$name" || die "docker start failed for candidate $name"
    sleep 15
    test "$(docker inspect -f '{{.State.Status}}' "$name")" = "running" \
      || die "candidate $name is not running"
  else
    test "$(docker inspect -f '{{.State.Status}}' "$name")" = "created" \
      || die "candidate $name should be created and held down"
  fi
  test "$(docker inspect -f '{{.Image}}' "$name")" = "$candidate_image" \
    || die "candidate $name image mismatch"
  log "CANDIDATE_DEPLOYED name=$name image=$candidate_image start=$start"
}

swap_role "$APP_SPEC_ENV" "$CANDIDATE_APP_IMAGE" "$APP_ENV_FILE" "$APP_ROLLBACK_NAME" start
APP_SWAPPED=1
swap_role "$V6_SPEC_ENV" "$CANDIDATE_V6_WORKER_IMAGE" "$V6_ENV_FILE" "$V6_ROLLBACK_NAME" hold
V6_SWAPPED=1
swap_role "$DASHBOARD_SPEC_ENV" "$CANDIDATE_DASHBOARD_WORKER_IMAGE" "$DASHBOARD_ENV_FILE" \
  "$DASHBOARD_ROLLBACK_NAME" hold
DASHBOARD_SWAPPED=1

# ---------- 6 candidate APP canary ----------
PHASE="CANDIDATE_CANARY"
log "=== 6 candidate APP canary ==="
sleep 10
test "$(docker inspect -f '{{.State.Status}}' "$APP_CONTAINER")" = "running" || die "canary status"
test "$(docker inspect -f '{{.State.OOMKilled}}' "$APP_CONTAINER")" = "false" || die "canary OOM"
test "$(docker inspect -f '{{.Image}}' "$APP_CONTAINER")" = "$CANDIDATE_APP_IMAGE" \
  || die "canary APP image mismatch"

# ---------- 7 quiesce ----------
PHASE="QUIESCE"
log "=== 7 quiesce APP + the four financial workers ==="
docker stop "$APP_CONTAINER" || die "cannot stop $APP_CONTAINER"
docker stop "$PROFIT_CONTAINER" || die "cannot stop $PROFIT_CONTAINER"
for container in "${QUIESCE_CONTAINERS[@]}"; do
  status="$(docker inspect -f '{{.State.Status}}' "$container")"
  case "$status" in
    exited|created) log "QUIESCED container=$container status=$status" ;;
    *) die "failed to quiesce $container (status=$status)" ;;
  esac
done
# The stock worker stays up, so its formula restriction is re-proven at mutation time.
require_container_env "$STOCK_CONTAINER" DASHBOARD_SNAPSHOT_FORMULA_VERSIONS \
  "STOCK_PLANNING_SNAPSHOT_V3"
test "$(docker inspect -f '{{.State.Status}}' "$STOCK_CONTAINER")" = "running" \
  || die "the stock worker must stay running"

# ---------- 8 EXECUTE_FROM_CACHE: pre-mutation gate, then the mutation ----------
# The all-target pre-mutation gate is not a separate host step: it runs inside this
# EXECUTE invocation, before the first write, and refuses with WRITES_PERFORMED=0.
# That marker is the only thing that lets a failure here be treated as "nothing was
# written"; without it the run is assumed to have mutated and needs a resume.
PHASE="EXECUTE_PRE_MUTATION_GATE"
log "=== 8 EXECUTE_FROM_CACHE (pre-mutation gate + mutation, zero Ozon network) ==="

rm -f "$OUT_DIR/EXECUTE_CHECKPOINT.json" "$OUT_DIR/EXECUTE_FROM_CACHE_RESULT.json"

execute_failed_before_mutation() {
  if [[ -e "$OUT_DIR/EXECUTE_CHECKPOINT.json" ]]; then return 1; fi
  if [[ -e "$OUT_DIR/EXECUTE_FROM_CACHE_RESULT.json" ]]; then return 1; fi
  if [[ ! -s "$EXECUTE_LOG" ]]; then return 1; fi
  grep -qE \
    'WRITES_PERFORMED=0|FULL_REPAIR_PRE_MUTATION_GATE=FAILED|ADAPTER_READINESS_GATE=FAILED|OWNER_APPROVAL_BINDING_MISMATCH|OWNER_APPROVAL_SHA_MISMATCH|OWNER_APPROVAL_PARSE_FAILED|SOURCE_DRIFT=YES|MUTATION_TIME_REQUIRED_APP_IMAGE|prepareCacheContentSha256 mismatch|ManifestSha256 file mismatch' \
    "$EXECUTE_LOG"
}

MUTATION_WINDOW_ENTERED=1
set +e
docker run --rm \
  --name "avorofin-repair-execute-${STAMP}" \
  --network host \
  --env-file "$APP_ENV_FILE" \
  -e EXECUTE_FROM_CACHE_OZON_NETWORK_CALL_COUNT_MAX=0 \
  "${MANIFEST_MOUNTS[@]}" \
  -v "$OWNER_APPROVAL_FILE:/approval/OWNER_APPROVAL.txt:ro" \
  -v "$CACHE_DIR:/cache:ro" \
  -v "$OUT_DIR:/out" \
  "${RUNNER_ENTRY[@]}" \
  "$REPAIR_RUNNER_IMAGE" \
  "${RUNNER_CMD[@]}" \
    --mode=EXECUTE_FROM_CACHE \
    --operationId="$OPERATION_ID" \
    --approvalFile=/approval/OWNER_APPROVAL.txt \
    --approvalSha256="$OWNER_APPROVAL_SHA256" \
    --approvalBindingSha256="$OWNER_APPROVAL_SHA256" \
    --executeMarker="$EXECUTE_MARKER" \
    "${MANIFEST_ARGS[@]}" \
    --sourceBackfillManifestSha256="$SOURCE_BACKFILL_MANIFEST_SHA256" \
    --statusOnlyManifestSha256="$STATUS_ONLY_MANIFEST_SHA256" \
    --snapshotTargetManifestSha256="$SNAPSHOT_TARGET_MANIFEST_SHA256" \
    --v2TargetManifestSha256="$V2_TARGET_MANIFEST_SHA256" \
    --expectedPreDeployAppImageSha256="$PRE_DEPLOY_APP_IMAGE" \
    --expectedCandidateAppImageSha256="$CANDIDATE_APP_IMAGE" \
    --expectedRepairRunnerImageSha256="$REPAIR_RUNNER_IMAGE" \
    --mutationTimeAppImageSha256="$CANDIDATE_APP_IMAGE" \
    --sourceBackfillTargetCount="$SOURCE_BACKFILL_TARGET_COUNT" \
    --statusStandaloneTargetCount="$STATUS_STANDALONE_REPAIR_COUNT" \
    --snapshotPostBatchDeleteCount="$SNAPSHOT_POST_BATCH_DELETE_COUNT" \
    --snapshotPostBatchRequeueCount="$SNAPSHOT_POST_BATCH_REQUEUE_COUNT" \
    --v2NumericMutationTargetCount="$V2_NUMERIC_MUTATION_TARGET_COUNT" \
    --prepareCacheManifestSha256="$PREPARE_CACHE_CONTENT_SHA256" \
    --prepareCache=/cache/PREPARE_CACHE.json \
    --prepareCacheManifest=/cache/PREPARE_CACHE.sha256.txt \
    --outDir=/out 2>&1 | tee "$EXECUTE_LOG"
EXECUTE_STATUS="${PIPESTATUS[0]}"
set -e

if [[ "$EXECUTE_STATUS" -ne 0 ]]; then
  if execute_failed_before_mutation; then
    MUTATION_PROVEN_ZERO_WRITES=1
    log "EXECUTE refused before the first write: WRITES_PERFORMED=0"
  fi
  die "EXECUTE_FROM_CACHE failed (status=$EXECUTE_STATUS)"
fi

PHASE="POST_MUTATION"
test -s "$OUT_DIR/EXECUTE_FROM_CACHE_RESULT.json" || die "EXECUTE wrote no result"
OPERATION_STARTED_AT="$(python3 -c '
import json, sys
with open(sys.argv[1], encoding="utf-8") as handle:
    print(json.load(handle).get("operationStartedAt", ""))
' "$OUT_DIR/EXECUTE_FROM_CACHE_RESULT.json")"
[[ -n "$OPERATION_STARTED_AT" ]] || die "EXECUTE result carries no operationStartedAt"
log "OPERATION_STARTED_AT=$OPERATION_STARTED_AT"

# ---------- 9 VERIFY_MUTATION_POSTCONDITIONS ----------
PHASE="VERIFY_MUTATION_POSTCONDITIONS"
log "=== 9 VERIFY_MUTATION_POSTCONDITIONS ==="
docker run --rm \
  --name "avorofin-repair-verify-stage1-${STAMP}" \
  --network host \
  --env-file "$APP_ENV_FILE" \
  "${MANIFEST_MOUNTS[@]}" \
  -v "$CACHE_DIR:/cache:ro" \
  -v "$OUT_DIR:/out" \
  "${RUNNER_ENTRY[@]}" \
  "$REPAIR_RUNNER_IMAGE" \
  "${RUNNER_CMD[@]}" \
    --mode=VERIFY_MUTATION_POSTCONDITIONS \
    "${MANIFEST_ARGS[@]}" \
    --prepareCache=/cache/PREPARE_CACHE.json \
    --operationStartedAt="$OPERATION_STARTED_AT" \
    --outDir=/out \
  || die "VERIFY_MUTATION_POSTCONDITIONS failed"

# ---------- 10 start the candidate read-model workers and prove the drain ----------
PHASE="WORKER_DRAIN"
log "=== 10 start candidate v6 + dashboard workers and poll exact SUCCESS counts ==="
docker start "$V6_CONTAINER" || die "cannot start candidate $V6_CONTAINER"
docker start "$DASHBOARD_CONTAINER" || die "cannot start candidate $DASHBOARD_CONTAINER"
sleep 10
for container in "$V6_CONTAINER" "$DASHBOARD_CONTAINER"; do
  test "$(docker inspect -f '{{.State.Status}}' "$container")" = "running" \
    || die "candidate $container did not stay running"
done

docker run --rm \
  --name "avorofin-repair-drain-${STAMP}" \
  --network host \
  --env-file "$APP_ENV_FILE" \
  -v "$OUT_DIR:/out" \
  "${RUNNER_ENTRY[@]}" \
  "$REPAIR_RUNNER_IMAGE" \
  "${DRAIN_CMD[@]}" \
    --operationStartedAt="$OPERATION_STARTED_AT" \
    --v6ExpectedSuccess="$V6_JOB_SUCCESS_EXPECTED_COUNT" \
    --snapshotExpectedSuccess="$SNAPSHOT_JOB_SUCCESS_EXPECTED_COUNT" \
    --timeoutSeconds="${WORKER_DRAIN_TIMEOUT_SECONDS:-1800}" \
    --pollSeconds=10 \
    --outDir=/out \
  || die "worker drain did not reach exactly $V6_JOB_SUCCESS_EXPECTED_COUNT v6 and $SNAPSHOT_JOB_SUCCESS_EXPECTED_COUNT snapshot SUCCESS jobs"

# ---------- 11 restore the remaining prior-running containers ----------
PHASE="RESTORE"
log "=== 11 restore APP + profit read-model worker ==="
docker start "$APP_CONTAINER" || die "cannot restart $APP_CONTAINER"
docker start "$PROFIT_CONTAINER" || die "cannot restart $PROFIT_CONTAINER"
sleep 15
for container in "${QUIESCE_CONTAINERS[@]}"; do
  test "$(docker inspect -f '{{.State.Status}}' "$container")" = "running" \
    || die "$container did not come back up"
  count="$(docker ps -q -f "name=^/${container}\$" | wc -l | tr -d ' ')"
  test "$count" = "1" || die "expected exactly one running $container, got $count"
done

# ---------- 12 VERIFY_FINAL_FINANCIAL_OUTPUT ----------
PHASE="VERIFY_FINAL_FINANCIAL_OUTPUT"
log "=== 12 VERIFY_FINAL_FINANCIAL_OUTPUT (July/August owner oracles) ==="
docker run --rm \
  --name "avorofin-repair-verify-stage2-${STAMP}" \
  --network host \
  --env-file "$APP_ENV_FILE" \
  "${MANIFEST_MOUNTS[@]}" \
  -v "$OUT_DIR:/out" \
  "${RUNNER_ENTRY[@]}" \
  "$REPAIR_RUNNER_IMAGE" \
  "${RUNNER_CMD[@]}" \
    --mode=VERIFY_FINAL_FINANCIAL_OUTPUT \
    "${MANIFEST_ARGS[@]}" \
    --operationStartedAt="$OPERATION_STARTED_AT" \
    --outDir=/out \
  || die "VERIFY_FINAL_FINANCIAL_OUTPUT failed"

FINAL_VERIFY_RESULT="$OUT_DIR/VERIFY_FINAL_FINANCIAL_OUTPUT_RESULT.json"
test -s "$FINAL_VERIFY_RESULT" || die "VERIFY_FINAL_FINANCIAL_OUTPUT wrote no result"

# ---------- 13 authenticated July/August canary plan ----------
# The oracle values in the plan come out of the VERIFY result that just passed, so the
# artifact carries real numbers rather than a template. The requests are described,
# not issued: the canary belongs to the second host orchestration.
PHASE="CANARY_PLAN"
log "=== 13 authenticated July/August canary plan artifact ==="
python3 - "$FINAL_VERIFY_RESULT" "$OUT_DIR/JULY_AUGUST_AUTHENTICATED_CANARY_PLAN.json" \
  "$OPERATION_ID" "$OWNER_APPROVAL_SHA256" "$CANDIDATE_APP_IMAGE" <<'PY'
import hashlib, json, sys

verify_path, out_path, operation_id, approval_sha, app_image = sys.argv[1:6]
with open(verify_path, encoding="utf-8") as handle:
    verify = json.load(handle)
if verify.get("ok") is not True:
    raise SystemExit("refusing to plan a canary from a VERIFY result that did not pass")

oracles = [
    {"name": check["name"], "expected": check.get("expected"), "observed": check.get("actual")}
    for check in verify.get("checks", [])
    if str(check.get("name", "")).startswith("owner_oracle")
]
if not oracles:
    raise SystemExit("VERIFY_FINAL_FINANCIAL_OUTPUT carries no owner oracle checks")

periods = [
    {"period": "2026-07", "dateFrom": "2026-07-01", "dateTo": "2026-07-31"},
    {"period": "2026-08", "dateFrom": "2026-08-01", "dateTo": "2026-08-31"},
]
requests = [
    {
        "step": 1,
        "method": "POST",
        "url": "http://127.0.0.1:3000/api/local-auth/login",
        "bodySchema": {"email": "string", "password": "string"},
        "bodyValueSource": (
            "LOCAL_AUTH_EMAIL and LOCAL_AUTH_PASSWORD read from the running "
            "avorofin-app Config.Env at canary time; deliberately absent here"
        ),
        "secretsInThisArtifact": False,
        "expect": {"httpStatus": 200, "json": {"ok": True}},
        "captures": "Set-Cookie avorofin_local_auth (httpOnly session token)",
    }
]
for index, period in enumerate(periods, start=2):
    for marketplace in ("OZON", "ALL"):
        requests.append(
            {
                "step": index,
                "method": "GET",
                "url": (
                    "http://127.0.0.1:3000/api/analytics/profit"
                    f"?dateFrom={period['dateFrom']}&dateTo={period['dateTo']}"
                    f"&companyName=ALL&marketplace={marketplace}"
                ),
                "headers": {"Cookie": "avorofin_local_auth=<captured in step 1>"},
                "expect": {"httpStatus": 200, "authenticated": True},
                "period": period["period"],
            }
        )

plan = {
    "JULY_AUGUST_AUTHENTICATED_CANARY": "PLANNED",
    "EXECUTED": "NO",
    "REASON": "DEFERRED_SECOND_HOST_ORCHESTRATION",
    "ANONYMOUS_PROBE_ACCEPTED": "NO",
    "authentication": {
        "mechanism": "LOCAL_AUTH_SESSION_COOKIE",
        "cookieName": "avorofin_local_auth",
        "loginRoute": "app/api/local-auth/login/route.ts",
        "credentialSource": "avorofin-app Config.Env LOCAL_AUTH_EMAIL / LOCAL_AUTH_PASSWORD",
        "secretsInThisArtifact": False,
    },
    "operationId": operation_id,
    "ownerApprovalSha256": approval_sha,
    "candidateAppImageSha256": app_image,
    "periods": periods,
    "requests": requests,
    "oraclesFromVerifiedPostState": oracles,
    "passCriteria": [
        "step 1 returns 200 and sets avorofin_local_auth",
        "every authenticated GET returns 200 (a 401/302 to /login is a FAIL, not a skip)",
        "each period total equals the owner oracle observed above, to the kopeck",
    ],
}
body = json.dumps(plan, ensure_ascii=False, indent=2) + "\n"
with open(out_path, "w", encoding="utf-8") as handle:
    handle.write(body)
with open(out_path + ".sha256.txt", "w", encoding="utf-8") as handle:
    handle.write(hashlib.sha256(body.encode("utf-8")).hexdigest() + "\n")
print(f"JULY_AUGUST_AUTHENTICATED_CANARY_PLAN=WRITTEN oracles={len(oracles)}")
PY
test -s "$OUT_DIR/JULY_AUGUST_AUTHENTICATED_CANARY_PLAN.json" || die "canary plan artifact missing"

# ---------- 14 Telegram: deferred, never claimed ----------
# A "send=false" marker is not evidence that the Telegram report is correct. The report
# runs on the second (Telegram) host, so this step records a deferral and a plan, and
# claims nothing about the outcome.
PHASE="TELEGRAM_DEFERRAL"
log "=== 14 Telegram deferral plan ==="
python3 - "$OUT_DIR/TELEGRAM_DEFERRED_SECOND_HOST_PLAN.json" "$OPERATION_ID" \
  "$OWNER_APPROVAL_SHA256" "$OPERATION_STARTED_AT" <<'PY'
import hashlib, json, sys

out_path, operation_id, approval_sha, operation_started_at = sys.argv[1:5]
plan = {
    "TELEGRAM_NOSEND_STEP": "DEFERRED_SECOND_HOST_ORCHESTRATION",
    "TELEGRAM_REPORT_PASS_CLAIMED": "NO",
    "TELEGRAM_SEND_MARKER_TREATED_AS_EVIDENCE": "NO",
    "reason": (
        "the daily report is rendered and sent by the separate Telegram production host; "
        "this wrapper cannot observe that render, so it refuses to claim PASS for it"
    ),
    "operationId": operation_id,
    "ownerApprovalSha256": approval_sha,
    "operationStartedAt": operation_started_at,
    "plan": [
        {
            "step": 1,
            "host": "TELEGRAM_PRODUCTION_HOST",
            "action": "pull the same candidate APP image sha and redeploy the report sender",
            "requiresOwnerApproval": True,
        },
        {
            "step": 2,
            "host": "TELEGRAM_PRODUCTION_HOST",
            "action": "render the July and August daily reports with send=false and diff against the owner oracles",
            "evidence": "TELEGRAM_RENDER_DIFF.json",
        },
        {
            "step": 3,
            "host": "TELEGRAM_PRODUCTION_HOST",
            "action": "only after a clean diff, enable send and record the delivered message ids",
            "requiresOwnerApproval": True,
        },
    ],
    "blockedUntil": "a separate owner approval for the Telegram host is issued",
}
body = json.dumps(plan, ensure_ascii=False, indent=2) + "\n"
with open(out_path, "w", encoding="utf-8") as handle:
    handle.write(body)
with open(out_path + ".sha256.txt", "w", encoding="utf-8") as handle:
    handle.write(hashlib.sha256(body.encode("utf-8")).hexdigest() + "\n")
print("TELEGRAM_NOSEND_STEP=DEFERRED_SECOND_HOST_ORCHESTRATION")
PY
test -s "$OUT_DIR/TELEGRAM_DEFERRED_SECOND_HOST_PLAN.json" || die "telegram deferral artifact missing"

# ---------- 15 stability window + final markers ----------
PHASE="STABILITY"
log "=== 15 stability window ==="
sleep "${STABILITY_WINDOW_SECONDS:-300}"
for container in "${QUIESCE_CONTAINERS[@]}" "$STOCK_CONTAINER"; do
  test "$(docker inspect -f '{{.State.Status}}' "$container")" = "running" \
    || die "stability: $container is not running"
  test "$(docker inspect -f '{{.State.OOMKilled}}' "$container")" = "false" \
    || die "stability: $container was OOM killed"
done

cat > "$OUT_DIR/PRODUCTION_RUN_FINAL_MARKERS.json" <<EOF
{
  "PRODUCTION_MUTATION_COMPLETED_UNDER_OWNER_APPROVAL": "YES",
  "STAGE1B": "NO",
  "OPERATION_ID": "$OPERATION_ID",
  "OWNER_APPROVAL_SHA256": "$OWNER_APPROVAL_SHA256",
  "OPERATION_STARTED_AT": "$OPERATION_STARTED_AT",
  "PREPARE_CACHE_CONTENT_SHA256": "$PREPARE_CACHE_CONTENT_SHA256",
  "CANDIDATE_APP_IMAGE_SHA256": "$CANDIDATE_APP_IMAGE",
  "CANDIDATE_REPAIR_RUNNER_IMAGE_SHA256": "$REPAIR_RUNNER_IMAGE",
  "CANDIDATE_V6_WORKER_IMAGE_SHA256": "$CANDIDATE_V6_WORKER_IMAGE",
  "CANDIDATE_DASHBOARD_WORKER_IMAGE_SHA256": "$CANDIDATE_DASHBOARD_WORKER_IMAGE",
  "VERIFY_MUTATION_POSTCONDITIONS": "PASS",
  "WORKER_DRAIN": "PASS",
  "VERIFY_FINAL_FINANCIAL_OUTPUT": "PASS",
  "TELEGRAM_NOSEND_STEP": "DEFERRED_SECOND_HOST_ORCHESTRATION",
  "TELEGRAM_REPORT_PASS_CLAIMED": "NO",
  "JULY_AUGUST_AUTHENTICATED_CANARY": "PLANNED_NOT_EXECUTED",
  "ROLLBACK_APP_CONTAINER_RETAINED": "$APP_ROLLBACK_NAME",
  "ROLLBACK_V6_WORKER_CONTAINER_RETAINED": "$V6_ROLLBACK_NAME",
  "ROLLBACK_DASHBOARD_WORKER_CONTAINER_RETAINED": "$DASHBOARD_ROLLBACK_NAME",
  "STAMP": "$STAMP"
}
EOF

log "FINAL_MARKERS"
log "PRODUCTION_MUTATION_COMPLETED_UNDER_OWNER_APPROVAL=YES"
log "STAGE1B=NO"
log "TELEGRAM_NOSEND_STEP=DEFERRED_SECOND_HOST_ORCHESTRATION"
log "STOP"
PHASE="DONE"
exit 0
