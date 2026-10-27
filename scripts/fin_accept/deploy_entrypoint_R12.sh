#!/usr/bin/env bash
# DEPLOY_ENTRYPOINT_R12 — authoritative sequence. DO NOT run against MAIN without owner OK.
# Usage (on bastion/host with docker+gh+psql):
#   export FA_STATE=/var/lib/avorofin/fa_images_R12
#   export CUTOVER_JOURNAL_DIR=/var/lib/avorofin/cutover_journal_R12
#   export CUTOVER_ENV_DIR=/opt/avorofin
#   export CUTOVER_PRE_SUFFIX=pre-fa-cutover-r12
#   export DATABASE_URL=...   # profit/dashboard target (secret; not archived)
#   export V6_READMODEL_TARGET_DATABASE_URL=...  # if distinct
#   bash scripts/fin_accept/deploy_entrypoint_R12.sh <stage>
# Stages: verify-artifacts | stop-claims | switch | weekly | verify-week | rollback | data-rollback
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAMP="${STAMP:-20261027_R12}"
FA_STATE="${FA_STATE:-/var/lib/avorofin/fa_images_R12}"
TAR_DIR="${TAR_DIR:-$FA_STATE/tars}"
META="${META:-$FA_STATE/evidence/image-meta}"
MANIFEST="${MANIFEST:-$TAR_DIR/ARTIFACTS_MANIFEST.json}"
JOURNAL_DIR="${CUTOVER_JOURNAL_DIR:-/var/lib/avorofin/cutover_journal_R12}"
RUN_ID="${GHA_RUN_ID:-}"
REPO="${REPO:-Artiomka77/marketplace-business-os}"

die() { echo "FATAL: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "missing $1"; }

load_expect() {
  [[ -f "$MANIFEST" ]] || die "missing MANIFEST $MANIFEST"
  python3 - <<'PY' "$MANIFEST"
import json,sys
m=json.load(open(sys.argv[1],encoding="utf-8"))
roles=m.get("roles") or m.get("images") or m
# tolerate either {role:{imageId}} or list
out={}
if isinstance(roles, dict):
  for k,v in roles.items():
    if isinstance(v, dict):
      out[k]=v.get("ImageId") or v.get("imageId") or v.get("id")
    else:
      out[k]=v
elif isinstance(roles, list):
  for v in roles:
    out[v["role"]]=v.get("ImageId") or v.get("imageId")
for k,v in out.items():
  if v: print(f"{k}={v}")
PY
}

stage_verify_artifacts() {
  need gh; need docker; need sha256sum
  mkdir -p "$FA_STATE" "$TAR_DIR"
  chmod 700 "$FA_STATE"
  [[ -n "$RUN_ID" ]] || die "set GHA_RUN_ID to the green R12 images-build-only run"
  (
    cd "$FA_STATE"
    gh run download "$RUN_ID" --repo "$REPO" \
      -n "fin-accept-image-tarballs-${STAMP}" -D "$TAR_DIR"
  )
  (
    cd "$TAR_DIR"
    [[ -f SHA256SUMS.txt ]] || die "SHA256SUMS.txt missing in $TAR_DIR"
    sha256sum -c SHA256SUMS.txt
    for r in app profit v6 dashboard stock; do
      [[ -f "${r}.tar.gz" ]] || die "missing ${r}.tar.gz"
      docker load -i "${r}.tar.gz"
    done
  )
  echo "VERIFY_ARTIFACTS_OK dir=$TAR_DIR"
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
  # drain MODE is NOT a claim gate. Stop containers → SIGTERM → stopping=true.
  # Wait RUNNING=0 only (PENDING may remain from APP/cron; that is not active work).
  docker stop avorofin-profit-readmodel-worker
  wait_running_zero profit \
    "SELECT count(*) FROM \"DashboardPeriodSnapshotJob\" WHERE status='RUNNING' AND \"formulaVersion\" IN ('FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1','FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1');"

  docker stop avorofin-v6-period-readmodel-worker
  wait_running_zero v6 \
    "SELECT count(*) FROM \"DashboardPeriodSnapshotJob\" WHERE status='RUNNING' AND \"formulaVersion\"='FINANCIAL_CORE_V6_PERIOD_READMODEL_V2';" \
    "${V6_READMODEL_TARGET_DATABASE_URL:-$DATABASE_URL}"

  docker stop avorofin-dashboard-period-snapshot-worker
  wait_running_zero dashboard \
    "SELECT count(*) FROM \"DashboardPeriodSnapshotJob\" WHERE status='RUNNING' AND \"formulaVersion\"='FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1';"

  docker stop avorofin-stock-planning-snapshot-worker
  wait_running_zero stock \
    "SELECT count(*) FROM \"DashboardPeriodSnapshotJob\" WHERE status='RUNNING' AND \"formulaVersion\" LIKE 'STOCK_PLANNING%';"

  echo "STOP_CLAIMS_OK (APP still up until switch)"
}

stage_switch() {
  need docker
  eval "$(load_expect | sed 's/^/EXPECT_/')"
  export CUTOVER_JOURNAL_DIR="$JOURNAL_DIR"
  export IMAGE_APP="${IMAGE_APP:-avorofin-p0-cogs-app:fin_accept_${STAMP}}"
  export IMAGE_PROFIT="${IMAGE_PROFIT:-avorofin-p0-cogs-profit:fin_accept_${STAMP}}"
  export IMAGE_V6="${IMAGE_V6:-avorofin-p0-cogs-v6:fin_accept_${STAMP}}"
  export IMAGE_DASHBOARD="${IMAGE_DASHBOARD:-avorofin-p0-cogs-dashboard:fin_accept_${STAMP}}"
  export IMAGE_STOCK="${IMAGE_STOCK:-avorofin-p0-cogs-stock:fin_accept_${STAMP}}"
  export EXPECT_APP="${EXPECT_app:-${EXPECT_APP:-}}"
  export EXPECT_PROFIT="${EXPECT_profit:-${EXPECT_PROFIT:-}}"
  export EXPECT_V6="${EXPECT_v6:-${EXPECT_V6:-}}"
  export EXPECT_DASHBOARD="${EXPECT_dashboard:-${EXPECT_DASHBOARD:-}}"
  export EXPECT_STOCK="${EXPECT_stock:-${EXPECT_STOCK:-}}"
  [[ -n "$EXPECT_APP" && -n "$EXPECT_PROFIT" && -n "$EXPECT_V6" && -n "$EXPECT_DASHBOARD" && -n "$EXPECT_STOCK" ]] \
    || die "EXPECT_* ImageIds missing — set from ARTIFACTS_MANIFEST.json"
  bash "$ROOT/scripts/deploy/cutover_five_roles.sh" switch
  echo "SWITCH_OK"
}

stage_weekly() {
  need node
  # Exact period 2026-10-19..2026-10-25; scopes ИП Петров / ИП Лебедева / ALL.
  # Uses real repository API via tsx runner (writes ONLY DashboardPeriodSnapshotJob rows).
  DATE_FROM=2026-10-19 DATE_TO=2026-10-25 \
    node --import tsx "$ROOT/scripts/fin_accept/run_weekly_enqueue_R12.ts"
  echo "WEEKLY_ENQUEUE_SUBMITTED — wait SUCCESS via wait_weekly_R12.sh"
  bash "$ROOT/scripts/fin_accept/wait_weekly_R12.sh"
}

stage_verify_week() {
  need node
  node --import tsx "$ROOT/scripts/fin_accept/verify_week_consumer_R12.ts"
}

stage_rollback() {
  export CUTOVER_JOURNAL_DIR="$JOURNAL_DIR"
  bash "$ROOT/scripts/deploy/cutover_five_roles.sh" rollback
}

stage_data_rollback() {
  # Exact restore of Ozon period rows for 2026-10-19..2026-10-25 only.
  # Requires SNAPSHOT_JSON from pre-cutover export (not whole DB / not COGS/Finance).
  [[ -n "${OZON_PERIOD_SNAPSHOT_JSON:-}" ]] || die "set OZON_PERIOD_SNAPSHOT_JSON"
  node --import tsx "$ROOT/scripts/fin_accept/run_data_rollback_ozon_R12.ts" \
    "$OZON_PERIOD_SNAPSHOT_JSON"
}

stage="${1:-}"
case "$stage" in
  verify-artifacts) stage_verify_artifacts ;;
  stop-claims) stage_stop_claims ;;
  switch) stage_switch ;;
  weekly) stage_weekly ;;
  verify-week) stage_verify_week ;;
  rollback) stage_rollback ;;
  data-rollback) stage_data_rollback ;;
  *)
    cat <<EOF
DEPLOY_ENTRYPOINT_R12 stages:
  verify-artifacts  # gh download + sha256sum -c + docker load (paths under \$FA_STATE/tars)
  stop-claims       # docker stop workers + wait RUNNING=0 (PENDING ignored)
  switch            # cutover_five_roles.sh switch with EXPECT_* from manifest
  weekly            # enqueue 19-25 matrix + wait SUCCESS
  verify-week       # consumer N/Business checks vs canon
  rollback          # cutover_five_roles.sh rollback (separate process OK)
  data-rollback     # restore exact Ozon period snapshot rows
productionChanged must remain false until owner executes intentionally.
EOF
    exit 2
    ;;
esac
