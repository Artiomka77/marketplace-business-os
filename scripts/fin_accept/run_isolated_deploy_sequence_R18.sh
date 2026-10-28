#!/usr/bin/env bash
# R18/C01 isolated full pass — real claim/produce workers, Finance fixture, rollback.
# No SQL status=SUCCESS for the positive path. Disposable target only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

: "${DATABASE_URL:?DATABASE_URL required (ephemeral)}"
if echo "$DATABASE_URL" | grep -Eiq '72\.56\.4\.62|ardelo|prod'; then
  echo "REFUSE production-looking DATABASE_URL"; exit 3
fi
export WAVE_B_PROFIT_TARGET_DATABASE_URL="${WAVE_B_PROFIT_TARGET_DATABASE_URL:-$DATABASE_URL}"
export V6_READMODEL_TARGET_DATABASE_URL="${V6_READMODEL_TARGET_DATABASE_URL:-$DATABASE_URL}"
export WAVE_B_TARGET_DB_MODE="${WAVE_B_TARGET_DB_MODE:-SAME_PRODUCTION_DB}"
export WEEKLY_REQUIRE_SAME_TARGETS=1
export DATE_FROM=2026-10-19 DATE_TO=2026-10-25
export WEEKLY_WAIT_POLL_MAX="${WEEKLY_WAIT_POLL_MAX:-20}"
export WEEKLY_WAIT_POLL_SLEEP="${WEEKLY_WAIT_POLL_SLEEP:-1}"
export STOP_CLAIMS_WAIT_MAX="${STOP_CLAIMS_WAIT_MAX:-2}"
export STOP_CLAIMS_WAIT_SLEEP="${STOP_CLAIMS_WAIT_SLEEP:-1}"

OUT_DIR="${R18_ISOLATION_OUT:-$ROOT/R18_isolation_out}"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"/{ids,backup,env,logs,fa_state,mockbin,telegram}
export WEEKLY_JOB_IDS_DIR="$OUT_DIR/ids"
export FA_STATE="$OUT_DIR/fa_state"
export WEEK_BACKUP_DIR="$OUT_DIR/backup"
export ENV_CAPTURE_DIR="$OUT_DIR/env"
export RUNNER_ENV_EXPORT_FILE="$FA_STATE/runner.env"
FIXTURE="${FINANCE_ADAPTER_FIXTURE:-$ROOT/scripts/fin_accept/fixtures/FINANCE_ADAPTER_ROWS.json}"

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

echo "=== load Finance fixture ==="
[[ -f "$FIXTURE" ]] || { echo "missing fixture $FIXTURE"; exit 2; }
node --import tsx scripts/fin_accept/load_finance_fixture_R17.ts "$FIXTURE" \
  | tee "$OUT_DIR/logs/load_finance.txt"

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

bash scripts/fin_accept/compare_main_env_keys_R12.sh \
  "$OUT_DIR/env/profit.captured.env" "$OUT_DIR/env/profit.expected.env" \
  | tee "$OUT_DIR/logs/env_runtime_match.txt"

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
  || { echo "FAIL missing psql error signal"; exit 34; }

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

# G3 status: VERIFIED only if real workers completed matrix + consumer PASS
g3_status="BLOCKED"
g3_proof="real_worker_scripts"
if [[ "$wpr" -eq 0 && "$vh_real" -eq 0 ]]; then
  g3_status="VERIFIED"
fi
echo "g3_status=$g3_status" | tee "$OUT_DIR/logs/g3_status.txt"

# Contract setup for G4/G5 (NOT counted as G3 VERIFIED — fixture compute marker)
echo "fixture_compute_for_g4_setup_only" > "$OUT_DIR/logs/g3_used_fixture_compute.txt"
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

# Empty SKU[] must clear SKUs created after backup
node --import tsx scripts/fin_accept/iso_drain_workers_R18.ts profit | tee "$OUT_DIR/logs/drain_for_sku.txt"
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
[[ "$vr" -eq 0 ]] || { echo "FAIL verify after restore"; tail -40 "$OUT_DIR/logs/verify_after_restore.txt"; exit 42; }

# ---------- G5: telegram plan + isolated rehearsal ----------
echo "=== G5 telegram plan + mock rehearsal ==="
export TELEGRAM_NEW_IMAGE="avorofin-p0-cogs-telegram:20261014_tg_top_truth"
export TELEGRAM_NEW_IMAGE_ID="sha256:7f9fee6a7e5f5595d6895d892d37dd218e5e2cb62ebf86a5b048ee15a1132453"
# Force SSH unavailable in CI — generator must still write JSON without NameError
set +e
FA_STATE="$FA_STATE" TELEGRAM_HOST=127.0.0.1 TELEGRAM_SSH_USER=nobody \
  bash scripts/fin_accept/deploy_entrypoint_R12.sh telegram-plan \
  >"$OUT_DIR/logs/telegram_plan.txt" 2>&1
tp=$?
set -e
[[ -f "$FA_STATE/telegram_plan.json" ]] || { echo "FAIL telegram_plan.json missing"; cat "$OUT_DIR/logs/telegram_plan.txt"; exit 43; }
grep -q 'NEW_TELEGRAM_IMAGE_WITH_ACCEPTED_DAILYREPORT' "$FA_STATE/telegram_plan.json" \
  && { echo "FAIL placeholder image still present"; exit 44; } || true
python3 - <<'PY' "$FA_STATE/telegram_plan.json" "$OUT_DIR/telegram/rehearsal.json"
import json,sys,pathlib
plan=json.load(open(sys.argv[1],encoding="utf-8"))
assert "commands_update_AFTER_MAIN_VERIFY" in plan
assert all("NEW_TELEGRAM_IMAGE" not in c for c in plan["commands_update_AFTER_MAIN_VERIFY"])
assert plan["newRuntime"]["image"].startswith("avorofin-p0-cogs-telegram")
# Isolated rehearsal checklist (no real send)
reh={
  "imageInspectBeforeStop": True,
  "envCaptured": True,
  "rollbackTag": "avorofin-p0-cogs-telegram:rollback_pre_c01",
  "healthWithoutOrTrue": True,
  "sendMessages": False,
  "commands": plan["commands_update_AFTER_MAIN_VERIFY"],
  "rollback": plan["commands_rollback"],
}
pathlib.Path(sys.argv[2]).write_text(json.dumps(reh,indent=2)+"\n",encoding="utf-8")
print("TELEGRAM_REHEARSAL_PLAN_OK")
PY

# Mock docker telegram health rehearsal
bash scripts/fin_accept/telegram_rehearsal_R18.sh "$OUT_DIR/telegram" \
  | tee "$OUT_DIR/logs/telegram_rehearsal.txt"
tg_reh=0
grep -q 'TELEGRAM_REHEARSAL_R18_OK' "$OUT_DIR/logs/telegram_rehearsal.txt" || tg_reh=1

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
g1_ok = ($ed == 0 and $rp == 0)
g2_ok = ($spf != 0 and $sc != 0)
g4_ok = ($rc_corrupt != 0 and "$gone" == "0" and "$left" == "0" and $vr == 0)
g5_ok = ($tg_reh == 0) and (out/"fa_state"/"telegram_plan.json").exists()
# G6 = reproducible bundle only after G1-G5 VERIFIED
g6_status = "VERIFIED" if (g1_ok and g2_ok and g3_status == "VERIFIED" and g4_ok and g5_ok) else "BLOCKED"
if g3_status != "VERIFIED":
  g6_status = "BLOCKED"

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
         ["logs/env_dollar.txt","logs/runtime_preflight_cross_proc.txt","logs/env_runtime_match.txt"],
         "safe_load_env_R18+runtime_preflight"),
    gate("G2", "MAIN stop/recovery on SQL/docker failure", g2_ok,
         ["logs/stop_claims_psql_fail.txt","logs/stop_claims_multi.txt","logs/docker_calls.txt"],
         "mock_docker+real_psql_error_path"),
    gate("G3", "Real workers 6/3/3 + consumers with Finance", g3_status=="VERIFIED",
         ["logs/enqueue_profit.txt","logs/real_worker_profit.txt","logs/verify_hit_real.txt","logs/g3_status.txt"],
         "real_worker_scripts",
         blocked_reason=("Disposable GHA lacks marketplace primary fixtures; real workers ran but "
                         "wait/verify did not PASS FINAL canon. Continue: load WEEK_FINAL primary into "
                         "ephemeral DB then re-run run_isolated_deploy_sequence_R18.sh")),
    gate("G4", "Scoped rollback PPM/SKU/V6/Dashboard", g4_ok,
         ["logs/restore_corrupt.txt","logs/restore_absent.txt","logs/restore_empty_sku.txt","logs/verify_after_restore.txt","backup/"],
         "real_db_restore_scripts"),
    gate("G5", "Telegram plan + isolated rehearsal without sends", g5_ok,
         ["fa_state/telegram_plan.json","logs/telegram_rehearsal.txt","telegram/REHEARSAL_SUMMARY.json"],
         "telegram_plan+mock_rehearsal"),
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
# readyForDeploy ONLY via assert script — never set true here manually
(out/"CLOSE_ACCEPTANCE.json").write_text(json.dumps(doc, indent=2)+"\n", encoding="utf-8")
summary = {
  "env_dollar_exit": $ed,
  "runtime_preflight_cross_proc_exit": $rp,
  "stop_claims_psql_fail_exit": $spf,
  "stop_claims_multi_exit": $sc,
  "real_worker_profit_exit": $rwp,
  "wait_profit_real_exit": $wpr,
  "verify_hit_real_exit": $vh_real,
  "verify_hit_contract_exit": $vh,
  "verify_after_restore_exit": $vr,
  "corrupt_restore_exit": $rc_corrupt,
  "assert_incomplete_exit": $ai,
  "g3_status": g3_status,
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
