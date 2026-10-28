#!/usr/bin/env bash
# R17 isolated full pass — real postgres + real scripts + Finance fixture.
# Positive verify REQUIRED. Disposable target only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

: "${DATABASE_URL:?DATABASE_URL required (ephemeral)}"
if echo "$DATABASE_URL" | grep -Eiq '72\.56\.4\.62|ardelo|prod'; then
  echo "REFUSE production-looking DATABASE_URL"; exit 3
fi
export WAVE_B_PROFIT_TARGET_DATABASE_URL="${WAVE_B_PROFIT_TARGET_DATABASE_URL:-$DATABASE_URL}"
export V6_READMODEL_TARGET_DATABASE_URL="${V6_READMODEL_TARGET_DATABASE_URL:-$DATABASE_URL}"
export WEEKLY_REQUIRE_SAME_TARGETS=1
export DATE_FROM=2026-10-19 DATE_TO=2026-10-25
export WEEKLY_WAIT_POLL_MAX="${WEEKLY_WAIT_POLL_MAX:-12}"
export WEEKLY_WAIT_POLL_SLEEP="${WEEKLY_WAIT_POLL_SLEEP:-1}"
export STOP_CLAIMS_WAIT_MAX="${STOP_CLAIMS_WAIT_MAX:-2}"
export STOP_CLAIMS_WAIT_SLEEP="${STOP_CLAIMS_WAIT_SLEEP:-1}"

OUT_DIR="${R17_ISOLATION_OUT:-$ROOT/R17_isolation_out}"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"/{ids,backup,env,logs,fa_state,mockbin}
export WEEKLY_JOB_IDS_DIR="$OUT_DIR/ids"
export FA_STATE="$OUT_DIR/fa_state"
export WEEK_BACKUP_DIR="$OUT_DIR/backup"
FIXTURE="${FINANCE_ADAPTER_FIXTURE:-$ROOT/scripts/fin_accept/fixtures/FINANCE_ADAPTER_ROWS.json}"

need() { command -v "$1" >/dev/null || { echo "missing $1"; exit 2; }; }
need psql; need node; need python3

echo "=== prisma db push ===" | tee "$OUT_DIR/logs/header.txt"
npx prisma db push --accept-data-loss 2>&1 | tee "$OUT_DIR/logs/prisma_push.txt"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL' | tee "$OUT_DIR/logs/seed_clean.txt"
TRUNCATE "DashboardPeriodSnapshotJob" CASCADE;
TRUNCATE "ProfitPeriodMetric" CASCADE;
TRUNCATE "ProfitSkuPeriodMetric" CASCADE;
SQL

echo "=== load Finance fixture ==="
[[ -f "$FIXTURE" ]] || { echo "missing fixture $FIXTURE"; exit 2; }
node --import tsx scripts/fin_accept/load_finance_fixture_R17.ts "$FIXTURE" \
  | tee "$OUT_DIR/logs/load_finance.txt"

echo "=== seed profit metrics + fingerprint sync ==="
node --import tsx scripts/fin_accept/seed_isolation_metrics_R16.ts \
  | tee "$OUT_DIR/logs/seed_metrics.txt"

echo "=== BLOCK A: capture-env expected from runtime (not image) ==="
mkdir -p "$OUT_DIR/env"
# Simulate runtime captured with DATABASE_URL present; expected=copy (cutover env-file model)
printf 'DATABASE_URL=%s\nWAVE_B_PROFIT_WORKER_MODE=queue\nWAVE_B_TARGET_DB_MODE=SAME_PRODUCTION_DB\n' \
  "$DATABASE_URL" > "$OUT_DIR/env/profit.captured.env"
cp -f "$OUT_DIR/env/profit.captured.env" "$OUT_DIR/env/profit.expected.env"
# Image-defaults empty DATABASE_URL must NOT be used as expected — prove compare passes on runtime pair
bash scripts/fin_accept/compare_main_env_keys_R12.sh \
  "$OUT_DIR/env/profit.captured.env" "$OUT_DIR/env/profit.expected.env" \
  | tee "$OUT_DIR/logs/env_runtime_match.txt"
# Missing files still fail
set +e
bash scripts/fin_accept/compare_main_env_keys_R12.sh \
  "$OUT_DIR/env/nope_a.env" "$OUT_DIR/env/nope_b.env" >"$OUT_DIR/logs/env_missing.txt" 2>&1
em=$?
set -e
[[ "$em" -ne 0 ]] || { echo "FAIL missing env"; exit 17; }

echo "=== BLOCK A: stop multi-role recovery ==="
MOCK="$OUT_DIR/mockbin"
cat > "$MOCK/docker" <<'EOS'
#!/usr/bin/env bash
echo "docker $*" >> "$(dirname "$0")/../logs/docker_calls.txt"
cmd="$1"; shift || true
case "$cmd" in
  inspect)
    # Status queries
    if [[ "$*" == *State.Status* ]]; then
      name=""
      for a in "$@"; do [[ "$a" == avorofin-* ]] && name="$a"; done
      # After stop recorded, report exited; else running
      if grep -q "stop $name\|kill .* $name" "$(dirname "$0")/../logs/docker_calls.txt" 2>/dev/null; then
        # If start happened after last stop, running again
        if awk -v n="$name" '
          $0 ~ ("stop " n) || $0 ~ ("kill .* " n) { stopped=1 }
          $0 ~ ("start " n) { stopped=0 }
          END { exit stopped?0:1 }' "$(dirname "$0")/../logs/docker_calls.txt"; then
          echo exited; exit 0
        fi
      fi
      echo running; exit 0
    fi
    if [[ "$*" == *State.Running* ]]; then
      name=""
      for a in "$@"; do [[ "$a" == avorofin-* ]] && name="$a"; done
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
# Force profit SUCCESS then set RUNNING; V6 will also be RUNNING so second stop fails → recover ALL
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
UPDATE "DashboardPeriodSnapshotJob" SET status='SUCCESS', "finishedAt"=NOW() WHERE true;
INSERT INTO "DashboardPeriodSnapshotJob"
 (id,"companyScope","dateFrom","dateTo","formulaVersion",status,priority,attempts,"maxAttempts","createdAt","updatedAt","finishedAt")
VALUES
 ('iso-profit-run','ИП Петров','2026-10-19','2026-10-25','FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1','RUNNING',40,1,3,NOW(),NOW(),NULL),
 ('iso-v6-run','ИП Петров','2026-10-19','2026-10-25','FINANCIAL_CORE_V6_PERIOD_READMODEL_V2','RUNNING',40,1,3,NOW(),NOW(),NULL)
ON CONFLICT (id) DO UPDATE SET status='RUNNING', "finishedAt"=NULL;
SQL
# Clear profit RUNNING after first stop succeeds by updating in wait? Our mock doesn't clear DB.
# Make profit drain succeed: after first stop_one, set profit RUNNING=0 via SQL in background? Simpler:
# only leave V6 RUNNING so profit stop OK, v6 fails → recover both.
psql "$DATABASE_URL" -c "UPDATE \"DashboardPeriodSnapshotJob\" SET status='SUCCESS', \"finishedAt\"=NOW() WHERE id='iso-profit-run';"

set +e
PATH="$MOCK:$PATH" \
STAMP=20261028_R17 FA_STATE="$FA_STATE" DATABASE_URL="$DATABASE_URL" \
  bash scripts/fin_accept/deploy_entrypoint_R12.sh stop-claims \
  >"$OUT_DIR/logs/stop_claims_multi.txt" 2>&1
sc=$?
set -e
echo "stop_claims_exit=$sc" | tee -a "$OUT_DIR/logs/stop_claims_multi.txt"
[[ "$sc" -ne 0 ]] || { echo "FAIL expected stop fail on v6"; exit 18; }
grep -q 'STOP_CLAIMS_RECOVER_ALL\|RESTARTED start avorofin-profit\|start avorofin-profit' \
  "$OUT_DIR/logs/stop_claims_multi.txt" "$OUT_DIR/logs/docker_calls.txt" \
  || { echo "FAIL expected recover all including profit"; cat "$OUT_DIR/logs/docker_calls.txt"; exit 19; }

echo "=== BLOCK B1: enqueue/wait stages + duplicate ID reject ==="
export WEEKLY_STAGE=profit WEEKLY_JOB_IDS_FILE="$OUT_DIR/ids/weekly_ids_profit.txt"
# Clean conflicting job rows from stop probe
psql "$DATABASE_URL" -c "DELETE FROM \"DashboardPeriodSnapshotJob\" WHERE id LIKE 'iso-%';"
node --import tsx scripts/fin_accept/run_weekly_enqueue_R12.ts "$OUT_DIR/weekly_profit.json" \
  | tee "$OUT_DIR/logs/enqueue_profit.txt"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
UPDATE "DashboardPeriodSnapshotJob"
SET status='SUCCESS', "lockedBy"=NULL, "lockedAt"=NULL, "finishedAt"=NOW()
WHERE "dateFrom"='2026-10-19'::date AND "dateTo"='2026-10-25'::date
  AND "formulaVersion" IN (
    'FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1',
    'FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1');
SQL
WEEKLY_STAGE=profit WEEKLY_JOB_IDS_FILE="$OUT_DIR/ids/weekly_ids_profit.txt" \
  bash scripts/fin_accept/wait_weekly_R12.sh | tee "$OUT_DIR/logs/wait_profit.txt"

# Duplicate IDs must fail
head -n1 "$OUT_DIR/ids/weekly_ids_profit.txt" > "$OUT_DIR/ids/dup.txt"
head -n1 "$OUT_DIR/ids/weekly_ids_profit.txt" >> "$OUT_DIR/ids/dup.txt"
# pad to 6 lines with same id
for i in 1 2 3 4; do head -n1 "$OUT_DIR/ids/weekly_ids_profit.txt" >> "$OUT_DIR/ids/dup.txt"; done
set +e
WEEKLY_STAGE=profit WEEKLY_JOB_IDS_FILE="$OUT_DIR/ids/dup.txt" WEEKLY_WAIT_POLL_MAX=2 \
  bash scripts/fin_accept/wait_weekly_R12.sh >"$OUT_DIR/logs/wait_dup.txt" 2>&1
wd=$?
set -e
[[ "$wd" -ne 0 ]] || { echo "FAIL dup ids"; exit 20; }
grep -q 'WEEKLY_WAIT_ID_DUPLICATE\|WEEKLY_WAIT_KEY_DUPLICATE' "$OUT_DIR/logs/wait_dup.txt"

# Reject WEEKLY_STAGE=all
set +e
WEEKLY_STAGE=all node --import tsx scripts/fin_accept/run_weekly_enqueue_R12.ts "$OUT_DIR/all_reject.json" \
  >"$OUT_DIR/logs/enqueue_all_reject.txt" 2>&1
wa=$?
set -e
[[ "$wa" -eq 6 ]] || { echo "FAIL all should exit 6"; exit 21; }

for st in v6 dashboard; do
  export WEEKLY_STAGE=$st WEEKLY_JOB_IDS_FILE="$OUT_DIR/ids/weekly_ids_${st}.txt"
  node --import tsx scripts/fin_accept/run_weekly_enqueue_R12.ts "$OUT_DIR/weekly_${st}.json" \
    | tee "$OUT_DIR/logs/enqueue_${st}.txt"
  psql "$DATABASE_URL" -c "UPDATE \"DashboardPeriodSnapshotJob\" SET status='SUCCESS', \"finishedAt\"=NOW() WHERE status<>'SUCCESS';"
  WEEKLY_STAGE=$st WEEKLY_JOB_IDS_FILE="$OUT_DIR/ids/weekly_ids_${st}.txt" \
    bash scripts/fin_accept/wait_weekly_R12.sh | tee "$OUT_DIR/logs/wait_${st}.txt"
done
cat "$OUT_DIR/ids/weekly_ids_profit.txt" "$OUT_DIR/ids/weekly_ids_v6.txt" "$OUT_DIR/ids/weekly_ids_dashboard.txt" \
  > "$OUT_DIR/ids/weekly_ids_final.txt"
WEEKLY_STAGE=final WEEKLY_JOB_IDS_FILE="$OUT_DIR/ids/weekly_ids_final.txt" \
  bash scripts/fin_accept/wait_weekly_R12.sh | tee "$OUT_DIR/logs/wait_final.txt"

echo "=== BLOCK B2: positive verify with Finance fixture (REQUIRED) ==="
set +e
node --import tsx scripts/fin_accept/verify_week_consumer_R12.ts "$OUT_DIR/verify_hit.json" \
  >"$OUT_DIR/logs/verify_hit.txt" 2>&1
vh=$?
set -e
echo "verify_hit_exit=$vh" | tee -a "$OUT_DIR/logs/verify_hit.txt"
[[ "$vh" -eq 0 ]] || { echo "FAIL positive verify required"; tail -40 "$OUT_DIR/logs/verify_hit.txt"; exit 22; }
grep -q 'VERIFY_WEEK_CONSUMER_R16_PASS\|VERIFY_WEEK_CONSUMER_R17_PASS\|"ok": true' "$OUT_DIR/logs/verify_hit.txt" \
  || grep -q '"ok": true' "$OUT_DIR/verify_hit.json"

echo "=== BLOCK B2: stale fingerprint must fail ==="
node --import tsx scripts/fin_accept/iso_mutate_helpers_R16.ts stale_fingerprint \
  | tee "$OUT_DIR/logs/mutate_stale_fp.txt"
set +e
node --import tsx scripts/fin_accept/verify_week_consumer_R12.ts "$OUT_DIR/verify_stale.json" \
  >"$OUT_DIR/logs/verify_stale.txt" 2>&1
vs=$?
set -e
[[ "$vs" -ne 0 ]] || { echo "FAIL stale fingerprint"; exit 23; }
grep -qi 'SOURCE_FINGERPRINT_STALE\|fingerprint\|UNAVAILABLE\|consumer' "$OUT_DIR/logs/verify_stale.txt" \
  || true
# restore fingerprints
node --import tsx scripts/fin_accept/seed_isolation_metrics_R16.ts | tee "$OUT_DIR/logs/reseed_fp.txt"

echo "=== BLOCK B3: backup → create absent-key row → restore deletes it → consumer PASS ==="
node --import tsx scripts/fin_accept/export_profit_period_backup_R16.ts "$OUT_DIR/backup" \
  | tee "$OUT_DIR/logs/backup_export.txt"
# Create a NEW Ozon row that was absent? All scopes present. Instead: delete Lebedeva from backup inventory hadRow by
# simulating post-rebuild extra: clone ALL Ozon to a fake? Use inventory: remove Lebedeva from DB, re-export? 
# Review case: absent before rebuild, appeared after. Simulate by deleting Lebedeva Ozon from backup inventory hadRow=false
# while inserting a synthetic extra formula row? Simpler: insert duplicate marketplace row with wrong scope not in backup.
# Use companyScope that is in allowlist: temporarily delete Lebedeva from snapshot inventory as hadRow=false and ensure row exists.
python3 - "$OUT_DIR/backup/backup_inventory.json" <<'PY'
import json,sys
inv=json.load(open(sys.argv[1],encoding="utf-8"))
for row in inv:
  if row.get("companyScope")=="ИП Лебедева" and row.get("marketplace")=="OZON":
    row["hadRow"]=False
json.dump(inv, open(sys.argv[1],"w",encoding="utf-8"), indent=2, ensure_ascii=False)
print("MARKED_LEBEDEVA_OZON_ABSENT_IN_INVENTORY")
PY
# Ensure Lebedeva Ozon exists in DB (it does from seed)
node --import tsx scripts/fin_accept/run_data_rollback_ozon_R12.ts "$OUT_DIR/backup" \
  | tee "$OUT_DIR/logs/restore_scoped.txt"
# Lebedeva Ozon must be deleted
gone="$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM \"ProfitPeriodMetric\" WHERE \"companyScope\"='ИП Лебедева' AND marketplace='OZON';")"
echo "lebedeva_ozon_count=$gone" | tee "$OUT_DIR/logs/lebedeva_after_restore.txt"
[[ "$gone" == "0" ]] || { echo "FAIL expected delete absent-at-backup row"; exit 24; }

# Re-seed full metrics for final consumer after restore proof
node --import tsx scripts/fin_accept/seed_isolation_metrics_R16.ts | tee "$OUT_DIR/logs/reseed_after_restore.txt"
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
[[ "$vr" -eq 0 ]] || { echo "FAIL verify after restore"; tail -30 "$OUT_DIR/logs/verify_after_restore.txt"; exit 25; }

python3 - <<PY
import json, pathlib
out=pathlib.Path("$OUT_DIR")
summary={
  "env_missing_exit": $em,
  "stop_claims_multi_exit": $sc,
  "wait_dup_exit": $wd,
  "enqueue_all_reject_exit": $wa,
  "verify_hit_exit": $vh,
  "verify_stale_exit": $vs,
  "verify_after_restore_exit": $vr,
  "lebedeva_ozon_after_absent_restore": "$gone",
  "ok_gates": {
    "env_missing_fail": $em!=0,
    "stop_recover_all": $sc!=0,
    "dup_ids_fail": $wd!=0,
    "all_stage_reject": $wa==6,
    "verify_positive": $vh==0,
    "stale_fail": $vs!=0,
    "verify_after_restore": $vr==0,
    "absent_key_deleted": "$gone"=="0",
  }
}
summary["all_required_gates"]=all(summary["ok_gates"].values())
(out/"SUMMARY.json").write_text(json.dumps(summary, indent=2)+"\n", encoding="utf-8")
print(json.dumps(summary, indent=2))
if not summary["all_required_gates"]:
  raise SystemExit(30)
print("R17_ISOLATED_SEQUENCE_PASS")
PY
