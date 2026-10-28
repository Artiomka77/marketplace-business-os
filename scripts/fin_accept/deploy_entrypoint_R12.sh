#!/usr/bin/env bash
# DEPLOY_ENTRYPOINT_R16 — authoritative sequence. DO NOT run against MAIN without owner OK.
# Stages:
#   preflight-artifacts | capture-env | compare-env | backup-week |
#   stop-claims | switch | weekly | verify-week | rollback | data-rollback | telegram-plan
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAMP="${STAMP:-20261028_R16}"
FA_STATE="${FA_STATE:-/var/lib/avorofin/fa_images_${STAMP}}"
TAR_DIR="${TAR_DIR:-$FA_STATE/tars}"
META_DIR="${META_DIR:-$FA_STATE/meta}"
MANIFEST="${MANIFEST:-$META_DIR/ARTIFACTS_MANIFEST.json}"
JOURNAL_DIR="${CUTOVER_JOURNAL_DIR:-/var/lib/avorofin/cutover_journal_${STAMP}}"
BACKUP_DIR="${WEEK_BACKUP_DIR:-$FA_STATE/backup_week}"
ENV_DIR="${ENV_CAPTURE_DIR:-$FA_STATE/env}"
RUN_ID="${GHA_RUN_ID:-}"
REPO="${REPO:-Artiomka77/marketplace-business-os}"
BUILD_COMMIT="${BUILD_SOURCE_COMMIT:-}"
# R15 image provenance retained when only scripts change:
IMAGE_STAMP="${IMAGE_STAMP:-20261028_R15}"
IMAGE_BUILD_COMMIT="${IMAGE_BUILD_COMMIT:-33d9461619f0ca0743ebb9477a15ba3698713146}"
IMAGE_GHA_RUN_ID="${IMAGE_GHA_RUN_ID:-40653680208}"
SCRIPTS_COMMIT="${SCRIPTS_COMMIT:-${BUILD_COMMIT:-}}"

die() { echo "FATAL: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "missing $1"; }

ROLES_CONTAINERS=(
  "app|avorofin-app"
  "profit|avorofin-profit-readmodel-worker"
  "v6|avorofin-v6-period-readmodel-worker"
  "dashboard|avorofin-dashboard-period-snapshot-worker"
  "stock|avorofin-stock-planning-snapshot-worker"
)

extract_expect_ids() {
  [[ -f "$MANIFEST" ]] || die "missing MANIFEST $MANIFEST — download meta artifact first"
  python3 - <<'PY' "$MANIFEST"
import json,sys,re
m=json.load(open(sys.argv[1],encoding="utf-8"))
roles={}
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
for k,v in m.items() if isinstance(m, dict) else []:
  if isinstance(v, str) and v.startswith("sha256:") and re.match(r'^(app|profit|v6|dashboard|stock)$', k):
    roles[k]=v
need=["app","profit","v6","dashboard","stock"]
missing=[r for r in need if not roles.get(r)]
if missing:
  print("MISSING_ROLES", ",".join(missing), file=sys.stderr)
  sys.exit(2)
for r in need:
  val=roles[r]
  if not isinstance(val,str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", val):
    print(f"BAD_ID {r}", file=sys.stderr); sys.exit(3)
  print(f"{r}={val}")
PY
}

stage_preflight_artifacts() {
  need gh; need docker; need sha256sum; need python3; need node; need psql
  mkdir -p "$FA_STATE" "$TAR_DIR" "$META_DIR" "$ENV_DIR" "$BACKUP_DIR"
  chmod 700 "$FA_STATE"
  [[ -n "$RUN_ID" ]] || RUN_ID="$IMAGE_GHA_RUN_ID"
  [[ -n "$RUN_ID" ]] || die "set GHA_RUN_ID (or IMAGE_GHA_RUN_ID) to green images run"
  # BOTH artifacts required BEFORE any stop
  local tar_name="fin-accept-image-tarballs-${IMAGE_STAMP}"
  local meta_name="fin-accept-image-meta-${IMAGE_STAMP}"
  gh run download "$RUN_ID" --repo "$REPO" -n "$tar_name" -D "$TAR_DIR"
  gh run download "$RUN_ID" --repo "$REPO" -n "$meta_name" -D "$META_DIR"
  if [[ -d "$META_DIR/image-meta" ]]; then
    cp -a "$META_DIR/image-meta/." "$META_DIR/" || true
  fi
  if [[ ! -f "$MANIFEST" ]]; then
    python3 - <<'PY' "$META_DIR" "$MANIFEST"
import json,sys,pathlib
meta=pathlib.Path(sys.argv[1]); out=pathlib.Path(sys.argv[2])
roles={}
for role in ["app","profit","v6","dashboard","stock"]:
  p=meta/f"{role}.ImageId.txt"
  if not p.exists():
    p=meta/"image-meta"/f"{role}.ImageId.txt"
  if not p.exists():
    raise SystemExit(f"missing {role}.ImageId.txt")
  roles[role]={"ImageId": p.read_text(encoding="utf-8").strip()}
out.write_text(json.dumps(roles,indent=2)+"\n",encoding="utf-8")
print("MANIFEST_BUILT_FROM_IMAGEID_TXT")
PY
  fi
  (
    cd "$TAR_DIR"
    if [[ -d image-tarballs ]]; then cd image-tarballs; fi
    [[ -f SHA256SUMS.txt ]] || die "SHA256SUMS.txt missing under $TAR_DIR"
    sha256sum -c SHA256SUMS.txt
    for r in app profit v6 dashboard stock; do
      [[ -f "${r}.tar.gz" ]] || die "missing ${r}.tar.gz"
      docker load -i "${r}.tar.gz"
    done
  )
  if [[ -n "$IMAGE_BUILD_COMMIT" && -f "$META_DIR/BUILD_IDENTITY.txt" ]]; then
    grep -q "$IMAGE_BUILD_COMMIT" "$META_DIR/BUILD_IDENTITY.txt" \
      || die "BUILD_IDENTITY missing IMAGE_BUILD_COMMIT=$IMAGE_BUILD_COMMIT"
  fi
  # Runtime prerequisites for scripts (not inside worker images when scripts-only R16)
  need node
  [[ -f "$ROOT/prisma/schema.prisma" ]] || die "missing prisma schema in scripts root"
  extract_expect_ids >/dev/null
  {
    echo "imageStamp=$IMAGE_STAMP"
    echo "imageBuildCommit=$IMAGE_BUILD_COMMIT"
    echo "imageGhaRunId=$RUN_ID"
    echo "scriptsCommit=${SCRIPTS_COMMIT:-unset}"
    echo "scriptsRoot=$ROOT"
  } | tee "$FA_STATE/PROVENANCE.txt"
  echo "PREFLIGHT_ARTIFACTS_OK tar=$TAR_DIR meta=$META_DIR"
}

# Capture RUNTIME container env (same source cutover uses). Never use image Config.Env as expected.
stage_capture_env() {
  need docker; need python3
  mkdir -p "$ENV_DIR" "$JOURNAL_DIR"
  local pair role cname out journal_out
  for pair in "${ROLES_CONTAINERS[@]}"; do
    role="${pair%%|*}"
    cname="${pair##*|}"
    out="$ENV_DIR/${role}.captured.env"
    journal_out="$JOURNAL_DIR/${cname}.env.captured"
    if ! docker inspect "$cname" >/dev/null 2>&1; then
      echo "CAPTURE_ENV_SKIP missing_container=$cname role=$role" >&2
      : > "$out"
      continue
    fi
    # Runtime Config.Env of the RUNNING container (= process env), NOT image defaults
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$cname" > "$out"
    cp -f "$out" "$journal_out"
    chmod 600 "$out" "$journal_out" 2>/dev/null || true
    python3 - <<'PY' "$out" "$ENV_DIR/${role}.captured.summary.json"
import hashlib,json,sys,re
path,out=sys.argv[1],sys.argv[2]
secret_re=re.compile(r"(PASSWORD|SECRET|TOKEN|KEY|DATABASE_URL|URL)=", re.I)
rows=[]
for line in open(path,encoding="utf-8",errors="replace"):
  line=line.rstrip("\n")
  if not line or "=" not in line: continue
  k,v=line.split("=",1)
  if secret_re.search(k+"=") or "DATABASE" in k.upper() or k.endswith("_URL"):
    rows.append({"key":k,"present":True,"sha256":hashlib.sha256(v.encode()).hexdigest()[:16]})
  else:
    rows.append({"key":k,"value":v})
json.dump({"role_env_keys":rows,"source":"running_container_runtime"}, open(out,"w",encoding="utf-8"), indent=2)
print("CAPTURED_RUNTIME", path)
PY
  done
  # Expected = cutover env-file that will be passed on switch:
  # prefer ENV_DIR/env/<container>.env, else journal captured, else copy of runtime captured.
  # Optional approved non-secret overrides: $ENV_DIR/<role>.expected.overrides.env
  for pair in "${ROLES_CONTAINERS[@]}"; do
    role="${pair%%|*}"
    cname="${pair##*|}"
    local exp="$ENV_DIR/${role}.expected.env"
    local cutover=""
    if [[ -f "${ENV_DIR}/env/${cname}.env" ]]; then
      cutover="${ENV_DIR}/env/${cname}.env"
    elif [[ -f "$JOURNAL_DIR/${cname}.env.captured" ]]; then
      cutover="$JOURNAL_DIR/${cname}.env.captured"
    else
      cutover="$ENV_DIR/${role}.captured.env"
    fi
    cp -f "$cutover" "$exp"
    if [[ -f "$ENV_DIR/${role}.expected.overrides.env" ]]; then
      # Merge overrides by key (safe line-based; no eval)
      python3 - <<'PY' "$exp" "$ENV_DIR/${role}.expected.overrides.env"
import sys
base,ovr=sys.argv[1],sys.argv[2]
vals={}
order=[]
def load(p):
  for line in open(p,encoding="utf-8",errors="replace"):
    line=line.rstrip("\n")
    if not line or line.startswith("#") or "=" not in line: continue
    k,v=line.split("=",1)
    if k not in vals: order.append(k)
    vals[k]=v
load(base); load(ovr)
open(base,"w",encoding="utf-8").write("".join(f"{k}={vals[k]}\n" for k in order))
print("MERGED_OVERRIDES", ovr)
PY
    fi
    # Document image defaults separately — NOT used for REQUIRED DATABASE_URL compare
    local tag="avorofin-p0-cogs-${role}:fin_accept_${IMAGE_STAMP}"
    if docker image inspect "$tag" >/dev/null 2>&1; then
      docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$tag" \
        > "$ENV_DIR/${role}.image_defaults.env" || true
    fi
  done
  echo "CAPTURE_ENV_OK dir=$ENV_DIR source=runtime_or_cutover_envfile"
}

# Export allowlisted keys from profit captured env into current shell file (no secret print).
stage_load_runner_env() {
  local role="${1:-profit}"
  local cap="$ENV_DIR/${role}.captured.env"
  [[ -f "$cap" ]] || die "missing $cap — run capture-env"
  local out="${RUNNER_ENV_EXPORT_FILE:-$FA_STATE/runner.env}"
  python3 - <<'PY' "$cap" "$out"
import sys
allow={"DATABASE_URL","V6_READMODEL_TARGET_DATABASE_URL","WAVE_B_PROFIT_TARGET_DATABASE_URL",
       "WAVE_B_PROFIT_WORKER_MODE","WAVE_B_TARGET_DB_MODE","V6_READMODEL_WORKER_MODE",
       "DASHBOARD_SNAPSHOT_WORKER_MODE","DASHBOARD_SNAPSHOT_FORMULA_VERSIONS",
       "WAVE_B_PROFIT_READMODEL_FIRST"}
src,dst=sys.argv[1],sys.argv[2]
vals={}
for line in open(src,encoding="utf-8",errors="replace"):
  if "=" not in line: continue
  k,v=line.rstrip("\n").split("=",1)
  if k in allow: vals[k]=v
if "DATABASE_URL" not in vals or not vals["DATABASE_URL"]:
  raise SystemExit("DATABASE_URL missing in captured runtime env")
open(dst,"w",encoding="utf-8").write("".join(f"{k}={vals[k]}\n" for k in vals))
print("RUNNER_ENV_WRITTEN keys=", ",".join(sorted(vals)), "path=", dst)
PY
  chmod 600 "$out"
  set -a
  # shellcheck disable=SC1090
  source "$out"
  set +a
  echo "LOAD_RUNNER_ENV_OK role=$role (secrets not printed)"
}

stage_runtime_preflight() {
  need node; need python3; need psql
  [[ -f "$ROOT/prisma/schema.prisma" ]] || die "missing prisma schema"
  node -e "require('fs').accessSync('node_modules/tsx/dist/loader.mjs')" 2>/dev/null \
    || [[ -d "$ROOT/node_modules/tsx" ]] \
    || die "tsx package missing — npm ci required for host runners"
  : "${DATABASE_URL:?DATABASE_URL required — run load-runner-env first}"
  node --import tsx -e 'import { prisma } from "@/lib/prisma"; const n=await prisma.$queryRawUnsafe("select 1 as n"); console.log("PRISMA_DB_OK", n); await prisma.$disconnect();' \
    || die "prisma/db preflight failed"
  echo "RUNTIME_PREFLIGHT_OK"
}

stage_compare_env() {
  local role="${1:?role}"
  local cap="${2:-$ENV_DIR/${role}.captured.env}"
  local exp="${3:-$ENV_DIR/${role}.expected.env}"
  [[ -f "$cap" ]] || die "captured env missing: $cap (run capture-env first)"
  [[ -f "$exp" ]] || die "expected env missing: $exp"
  bash "$ROOT/scripts/fin_accept/compare_main_env_keys_R12.sh" "$cap" "$exp" | tee /tmp/env_compare_${role}.txt
  if grep -E 'MISMATCH|MISSING_IN_CAPTURED|MISMATCH_PRESENCE|REQUIRED_MISSING|FILE_MISSING' /tmp/env_compare_${role}.txt >/dev/null; then
    die "env compare failed for $role — see /tmp/env_compare_${role}.txt"
  fi
  # Target identity proof (no secret print)
  python3 - <<'PY' "$cap"
import sys
from urllib.parse import urlparse
vals={}
for line in open(sys.argv[1],encoding="utf-8",errors="replace"):
  if "=" not in line: continue
  k,v=line.strip().split("=",1)
  vals[k]=v
db=vals.get("DATABASE_URL","")
profit=vals.get("WAVE_B_PROFIT_TARGET_DATABASE_URL") or db
v6=vals.get("V6_READMODEL_TARGET_DATABASE_URL") or db
def ident(u):
  try:
    p=urlparse(u); return (p.scheme,p.hostname,p.port,p.path)
  except Exception:
    return u
same_p=ident(db)==ident(profit)
same_v=ident(db)==ident(v6)
print(f"TARGET_PROOF profit_same={same_p} v6_same={same_v}")
if db and (not same_p or not same_v):
  print("TARGET_SPLIT_DETECTED — weekly requires WEEKLY_REQUIRE_SAME_TARGETS=0 + per-target wait; default entrypoint refuses")
  raise SystemExit(6)
PY
  echo "COMPARE_ENV_OK role=$role"
}

stage_backup_week() {
  need node
  : "${DATABASE_URL:?DATABASE_URL required for backup}"
  mkdir -p "$BACKUP_DIR"
  node --import tsx "$ROOT/scripts/fin_accept/export_profit_period_backup_R16.ts" "$BACKUP_DIR" \
    | tee "$BACKUP_DIR/export_stdout.txt"
  [[ -f "$BACKUP_DIR/ozon_profit_period_snapshot.json" ]] || die "backup Ozon snapshot missing"
  [[ -f "$BACKUP_DIR/backup_meta.json" ]] || die "backup meta missing"
  export OZON_PERIOD_SNAPSHOT_JSON="$BACKUP_DIR/ozon_profit_period_snapshot.json"
  echo "$OZON_PERIOD_SNAPSHOT_JSON" > "$FA_STATE/OZON_PERIOD_SNAPSHOT_JSON.path"
  echo "BACKUP_WEEK_OK path=$OZON_PERIOD_SNAPSHOT_JSON"
}

wait_running_zero() {
  local label="$1" sql="$2" url="${3:-$DATABASE_URL}"
  local max="${4:-${STOP_CLAIMS_WAIT_MAX:-36}}"  # default 36*5s≈3min; override in isolation
  local sleep_s="${STOP_CLAIMS_WAIT_SLEEP:-5}"
  [[ -n "${url:-}" ]] || die "DATABASE_URL required for wait ($label)"
  local i=0
  while (( i < max )); do
    local n
    n="$(psql "$url" -Atc "$sql" | head -n1 | tr -d '[:space:]')"
    n="${n:-0}"
    echo "WAIT_$label RUNNING_COUNT=$n"
    [[ "$n" == "0" ]] && return 0
    sleep "$sleep_s"
    i=$((i+1))
  done
  return 1
}

restore_all_touched() {
  local state_file="$1"
  local touched_file="$2"
  [[ -f "$touched_file" ]] || return 0
  local cname was
  while IFS= read -r cname || [[ -n "${cname:-}" ]]; do
    [[ -z "${cname:-}" ]] && continue
    was="$(python3 -c "import json;print(json.load(open(r'$state_file')).get('$cname','missing'))")"
    if [[ "$was" == "running" ]]; then
      echo "STOP_CLAIMS_RECOVER_ALL start $cname (was=$was)"
      docker start "$cname" || echo "WARN: restart failed $cname" >&2
    fi
  done < "$touched_file"
}

container_is_running() {
  local cname="$1"
  local st
  st="$(docker inspect -f '{{.State.Running}}' "$cname" 2>/dev/null || echo false)"
  [[ "$st" == "true" ]]
}

stage_stop_claims() {
  need docker; need psql
  : "${DATABASE_URL:?DATABASE_URL required}"
  local state_file="$FA_STATE/stop_claims_prestate.json"
  local touched_file="$FA_STATE/stop_claims_touched.txt"
  : > "$touched_file"
  mkdir -p "$FA_STATE"
  python3 - <<'PY' "$state_file"
import json,subprocess,sys
names=[
 "avorofin-profit-readmodel-worker",
 "avorofin-v6-period-readmodel-worker",
 "avorofin-dashboard-period-snapshot-worker",
 "avorofin-stock-planning-snapshot-worker",
]
state={}
for n in names:
  try:
    out=subprocess.check_output(["docker","inspect","-f","{{.State.Status}}",n], text=True).strip()
  except Exception:
    out="missing"
  state[n]=out
json.dump(state, open(sys.argv[1],"w",encoding="utf-8"), indent=2)
print("PRESTATE", state)
PY

  fail_restore() {
    echo "STOP_CLAIMS_FAIL — restoring ALL touched roles" >&2
    restore_all_touched "$state_file" "$touched_file"
    die "$*"
  }

  stop_one() {
    local cname="$1" label="$2" sql="$3" url="${4:-$DATABASE_URL}"
    local was
    was="$(python3 -c "import json;print(json.load(open(r'$state_file')).get('$cname','missing'))")"
    echo "$cname" >> "$touched_file"
    if [[ "$was" == "running" ]]; then
      docker kill --signal=SIGTERM "$cname" 2>/dev/null || docker stop -t 20 "$cname" || true
    else
      docker stop -t 5 "$cname" 2>/dev/null || true
    fi
    # Claim drain
    if ! wait_running_zero "$label" "$sql" "$url"; then
      fail_restore "timeout RUNNING=0 for $label"
    fi
    # Container must actually be stopped (claims=0 with running writer is NOT OK)
    if container_is_running "$cname"; then
      docker stop -t 10 "$cname" || true
      if container_is_running "$cname"; then
        fail_restore "container still running after stop: $cname (claims drained but writer alive)"
      fi
    fi
    echo "STOP_OK $label container_stopped=true claims=0"
    return 0
  }

  stop_one avorofin-profit-readmodel-worker profit \
    "SELECT count(*) FROM \"DashboardPeriodSnapshotJob\" WHERE status='RUNNING' AND \"formulaVersion\" IN ('FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1','FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1');"

  stop_one avorofin-v6-period-readmodel-worker v6 \
    "SELECT count(*) FROM \"DashboardPeriodSnapshotJob\" WHERE status='RUNNING' AND \"formulaVersion\"='FINANCIAL_CORE_V6_PERIOD_READMODEL_V2';" \
    "${V6_READMODEL_TARGET_DATABASE_URL:-$DATABASE_URL}"

  stop_one avorofin-dashboard-period-snapshot-worker dashboard \
    "SELECT count(*) FROM \"DashboardPeriodSnapshotJob\" WHERE status='RUNNING' AND \"formulaVersion\"='FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1';"

  stop_one avorofin-stock-planning-snapshot-worker stock \
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
  export IMAGE_APP="${IMAGE_APP:-avorofin-p0-cogs-app:fin_accept_${IMAGE_STAMP}}"
  export IMAGE_PROFIT="${IMAGE_PROFIT:-avorofin-p0-cogs-profit:fin_accept_${IMAGE_STAMP}}"
  export IMAGE_V6="${IMAGE_V6:-avorofin-p0-cogs-v6:fin_accept_${IMAGE_STAMP}}"
  export IMAGE_DASHBOARD="${IMAGE_DASHBOARD:-avorofin-p0-cogs-dashboard:fin_accept_${IMAGE_STAMP}}"
  export IMAGE_STOCK="${IMAGE_STOCK:-avorofin-p0-cogs-stock:fin_accept_${IMAGE_STAMP}}"
  bash "$ROOT/scripts/deploy/cutover_five_roles.sh" switch
  echo "SWITCH_OK"
}

stage_weekly() {
  need node; need psql
  : "${DATABASE_URL:?DATABASE_URL required}"
  export WEEKLY_JOB_IDS_DIR="${WEEKLY_JOB_IDS_DIR:-$FA_STATE/weekly_ids}"
  export WEEKLY_REQUIRE_SAME_TARGETS="${WEEKLY_REQUIRE_SAME_TARGETS:-1}"
  mkdir -p "$WEEKLY_JOB_IDS_DIR"

  run_stage() {
    local st="$1"
    export WEEKLY_STAGE="$st"
    export WEEKLY_JOB_IDS_FILE="$WEEKLY_JOB_IDS_DIR/weekly_ids_${st}.txt"
    node --import tsx "$ROOT/scripts/fin_accept/run_weekly_enqueue_R12.ts" \
      "$FA_STATE/weekly_${st}.json"
    bash "$ROOT/scripts/fin_accept/wait_weekly_R12.sh"
  }

  run_stage profit
  run_stage v6
  run_stage dashboard

  # Final gate: all 12 IDs across stages
  cat "$WEEKLY_JOB_IDS_DIR/weekly_ids_profit.txt" \
      "$WEEKLY_JOB_IDS_DIR/weekly_ids_v6.txt" \
      "$WEEKLY_JOB_IDS_DIR/weekly_ids_dashboard.txt" \
    > "$WEEKLY_JOB_IDS_DIR/weekly_ids_final.txt"
  export WEEKLY_STAGE=final
  export WEEKLY_JOB_IDS_FILE="$WEEKLY_JOB_IDS_DIR/weekly_ids_final.txt"
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
  # Prefer full backup directory (Ozon+WB+SKU+inventory). Fallback to ozon json path.
  local target="${WEEK_BACKUP_DIR:-$BACKUP_DIR}"
  if [[ ! -d "$target" ]]; then
    local snap="${OZON_PERIOD_SNAPSHOT_JSON:-}"
    if [[ -z "$snap" && -f "$FA_STATE/OZON_PERIOD_SNAPSHOT_JSON.path" ]]; then
      snap="$(cat "$FA_STATE/OZON_PERIOD_SNAPSHOT_JSON.path")"
    fi
    [[ -n "$snap" ]] || die "WEEK_BACKUP_DIR / OZON_PERIOD_SNAPSHOT_JSON unset — run backup-week"
    target="$snap"
  fi
  # Quiesce writers before data restore (do not start workers mid-restore)
  echo "DATA_ROLLBACK_REQUIRE_NO_WRITER — ensure stop-claims done; not starting workers here"
  node --import tsx "$ROOT/scripts/fin_accept/run_data_rollback_ozon_R12.ts" "$target"
}

# Concrete Telegram update/rollback after MAIN verify. Does NOT send messages.
stage_telegram_plan() {
  local out="$FA_STATE/telegram_plan.json"
  mkdir -p "$FA_STATE" "$JOURNAL_DIR"
  local host="${TELEGRAM_HOST:-64.188.63.133}"
  local user="${TELEGRAM_SSH_USER:-root}"
  local inspect="$FA_STATE/telegram_ro_inspect.txt"
  if ssh -o BatchMode=yes -o ConnectTimeout=10 "${user}@${host}" "true" 2>/dev/null; then
    ssh -o BatchMode=yes "${user}@${host}" "bash -s" <<'EOF' | tee "$inspect"
set -euo pipefail
cd /opt/avorofin
docker inspect avorofin-telegram-app --format 'name={{.Name}} image={{.Config.Image}} id={{.Image}} status={{.State.Status}} ports={{json .HostConfig.PortBindings}}' || true
ss -lptn | grep -E '8091|8092|3001|443' || true
EOF
  else
    echo "TELEGRAM_SSH_UNAVAILABLE" | tee "$inspect"
  fi
  python3 - <<PY
import json, pathlib, re
out=pathlib.Path(r"$out")
inspect=pathlib.Path(r"$inspect").read_text(encoding="utf-8", errors="replace")
m=re.search(r"image=(\\S+).*?id=(sha256:\\S+)", inspect)
cur_image = m.group(1) if m else "avorofin-p0-cogs-telegram:20261014_tg_top_truth"
cur_id = m.group(2) if m else "sha256:7f9fee6a7e5f5595d6895d892d37dd218e5e2cb62ebf86a5b048ee15a1132453"
ssh_ok = "TELEGRAM_SSH_UNAVAILABLE" not in inspect
plan={
  "productionChanged": False,
  "sendMessages": False,
  "telegramReady": ssh_ok,
  "host": "$host",
  "sshUser": "$user",
  "remoteRoot": "/opt/avorofin",
  "afterMainGate": "MAIN verify-week PASS",
  "observedRuntime": {
    "container": "avorofin-telegram-app",
    "image": cur_image,
    "imageId": cur_id,
    "hostPort": "127.0.0.1:3001->3000/tcp",
    "listeners": "443 caddy; 8091 test; 8092 bridge; 3001 telegram app",
    "composeManaged": False
  },
  "dailyReportSha_expected_R15": "9c800fcc2d9a75fc4940de03c2f87a511f78677210cd83793a33577cf9e58327",
  "commands_update_AFTER_MAIN_VERIFY": [
    f"ssh {user}@{host} 'docker inspect avorofin-telegram-app -f \"{{{{range .Config.Env}}}}{{{{println .}}}}{{{{end}}}}\" > /var/lib/avorofin/tg_env_captured.env && chmod 600 /var/lib/avorofin/tg_env_captured.env'",
    f"ssh {user}@{host} 'docker tag {cur_image} avorofin-p0-cogs-telegram:rollback_pre_r17 && echo {cur_id} > /var/lib/avorofin/tg_rollback_imageid.txt'",
    f"ssh {user}@{host} 'docker stop avorofin-telegram-app && docker rm avorofin-telegram-app'",
    f"ssh {user}@{host} 'docker run -d --name avorofin-telegram-app --restart unless-stopped --env-file /var/lib/avorofin/tg_env_captured.env -p 127.0.0.1:3001:3000 NEW_TELEGRAM_IMAGE_WITH_ACCEPTED_DAILYREPORT'",
    f"ssh {user}@{host} 'curl -sf -o /dev/null -w \"%{{http_code}}\" http://127.0.0.1:3001/ || true'"
  ],
  "commands_rollback": [
    f"ssh {user}@{host} 'docker stop avorofin-telegram-app; docker rm avorofin-telegram-app'",
    f"ssh {user}@{host} 'docker run -d --name avorofin-telegram-app --restart unless-stopped --env-file /var/lib/avorofin/tg_env_captured.env -p 127.0.0.1:3001:3000 avorofin-p0-cogs-telegram:rollback_pre_r17'"
  ],
  "forbidden": ["telegram send", "op 572", "test finance tx"],
  "scriptsCommit": "$SCRIPTS_COMMIT",
  "imageStampApp": "$IMAGE_STAMP"
}
out.write_text(json.dumps(plan, indent=2)+"\\n", encoding="utf-8")
print("TELEGRAM_PLAN_OK" if ssh_ok else "TELEGRAM_PLAN_WRITTEN_SSH_BLOCKED", out)
PY
}

stage="${1:-}"
case "$stage" in
  preflight-artifacts) stage_preflight_artifacts ;;
  capture-env) stage_capture_env ;;
  load-runner-env) shift; stage_load_runner_env "$@" ;;
  runtime-preflight) stage_runtime_preflight ;;
  compare-env) shift; stage_compare_env "$@" ;;
  backup-week) stage_backup_week ;;
  stop-claims) stage_stop_claims ;;
  switch) stage_switch ;;
  weekly) stage_weekly ;;
  verify-week) stage_verify_week ;;
  rollback) stage_rollback ;;
  data-rollback) stage_data_rollback ;;
  telegram-plan) stage_telegram_plan ;;
  *)
    cat <<EOF
DEPLOY_ENTRYPOINT_R17 stages (order):
  preflight-artifacts
  capture-env                 # runtime container env (not image Config)
  load-runner-env [role]      # export allowlisted keys for host runners
  runtime-preflight           # node/tsx/prisma/db before stop
  compare-env <role>
  backup-week
  stop-claims                 # restore ALL touched roles on any fail; container must stop
  switch
  weekly
  verify-week
  data-rollback               # WEEK_BACKUP_DIR scoped PPM+SKU
  rollback
  telegram-plan               # concrete docker run/rollback on 64.188.63.133
IMAGE_STAMP default=$IMAGE_STAMP (R15 images). productionChanged=false until owner OK.
EOF
    exit 2
    ;;
esac
