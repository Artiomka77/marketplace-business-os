#!/usr/bin/env bash
# Wait SUCCESS for the exact 19–25 job matrix. Empty matrix / missing IDs = FAIL.
# PENDING may exist until claimed; gate requires every expected ID → SUCCESS.
set -euo pipefail
DATE_FROM="${DATE_FROM:-2026-10-19}"
DATE_TO="${DATE_TO:-2026-10-25}"
: "${DATABASE_URL:?DATABASE_URL required}"
V6_URL="${V6_READMODEL_TARGET_DATABASE_URL:-$DATABASE_URL}"
JOB_IDS_FILE="${WEEKLY_JOB_IDS_FILE:-}"

FORMULAS=(
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2
  FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1
)
SCOPES=('ALL' 'ИП Петров' 'ИП Лебедева')
EXPECTED_COUNT=$(( ${#FORMULAS[@]} * ${#SCOPES[@]} ))

sql_count() {
  local url="$1"
  psql "$url" -Atc "
    SELECT count(*) FROM \"DashboardPeriodSnapshotJob\"
    WHERE \"dateFrom\"='${DATE_FROM}'::date AND \"dateTo\"='${DATE_TO}'::date
      AND \"formulaVersion\" IN ('${FORMULAS[0]}','${FORMULAS[1]}','${FORMULAS[2]}','${FORMULAS[3]}')
      AND \"companyScope\" IN ('ALL','ИП Петров','ИП Лебедева');
  " | tr -d '[:space:]'
}

sql_success() {
  local url="$1"
  psql "$url" -Atc "
    SELECT count(*) FROM \"DashboardPeriodSnapshotJob\"
    WHERE \"dateFrom\"='${DATE_FROM}'::date AND \"dateTo\"='${DATE_TO}'::date
      AND \"formulaVersion\" IN ('${FORMULAS[0]}','${FORMULAS[1]}','${FORMULAS[2]}','${FORMULAS[3]}')
      AND \"companyScope\" IN ('ALL','ИП Петров','ИП Лебедева')
      AND status='SUCCESS';
  " | tr -d '[:space:]'
}

sql_bad() {
  local url="$1"
  psql "$url" -Atc "
    SELECT count(*) FROM \"DashboardPeriodSnapshotJob\"
    WHERE \"dateFrom\"='${DATE_FROM}'::date AND \"dateTo\"='${DATE_TO}'::date
      AND \"formulaVersion\" IN ('${FORMULAS[0]}','${FORMULAS[1]}','${FORMULAS[2]}','${FORMULAS[3]}')
      AND \"companyScope\" IN ('ALL','ИП Петров','ИП Лебедева')
      AND (
        status NOT IN ('PENDING','RUNNING','SUCCESS','ERROR')
        OR (status='ERROR' AND attempts>=\"maxAttempts\")
      );
  " | tr -d '[:space:]'
}

check_ids_file() {
  [[ -n "$JOB_IDS_FILE" ]] || return 0
  [[ -f "$JOB_IDS_FILE" ]] || { echo "WEEKLY_WAIT_MISSING_IDS_FILE" >&2; exit 2; }
  while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    st="$(psql "$DATABASE_URL" -Atc "SELECT status FROM \"DashboardPeriodSnapshotJob\" WHERE id='${id}';" | tr -d '[:space:]')"
    if [[ "$st" != "SUCCESS" ]]; then
      echo "WEEKLY_WAIT_ID_NOT_SUCCESS id=$id status=${st:-MISS}" >&2
      return 1
    fi
  done < "$JOB_IDS_FILE"
  return 0
}

for i in $(seq 1 180); do
  echo "--- poll $i ---"
  total="$(sql_count "$DATABASE_URL")"
  success="$(sql_success "$DATABASE_URL")"
  bad="$(sql_bad "$DATABASE_URL")"
  echo "DATABASE_URL total=$total success=$success bad=$bad expect=$EXPECTED_COUNT"
  if [[ "$V6_URL" != "$DATABASE_URL" ]]; then
    v6t="$(sql_count "$V6_URL")"
    v6s="$(sql_success "$V6_URL")"
    echo "V6_URL total=$v6t success=$v6s"
  fi
  if [[ "${bad:-0}" != "0" ]]; then
    echo "WEEKLY_WAIT_FAILED bad_status_or_exhausted=$bad" >&2
    exit 3
  fi
  if [[ "${total:-0}" -lt "$EXPECTED_COUNT" ]]; then
    echo "WEEKLY_WAIT_INCOMPLETE_MATRIX total=$total expect=$EXPECTED_COUNT"
    sleep 10
    continue
  fi
  if [[ "${success:-0}" -ge "$EXPECTED_COUNT" ]]; then
    if check_ids_file; then
      echo "WEEKLY_WAIT_ALL_SUCCESS count=$success"
      exit 0
    fi
  fi
  sleep 10
done
echo "WEEKLY_WAIT_TIMEOUT" >&2
exit 4
