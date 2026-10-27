#!/usr/bin/env bash
# Unified 5-role cutover/rollback for FIN_ACCEPT build-only release prep.
# Does NOT deploy by itself: caller supplies image tags and must not invoke on MAIN
# unless explicitly authorized outside this script.
#
# Roles: app, profit-readmodel-worker, v6-period-readmodel-worker,
#        dashboard-period-snapshot-worker, stock-planning-snapshot-worker
set -euo pipefail

JOURNAL_DIR="${CUTOVER_JOURNAL_DIR:-/tmp/avorofin_cutover_journal}"
PRE_SUFFIX="${CUTOVER_PRE_SUFFIX:-pre-fa-cutover}"
mkdir -p "$JOURNAL_DIR"
: >"$JOURNAL_DIR/switched_roles.txt"
: >"$JOURNAL_DIR/role_expect_image.txt"

ROLES=(
  avorofin-app
  avorofin-profit-readmodel-worker
  avorofin-v6-period-readmodel-worker
  avorofin-dashboard-period-snapshot-worker
  avorofin-stock-planning-snapshot-worker
)

die() { echo "FATAL: $*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }

require_env_tag() {
  local var=$1
  [[ -n "${!var:-}" ]] || die "missing $var"
}

record_switched() {
  printf '%s\n' "$1" >>"$JOURNAL_DIR/switched_roles.txt"
}

expect_for() {
  local role=$1
  grep "^${role}=" "$JOURNAL_DIR/role_expect_image.txt" | head -1 | cut -d= -f2-
}

capture_runtime_hints() {
  local role=$1
  local out="$JOURNAL_DIR/${role}.runtime_before.txt"
  {
    echo "role=$role"
    docker inspect -f 'User={{.Config.User}}' "$role" 2>/dev/null || echo "User="
    docker inspect -f 'NetworkMode={{.HostConfig.NetworkMode}}' "$role" 2>/dev/null || true
    docker port "$role" 2>/dev/null || true
  } >"$out" || true
}

switch_one() {
  local role=$1
  local image=$2
  local expect_id=$3
  local pre="${role}-${PRE_SUFFIX}"
  local user_args=()
  local net_args=()
  local publish_args=()
  local workdir_args=()
  local env_file_args=()

  capture_runtime_hints "$role"

  # Preserve APP runtime user/port and worker network/user from live container when present.
  local cfg_user cfg_net
  cfg_user=$(docker inspect -f '{{.Config.User}}' "$role" 2>/dev/null || true)
  cfg_net=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$role" 2>/dev/null || true)
  if [[ -n "$cfg_user" ]]; then user_args=(--user "$cfg_user"); fi
  if [[ -n "$cfg_net" && "$cfg_net" != "default" ]]; then
    net_args=(--network "$cfg_net")
  else
    net_args=(--network bridge)
  fi
  if [[ "$role" == "avorofin-app" ]]; then
    # Keep published host port if previously bound.
    local host_port
    host_port=$(docker port "$role" 3000/tcp 2>/dev/null | head -1 | awk -F: '{print $NF}' || true)
    if [[ -n "$host_port" ]]; then
      publish_args=(-p "${host_port}:3000")
    fi
  fi
  if [[ -f "${CUTOVER_ENV_DIR:-/opt/avorofin}/env/${role}.env" ]]; then
    env_file_args=(--env-file "${CUTOVER_ENV_DIR:-/opt/avorofin}/env/${role}.env")
  elif [[ -f "${CUTOVER_ENV_DIR:-}/.env.production" && "$role" == "avorofin-app" ]]; then
    env_file_args=(--env-file "${CUTOVER_ENV_DIR}/.env.production")
  fi

  docker rename "$role" "$pre" || return $?
  docker stop "$pre" || true
  record_switched "$role"
  printf '%s=%s\n' "$role" "$expect_id" >>"$JOURNAL_DIR/role_expect_image.txt"

  docker run -d --name "$role" --restart unless-stopped \
    "${user_args[@]}" "${net_args[@]}" "${publish_args[@]}" "${workdir_args[@]}" \
    "${env_file_args[@]}" \
    "$image" || return $?

  local got
  got=$(docker inspect -f '{{.Image}}' "$role") || return $?
  [[ "$got" == "$expect_id" ]] || {
    echo "IMAGE_MISMATCH $role got=$got expect=$expect_id" >&2
    return 4
  }
  return 0
}

rollback() {
  local switched=()
  mapfile -t switched < <(sort -u "$JOURNAL_DIR/switched_roles.txt" | grep -v '^$' || true)
  local role pre
  for role in "${switched[@]}"; do
    pre="${role}-${PRE_SUFFIX}"
    docker stop "$role" 2>/dev/null || true
    docker rm "$role" 2>/dev/null || true
    if docker inspect "$pre" >/dev/null 2>&1; then
      docker rename "$pre" "$role" || {
        echo "ROLLBACK_RENAME_FAILED $role" >&2
        return 5
      }
      docker start "$role" || {
        echo "ROLLBACK_START_FAILED $role" >&2
        return 5
      }
    else
      echo "ROLLBACK_MISSING_PRE $role" >&2
      return 5
    fi
  done

  # Untouched roles must remain; never delete containers that were not switched.
  local c
  for c in "${ROLES[@]}"; do
    if grep -qx "$c" "$JOURNAL_DIR/switched_roles.txt" 2>/dev/null; then
      docker inspect "$c" >/dev/null 2>&1 || {
        echo "FINAL_STATE_MISSING_SWITCHED $c" >&2
        return 6
      }
    else
      # If it existed before plan, it must still exist.
      if [[ -f "$JOURNAL_DIR/preexist_${c}" ]]; then
        docker inspect "$c" >/dev/null 2>&1 || {
          echo "UNTOUCHED_ROLE_REMOVED $c" >&2
          return 6
        }
      fi
    fi
  done
  return 0
}

verify_all_expect_ids() {
  local role got expect
  for role in "${ROLES[@]}"; do
    expect=$(expect_for "$role" || true)
    [[ -n "$expect" ]] || continue
    got=$(docker inspect -f '{{.Image}}' "$role") || return 4
    [[ "$got" == "$expect" ]] || {
      echo "POST_VERIFY_MISMATCH $role got=$got expect=$expect" >&2
      return 4
    }
  done
  return 0
}

cmd=${1:-}
case "$cmd" in
  switch)
    require_env_tag IMAGE_APP
    require_env_tag IMAGE_PROFIT
    require_env_tag IMAGE_V6
    require_env_tag IMAGE_DASHBOARD
    require_env_tag IMAGE_STOCK
    require_env_tag EXPECT_APP
    require_env_tag EXPECT_PROFIT
    require_env_tag EXPECT_V6
    require_env_tag EXPECT_DASHBOARD
    require_env_tag EXPECT_STOCK

    for c in "${ROLES[@]}"; do
      if docker inspect "$c" >/dev/null 2>&1; then
        : >"$JOURNAL_DIR/preexist_${c}"
      fi
    done

    switch_or_fail() {
      local role=$1 image=$2 expect=$3
      set +e
      switch_one "$role" "$image" "$expect"
      local ec=$?
      set -e
      if [[ $ec -ne 0 ]]; then
        log "SWITCH_FAILED ec=$ec"
        rollback || true
        exit "$ec"
      fi
      if [[ "${FAIL_AFTER_ROLE:-}" == "$role" ]]; then
        log "FAIL_MID_TRIGGERED after=$role"
        set +e
        return 3
      fi
      return 0
    }

    set +e
    switch_or_fail avorofin-profit-readmodel-worker "$IMAGE_PROFIT" "$EXPECT_PROFIT" || {
      ec=$?; set -e; log "SWITCH_FAILED ec=$ec"; rollback || true; exit "$ec"
    }
    switch_or_fail avorofin-v6-period-readmodel-worker "$IMAGE_V6" "$EXPECT_V6" || {
      ec=$?; set -e; log "SWITCH_FAILED ec=$ec"; rollback || true; exit "$ec"
    }
    switch_or_fail avorofin-dashboard-period-snapshot-worker "$IMAGE_DASHBOARD" "$EXPECT_DASHBOARD" || {
      ec=$?; set -e; log "SWITCH_FAILED ec=$ec"; rollback || true; exit "$ec"
    }
    switch_or_fail avorofin-stock-planning-snapshot-worker "$IMAGE_STOCK" "$EXPECT_STOCK" || {
      ec=$?; set -e; log "SWITCH_FAILED ec=$ec"; rollback || true; exit "$ec"
    }
    switch_or_fail avorofin-app "$IMAGE_APP" "$EXPECT_APP" || {
      ec=$?; set -e; log "SWITCH_FAILED ec=$ec"; rollback || true; exit "$ec"
    }
    set -e
    verify_all_expect_ids
    log "SWITCH_OK"
    ;;
  rollback)
    rollback
    log "ROLLBACK_OK"
    ;;
  *)
    echo "usage: $0 switch|rollback" >&2
    exit 2
    ;;
esac
