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
  local id st formula scope df dt
  local seen_file
  seen_file="$(mktemp)"
  local scopes_seen_file
  scopes_seen_file="$(mktemp)"
  # shellcheck disable=SC2064
  trap 'rm -f "$seen_file" "$scopes_seen_file"' RETURN
  while IFS= read -r id || [[ -n "${id:-}" ]]; do
    [[ -z "${id:-}" ]] && continue
    if grep -Fxq "$id" "$seen_file"; then
      echo "WEEKLY_WAIT_ID_DUPLICATE id=$id" >&2
      return 1
    fi
    echo "$id" >> "$seen_file"
    n=$((n+1))
    # Prefer target URL for this stage — require exact key match for current week
    row="$(psql "$TARGET_URL" -Atc "SELECT status||'|'||\"formulaVersion\"||'|'||\"companyScope\"||'|'||to_char(\"dateFrom\"::date,'YYYY-MM-DD')||'|'||to_char(\"dateTo\"::date,'YYYY-MM-DD')||'|'||CASE WHEN \"finishedAt\" IS NULL THEN '0' ELSE '1' END FROM \"DashboardPeriodSnapshotJob\" WHERE id='$(sql_escape "$id")';")"
    if [[ -z "$row" ]]; then
      echo "WEEKLY_WAIT_ID_MISS id=$id target_poll" >&2
      return 1
    fi
    IFS='|' read -r st formula scope df dt finished <<<"$row"
    if [[ "$st" != "SUCCESS" ]]; then
      echo "WEEKLY_WAIT_ID_NOT_SUCCESS id=$id status=$st" >&2
      return 1
    fi
    if ! formula_in_list "$formula"; then
      echo "WEEKLY_WAIT_ID_WRONG_STAGE id=$id formula=$formula stage=$STAGE" >&2
      return 1
    fi
    if [[ "$df" != "$DATE_FROM" || "$dt" != "$DATE_TO" ]]; then
      echo "WEEKLY_WAIT_ID_WRONG_DATES id=$id from=$df to=$dt" >&2
      return 1
    fi
    if [[ "$scope" != "ALL" && "$scope" != "ИП Петров" && "$scope" != "ИП Лебедева" ]]; then
      echo "WEEKLY_WAIT_ID_WRONG_SCOPE id=$id scope=$scope" >&2
      return 1
    fi
    # Unique (scope,formula) among listed IDs
    local key="${scope}|${formula}"
    if grep -Fxq "$key" "$scopes_seen_file"; then
      echo "WEEKLY_WAIT_KEY_DUPLICATE key=$key id=$id" >&2
      return 1
    fi
    echo "$key" >> "$scopes_seen_file"
    # finishedAt required as generation/completion evidence for SUCCESS
    if [[ "${finished:-0}" != "1" ]]; then
      echo "WEEKLY_WAIT_ID_NO_FINISHEDAT id=$id" >&2
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
