#!/usr/bin/env bash
# Local/safe COMPARE of non-secret MODE/formula/DB-target key NAMES and MATCH/MISMATCH
# of secret values WITHOUT printing secrets. Inputs are env dumps from docker inspect
# (KEY=VALUE lines). APP .env.production is NOT treated as equivalent to Config.Env.
#
#   bash scripts/fin_accept/compare_main_env_keys_R12.sh captured.env expected.env
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
  # strip KEY=
  grep -E "^${key}=" "$file" 2>/dev/null | head -n1 | sed "s/^${key}=//" || true
}

echo "NONSECRET_NAME_AND_VALUE_COMPARE"
for k in "${NONSECRET_KEYS[@]}"; do
  cv="$(get_val "$CAP" "$k")"
  ev="$(get_val "$EXP" "$k")"
  if [[ -z "$cv" && -z "$ev" ]]; then
    echo "$k ABSENT_BOTH"
  elif [[ -z "$cv" ]]; then
    echo "$k MISSING_IN_CAPTURED"
  elif [[ -z "$ev" ]]; then
    echo "$k EXTRA_IN_CAPTURED value_present=yes"
  elif [[ "$cv" == "$ev" ]]; then
    echo "$k MATCH"
  else
    echo "$k MISMATCH"
  fi
done

echo "SECRET_VALUE_COMPARE_NO_PRINT"
for k in "${SECRET_KEYS[@]}"; do
  cv="$(get_val "$CAP" "$k")"
  ev="$(get_val "$EXP" "$k")"
  if [[ -z "$cv" && -z "$ev" ]]; then
    echo "$k ABSENT_BOTH"
  elif [[ -z "$cv" || -z "$ev" ]]; then
    echo "$k MISMATCH_PRESENCE"
  elif [[ "$cv" == "$ev" ]]; then
    echo "$k MATCH"
  else
    echo "$k MISMATCH"
  fi
done
echo "APP_ENV_FILE_NOT_EQUIVALENT_TO_CONFIG_ENV=true"
echo "COMPARE_MAIN_ENV_KEYS_R12_DONE"
