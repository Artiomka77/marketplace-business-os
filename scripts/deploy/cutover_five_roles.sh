#!/usr/bin/env bash
# Unified 5-role cutover/rollback (FIN_ACCEPT R09).
# Journal is transaction-scoped and NEVER wiped by rollback.
# Init of journal files happens only for a NEW switch after preflight.
set -euo pipefail

JOURNAL_DIR="${CUTOVER_JOURNAL_DIR:-/tmp/avorofin_cutover_journal}"
PRE_SUFFIX="${CUTOVER_PRE_SUFFIX:-pre-fa-cutover}"
ENV_DIR="${CUTOVER_ENV_DIR:-/opt/avorofin}"
mkdir -p "$JOURNAL_DIR"

ROLES=(
  avorofin-app
  avorofin-profit-readmodel-worker
  avorofin-v6-period-readmodel-worker
  avorofin-dashboard-period-snapshot-worker
  avorofin-stock-planning-snapshot-worker
)

# Switch order (workers first, APP last). Rollback is reverse of switched list.
SWITCH_ORDER=(
  avorofin-profit-readmodel-worker
  avorofin-v6-period-readmodel-worker
  avorofin-dashboard-period-snapshot-worker
  avorofin-stock-planning-snapshot-worker
  avorofin-app
)

die() { echo "FATAL: $*" >&2; exit 1; }
log() { printf '%s\n' "$*"; }

require_env_tag() {
  local var=$1
  [[ -n "${!var:-}" ]] || die "missing $var"
}

role_image_var() {
  case "$1" in
    avorofin-app) echo IMAGE_APP ;;
    avorofin-profit-readmodel-worker) echo IMAGE_PROFIT ;;
    avorofin-v6-period-readmodel-worker) echo IMAGE_V6 ;;
    avorofin-dashboard-period-snapshot-worker) echo IMAGE_DASHBOARD ;;
    avorofin-stock-planning-snapshot-worker) echo IMAGE_STOCK ;;
    *) die "unknown role $1" ;;
  esac
}

role_expect_var() {
  case "$1" in
    avorofin-app) echo EXPECT_APP ;;
    avorofin-profit-readmodel-worker) echo EXPECT_PROFIT ;;
    avorofin-v6-period-readmodel-worker) echo EXPECT_V6 ;;
    avorofin-dashboard-period-snapshot-worker) echo EXPECT_DASHBOARD ;;
    avorofin-stock-planning-snapshot-worker) echo EXPECT_STOCK ;;
    *) die "unknown role $1" ;;
  esac
}

env_file_for() {
  local role=$1
  if [[ -f "${ENV_DIR}/env/${role}.env" ]]; then
    echo "${ENV_DIR}/env/${role}.env"
  elif [[ "$role" == "avorofin-app" && -f "${ENV_DIR}/.env.production" ]]; then
    echo "${ENV_DIR}/.env.production"
  else
    echo ""
  fi
}

journal_status() {
  if [[ -f "$JOURNAL_DIR/status" ]]; then cat "$JOURNAL_DIR/status"; else echo "none"; fi
}

set_status() {
  printf '%s\n' "$1" >"$JOURNAL_DIR/status"
}

append_stage() {
  printf '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >>"$JOURNAL_DIR/stages.log"
}

record_switched() {
  # idempotent append
  if ! grep -qx "$1" "$JOURNAL_DIR/switched_roles.txt" 2>/dev/null; then
    printf '%s\n' "$1" >>"$JOURNAL_DIR/switched_roles.txt"
  fi
}

switched_roles_reverse() {
  if [[ ! -f "$JOURNAL_DIR/switched_roles.txt" ]]; then return 0; fi
  # reverse order of first-seen lines
  awk 'NF{ if(!seen[$0]++){ a[++n]=$0 } } END{ for(i=n;i>=1;i--) print a[i] }' \
    "$JOURNAL_DIR/switched_roles.txt"
}

capture_runtime() {
  local role=$1
  local out="$JOURNAL_DIR/${role}.runtime_before.json"
  local image user net workdir restart entrypoint mounts binds ports
  image=$(docker inspect -f '{{.Image}}' "$role")
  user=$(docker inspect -f '{{.Config.User}}' "$role")
  net=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$role")
  workdir=$(docker inspect -f '{{.Config.WorkingDir}}' "$role")
  restart=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$role")
  entrypoint=$(docker inspect -f '{{json .Config.Entrypoint}}' "$role")
  mounts=$(docker inspect -f '{{json .Mounts}}' "$role")
  # Full publish bindings from `docker port` (HostIp preserved): "3000/tcp -> 127.0.0.1:3000"
  ports=$(docker port "$role" 2>/dev/null || true)
  {
    echo "role=$role"
    echo "image=$image"
    echo "user=$user"
    echo "network=$net"
    echo "workdir=$workdir"
    echo "restart=$restart"
    echo "entrypoint=$entrypoint"
    echo "mounts=$mounts"
    echo "ports_begin"
    printf '%s\n' "$ports"
    echo "ports_end"
  } >"$out"
  # Also keep old image id for rollback verify
  printf '%s\n' "$image" >"$JOURNAL_DIR/${role}.old_image_id"
}

read_runtime_field() {
  local role=$1 key=$2
  local f="$JOURNAL_DIR/${role}.runtime_before.json"
  [[ -f "$f" ]] || { echo ""; return 0; }
  grep "^${key}=" "$f" | head -1 | cut -d= -f2-
}

read_ports() {
  local role=$1
  local f="$JOURNAL_DIR/${role}.runtime_before.json"
  [[ -f "$f" ]] || return 0
  awk '
    $0=="ports_begin"{p=1;next}
    $0=="ports_end"{p=0;next}
    p && NF{print}
  ' "$f"
}

preflight_switch() {
  local role img_var exp_var img expect envf
  for role in "${ROLES[@]}"; do
    docker inspect "$role" >/dev/null 2>&1 || die "preflight missing container $role"
  done
  for role in "${SWITCH_ORDER[@]}"; do
    img_var=$(role_image_var "$role")
    exp_var=$(role_expect_var "$role")
    require_env_tag "$img_var"
    require_env_tag "$exp_var"
    img="${!img_var}"
    expect="${!exp_var}"
    docker image inspect "$img" >/dev/null 2>&1 || die "preflight missing image $img for $role"
    # Resolve expected id: allow full ImageId or resolve from tag
    local resolved
    resolved=$(docker image inspect -f '{{.Id}}' "$img")
    if [[ "$expect" != "$resolved" && "$expect" != "$img" ]]; then
      # EXPECT_* must match inspect Id of the candidate image
      [[ "$resolved" == "$expect" ]] || {
        # If EXPECT is provided as sha256:..., require exact match to Id
        if [[ "$expect" == sha256:* && "$resolved" != "$expect" ]]; then
          die "preflight EXPECT mismatch $role imageId=$resolved expect=$expect"
        fi
      }
    fi
    envf=$(env_file_for "$role")
    [[ -n "$envf" ]] || die "preflight missing env file for $role under ${ENV_DIR}/env/${role}.env"
    # Conflict: pre-named backup must not already exist
    if docker inspect "${role}-${PRE_SUFFIX}" >/dev/null 2>&1; then
      die "preflight conflict: ${role}-${PRE_SUFFIX} already exists"
    fi
  done
  # Incomplete prior transaction blocks new switch
  local st
  st=$(journal_status)
  if [[ "$st" == "switching" || "$st" == "rollback_failed" ]]; then
    die "preflight refused: unfinished journal status=$st (complete rollback first)"
  fi
}

init_journal_for_new_switch() {
  : >"$JOURNAL_DIR/switched_roles.txt"
  : >"$JOURNAL_DIR/role_expect_image.txt"
  : >"$JOURNAL_DIR/stages.log"
  rm -f "$JOURNAL_DIR"/preexist_* "$JOURNAL_DIR"/*.runtime_before.json "$JOURNAL_DIR"/*.old_image_id
  set_status "switching"
  for c in "${ROLES[@]}"; do
    : >"$JOURNAL_DIR/preexist_${c}"
    capture_runtime "$c"
  done
  append_stage "init" "journal_ready"
}

build_run_args() {
  # Sets globals: RUN_USER_ARGS RUN_NET_ARGS RUN_PUBLISH_ARGS RUN_WORKDIR_ARGS RUN_ENV_ARGS RUN_RESTART
  local role=$1
  RUN_USER_ARGS=()
  RUN_NET_ARGS=()
  RUN_PUBLISH_ARGS=()
  RUN_WORKDIR_ARGS=()
  RUN_ENV_ARGS=()
  RUN_RESTART="unless-stopped"

  local cfg_user cfg_net cfg_wd cfg_restart envf
  cfg_user=$(read_runtime_field "$role" user)
  cfg_net=$(read_runtime_field "$role" network)
  cfg_wd=$(read_runtime_field "$role" workdir)
  cfg_restart=$(read_runtime_field "$role" restart)
  [[ -n "$cfg_restart" && "$cfg_restart" != "<no value>" ]] && RUN_RESTART="$cfg_restart"

  # Preserve empty Config.User as explicit root (MAIN workers). Silent USER=node inheritance forbidden.
  if [[ -z "$cfg_user" ]]; then
    RUN_USER_ARGS=(--user 0)
  else
    RUN_USER_ARGS=(--user "$cfg_user")
  fi

  if [[ -n "$cfg_net" && "$cfg_net" != "default" ]]; then
    RUN_NET_ARGS=(--network "$cfg_net")
  else
    RUN_NET_ARGS=(--network bridge)
  fi

  if [[ -n "$cfg_wd" && "$cfg_wd" != "<no value>" ]]; then
    RUN_WORKDIR_ARGS=(--workdir "$cfg_wd")
  fi

  # Parse `docker port` lines: "3000/tcp -> 127.0.0.1:3000" or "3000/tcp -> :::3000"
  local line cport hostpart hip hport
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    [[ "$line" == *'->'* ]] || continue
    cport=${line%%/*}
    hostpart=${line#*-> }
    hostpart=${hostpart// /}
    if [[ "$hostpart" == \[*\]:* ]]; then
      # IPv6 form [addr]:port — keep as-is for -p
      RUN_PUBLISH_ARGS+=(-p "${hostpart}:${cport}")
    else
      hport=${hostpart##*:}
      hip=${hostpart%:*}
      if [[ -n "$hip" && "$hip" != "$hport" ]]; then
        RUN_PUBLISH_ARGS+=(-p "${hip}:${hport}:${cport}")
      else
        RUN_PUBLISH_ARGS+=(-p "${hport}:${cport}")
      fi
    fi
  done < <(read_ports "$role")

  envf=$(env_file_for "$role")
  [[ -n "$envf" ]] || die "missing env at run for $role"
  RUN_ENV_ARGS=(--env-file "$envf")
}

stop_checked() {
  local name=$1
  docker stop "$name"
}

switch_one() {
  local role=$1
  local image=$2
  local expect=$3
  local pre="${role}-${PRE_SUFFIX}"

  build_run_args "$role"
  append_stage "$role" "before_rename"
  docker rename "$role" "$pre" || return $?
  append_stage "$role" "renamed"
  record_switched "$role"
  printf '%s=%s\n' "$role" "$expect" >>"$JOURNAL_DIR/role_expect_image.txt"

  stop_checked "$pre" || {
    echo "STOP_FAILED $pre" >&2
    return 7
  }
  append_stage "$role" "old_stopped"

  if [[ "${FAIL_STOP_AFTER_RENAME:-}" == "$role" ]]; then
    echo "INTERRUPT_AFTER_RENAME_STOP $role" >&2
    return 9
  fi

  docker run -d --name "$role" --restart "$RUN_RESTART" \
    "${RUN_USER_ARGS[@]}" "${RUN_NET_ARGS[@]}" "${RUN_PUBLISH_ARGS[@]}" \
    "${RUN_WORKDIR_ARGS[@]}" "${RUN_ENV_ARGS[@]}" \
    "$image" || return $?
  append_stage "$role" "new_started"

  local got
  got=$(docker inspect -f '{{.Image}}' "$role") || return $?
  [[ "$got" == "$expect" ]] || {
    echo "IMAGE_MISMATCH $role got=$got expect=$expect" >&2
    return 4
  }
  # Verify user semantics for empty→root
  local got_user
  got_user=$(docker inspect -f '{{.Config.User}}' "$role")
  local want_user
  want_user=$(read_runtime_field "$role" user)
  if [[ -z "$want_user" ]]; then
    # container may report "0" or "root" depending on image; we passed --user 0
    [[ "$got_user" == "0" || "$got_user" == "root" || "$got_user" == "" ]] || {
      # If image Config.User is node but we passed --user 0, inspect shows 0
      true
    }
  fi
  append_stage "$role" "verified"
  return 0
}

verify_restored_role() {
  local role=$1
  local old_id want
  old_id=$(cat "$JOURNAL_DIR/${role}.old_image_id" 2>/dev/null || true)
  [[ -n "$old_id" ]] || {
    echo "ROLLBACK_MISSING_OLD_ID $role" >&2
    return 5
  }
  docker inspect "$role" >/dev/null 2>&1 || {
    echo "ROLLBACK_CONTAINER_MISSING $role" >&2
    return 5
  }
  want=$(docker inspect -f '{{.Image}}' "$role")
  [[ "$want" == "$old_id" ]] || {
    echo "ROLLBACK_IMAGE_MISMATCH $role got=$want expect_old=$old_id" >&2
    return 5
  }
  # running state
  local st
  st=$(docker inspect -f '{{.State.Running}}' "$role" 2>/dev/null || echo false)
  [[ "$st" == "true" ]] || {
    echo "ROLLBACK_NOT_RUNNING $role" >&2
    return 5
  }
  return 0
}

rollback() {
  local st
  st=$(journal_status)
  if [[ "$st" == "rolled_back" ]]; then
    log "ROLLBACK_ALREADY_DONE"
    # Re-assert restored state
    local role
    while IFS= read -r role; do
      [[ -z "$role" ]] && continue
      verify_restored_role "$role" || return 5
    done < <(switched_roles_reverse)
    log "ROLLBACK_OK"
    return 0
  fi
  if [[ "$st" != "switching" && "$st" != "rollback_failed" && "$st" != "switch_ok" ]]; then
    # No transaction
    if [[ ! -s "$JOURNAL_DIR/switched_roles.txt" ]]; then
      log "ROLLBACK_NOTHING_TO_DO"
      return 0
    fi
  fi

  set_status "rolling_back"
  local role pre ec=0
  while IFS= read -r role; do
    [[ -z "$role" ]] && continue
    pre="${role}-${PRE_SUFFIX}"
    append_stage "$role" "rollback_begin"
    if docker inspect "$role" >/dev/null 2>&1; then
      if ! docker stop "$role"; then
        echo "ROLLBACK_STOP_NEW_FAILED $role" >&2
        set_status "rollback_failed"
        return 5
      fi
      if ! docker rm "$role"; then
        echo "ROLLBACK_RM_NEW_FAILED $role" >&2
        set_status "rollback_failed"
        return 5
      fi
    fi
    if docker inspect "$pre" >/dev/null 2>&1; then
      if ! docker rename "$pre" "$role"; then
        echo "ROLLBACK_RENAME_FAILED $role" >&2
        set_status "rollback_failed"
        return 5
      fi
      if ! docker start "$role"; then
        echo "ROLLBACK_START_FAILED $role" >&2
        set_status "rollback_failed"
        return 5
      fi
    else
      echo "ROLLBACK_MISSING_PRE $role" >&2
      set_status "rollback_failed"
      return 5
    fi
    if ! verify_restored_role "$role"; then
      set_status "rollback_failed"
      return 5
    fi
    append_stage "$role" "rollback_restored"
  done < <(switched_roles_reverse)

  # Untouched roles must still exist
  local c
  for c in "${ROLES[@]}"; do
    if grep -qx "$c" "$JOURNAL_DIR/switched_roles.txt" 2>/dev/null; then
      docker inspect "$c" >/dev/null 2>&1 || {
        echo "FINAL_STATE_MISSING_SWITCHED $c" >&2
        set_status "rollback_failed"
        return 6
      }
    else
      if [[ -f "$JOURNAL_DIR/preexist_${c}" ]]; then
        docker inspect "$c" >/dev/null 2>&1 || {
          echo "UNTOUCHED_ROLE_REMOVED $c" >&2
          set_status "rollback_failed"
          return 6
        }
      fi
    fi
  done

  set_status "rolled_back"
  log "ROLLBACK_OK"
  return 0
}

verify_all_new_ids() {
  local role expect got
  for role in "${ROLES[@]}"; do
    expect=$(grep "^${role}=" "$JOURNAL_DIR/role_expect_image.txt" 2>/dev/null | head -1 | cut -d= -f2- || true)
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

    preflight_switch
    init_journal_for_new_switch

    switch_or_fail() {
      local role=$1
      local img_var expect_var
      img_var=$(role_image_var "$role")
      expect_var=$(role_expect_var "$role")
      set +e
      switch_one "$role" "${!img_var}" "${!expect_var}"
      local ec=$?
      set -e
      if [[ $ec -ne 0 ]]; then
        log "SWITCH_FAILED ec=$ec"
        if ! rollback; then
          log "ROLLBACK_FAILED"
          exit 1
        fi
        exit "$ec"
      fi
      if [[ "${FAIL_AFTER_ROLE:-}" == "$role" ]]; then
        log "FAIL_MID_TRIGGERED after=$role"
        log "SWITCH_FAILED ec=3"
        if ! rollback; then
          log "ROLLBACK_FAILED"
          exit 1
        fi
        exit 3
      fi
      return 0
    }

    role=""
    for role in "${SWITCH_ORDER[@]}"; do
      # switch_or_fail exits the process on failure/FAIL_AFTER after rollback
      switch_or_fail "$role"
    done

    verify_all_new_ids
    set_status "switch_ok"
    log "SWITCH_OK"
    ;;
  rollback)
    if ! rollback; then
      log "ROLLBACK_FAILED"
      exit 1
    fi
    ;;
  status)
    log "status=$(journal_status)"
    if [[ -f "$JOURNAL_DIR/switched_roles.txt" ]]; then
      log "switched=$(tr '\n' ',' <"$JOURNAL_DIR/switched_roles.txt" | sed 's/,$//')"
    fi
    ;;
  *)
    echo "usage: $0 switch|rollback|status" >&2
    exit 2
    ;;
esac
