#!/usr/bin/env bash
# Compare non-secret MODE/formula keys and secret presence/equality WITHOUT printing secrets.
# Exit 1 on any MISMATCH / missing required key.
set -euo pipefail
CAP="${1:?captured.env}"
EXP="${2:?expected.env}"
NONSECRET_KEYS=(
  WAVE_B_PROFIT_WORKER_MODE
  WAVE_B_TARGET_DB_MODE
  V6_READMODEL_WORKER_MODE
  DASHBOARD_SNAPSHOT_WORKER_MODE
  DASHBOARD_SNAPSHOT_FORMULA_VERSIONS
)
SECRET_KEYS=(
  DATABASE_URL
  V6_READMODEL_TARGET_DATABASE_URL
  WAVE_B_PROFIT_TARGET_DATABASE_URL
)

get_val() {
  local file="$1" key="$2"
  grep -E "^${key}=" "$file" 2>/dev/null | head -n1 | sed "s/^${key}=//" || true
}

fail=0
echo "NONSECRET_NAME_AND_VALUE_COMPARE"
for k in "${NONSECRET_KEYS[@]}"; do
  cv="$(get_val "$CAP" "$k")"
  ev="$(get_val "$EXP" "$k")"
  if [[ -z "$cv" && -z "$ev" ]]; then
    echo "$k ABSENT_BOTH"
  elif [[ -z "$cv" ]]; then
    echo "$k MISSING_IN_CAPTURED"; fail=1
  elif [[ -z "$ev" ]]; then
    echo "$k EXTRA_IN_CAPTURED value_present=yes"
  elif [[ "$cv" == "$ev" ]]; then
    echo "$k MATCH"
  else
    echo "$k MISMATCH"; fail=1
  fi
done

echo "SECRET_VALUE_COMPARE_NO_PRINT"
for k in "${SECRET_KEYS[@]}"; do
  cv="$(get_val "$CAP" "$k")"
  ev="$(get_val "$EXP" "$k")"
  if [[ -z "$cv" && -z "$ev" ]]; then
    echo "$k ABSENT_BOTH"
  elif [[ -z "$cv" || -z "$ev" ]]; then
    # Only fail when expected side requires the key
    if [[ -n "$ev" ]]; then
      echo "$k MISMATCH_PRESENCE"; fail=1
    else
      echo "$k EXTRA_IN_CAPTURED_SECRET"
    fi
  elif [[ "$cv" == "$ev" ]]; then
    echo "$k MATCH"
  else
    echo "$k MISMATCH"; fail=1
  fi
done
echo "APP_ENV_FILE_NOT_EQUIVALENT_TO_CONFIG_ENV=true"
echo "COMPARE_MAIN_ENV_KEYS_DONE fail=$fail"
exit "$fail"
