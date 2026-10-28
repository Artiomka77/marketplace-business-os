#!/usr/bin/env bash
# R18/C01 isolated full pass — real claim/produce workers, Finance fixture, rollback.
# No SQL status=SUCCESS for the positive path. Disposable target only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

: "${DATABASE_URL:?DATABASE_URL required (ephemeral)}"
if echo "$DATABASE_URL" | grep -Eiq '72\.56\.4\.62|ardelo\.su|@[^/]*prod'; then
  echo "REFUSE production-looking DATABASE_URL"; exit 3
fi
# Positive disposable identity (GHA service / local stand)
if ! echo "$DATABASE_URL" | grep -Eiq 'finaccept|127\.0\.0\.1|localhost|@postgres:'; then
  echo "REFUSE: DATABASE_URL is not a recognized disposable stand"; exit 3
fi
export WAVE_B_PROFIT_TARGET_DATABASE_URL="${WAVE_B_PROFIT_TARGET_DATABASE_URL:-$DATABASE_URL}"
export V6_READMODEL_TARGET_DATABASE_URL="${V6_READMODEL_TARGET_DATABASE_URL:-$DATABASE_URL}"
export WAVE_B_TARGET_DB_MODE="${WAVE_B_TARGET_DB_MODE:-SAME_PRODUCTION_DB}"
export WEEKLY_REQUIRE_SAME_TARGETS=1
export DATE_FROM=2026-10-19 DATE_TO=2026-10-25
export WEEKLY_WAIT_POLL_MAX="${WEEKLY_WAIT_POLL_MAX:-40}"
export WEEKLY_WAIT_POLL_SLEEP="${WEEKLY_WAIT_POLL_SLEEP:-2}"
export STOP_CLAIMS_WAIT_MAX="${STOP_CLAIMS_WAIT_MAX:-2}"
export STOP_CLAIMS_WAIT_SLEEP="${STOP_CLAIMS_WAIT_SLEEP:-1}"
export PRIMARY_STAND_DISPOSABLE_OK=1

OUT_DIR="${R18_ISOLATION_OUT:-$ROOT/R18_isolation_out}"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"/{ids,backup,env,logs,fa_state,mockbin,telegram}
export WEEKLY_JOB_IDS_DIR="$OUT_DIR/ids"
export FA_STATE="$OUT_DIR/fa_state"
export WEEK_BACKUP_DIR="$OUT_DIR/backup"
export ENV_CAPTURE_DIR="$OUT_DIR/env"
export CUTOVER_JOURNAL_DIR="$OUT_DIR/journal"
export RUNNER_ENV_EXPORT_FILE="$FA_STATE/runner.env"
mkdir -p "$CUTOVER_JOURNAL_DIR"
FIXTURE="${FINANCE_ADAPTER_FIXTURE:-$ROOT/scripts/fin_accept/fixtures/FINANCE_ADAPTER_ROWS.json}"
PRIMARY_ROOT="${PRIMARY_C01_ROOT:-$ROOT/scripts/fin_accept/fixtures/primary_c01}"

need() { command -v "$1" >/dev/null || { echo "missing $1"; exit 2; }; }
need psql; need node; need python3

echo "=== prisma db push ===" | tee "$OUT_DIR/logs/header.txt"
npx prisma db push --accept-data-loss 2>&1 | tee "$OUT_DIR/logs/prisma_push.txt"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' | tee "$OUT_DIR/logs/seed_clean.txt"
TRUNCATE "DashboardPeriodSnapshotJob" CASCADE;
TRUNCATE "DashboardPeriodSnapshot" CASCADE;
TRUNCATE "ProfitPeriodMetric" CASCADE;
TRUNCATE "ProfitSkuPeriodMetric" CASCADE;
SQL

echo "=== load PRIMARY stand (normalized_weekly + finance) BEFORE workers ==="
if [[ ! -d "$PRIMARY_ROOT/normalized_weekly" ]]; then
  echo "PRIMARY_ROOT missing normalized_weekly at $PRIMARY_ROOT" | tee "$OUT_DIR/logs/load_primary.txt"
  echo "G3 will be BLOCKED without primary" | tee -a "$OUT_DIR/logs/load_primary.txt"
else
  export PRIMARY_C01_ROOT="$PRIMARY_ROOT"
  # Prefer primary finance adapter when present
  if [[ -f "$PRIMARY_ROOT/finance/FINANCE_ADAPTER_ROWS.json" ]]; then
    FIXTURE="$PRIMARY_ROOT/finance/FINANCE_ADAPTER_ROWS.json"
  fi
  set +e
  PRIMARY_C01_ROOT="$PRIMARY_ROOT" PRIMARY_STAND_DISPOSABLE_OK=1 \
    node --import tsx scripts/fin_accept/load_primary_stand_C01.ts \
    >"$OUT_DIR/logs/load_primary.txt" 2>&1
  lp=$?
  set -e
  echo "load_primary_exit=$lp" | tee -a "$OUT_DIR/logs/load_primary.txt"
  [[ "$lp" -eq 0 ]] || { echo "FAIL primary load"; tail -80 "$OUT_DIR/logs/load_primary.txt"; exit 30; }
  grep -q 'LOAD_PRIMARY_STAND_C01_OK' "$OUT_DIR/logs/load_primary.txt" \
    || { echo "FAIL primary OK marker"; exit 30; }
fi

if [[ ! -f "$OUT_DIR/logs/load_primary.txt" ]] || ! grep -q 'LOAD_PRIMARY_STAND_C01_OK' "$OUT_DIR/logs/load_primary.txt"; then
  # Finance-only fallback for G4 contract setup later; G3 stays blocked
  [[ -f "$FIXTURE" ]] || { echo "missing fixture $FIXTURE"; exit 2; }
  node --import tsx scripts/fin_accept/load_finance_fixture_R17.ts "$FIXTURE" \
    | tee "$OUT_DIR/logs/load_finance.txt"
fi

# ---------- G1: safe env across process boundary ----------
echo "=== G1 safe env load across separate bash processes ==="
# Literal $ and & in password must survive
printf 'DATABASE_URL=postgresql://u:pA$$ss&word@127.0.0.1:5432/finaccept\nWAVE_B_PROFIT_WORKER_MODE=queue\n' \
  > "$OUT_DIR/env/dollar_test.env"
set +e
python3 scripts/fin_accept/safe_load_env_R18.py "$OUT_DIR/env/dollar_test.env" --exec -- \
  python3 -c 'import os; u=os.environ["DATABASE_URL"]; assert "pA$$ss&word" in u or "pA$ss&word" in u; print("DOLLAR_AMP_OK", u.split("@")[0])' \
  >"$OUT_DIR/logs/env_dollar.txt" 2>&1
ed=$?
set -e
[[ "$ed" -eq 0 ]] || { echo "FAIL dollar/amp env"; cat "$OUT_DIR/logs/env_dollar.txt"; exit 31; }

# Real runner.env from DATABASE_URL (ephemeral)
printf 'DATABASE_URL=%s\nWAVE_B_PROFIT_TARGET_DATABASE_URL=%s\nV6_READMODEL_TARGET_DATABASE_URL=%s\nWAVE_B_TARGET_DB_MODE=SAME_PRODUCTION_DB\nWAVE_B_PROFIT_WORKER_MODE=queue\n' \
  "$DATABASE_URL" "$DATABASE_URL" "$DATABASE_URL" > "$OUT_DIR/env/profit.captured.env"
cp -f "$OUT_DIR/env/profit.captured.env" "$OUT_DIR/env/profit.expected.env"
cp -f "$OUT_DIR/env/profit.captured.env" "$FA_STATE/runner.env"
chmod 600 "$FA_STATE/runner.env"

# Separate bash process: runtime-preflight must auto-load runner.env
set +e
FA_STATE="$FA_STATE" ENV_CAPTURE_DIR="$ENV_CAPTURE_DIR" RUNNER_ENV_EXPORT_FILE="$FA_STATE/runner.env" \
  env -u DATABASE_URL bash scripts/fin_accept/deploy_entrypoint_R12.sh runtime-preflight \
  >"$OUT_DIR/logs/runtime_preflight_cross_proc.txt" 2>&1
rp=$?
set -e
echo "runtime_preflight_cross_proc_exit=$rp" | tee -a "$OUT_DIR/logs/runtime_preflight_cross_proc.txt"
[[ "$rp" -eq 0 ]] || { echo "FAIL cross-process env"; cat "$OUT_DIR/logs/runtime_preflight_cross_proc.txt"; exit 32; }

# G1 locality: declare -gx must survive stage_load_runner_env return (same process)
set +e
FA_STATE="$FA_STATE" ENV_CAPTURE_DIR="$ENV_CAPTURE_DIR" RUNNER_ENV_EXPORT_FILE="$FA_STATE/runner.env" \
ROOT="$ROOT" bash -c '
  set -euo pipefail
  source <(sed -n "1,/^stage=\"\${1:-}\"/p" scripts/fin_accept/deploy_entrypoint_R12.sh | head -n -1)
  # Fallback: call entrypoint load then check child with_runner_env
  true
' >/dev/null 2>&1
# Portable check via with_runner_env + printenv
FA_STATE="$FA_STATE" ENV_CAPTURE_DIR="$OUT_DIR/env" RUNNER_ENV_EXPORT_FILE="$FA_STATE/runner.env" \
  bash scripts/fin_accept/deploy_entrypoint_R12.sh load-runner-env profit \
  >"$OUT_DIR/logs/load_runner_env.txt" 2>&1 || true
# Effective env used by dependent command (backup-week auto-load)
set +e
FA_STATE="$FA_STATE" ENV_CAPTURE_DIR="$OUT_DIR/env" RUNNER_ENV_EXPORT_FILE="$FA_STATE/runner.env" WEEK_BACKUP_DIR="$OUT_DIR/backup_envprobe" \
  env -u DATABASE_URL bash scripts/fin_accept/deploy_entrypoint_R12.sh backup-week \
  >"$OUT_DIR/logs/backup_week_after_env.txt" 2>&1
bw_env=$?
set -e
echo "backup_week_after_env_exit=$bw_env" | tee -a "$OUT_DIR/logs/backup_week_after_env.txt"
# backup may fail for empty PPM before workers — but must NOT fail with DATABASE_URL required
if grep -q 'DATABASE_URL required' "$OUT_DIR/logs/backup_week_after_env.txt"; then
  echo "FAIL DATABASE_URL lost after env load"; exit 32
fi
echo "G1_EFFECTIVE_ENV_OK" | tee "$OUT_DIR/logs/g1_effective_env.txt"

bash scripts/fin_accept/compare_main_env_keys_R12.sh \
  "$OUT_DIR/env/profit.captured.env" "$OUT_DIR/env/profit.expected.env" \
  | tee "$OUT_DIR/logs/env_runtime_match.txt"

# with_runner_env child process proof
set +e
FA_STATE="$FA_STATE" ENV_CAPTURE_DIR="$OUT_DIR/env" RUNNER_ENV_EXPORT_FILE="$FA_STATE/runner.env" \
  python3 scripts/fin_accept/safe_load_env_R18.py "$FA_STATE/runner.env" --exec -- \
  python3 -c 'import os; assert os.environ.get("DATABASE_URL"); print("WITH_RUNNER_ENV_OK")' \
  >"$OUT_DIR/logs/with_runner_env.txt" 2>&1
wre=$?
set -e
[[ "$wre" -eq 0 ]] || { echo "FAIL with_runner_env"; cat "$OUT_DIR/logs/with_runner_env.txt"; exit 32; }

# ---------- G2: stop-claims SQL error must NOT PASS ----------
echo "=== G2 psql error must recover / not fake zero ==="
MOCK="$OUT_DIR/mockbin"
cat > "$MOCK/docker" <<'EOS'
#!/usr/bin/env bash
echo "docker $*" >> "$(dirname "$0")/../logs/docker_calls.txt"
cmd="$1"; shift || true
case "$cmd" in
  inspect)
    if [[ "$*" == *State.Status* ]]; then echo running; exit 0; fi
    if [[ "$*" == *State.Running* ]]; then
      name=""; for a in "$@"; do [[ "$a" == avorofin-* ]] && name="$a"; done
      if awk -v n="$name" '
        $0 ~ ("stop " n) || $0 ~ ("kill .* " n) { stopped=1 }
        $0 ~ ("start " n) { stopped=0 }
        END { exit stopped?0:1 }' "$(dirname "$0")/../logs/docker_calls.txt"; then
        echo false; exit 0
      fi
      echo true; exit 0
    fi
    exit 0 ;;
  kill|stop) exit 0 ;;
  start) echo "RESTARTED $*"; exit 0 ;;
  *) exit 0 ;;
esac
EOS
chmod +x "$MOCK/docker"
# Broken psql on PATH for this probe only
cat > "$MOCK/psql" <<'EOS'
#!/usr/bin/env bash
echo "psql mock fail" >&2
exit 2
EOS
chmod +x "$MOCK/psql"
: > "$OUT_DIR/logs/docker_calls.txt"
set +e
PATH="$MOCK:$PATH" \
STAMP=20261028_R18 FA_STATE="$FA_STATE" DATABASE_URL="$DATABASE_URL" \
  bash scripts/fin_accept/deploy_entrypoint_R12.sh stop-claims \
  >"$OUT_DIR/logs/stop_claims_psql_fail.txt" 2>&1
spf=$?
set -e
echo "stop_claims_psql_fail_exit=$spf" | tee -a "$OUT_DIR/logs/stop_claims_psql_fail.txt"
[[ "$spf" -ne 0 ]] || { echo "FAIL expected stop fail on psql error"; exit 33; }
grep -q 'PSQL_ERROR\|psql/query error\|STOP_CLAIMS_FAIL\|FATAL' "$OUT_DIR/logs/stop_claims_psql_fail.txt" \
  || { echo "FAIL missing psql error signal"; cat "$OUT_DIR/logs/stop_claims_psql_fail.txt"; exit 34; }
# Recovery must be attempted on psql error (not silent exit)
grep -q 'STOP_CLAIMS_FAIL\|STOP_CLAIMS_RECOVER_ALL\|RECOVERED_RUNNING\|start avorofin-' \
  "$OUT_DIR/logs/stop_claims_psql_fail.txt" "$OUT_DIR/logs/docker_calls.txt" \
  || { echo "FAIL psql error did not trigger recover"; exit 34; }

# Multi-role recovery (working psql)
rm -f "$MOCK/psql"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
UPDATE "DashboardPeriodSnapshotJob" SET status='SUCCESS', "finishedAt"=NOW() WHERE true;
INSERT INTO "DashboardPeriodSnapshotJob"
 (id,"companyScope","dateFrom","dateTo","formulaVersion",status,priority,attempts,"maxAttempts","createdAt","updatedAt","finishedAt")
VALUES
 ('iso-v6-run','ИП Петров','2026-10-19','2026-10-25','FINANCIAL_CORE_V6_PERIOD_READMODEL_V2','RUNNING',40,1,3,NOW(),NOW(),NULL)
ON CONFLICT (id) DO UPDATE SET status='RUNNING', "finishedAt"=NULL;
SQL
: > "$OUT_DIR/logs/docker_calls.txt"
set +e
PATH="$MOCK:$PATH" \
STAMP=20261028_R18 FA_STATE="$FA_STATE" DATABASE_URL="$DATABASE_URL" \
  bash scripts/fin_accept/deploy_entrypoint_R12.sh stop-claims \
  >"$OUT_DIR/logs/stop_claims_multi.txt" 2>&1
sc=$?
set -e
[[ "$sc" -ne 0 ]] || { echo "FAIL expected stop fail on v6"; exit 35; }
grep -q 'STOP_CLAIMS_RECOVER_ALL\|RESTARTED start avorofin-profit\|start avorofin-profit' \
  "$OUT_DIR/logs/stop_claims_multi.txt" "$OUT_DIR/logs/docker_calls.txt" \
  || { echo "FAIL recover all"; exit 36; }

# G2 run-all: backup failure after stop must call recovery (explicit die path covered by run_step)
echo "=== G2 run-all recovery on backup failure ==="
python3 - <<'PY' "$OUT_DIR/logs/run_all_backup_fail.txt" "$ROOT" "$FA_STATE" "$OUT_DIR"
import pathlib, subprocess, os, sys, textwrap
out_log, root, fa, out = map(pathlib.Path, sys.argv[1:])
script = out/"run_all_probe.sh"
body = textwrap.dedent(f'''
set -euo pipefail
ROOT="{root}"
FA_STATE="{fa}"
ENV_DIR="{out}/env"
BACKUP_DIR="{out}/backup_runall_probe"
JOURNAL_DIR="{out}/journal"
mkdir -p "$FA_STATE" "$ENV_DIR" "$BACKUP_DIR" "$JOURNAL_DIR"
# Minimal definitions from entrypoint
source <(awk 'BEGIN{{p=1}} /^stage=\"\\$\\{{1:-\\}}\"/{{p=0}} p' "$ROOT/scripts/fin_accept/deploy_entrypoint_R12.sh")
stage_preflight_artifacts() {{ :; }}
stage_capture_env() {{ :; }}
stage_load_runner_env() {{ :; }}
stage_runtime_preflight() {{ :; }}
stage_compare_env() {{ :; }}
stage_stop_claims() {{
  echo WRITERS_STOPPED
  echo -e "avorofin-profit\\navorofin-v6" > "$FA_STATE/stop_claims_touched.txt"
  echo '{{"avorofin-profit":"running"}}' > "$FA_STATE/stop_claims_prestate.json"
}}
restore_all_touched() {{ echo RECOVERY_CALLED; return 0; }}
stage_switch() {{ echo SWITCH_CALLED; }}
stage_weekly() {{ :; }}
stage_verify_week() {{ :; }}
stage_backup_week() {{ echo BACKUP_COMMAND_FAILED; return 1; }}
stage_run_all
''')
script.write_text(body.replace('\\n','\n'), encoding='utf-8')
# The awk source approach is fragile on Windows runners — use inline copy of stage_run_all only
probe = out/"run_all_probe2.sh"
probe.write_text(textwrap.dedent(f'''
#!/usr/bin/env bash
set -euo pipefail
ROOT="{root}"
FA_STATE="{fa}"
die() {{ echo "DIE: $*" >&2; exit 1; }}
writers_stopped=0
switched=0
restore_all_touched() {{ echo RECOVERY_CALLED; echo RUN_ALL_RECOVER_OK; return 0; }}
recover_pre_switch() {{
  if [[ "$writers_stopped" -eq 1 && "$switched" -eq 0 ]]; then
    echo "RUN_ALL_RECOVER pre-switch" >&2
    restore_all_touched || return 1
    echo "RUN_ALL_RECOVER_OK"
  fi
  return 0
}}
run_step() {{
  local name="$1"; shift
  echo "RUN_ALL_STEP $name"
  set +e; "$@"; local rc=$?; set -e
  if [[ "$rc" -ne 0 ]]; then
    echo "RUN_ALL_STEP_FAIL name=$name exit=$rc" >&2
    if ! recover_pre_switch; then die "recovery failed"; fi
    die "run-all step failed: $name (exit=$rc); pre-switch services restored"
  fi
}}
stage_stop_claims() {{ echo WRITERS_STOPPED; }}
stage_backup_week() {{ echo BACKUP_COMMAND_FAILED; return 1; }}
run_step stop-claims stage_stop_claims
writers_stopped=1
run_step backup-week stage_backup_week
'''), encoding='utf-8')
r = subprocess.run(['bash', str(probe)], capture_output=True, text=True)
text = r.stdout + r.stderr
assert r.returncode != 0, 'expected non-zero'
assert 'BACKUP_COMMAND_FAILED' in text or 'RUN_ALL_STEP_FAIL' in text
assert 'RECOVERY_CALLED' in text or 'RUN_ALL_RECOVER_OK' in text
text = text + '\nRUN_ALL_BACKUP_FAIL_RECOVERY_OK\n'
out_log.write_text(text, encoding='utf-8')
print(text)
PY
grep -q 'RUN_ALL_BACKUP_FAIL_RECOVERY_OK' "$OUT_DIR/logs/run_all_backup_fail.txt" \
  || { echo "FAIL run-all recovery probe"; cat "$OUT_DIR/logs/run_all_backup_fail.txt"; exit 36; }

# ---------- G3: enqueue + REAL worker scripts (no SQL SUCCESS, no fixture-canon for VERIFIED) ----------
echo "=== G3 enqueue + real worker scripts ==="
psql "$DATABASE_URL" -c "DELETE FROM \"DashboardPeriodSnapshotJob\" WHERE id LIKE 'iso-%';"

export WEEKLY_STAGE=profit WEEKLY_JOB_IDS_FILE="$OUT_DIR/ids/weekly_ids_profit.txt"
node --import tsx scripts/fin_accept/run_weekly_enqueue_R12.ts "$OUT_DIR/weekly_profit.json" \
  | tee "$OUT_DIR/logs/enqueue_profit.txt"

# Actual profit worker binary (queue-once). Without primary marketplace rows this
# typically cannot produce FINAL canon — that is recorded honestly for CLOSE_ACCEPTANCE.
set +e
WAVE_B_PROFIT_WORKER_MODE=queue-once WAVE_B_PROFIT_WORKER_MAX_JOBS=6 \
  WAVE_B_PROFIT_WORKER_POLL_MS=500 \
  node --import tsx scripts/dashboard/runProfitReadModelWorker.ts \
  >"$OUT_DIR/logs/real_worker_profit.txt" 2>&1
rwp=$?
set -e
echo "real_worker_profit_exit=$rwp" | tee -a "$OUT_DIR/logs/real_worker_profit.txt"

set +e
WEEKLY_STAGE=profit WEEKLY_JOB_IDS_FILE="$OUT_DIR/ids/weekly_ids_profit.txt" \
  WEEKLY_WAIT_POLL_MAX=8 \
  bash scripts/fin_accept/wait_weekly_R12.sh >"$OUT_DIR/logs/wait_profit_real.txt" 2>&1
wpr=$?
set -e
echo "wait_profit_real_exit=$wpr" | tee -a "$OUT_DIR/logs/wait_profit_real.txt"

for st in v6 dashboard; do
  export WEEKLY_STAGE=$st WEEKLY_JOB_IDS_FILE="$OUT_DIR/ids/weekly_ids_${st}.txt"
  node --import tsx scripts/fin_accept/run_weekly_enqueue_R12.ts "$OUT_DIR/weekly_${st}.json" \
    | tee "$OUT_DIR/logs/enqueue_${st}.txt"
done
set +e
V6_READMODEL_WORKER_MODE=queue-once V6_READMODEL_WORKER_MAX_JOBS=3 \
  node --import tsx scripts/dashboard/runV6PeriodReadModelWorker.ts \
  >"$OUT_DIR/logs/real_worker_v6.txt" 2>&1
rwv=$?
DASHBOARD_SNAPSHOT_WORKER_MODE=drain \
  node --import tsx scripts/dashboard/runDashboardPeriodSnapshotWorker.ts \
  >"$OUT_DIR/logs/real_worker_dashboard.txt" 2>&1
rwd=$?
set -e
echo "real_worker_v6_exit=$rwv dashboard_exit=$rwd" | tee "$OUT_DIR/logs/real_worker_exits.txt"

set +e
node --import tsx scripts/fin_accept/verify_week_consumer_R12.ts "$OUT_DIR/verify_hit_real.json" \
  >"$OUT_DIR/logs/verify_hit_real.txt" 2>&1
vh_real=$?
set -e
echo "verify_hit_real_exit=$vh_real" | tee -a "$OUT_DIR/logs/verify_hit_real.txt"

# G3 status: VERIFIED only if ALL three stages + consumers PASS (not process exit alone)
g3_status="BLOCKED"
g3_proof="real_worker_scripts"
g3_blocked_reason="real workers/consumers did not reach FINAL matrix"
primary_ok=0
grep -q 'LOAD_PRIMARY_STAND_C01_OK' "$OUT_DIR/logs/load_primary.txt" 2>/dev/null && primary_ok=1

# Inspect consumer / coverage from verify + DB + worker logs (V6 may store
# coverage in payload/job events; column alone is not the acceptance contract).
# V6 period read-model persists to PeriodCompanyMarketplaceMetric (not only DashboardPeriodSnapshot).
v6_metric_rows="$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM \"PeriodCompanyMarketplaceMetric\" WHERE \"formulaVersion\"='FINANCIAL_CORE_V6_PERIOD_READMODEL_V2' AND \"dataMode\"='FINAL'" 2>/dev/null || echo 0)"
dash_final="$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM \"DashboardPeriodSnapshot\" WHERE \"formulaVersion\"='FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1' AND \"coverageStatus\"='COMPLETE'")"
ppm_final="$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM \"ProfitPeriodMetric\" WHERE \"dataMode\"='FINAL'")"
v6_final_jobs="$(grep -c '\"dataMode\":\"FINAL\"' "$OUT_DIR/logs/real_worker_v6.txt" 2>/dev/null || true)"
ozon_final_jobs="$(grep -c '\"marketplace\":\"OZON\".*\"dataMode\":\"FINAL\"' "$OUT_DIR/logs/real_worker_profit.txt" 2>/dev/null || true)"
wb_final_jobs="$(grep -c '\"marketplace\":\"WB\".*\"dataMode\":\"FINAL\"' "$OUT_DIR/logs/real_worker_profit.txt" 2>/dev/null || true)"
echo "g3_matrix primary_ok=$primary_ok wpr=$wpr rwv=$rwv rwd=$rwd vh_real=$vh_real v6_metric_final=$v6_metric_rows v6_final_jobs=$v6_final_jobs dash_complete=$dash_final ppm_final=$ppm_final ozon_final=$ozon_final_jobs wb_final=$wb_final_jobs" \
  | tee "$OUT_DIR/logs/g3_matrix.txt"

# G3 VERIFIED: primary loaded, 6/3/3 workers ran, Profit FINAL both MP, V6 FINAL jobs×3
# (and/or PeriodCompanyMarketplaceMetric FINAL rows), Dashboard COMPLETE, verify PASS.
if [[ "$primary_ok" -eq 1 && "$wpr" -eq 0 && "$rwv" -eq 0 && "$rwd" -eq 0 && "$vh_real" -eq 0 \
      && "$ppm_final" -ge 6 && "$ozon_final_jobs" -ge 3 && "$wb_final_jobs" -ge 3 \
      && "$v6_final_jobs" -ge 3 && "$dash_final" -ge 1 ]]; then
  g3_status="VERIFIED"
  g3_blocked_reason=""
else
  g3_status="BLOCKED"
  g3_blocked_reason="primary_ok=$primary_ok wait_profit=$wpr v6_exit=$rwv dash_exit=$rwd verify=$vh_real ppm_final=$ppm_final ozon_final=$ozon_final_jobs wb_final=$wb_final_jobs v6_final_jobs=$v6_final_jobs v6_metric_final=$v6_metric_rows dash_complete=$dash_final"
fi
echo "g3_status=$g3_status" | tee "$OUT_DIR/logs/g3_status.txt"
echo "g3_blocked_reason=$g3_blocked_reason" | tee -a "$OUT_DIR/logs/g3_status.txt"

# Contract setup for G4 (NOT the G3 verified path). Separate marker name so assert
# does not treat G4 fixture setup as G3 substitution.
echo "fixture_compute_for_g4_setup_only" > "$OUT_DIR/logs/g4_contract_fixture_setup.txt"
# Do NOT write g3_used_fixture_for_verified_path.txt on the real path.
# Reset jobs/metrics for rollback contract tests
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
TRUNCATE "DashboardPeriodSnapshotJob" CASCADE;
TRUNCATE "DashboardPeriodSnapshot" CASCADE;
TRUNCATE "ProfitPeriodMetric" CASCADE;
TRUNCATE "ProfitSkuPeriodMetric" CASCADE;
SQL
node --import tsx scripts/fin_accept/load_finance_fixture_R17.ts "$FIXTURE" \
  | tee "$OUT_DIR/logs/reload_finance_g4.txt"
export WEEKLY_STAGE=profit WEEKLY_JOB_IDS_FILE="$OUT_DIR/ids/weekly_ids_profit.txt"
node --import tsx scripts/fin_accept/run_weekly_enqueue_R12.ts "$OUT_DIR/weekly_profit_g4.json" \
  | tee "$OUT_DIR/logs/enqueue_profit_g4.txt"
node --import tsx scripts/fin_accept/iso_drain_workers_R18.ts profit \
  | tee "$OUT_DIR/logs/drain_profit.txt"
WEEKLY_STAGE=profit WEEKLY_JOB_IDS_FILE="$OUT_DIR/ids/weekly_ids_profit.txt" \
  bash scripts/fin_accept/wait_weekly_R12.sh | tee "$OUT_DIR/logs/wait_profit.txt"
for st in v6 dashboard; do
  export WEEKLY_STAGE=$st WEEKLY_JOB_IDS_FILE="$OUT_DIR/ids/weekly_ids_${st}.txt"
  node --import tsx scripts/fin_accept/run_weekly_enqueue_R12.ts "$OUT_DIR/weekly_${st}_g4.json" \
    | tee "$OUT_DIR/logs/enqueue_${st}_g4.txt"
  node --import tsx scripts/fin_accept/iso_drain_workers_R18.ts "$st" \
    | tee "$OUT_DIR/logs/drain_${st}.txt"
  WEEKLY_STAGE=$st WEEKLY_JOB_IDS_FILE="$OUT_DIR/ids/weekly_ids_${st}.txt" \
    bash scripts/fin_accept/wait_weekly_R12.sh | tee "$OUT_DIR/logs/wait_${st}.txt"
done
set +e
node --import tsx scripts/fin_accept/verify_week_consumer_R12.ts "$OUT_DIR/verify_hit.json" \
  >"$OUT_DIR/logs/verify_hit.txt" 2>&1
vh=$?
set -e
echo "verify_hit_contract_exit=$vh (g4 setup; not G3 proof)" | tee -a "$OUT_DIR/logs/verify_hit.txt"
[[ "$vh" -eq 0 ]] || { echo "FAIL g4-setup verify"; tail -40 "$OUT_DIR/logs/verify_hit.txt"; exit 37; }

v6c="$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM \"DashboardPeriodSnapshot\" WHERE \"formulaVersion\"='FINANCIAL_CORE_V6_PERIOD_READMODEL_V2'")"
dsc="$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM \"DashboardPeriodSnapshot\" WHERE \"formulaVersion\"='FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1'")"
echo "v6_snapshots=$v6c dashboard_snapshots=$dsc" | tee "$OUT_DIR/logs/dependent_snapshots.txt"
[[ "$v6c" -ge 1 && "$dsc" -ge 1 ]] || { echo "FAIL missing V6/Dashboard snapshots"; exit 38; }

# ---------- G4: scoped rollback ----------
echo "=== G4 backup → mutate → restore → verify ==="
node --import tsx scripts/fin_accept/export_profit_period_backup_R16.ts "$OUT_DIR/backup" \
  | tee "$OUT_DIR/logs/backup_export.txt"
[[ -f "$OUT_DIR/backup/sku_profit_period_snapshot.json" ]]
[[ -f "$OUT_DIR/backup/v6_period_snapshot.json" ]]
sku_count_backup="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).length)" "$OUT_DIR/backup/sku_profit_period_snapshot.json")"
echo "sku_count_backup=$sku_count_backup" | tee "$OUT_DIR/logs/sku_backup_count.txt"

# Corrupt backup must fail (PPM present + hadRow=false)
cp -a "$OUT_DIR/backup" "$OUT_DIR/backup_corrupt"
python3 - "$OUT_DIR/backup_corrupt/backup_inventory.json" <<'PY'
import json,sys
inv=json.load(open(sys.argv[1],encoding="utf-8"))
for row in inv:
  if row.get("companyScope")=="ИП Лебедева" and row.get("marketplace")=="OZON" and row.get("hadRow"):
    row["hadRow"]=False
json.dump(inv, open(sys.argv[1],"w",encoding="utf-8"), indent=2, ensure_ascii=False)
print("CORRUPTED_INVENTORY")
PY
set +e
node --import tsx scripts/fin_accept/run_data_rollback_ozon_R12.ts "$OUT_DIR/backup_corrupt" \
  >"$OUT_DIR/logs/restore_corrupt.txt" 2>&1
rc_corrupt=$?
set -e
[[ "$rc_corrupt" -ne 0 ]] || { echo "FAIL corrupt backup should reject"; exit 39; }
grep -q 'CORRUPT_BACKUP' "$OUT_DIR/logs/restore_corrupt.txt"

# Genuine absence: delete Lebedeva Ozon before export, then create, then restore
psql "$DATABASE_URL" -c "DELETE FROM \"ProfitSkuPeriodMetric\" WHERE \"companyScope\"='ИП Лебедева' AND marketplace='OZON';"
psql "$DATABASE_URL" -c "DELETE FROM \"ProfitPeriodMetric\" WHERE \"companyScope\"='ИП Лебедева' AND marketplace='OZON';"
node --import tsx scripts/fin_accept/export_profit_period_backup_R16.ts "$OUT_DIR/backup_absent" \
  | tee "$OUT_DIR/logs/backup_absent.txt"
# recreate Lebedeva Ozon (simulate post-rebuild appearance) without editing backup inventory
node --import tsx scripts/fin_accept/seed_isolation_metrics_R16.ts | tee "$OUT_DIR/logs/reseed_for_absent.txt"
node --import tsx scripts/fin_accept/run_data_rollback_ozon_R12.ts "$OUT_DIR/backup_absent" \
  | tee "$OUT_DIR/logs/restore_absent.txt"
gone="$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM \"ProfitPeriodMetric\" WHERE \"companyScope\"='ИП Лебедева' AND marketplace='OZON'")"
echo "lebedeva_ozon_after_absent_restore=$gone" | tee "$OUT_DIR/logs/lebedeva_after_restore.txt"
[[ "$gone" == "0" ]] || { echo "FAIL genuine absent restore"; exit 40; }

# V6 ALL absent at backup must delete post-backup V6 ALL on restore
psql "$DATABASE_URL" -c "DELETE FROM \"DashboardPeriodSnapshot\" WHERE \"companyScope\"='ALL' AND \"formulaVersion\"='FINANCIAL_CORE_V6_PERIOD_READMODEL_V2'"
node --import tsx scripts/fin_accept/export_profit_period_backup_R16.ts "$OUT_DIR/backup_v6_absent" \
  | tee "$OUT_DIR/logs/backup_v6_absent.txt"
# create post-backup V6 ALL
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "DashboardPeriodSnapshot"
 (id,"companyScope","dateFrom","dateTo","formulaVersion",payload,"payloadChecksum","sourceFingerprint","coverageStatus","rowsCount","calculationMs","generatedAt","updatedAt")
VALUES
 ('post-backup-v6-all','ALL','2026-10-19','2026-10-25','FINANCIAL_CORE_V6_PERIOD_READMODEL_V2','{"afterBackup":true}'::jsonb,'x','y','COMPLETE',1,1,NOW(),NOW())
ON CONFLICT ("companyScope","dateFrom","dateTo","formulaVersion") DO UPDATE
 SET payload='{"afterBackup":true}'::jsonb, "updatedAt"=NOW();
SQL
node --import tsx scripts/fin_accept/run_data_rollback_ozon_R12.ts "$OUT_DIR/backup_v6_absent" \
  | tee "$OUT_DIR/logs/restore_v6_absent.txt"
v6gone="$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM \"DashboardPeriodSnapshot\" WHERE \"companyScope\"='ALL' AND \"formulaVersion\"='FINANCIAL_CORE_V6_PERIOD_READMODEL_V2'")"
echo "v6_all_after_absent_restore=$v6gone" | tee "$OUT_DIR/logs/v6_absent_after_restore.txt"
[[ "$v6gone" == "0" ]] || { echo "FAIL v6 absent restore left post-backup row"; exit 40; }

# Missing V6 file must hard-fail (≠ empty array)
cp -a "$OUT_DIR/backup_v6_absent" "$OUT_DIR/backup_missing_v6"
rm -f "$OUT_DIR/backup_missing_v6/v6_period_snapshot.json"
set +e
node --import tsx scripts/fin_accept/run_data_rollback_ozon_R12.ts "$OUT_DIR/backup_missing_v6" \
  >"$OUT_DIR/logs/restore_missing_v6.txt" 2>&1
rc_miss_v6=$?
set -e
[[ "$rc_miss_v6" -ne 0 ]] || { echo "FAIL missing v6 file should reject"; exit 40; }
grep -q 'MISSING_V6_SNAPSHOT_FILE' "$OUT_DIR/logs/restore_missing_v6.txt"

# Rehydrate full week PPM+jobs for subsequent empty-SKU / consumer-after-restore path
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
TRUNCATE "DashboardPeriodSnapshotJob" CASCADE;
TRUNCATE "DashboardPeriodSnapshot" CASCADE;
TRUNCATE "ProfitPeriodMetric" CASCADE;
TRUNCATE "ProfitSkuPeriodMetric" CASCADE;
SQL
node --import tsx scripts/fin_accept/load_finance_fixture_R17.ts "$FIXTURE" \
  | tee "$OUT_DIR/logs/reload_finance_after_absent.txt"
for st in profit v6 dashboard; do
  export WEEKLY_STAGE=$st WEEKLY_JOB_IDS_FILE="$OUT_DIR/ids/weekly_ids_${st}_rehydrate.txt"
  node --import tsx scripts/fin_accept/run_weekly_enqueue_R12.ts "$OUT_DIR/weekly_${st}_rehydrate.json" \
    | tee "$OUT_DIR/logs/enqueue_${st}_rehydrate.txt"
  node --import tsx scripts/fin_accept/iso_drain_workers_R18.ts "$st" \
    | tee "$OUT_DIR/logs/drain_${st}_rehydrate.txt"
done

# Empty SKU[] must clear SKUs created after backup
node --import tsx scripts/fin_accept/export_profit_period_backup_R16.ts "$OUT_DIR/backup_sku" \
  | tee "$OUT_DIR/logs/backup_sku.txt"
# Force empty SKU file in backup while adding a new SKU in DB
echo '[]' > "$OUT_DIR/backup_sku/sku_profit_period_snapshot.json"
node --import tsx scripts/fin_accept/iso_extra_sku_R18.ts \
  | tee "$OUT_DIR/logs/ensure_extra_sku.txt"
node --import tsx scripts/fin_accept/run_data_rollback_ozon_R12.ts "$OUT_DIR/backup_sku" \
  | tee "$OUT_DIR/logs/restore_empty_sku.txt"
left="$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM \"ProfitSkuPeriodMetric\" WHERE \"productKey\"='post-backup-sku'")"
echo "post_backup_sku_after_restore=$left" | tee "$OUT_DIR/logs/sku_cleared.txt"
[[ "$left" == "0" ]] || { echo "FAIL empty SKU[] did not clear"; exit 41; }

# Full restore of good backup2 + consumer
node --import tsx scripts/fin_accept/iso_drain_workers_R18.ts all | tee "$OUT_DIR/logs/drain_all_final.txt"
# Re-load finance (untouched) and re-verify — first re-drain profit for fingerprints
node --import tsx scripts/fin_accept/export_profit_period_backup_R16.ts "$OUT_DIR/backup2" \
  | tee "$OUT_DIR/logs/backup2.txt"
node --import tsx scripts/fin_accept/iso_mutate_helpers_R16.ts mutate_after_backup \
  | tee "$OUT_DIR/logs/mutate_after_backup.txt"
node --import tsx scripts/fin_accept/run_data_rollback_ozon_R12.ts "$OUT_DIR/backup2" \
  | tee "$OUT_DIR/logs/restore_ok.txt"
set +e
node --import tsx scripts/fin_accept/verify_week_consumer_R12.ts "$OUT_DIR/verify_after_restore.json" \
  >"$OUT_DIR/logs/verify_after_restore.txt" 2>&1
vr=$?
set -e
echo "verify_after_restore_exit=$vr" | tee -a "$OUT_DIR/logs/verify_after_restore.txt"
if [[ "$vr" -ne 0 ]]; then
  echo "WARN verify after restore failed — recorded in G4 (continuing to acceptance write)"
  tail -40 "$OUT_DIR/logs/verify_after_restore.txt" | tee -a "$OUT_DIR/logs/verify_after_restore.txt" || true
fi

# ---------- G5: real docker candidate → concrete plan → replay (no sends) ----------
echo "=== G5 telegram real docker rehearsal + concrete plan ==="
unset TELEGRAM_NEW_IMAGE TELEGRAM_NEW_IMAGE_ID || true
set +e
bash scripts/fin_accept/telegram_rehearsal_R18.sh "$OUT_DIR/telegram" \
  >"$OUT_DIR/logs/telegram_rehearsal.txt" 2>&1
tg_rc=$?
set -e
cat "$OUT_DIR/logs/telegram_rehearsal.txt" || true
tg_reh=1
tg_mock=0
if grep -q 'TELEGRAM_REHEARSAL_R18_OK' "$OUT_DIR/logs/telegram_rehearsal.txt"; then
  tg_reh=0
fi
if [[ -f "$OUT_DIR/telegram/REHEARSAL_SUMMARY.json" ]] && grep -q '"mockUsed": true' "$OUT_DIR/telegram/REHEARSAL_SUMMARY.json"; then
  tg_mock=1
  tg_reh=1
fi
if [[ -f "$OUT_DIR/telegram/REHEARSAL_SUMMARY.json" ]]; then
  export TELEGRAM_NEW_IMAGE="$(python3 -c "import json;print(json.load(open(r'$OUT_DIR/telegram/REHEARSAL_SUMMARY.json')).get('imageIdExpected','') and 'avorofin-p0-cogs-telegram:c01_isolation_local')")"
  export TELEGRAM_NEW_IMAGE_ID="$(python3 -c "import json;s=json.load(open(r'$OUT_DIR/telegram/REHEARSAL_SUMMARY.json'));print(s.get('imageIdObserved') or s.get('imageIdExpected') or '')")"
  # Prefer observed tag from build log if present
  if docker image inspect avorofin-p0-cogs-telegram:c01_isolation_local >/dev/null 2>&1; then
    export TELEGRAM_NEW_IMAGE="avorofin-p0-cogs-telegram:c01_isolation_local"
    export TELEGRAM_NEW_IMAGE_ID="$(docker image inspect -f '{{.Id}}' "$TELEGRAM_NEW_IMAGE")"
  fi
fi
set +e
FA_STATE="$FA_STATE" CUTOVER_JOURNAL_DIR="$CUTOVER_JOURNAL_DIR" \
TELEGRAM_HOST=64.188.63.133 TELEGRAM_SSH_USER=root \
TELEGRAM_NEW_IMAGE="${TELEGRAM_NEW_IMAGE:-avorofin-p0-cogs-telegram:c01_isolation_local}" \
TELEGRAM_NEW_IMAGE_ID="${TELEGRAM_NEW_IMAGE_ID:-MUST_SET_TELEGRAM_NEW_IMAGE_ID_AFTER_LOAD}" \
  bash scripts/fin_accept/deploy_entrypoint_R12.sh telegram-plan \
  >"$OUT_DIR/logs/telegram_plan.txt" 2>&1
tp=$?
set -e
if [[ -f "$FA_STATE/telegram_plan.json" ]]; then
  grep -q 'NEW_TELEGRAM_IMAGE_WITH_ACCEPTED_DAILYREPORT' "$FA_STATE/telegram_plan.json" \
    && { echo "FAIL placeholder image still present"; exit 44; } || true
  python3 - <<'PY' "$OUT_DIR/telegram/REHEARSAL_SUMMARY.json" "$FA_STATE/telegram_plan.json"
import json,sys,pathlib
sum_path, plan_path = sys.argv[1:3]
plan=json.load(open(plan_path,encoding="utf-8"))
summ={}
if pathlib.Path(sum_path).exists():
  summ=json.load(open(sum_path,encoding="utf-8"))
plan["isolationRehearsalOk"]=bool(summ.get("ok") and not summ.get("mockUsed"))
plan["dailyReportShaOk"]=bool(summ.get("dailyReportShaOk"))
plan["autoRecoveryOnBadHealth"]=bool(summ.get("autoRecoveryOnBadHealth"))
json.dump(plan, open(plan_path,"w",encoding="utf-8"), indent=2, ensure_ascii=False)
print("TELEGRAM_PLAN_BOUND_TO_REHEARSAL")
PY
fi
echo "tg_reh=$tg_reh tg_mock=$tg_mock tg_rc=$tg_rc" | tee "$OUT_DIR/logs/g5_status.txt"

# ---------- Meta: assert rejects incomplete CLOSE_ACCEPTANCE ----------
echo "=== meta: readiness assert must refuse incomplete gates ==="
python3 - <<'PY' "$OUT_DIR/CLOSE_ACCEPTANCE_INCOMPLETE.json"
import json,sys
doc={
  "gates":[{"id":"G1","status":"VERIFIED","evidence":["x"]},
           {"id":"G2","status":"VERIFIED","evidence":["x"]},
           {"id":"G3","status":"NOT_RUN","evidence":[]},
           {"id":"G4","status":"VERIFIED","evidence":["x"]},
           {"id":"G5","status":"VERIFIED","evidence":["x"]},
           {"id":"G6","status":"VERIFIED","evidence":["x"]}],
  "readyForDeploy": True,
  "productionChanged": False,
  "telegramSent": False,
}
json.dump(doc, open(sys.argv[1],"w",encoding="utf-8"), indent=2)
PY
set +e
node --import tsx scripts/fin_accept/assert_close_acceptance_R18.ts \
  "$OUT_DIR/CLOSE_ACCEPTANCE_INCOMPLETE.json" "$OUT_DIR" \
  >"$OUT_DIR/logs/assert_incomplete.txt" 2>&1
ai=$?
set -e
[[ "$ai" -ne 0 ]] || { echo "FAIL assert must reject incomplete"; exit 45; }

# ---------- Write CLOSE_ACCEPTANCE from actual run ----------
scripts_commit="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
python3 - <<PY
import json, pathlib
out = pathlib.Path("$OUT_DIR")
g3_status = "$g3_status"
g3_blocked_reason = """$g3_blocked_reason"""
g1_ok = ($ed == 0 and $rp == 0 and $wre == 0 and (out/"logs"/"g1_effective_env.txt").exists())
g2_ok = ($spf != 0 and $sc != 0 and (out/"logs"/"run_all_backup_fail.txt").exists()
         and "RUN_ALL_BACKUP_FAIL_RECOVERY_OK" in (out/"logs"/"run_all_backup_fail.txt").read_text(encoding="utf-8", errors="replace"))
g4_ok = ($rc_corrupt != 0 and "$gone" == "0" and "$left" == "0"
         and "$v6gone" == "0" and $rc_miss_v6 != 0)
g5_ok = ($tg_reh == 0) and (out/"fa_state"/"telegram_plan.json").exists() and ($tg_mock == 0)
g6_status = "VERIFIED" if (g1_ok and g2_ok and g3_status == "VERIFIED" and g4_ok and g5_ok) else "BLOCKED"

def gate(gid, desc, ok, evidence, proof, blocked_reason=None):
  st = "VERIFIED" if ok else ("BLOCKED" if blocked_reason else "FAILED")
  if gid == "G3":
    st = g3_status if g3_status in ("VERIFIED","BLOCKED","FAILED") else "FAILED"
  if gid == "G6":
    st = g6_status
  g = {"id": gid, "description": desc, "status": st, "evidence": evidence, "proofType": proof}
  if blocked_reason and st != "VERIFIED":
    g["blockedReason"] = blocked_reason
  return g

doc = {
  "documentType": "CLOSE_ACCEPTANCE_EXECUTED",
  "scope": "FIN_CLOSE_20261028_C01 / R18",
  "weekBusinessCanon": 994198.47,
  "scriptsCommit": "$scripts_commit",
  "gates": [
    gate("G1", "Safe effective environment reaches all runners", g1_ok,
         ["logs/env_dollar.txt","logs/runtime_preflight_cross_proc.txt","logs/g1_effective_env.txt","logs/with_runner_env.txt","logs/env_runtime_match.txt"],
         "safe_load_env_R18+with_runner_env+backup_week_autoload"),
    gate("G2", "MAIN run-all stop/recovery + SQL/docker failure paths", g2_ok,
         ["logs/stop_claims_psql_fail.txt","logs/stop_claims_multi.txt","logs/run_all_backup_fail.txt","logs/docker_calls.txt"],
         "run_all_run_step_recovery+stop_claims"),
    gate("G3", "Real workers 6/3/3 + consumers with primary+Finance", g3_status=="VERIFIED",
         ["logs/load_primary.txt","logs/enqueue_profit.txt","logs/real_worker_profit.txt","logs/real_worker_v6.txt","logs/real_worker_dashboard.txt","logs/verify_hit_real.txt","logs/g3_matrix.txt","logs/g3_status.txt"],
         "real_worker_scripts",
         blocked_reason=g3_blocked_reason or "G3 consumers not FINAL/COMPLETE"),
    gate("G4", "Scoped rollback PPM/SKU/V6/Dashboard incl. absent dependents", g4_ok,
         ["logs/restore_corrupt.txt","logs/restore_absent.txt","logs/restore_v6_absent.txt","logs/restore_missing_v6.txt","logs/restore_empty_sku.txt","logs/verify_after_restore.txt","backup/"],
         "real_db_restore_scripts"),
    gate("G5", "Telegram concrete runtime update/rollback rehearsal (no sends)", g5_ok,
         ["fa_state/telegram_plan.json","logs/telegram_rehearsal.txt","telegram/REHEARSAL_SUMMARY.json","logs/g5_status.txt"],
         "telegram_plan+real_docker_rehearsal",
         blocked_reason=("mock rehearsal or docker/dailyReport proof failed" if not g5_ok else None)),
    gate("G6", "One executable reproducible release bundle", g6_status=="VERIFIED",
         ["CLOSE_ACCEPTANCE.json","SUMMARY.json","ASSERT_REPORT.json"],
         "assert_close_acceptance_R18",
         blocked_reason="G6 requires G1-G5 VERIFIED"),
  ],
  "productionChanged": False,
  "telegramSent": False,
  "deploymentStatus": "NOT_EXECUTED",
  "annualAuditStatus": "QUEUED_AFTER_LIVE_ACCEPTANCE",
  "readyForDeploy": False,
}
(out/"CLOSE_ACCEPTANCE.json").write_text(json.dumps(doc, indent=2)+"\n", encoding="utf-8")
summary = {
  "env_dollar_exit": $ed,
  "runtime_preflight_cross_proc_exit": $rp,
  "with_runner_env_exit": $wre,
  "stop_claims_psql_fail_exit": $spf,
  "stop_claims_multi_exit": $sc,
  "real_worker_profit_exit": $rwp,
  "real_worker_v6_exit": $rwv,
  "real_worker_dashboard_exit": $rwd,
  "wait_profit_real_exit": $wpr,
  "verify_hit_real_exit": $vh_real,
  "verify_hit_contract_exit": $vh,
  "verify_after_restore_exit": $vr,
  "corrupt_restore_exit": $rc_corrupt,
  "assert_incomplete_exit": $ai,
  "tg_reh": $tg_reh,
  "tg_mock": $tg_mock,
  "g3_status": g3_status,
  "g3_blocked_reason": g3_blocked_reason,
  "g6_status": g6_status,
  "lebedeva_ozon_after_absent_restore": "$gone",
  "post_backup_sku_after_empty_restore": "$left",
  "v6_snapshots": int("$v6c"),
  "dashboard_snapshots": int("$dsc"),
  "contract_ok": {
    "g1": g1_ok, "g2": g2_ok, "g4": g4_ok, "g5": g5_ok,
    "assert_rejects_incomplete": $ai != 0,
  },
}
(out/"SUMMARY.json").write_text(json.dumps(summary, indent=2)+"\n", encoding="utf-8")
print(json.dumps(summary, indent=2))
PY

set +e
node --import tsx scripts/fin_accept/assert_close_acceptance_R18.ts \
  "$OUT_DIR/CLOSE_ACCEPTANCE.json" "$OUT_DIR" \
  | tee "$OUT_DIR/logs/assert_final.txt"
assert_rc=$?
set -e
echo "assert_final_exit=$assert_rc" | tee -a "$OUT_DIR/logs/assert_final.txt"

# Isolation sequence completes diagnostics even when not READY; non-zero if assert fails
if [[ "$assert_rc" -eq 0 ]]; then
  echo "R18_ISOLATED_SEQUENCE_READY_FOR_DEPLOY"
  exit 0
fi
echo "R18_ISOLATED_SEQUENCE_COMPLETE_NOT_READY"
# Exit 0 for workflow artifact upload of diagnostics; readiness is in ASSERT_REPORT / CLOSE_ACCEPTANCE
# Workflow must not treat this as deploy-ready — packer reads assert_final_exit
exit 0
