#!/usr/bin/env bash
# DEPLOY_ENTRYPOINT_R15 — authoritative sequence. DO NOT run against MAIN without owner OK.
# Stages: preflight-artifacts | compare-env | stop-claims | switch | weekly | verify-week | rollback | data-rollback
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAMP="${STAMP:-20261028_R15}"
FA_STATE="${FA_STATE:-/var/lib/avorofin/fa_images_${STAMP}}"
TAR_DIR="${TAR_DIR:-$FA_STATE/tars}"
META_DIR="${META_DIR:-$FA_STATE/meta}"
MANIFEST="${MANIFEST:-$META_DIR/ARTIFACTS_MANIFEST.json}"
JOURNAL_DIR="${CUTOVER_JOURNAL_DIR:-/var/lib/avorofin/cutover_journal_${STAMP}}"
RUN_ID="${GHA_RUN_ID:-}"
REPO="${REPO:-Artiomka77/marketplace-business-os}"
BUILD_COMMIT="${BUILD_SOURCE_COMMIT:-}"

die() { echo "FATAL: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "missing $1"; }

extract_expect_ids() {
  [[ -f "$MANIFEST" ]] || die "missing MANIFEST $MANIFEST — download meta artifact first"
  python3 - <<'PY' "$MANIFEST"
import json,sys,re
m=json.load(open(sys.argv[1],encoding="utf-8"))
roles={}
# Prefer explicit roles map
cand=m.get("roles") or m.get("images") or m.get("artifacts") or m
if isinstance(cand, dict):
  for k,v in cand.items():
    if isinstance(v, dict):
      roles[k]=v.get("ImageId") or v.get("imageId") or v.get("id")
    elif isinstance(v, str) and v.startswith("sha256:"):
      roles[k]=v
elif isinstance(cand, list):
  for v in cand:
    if isinstance(v, dict) and "role" in v:
      roles[v["role"]]=v.get("ImageId") or v.get("imageId")
# Also scan flat keys like app.ImageId
for k,v in m.items() if isinstance(m, dict) else []:
  if isinstance(v, str) and v.startswith("sha256:") and re.match(r'^(app|profit|v6|dashboard|stock)$', k):
    roles[k]=v
need=["app","profit","v6","dashboard","stock"]
missing=[r for r in need if not roles.get(r)]
if missing:
  print("MISSING_ROLES", ",".join(missing), file=sys.stderr)
  # try image-meta sibling files pattern handled by caller
  sys.exit(2)
for r in need:
  val=roles[r]
  if not isinstance(val,str) or not val.startswith("sha256:") or len(val)<20:
    print(f"BAD_ID {r}", file=sys.stderr); sys.exit(3)
  # safe shell assignment — only sha256 hex
  if not re.fullmatch(r"sha256:[0-9a-f]{64}", val):
    print(f"UNSAFE_ID {r}", file=sys.stderr); sys.exit(4)
  print(f"{r}={val}")
PY
}

stage_preflight_artifacts() {
  need gh; need docker; need sha256sum; need python3
  mkdir -p "$FA_STATE" "$TAR_DIR" "$META_DIR"
  chmod 700 "$FA_STATE"
  [[ -n "$RUN_ID" ]] || die "set GHA_RUN_ID to the green images-build-only run"
  # BOTH artifacts required BEFORE any stop
  gh run download "$RUN_ID" --repo "$REPO" \
    -n "fin-accept-image-tarballs-${STAMP}" -D "$TAR_DIR"
  gh run download "$RUN_ID" --repo "$REPO" \
    -n "fin-accept-image-meta-${STAMP}" -D "$META_DIR"
  # Flatten nested image-meta if present
  if [[ -d "$META_DIR/image-meta" ]]; then
    cp -a "$META_DIR/image-meta/." "$META_DIR/" || true
  fi
  if [[ ! -f "$MANIFEST" ]]; then
    # Construct manifest from ImageId.txt files when workflow layout nests them
    python3 - <<'PY' "$META_DIR" "$MANIFEST"
import json,sys,pathlib
meta=pathlib.Path(sys.argv[1]); out=pathlib.Path(sys.argv[2])
roles={}
for role in ["app","profit","v6","dashboard","stock"]:
  p=meta/f"{role}.ImageId.txt"
  if not p.exists():
    # nested
    p=meta/"image-meta"/f"{role}.ImageId.txt"
  if not p.exists():
    raise SystemExit(f"missing {role}.ImageId.txt")
  roles[role]={"ImageId": p.read_text(encoding="utf-8").strip()}
out.write_text(json.dumps({"roles":roles},indent=2)+"\n",encoding="utf-8")
print("MANIFEST_BUILT_FROM_IMAGEID_TXT")
PY
  fi
  (
    cd "$TAR_DIR"
    # tarballs may be nested under image-tarballs/
    if [[ -d image-tarballs ]]; then
      cd image-tarballs
    fi
    [[ -f SHA256SUMS.txt ]] || die "SHA256SUMS.txt missing under $TAR_DIR"
    sha256sum -c SHA256SUMS.txt
    for r in app profit v6 dashboard stock; do
      [[ -f "${r}.tar.gz" ]] || die "missing ${r}.tar.gz"
      docker load -i "${r}.tar.gz"
    done
  )
  # Prove build commit if provided
  if [[ -n "$BUILD_COMMIT" && -f "$META_DIR/BUILD_IDENTITY.txt" ]]; then
    grep -q "$BUILD_COMMIT" "$META_DIR/BUILD_IDENTITY.txt" \
      || die "BUILD_IDENTITY does not contain BUILD_SOURCE_COMMIT=$BUILD_COMMIT"
  fi
  extract_expect_ids >/dev/null
  echo "PREFLIGHT_ARTIFACTS_OK tar=$TAR_DIR meta=$META_DIR"
}

stage_compare_env() {
  # Required before mutations. CAPTURED_ENV / EXPECTED_ENV are non-secret dumps.
  local role="${1:?role}"
  local cap="${2:?captured.env}"
  local exp="${3:?expected.env}"
  bash "$ROOT/scripts/fin_accept/compare_main_env_keys_R12.sh" "$cap" "$exp" | tee /tmp/env_compare_${role}.txt
  if grep -E 'MISMATCH|MISSING_IN_CAPTURED|MISMATCH_PRESENCE' /tmp/env_compare_${role}.txt >/dev/null; then
    die "env compare failed for $role — see /tmp/env_compare_${role}.txt"
  fi
  echo "COMPARE_ENV_OK role=$role"
}

wait_running_zero() {
  local label="$1" sql="$2" url="${3:-$DATABASE_URL}"
  [[ -n "${url:-}" ]] || die "DATABASE_URL required for wait ($label)"
  local i=0
  while (( i < 120 )); do
    local n
    n="$(psql "$url" -Atc "$sql" | head -n1 | tr -d '[:space:]')"
    n="${n:-0}"
    echo "WAIT_$label RUNNING_COUNT=$n"
    [[ "$n" == "0" ]] && return 0
    sleep 5
    i=$((i+1))
  done
  die "timeout waiting RUNNING=0 for $label"
}

stage_stop_claims() {
  need docker; need psql
  # Do NOT start stop until artifacts+env preflight done (caller order).
  docker stop avorofin-profit-readmodel-worker || true
  wait_running_zero profit \
    "SELECT count(*) FROM \"DashboardPeriodSnapshotJob\" WHERE status='RUNNING' AND \"formulaVersion\" IN ('FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1','FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1');"

  docker stop avorofin-v6-period-readmodel-worker || true
  wait_running_zero v6 \
    "SELECT count(*) FROM \"DashboardPeriodSnapshotJob\" WHERE status='RUNNING' AND \"formulaVersion\"='FINANCIAL_CORE_V6_PERIOD_READMODEL_V2';" \
    "${V6_READMODEL_TARGET_DATABASE_URL:-$DATABASE_URL}"

  docker stop avorofin-dashboard-period-snapshot-worker || true
  wait_running_zero dashboard \
    "SELECT count(*) FROM \"DashboardPeriodSnapshotJob\" WHERE status='RUNNING' AND \"formulaVersion\"='FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1';"

  docker stop avorofin-stock-planning-snapshot-worker || true
  wait_running_zero stock \
    "SELECT count(*) FROM \"DashboardPeriodSnapshotJob\" WHERE status='RUNNING' AND \"formulaVersion\" LIKE 'STOCK_PLANNING%';"

  echo "STOP_CLAIMS_OK (APP still up until switch)"
}

stage_switch() {
  need docker
  mapfile -t lines < <(extract_expect_ids)
  for line in "${lines[@]}"; do
    role="${line%%=*}"
    id="${line#*=}"
    case "$role" in
      app) export EXPECT_APP="$id" ;;
      profit) export EXPECT_PROFIT="$id" ;;
      v6) export EXPECT_V6="$id" ;;
      dashboard) export EXPECT_DASHBOARD="$id" ;;
      stock) export EXPECT_STOCK="$id" ;;
    esac
  done
  export CUTOVER_JOURNAL_DIR="$JOURNAL_DIR"
  export IMAGE_APP="${IMAGE_APP:-avorofin-p0-cogs-app:fin_accept_${STAMP}}"
  export IMAGE_PROFIT="${IMAGE_PROFIT:-avorofin-p0-cogs-profit:fin_accept_${STAMP}}"
  export IMAGE_V6="${IMAGE_V6:-avorofin-p0-cogs-v6:fin_accept_${STAMP}}"
  export IMAGE_DASHBOARD="${IMAGE_DASHBOARD:-avorofin-p0-cogs-dashboard:fin_accept_${STAMP}}"
  export IMAGE_STOCK="${IMAGE_STOCK:-avorofin-p0-cogs-stock:fin_accept_${STAMP}}"
  bash "$ROOT/scripts/deploy/cutover_five_roles.sh" switch
  echo "SWITCH_OK"
}

stage_weekly() {
  need node
  export WEEKLY_JOB_IDS_FILE="${WEEKLY_JOB_IDS_FILE:-$FA_STATE/weekly_job_ids.txt}"
  # Stage profit first, wait, then dependent snapshots.
  WEEKLY_STAGE=profit node --import tsx "$ROOT/scripts/fin_accept/run_weekly_enqueue_R12.ts" "$FA_STATE/weekly_profit.json"
  bash "$ROOT/scripts/fin_accept/wait_weekly_R12.sh"
  WEEKLY_STAGE=v6 node --import tsx "$ROOT/scripts/fin_accept/run_weekly_enqueue_R12.ts" "$FA_STATE/weekly_v6.json"
  bash "$ROOT/scripts/fin_accept/wait_weekly_R12.sh"
  WEEKLY_STAGE=dashboard node --import tsx "$ROOT/scripts/fin_accept/run_weekly_enqueue_R12.ts" "$FA_STATE/weekly_dash.json"
  bash "$ROOT/scripts/fin_accept/wait_weekly_R12.sh"
  echo "WEEKLY_ENQUEUE_AND_WAIT_OK"
}

stage_verify_week() {
  need node
  node --import tsx "$ROOT/scripts/fin_accept/verify_week_consumer_R12.ts" "$FA_STATE/verify_week.json"
}

stage_rollback() {
  export CUTOVER_JOURNAL_DIR="$JOURNAL_DIR"
  bash "$ROOT/scripts/deploy/cutover_five_roles.sh" rollback
}

stage_data_rollback() {
  [[ -n "${OZON_PERIOD_SNAPSHOT_JSON:-}" ]] || die "set OZON_PERIOD_SNAPSHOT_JSON to full-contract snapshot"
  node --import tsx "$ROOT/scripts/fin_accept/run_data_rollback_ozon_R12.ts" \
    "$OZON_PERIOD_SNAPSHOT_JSON"
}

stage="${1:-}"
case "$stage" in
  preflight-artifacts) stage_preflight_artifacts ;;
  compare-env) shift; stage_compare_env "$@" ;;
  stop-claims) stage_stop_claims ;;
  switch) stage_switch ;;
  weekly) stage_weekly ;;
  verify-week) stage_verify_week ;;
  rollback) stage_rollback ;;
  data-rollback) stage_data_rollback ;;
  *)
    cat <<EOF
DEPLOY_ENTRYPOINT_R15 stages (order):
  preflight-artifacts   # BOTH tar+meta artifacts; sha256; load; NO stop yet
  compare-env <role> <captured.env> <expected.env>  # non-zero on MISMATCH
  stop-claims           # docker stop + RUNNING=0 (PENDING ignored)
  switch
  weekly                # profit → wait → v6 → wait → dashboard → wait
  verify-week           # WB+Ozon+Finance+business vs canon (fail on miss)
  rollback
  data-rollback         # full ProfitPeriodMetric contract restore
productionChanged must remain false until owner executes intentionally.
EOF
    exit 2
    ;;
esac
