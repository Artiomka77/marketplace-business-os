#!/usr/bin/env bash
# Wait SUCCESS for the exact 19–25 job matrix. PENDING is allowed until claimed;
# stop only on ERROR/exhausted or timeout. RUNNING must drain to 0 then SUCCESS.
set -euo pipefail
DATE_FROM="${DATE_FROM:-2026-10-19}"
DATE_TO="${DATE_TO:-2026-10-25}"
: "${DATABASE_URL:?DATABASE_URL required}"
V6_URL="${V6_READMODEL_TARGET_DATABASE_URL:-$DATABASE_URL}"

FORMULAS=(
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2
  FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1
)

sql_status() {
  local url="$1"
  psql "$url" -Atc "
    SELECT \"formulaVersion\"||'|'||status||'|'||count(*)
    FROM \"DashboardPeriodSnapshotJob\"
    WHERE \"dateFrom\"='${DATE_FROM}'::date AND \"dateTo\"='${DATE_TO}'::date
      AND \"formulaVersion\" = ANY(ARRAY['${FORMULAS[0]}','${FORMULAS[1]}','${FORMULAS[2]}','${FORMULAS[3]}'])
      AND \"companyScope\" IN ('ALL','ИП Петров','ИП Лебедева')
    GROUP BY 1,2
    ORDER BY 1,2;
  "
}

for i in $(seq 1 180); do
  echo "--- poll $i ---"
  sql_status "$DATABASE_URL" || true
  if [[ "$V6_URL" != "$DATABASE_URL" ]]; then
    sql_status "$V6_URL" || true
  fi
  pending_or_running="$(psql "$DATABASE_URL" -Atc "
    SELECT count(*) FROM \"DashboardPeriodSnapshotJob\"
    WHERE \"dateFrom\"='${DATE_FROM}'::date AND \"dateTo\"='${DATE_TO}'::date
      AND \"formulaVersion\" = ANY(ARRAY['${FORMULAS[0]}','${FORMULAS[1]}','${FORMULAS[2]}','${FORMULAS[3]}'])
      AND \"companyScope\" IN ('ALL','ИП Петров','ИП Лебедева')
      AND status IN ('PENDING','RUNNING','ERROR');
  " | tr -d '[:space:]')"
  err="$(psql "$DATABASE_URL" -Atc "
    SELECT count(*) FROM \"DashboardPeriodSnapshotJob\"
    WHERE \"dateFrom\"='${DATE_FROM}'::date AND \"dateTo\"='${DATE_TO}'::date
      AND \"formulaVersion\" = ANY(ARRAY['${FORMULAS[0]}','${FORMULAS[1]}','${FORMULAS[2]}','${FORMULAS[3]}'])
      AND \"companyScope\" IN ('ALL','ИП Петров','ИП Лебедева')
      AND status='ERROR' AND attempts>=\"maxAttempts\";
  " | tr -d '[:space:]')"
  if [[ "${err:-0}" != "0" ]]; then
    echo "WEEKLY_WAIT_FAILED exhausted ERROR count=$err" >&2
    exit 3
  fi
  if [[ "${pending_or_running:-0}" == "0" ]]; then
    echo "WEEKLY_WAIT_ALL_SUCCESS"
    exit 0
  fi
  sleep 10
done
echo "WEEKLY_WAIT_TIMEOUT" >&2
exit 4
