#!/usr/bin/env bash
# Wait SUCCESS for the CURRENT weekly stage matrix only (not future stages).
# Requires WEEKLY_JOB_IDS_FILE with exact IDs enqueued for this stage.
# Empty matrix / missing IDs / wrong target = FAIL. Stale SUCCESS without listed IDs ≠ PASS.
set -euo pipefail
DATE_FROM="${DATE_FROM:-2026-10-19}"
DATE_TO="${DATE_TO:-2026-10-25}"
: "${DATABASE_URL:?DATABASE_URL required}"
: "${WEEKLY_JOB_IDS_FILE:?WEEKLY_JOB_IDS_FILE required (exact IDs for this stage)}"
STAGE="${WEEKLY_STAGE:-all}"
V6_URL="${V6_READMODEL_TARGET_DATABASE_URL:-$DATABASE_URL}"
PROFIT_URL="${WAVE_B_PROFIT_TARGET_DATABASE_URL:-$DATABASE_URL}"
POLL_MAX="${WEEKLY_WAIT_POLL_MAX:-180}"
POLL_SLEEP="${WEEKLY_WAIT_POLL_SLEEP:-10}"

case "$STAGE" in
  profit)
    FORMULAS=(
      FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1
      FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1
    )
    TARGET_URL="$PROFIT_URL"
    ;;
  v6)
    FORMULAS=(FINANCIAL_CORE_V6_PERIOD_READMODEL_V2)
    TARGET_URL="$V6_URL"
    ;;
  dashboard)
    FORMULAS=(FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1)
    TARGET_URL="$DATABASE_URL"
    ;;
  all|final)
    FORMULAS=(
      FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1
      FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1
      FINANCIAL_CORE_V6_PERIOD_READMODEL_V2
      FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1
    )
    # final gate: every formula must live on its real target; prove identity first
    TARGET_URL="$DATABASE_URL"
    ;;
  *)
    echo "WEEKLY_WAIT_BAD_STAGE stage=$STAGE" >&2
    exit 2
    ;;
esac

SCOPES=('ALL' 'ИП Петров' 'ИП Лебедева')
EXPECTED_COUNT=$(( ${#FORMULAS[@]} * ${#SCOPES[@]} ))

same_db_identity() {
  python3 - "$1" "$2" <<'PY'
import sys
from urllib.parse import urlparse
a,b=sys.argv[1],sys.argv[2]
try:
  ua,ub=urlparse(a),urlparse(b)
  ok=(ua.scheme==ub.scheme and ua.hostname==ub.hostname and (ua.port or '')==(ub.port or '') and ua.path==ub.path)
except Exception:
  ok=(a==b)
sys.exit(0 if ok else 1)
PY
}

prove_targets_for_final() {
  # Reject unsupported split targets unless every stage URL is identical to DATABASE_URL.
  local mismatches=0
  if ! same_db_identity "$PROFIT_URL" "$DATABASE_URL"; then
    echo "WEEKLY_WAIT_UNSUPPORTED_SPLIT profit_target!=DATABASE_URL (enqueue/wait must use proven same identity or dedicated stage runners)" >&2
    mismatches=1
  fi
  if ! same_db_identity "$V6_URL" "$DATABASE_URL"; then
    echo "WEEKLY_WAIT_UNSUPPORTED_SPLIT v6_target!=DATABASE_URL" >&2
    mismatches=1
  fi
  if [[ "$mismatches" != "0" ]]; then
    exit 5
  fi
  echo "WEEKLY_WAIT_TARGETS_SAME_AS_DATABASE_URL=true"
}

if [[ "$STAGE" == "all" || "$STAGE" == "final" ]]; then
  prove_targets_for_final
fi

# Stage-specific URL must be the one we poll for counts when not final.
if [[ "$STAGE" == "profit" ]]; then
  if ! same_db_identity "$PROFIT_URL" "$DATABASE_URL"; then
    # Allowed only when caller explicitly polls PROFIT_URL (TARGET_URL already set).
    echo "WEEKLY_WAIT_PROFIT_TARGET_SEPARATE=true"
  fi
fi
if [[ "$STAGE" == "v6" ]]; then
  if ! same_db_identity "$V6_URL" "$DATABASE_URL"; then
    echo "WEEKLY_WAIT_V6_TARGET_SEPARATE=true"
  fi
fi

formula_in_list() {
  local f="$1"
  local x
  for x in "${FORMULAS[@]}"; do
    [[ "$x" == "$f" ]] && return 0
  done
  return 1
}

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

build_formula_in() {
  local first=1
  local f
  local out="("
  for f in "${FORMULAS[@]}"; do
    if [[ "$first" -eq 1 ]]; then first=0; else out+=","; fi
    out+="'$(sql_escape "$f")'"
  done
  out+=")"
  printf "%s" "$out"
}

FORMULA_IN="$(build_formula_in)"

sql_count() {
  local url="$1"
  psql "$url" -Atc "
    SELECT count(*) FROM \"DashboardPeriodSnapshotJob\"
    WHERE \"dateFrom\"='${DATE_FROM}'::date AND \"dateTo\"='${DATE_TO}'::date
      AND \"formulaVersion\" IN ${FORMULA_IN}
      AND \"companyScope\" IN ('ALL','ИП Петров','ИП Лебедева');
  " | tr -d '[:space:]'
}

sql_success() {
  local url="$1"
  psql "$url" -Atc "
    SELECT count(*) FROM \"DashboardPeriodSnapshotJob\"
    WHERE \"dateFrom\"='${DATE_FROM}'::date AND \"dateTo\"='${DATE_TO}'::date
      AND \"formulaVersion\" IN ${FORMULA_IN}
      AND \"companyScope\" IN ('ALL','ИП Петров','ИП Лебедева')
      AND status='SUCCESS';
  " | tr -d '[:space:]'
}

sql_bad() {
  local url="$1"
  psql "$url" -Atc "
    SELECT count(*) FROM \"DashboardPeriodSnapshotJob\"
    WHERE \"dateFrom\"='${DATE_FROM}'::date AND \"dateTo\"='${DATE_TO}'::date
      AND \"formulaVersion\" IN ${FORMULA_IN}
      AND \"companyScope\" IN ('ALL','ИП Петров','ИП Лебедева')
      AND (
        status NOT IN ('PENDING','RUNNING','SUCCESS','ERROR')
        OR (status='ERROR' AND attempts>=\"maxAttempts\")
      );
  " | tr -d '[:space:]'
}

check_ids_file() {
  [[ -f "$WEEKLY_JOB_IDS_FILE" ]] || { echo "WEEKLY_WAIT_MISSING_IDS_FILE path=$WEEKLY_JOB_IDS_FILE" >&2; exit 2; }
  local n=0
  local id st formula
  while IFS= read -r id || [[ -n "${id:-}" ]]; do
    [[ -z "${id:-}" ]] && continue
    n=$((n+1))
    # Prefer target URL for this stage
    st="$(psql "$TARGET_URL" -Atc "SELECT status FROM \"DashboardPeriodSnapshotJob\" WHERE id='$(sql_escape "$id")';" | tr -d '[:space:]')"
    if [[ -z "$st" ]]; then
      # If final/all on same DB, also try (should be same). Miss = fail.
      echo "WEEKLY_WAIT_ID_MISS id=$id target_poll" >&2
      return 1
    fi
    if [[ "$st" != "SUCCESS" ]]; then
      echo "WEEKLY_WAIT_ID_NOT_SUCCESS id=$id status=$st" >&2
      return 1
    fi
    formula="$(psql "$TARGET_URL" -Atc "SELECT \"formulaVersion\" FROM \"DashboardPeriodSnapshotJob\" WHERE id='$(sql_escape "$id")';" | tr -d '[:space:]')"
    if ! formula_in_list "$formula"; then
      echo "WEEKLY_WAIT_ID_WRONG_STAGE id=$id formula=$formula stage=$STAGE" >&2
      return 1
    fi
  done < "$WEEKLY_JOB_IDS_FILE"
  if [[ "$n" -lt "$EXPECTED_COUNT" ]]; then
    echo "WEEKLY_WAIT_IDS_SHORT count=$n expect=$EXPECTED_COUNT" >&2
    return 1
  fi
  if [[ "$n" -gt "$EXPECTED_COUNT" ]]; then
    echo "WEEKLY_WAIT_IDS_EXTRA count=$n expect=$EXPECTED_COUNT" >&2
    return 1
  fi
  return 0
}

# Decorative print of other URLs is NOT a success condition.
echo "WEEKLY_WAIT_STAGE=$STAGE expect=$EXPECTED_COUNT target_poll=set ids=$WEEKLY_JOB_IDS_FILE"
if [[ "$V6_URL" != "$DATABASE_URL" ]]; then
  echo "V6_URL_CONFIGURED=true (polled only when STAGE=v6 or proven-same final)"
fi

for i in $(seq 1 "$POLL_MAX"); do
  echo "--- poll $i ---"
  total="$(sql_count "$TARGET_URL")"
  success="$(sql_success "$TARGET_URL")"
  bad="$(sql_bad "$TARGET_URL")"
  echo "TARGET total=$total success=$success bad=$bad expect=$EXPECTED_COUNT stage=$STAGE"
  if [[ "${bad:-0}" != "0" ]]; then
    echo "WEEKLY_WAIT_FAILED bad_status_or_exhausted=$bad" >&2
    exit 3
  fi
  if [[ "${total:-0}" -lt "$EXPECTED_COUNT" ]]; then
    echo "WEEKLY_WAIT_INCOMPLETE_MATRIX total=$total expect=$EXPECTED_COUNT"
    sleep "$POLL_SLEEP"
    continue
  fi
  if [[ "${success:-0}" -ge "$EXPECTED_COUNT" ]]; then
    if check_ids_file; then
      echo "WEEKLY_WAIT_STAGE_SUCCESS stage=$STAGE count=$success"
      exit 0
    fi
  fi
  sleep "$POLL_SLEEP"
done
echo "WEEKLY_WAIT_TIMEOUT stage=$STAGE" >&2
exit 4
