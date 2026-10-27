#!/usr/bin/env bash
# Unified 5-role cutover/rollback (FIN_ACCEPT R11).
# Journal is transaction-scoped and NEVER wiped by rollback.
# Init of journal files happens only for a NEW switch after preflight.
# Rollback is identity-aware and resumable after partial restore / crash.
set -euo pipefail

JOURNAL_DIR="${CUTOVER_JOURNAL_DIR:-/tmp/avorofin_cutover_journal}"
PRE_SUFFIX="${CUTOVER_PRE_SUFFIX:-pre-fa-cutover}"
ENV_DIR="${CUTOVER_ENV_DIR:-/opt/avorofin}"
mkdir -p "$JOURNAL_DIR"
chmod 700 "$JOURNAL_DIR" 2>/dev/null || true

ROLES=(
  avorofin-app
  avorofin-profit-readmodel-worker
  avorofin-v6-period-readmodel-worker
  avorofin-dashboard-period-snapshot-worker
  avorofin-stock-planning-snapshot-worker
)

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

# Prefer explicit env files; else journal-captured runtime env (MAIN has no /env dir).
env_file_for() {
  local role=$1
  if [[ -f "${ENV_DIR}/env/${role}.env" ]]; then
    echo "${ENV_DIR}/env/${role}.env"
  elif [[ "$role" == "avorofin-app" && -f "${ENV_DIR}/.env.production" ]]; then
    echo "${ENV_DIR}/.env.production"
  elif [[ -f "$JOURNAL_DIR/${role}.env.captured" ]]; then
    echo "$JOURNAL_DIR/${role}.env.captured"
  else
    echo ""
  fi
}

capture_env_from_container() {
  local role=$1
  local out="$JOURNAL_DIR/${role}.env.captured"
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$role" >"$out"
  chmod 600 "$out" 2>/dev/null || true
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
  if ! grep -qx "$1" "$JOURNAL_DIR/switched_roles.txt" 2>/dev/null; then
    printf '%s\n' "$1" >>"$JOURNAL_DIR/switched_roles.txt"
  fi
}

write_role_meta() {
  local role=$1
  local f="$JOURNAL_DIR/${role}.role_meta"
  shift
  local pair k v
  touch "$f"
  for pair in "$@"; do
    k=${pair%%=*}
    v=${pair#*=}
    if grep -q "^${k}=" "$f" 2>/dev/null; then
      grep -v "^${k}=" "$f" >"${f}.tmp" || true
      mv "${f}.tmp" "$f"
    fi
    printf '%s=%s\n' "$k" "$v" >>"$f"
  done
}

read_role_meta() {
  local role=$1 key=$2
  local f="$JOURNAL_DIR/${role}.role_meta"
  [[ -f "$f" ]] || { echo ""; return 0; }
  grep "^${key}=" "$f" | head -1 | cut -d= -f2-
}

expect_image_for_role() {
  local role=$1
  local from_meta from_file
  from_meta=$(read_role_meta "$role" replacement_expect)
  if [[ -n "$from_meta" ]]; then echo "$from_meta"; return 0; fi
  from_file=$(grep "^${role}=" "$JOURNAL_DIR/role_expect_image.txt" 2>/dev/null | head -1 | cut -d= -f2- || true)
  echo "$from_file"
}

switched_roles_reverse() {
  if [[ ! -f "$JOURNAL_DIR/switched_roles.txt" ]]; then return 0; fi
  awk 'NF{ if(!seen[$0]++){ a[++n]=$0 } } END{ for(i=n;i>=1;i--) print a[i] }' \
    "$JOURNAL_DIR/switched_roles.txt"
}

roles_needing_rollback_reverse() {
  local role pre old_id img
  declare -A seen=()
  local list=()
  while IFS= read -r role; do
    [[ -z "$role" ]] && continue
    list+=("$role")
    seen["$role"]=1
  done < <(switched_roles_reverse)
  for role in "${ROLES[@]}"; do
    [[ -n "${seen[$role]:-}" ]] && continue
    pre="${role}-${PRE_SUFFIX}"
    old_id=$(cat "$JOURNAL_DIR/${role}.old_image_id" 2>/dev/null || true)
    [[ -n "$old_id" ]] || continue
    if docker inspect "$pre" >/dev/null 2>&1; then
      img=$(docker inspect -f '{{.Image}}' "$pre" 2>/dev/null || true)
      if [[ "$img" == "$old_id" ]]; then
        record_switched "$role"
        list=("$role" "${list[@]}")
        seen["$role"]=1
        append_stage "$role" "discovered_orphan_backup"
      fi
    fi
  done
  declare -A printed=()
  local r
  for r in "${list[@]}"; do
    [[ -n "${printed[$r]:-}" ]] && continue
    printed["$r"]=1
    printf '%s\n' "$r"
  done
}

capture_runtime() {
  local role=$1
  local out="$JOURNAL_DIR/${role}.runtime_before.json"
  local image user net workdir restart entrypoint mounts ports cid
  image=$(docker inspect -f '{{.Image}}' "$role")
  cid=$(docker inspect -f '{{.Id}}' "$role")
  user=$(docker inspect -f '{{.Config.User}}' "$role")
  net=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$role")
  workdir=$(docker inspect -f '{{.Config.WorkingDir}}' "$role")
  restart=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$role")
  entrypoint=$(docker inspect -f '{{json .Config.Entrypoint}}' "$role")
  mounts=$(docker inspect -f '{{json .Mounts}}' "$role")
  ports=$(docker port "$role" 2>/dev/null || true)
  {
    echo "role=$role"
    echo "image=$image"
    echo "id=$cid"
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
  printf '%s\n' "$image" >"$JOURNAL_DIR/${role}.old_image_id"
  printf '%s\n' "$cid" >"$JOURNAL_DIR/${role}.old_container_id"
  write_role_meta "$role" \
    "old_image_id=$image" \
    "old_container_id=$cid" \
    "backup_name=${role}-${PRE_SUFFIX}" \
    "restored=0" \
    "phase=captured"
  capture_env_from_container "$role"
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

container_image() {
  docker inspect -f '{{.Image}}' "$1" 2>/dev/null || true
}

container_id() {
  docker inspect -f '{{.Id}}' "$1" 2>/dev/null || true
}

container_running() {
  docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false
}

preflight_switch() {
  local role img_var exp_var img expect envf env_count
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
    local resolved
    resolved=$(docker image inspect -f '{{.Id}}' "$img")
    if [[ "$expect" != "$resolved" && "$expect" != "$img" ]]; then
      if [[ "$expect" == sha256:* && "$resolved" != "$expect" ]]; then
        die "preflight EXPECT mismatch $role imageId=$resolved expect=$expect"
      fi
    fi
    envf=$(env_file_for "$role")
    if [[ -z "$envf" ]]; then
      env_count=$(docker inspect -f '{{len .Config.Env}}' "$role" 2>/dev/null || echo 0)
      [[ "$env_count" -ge 1 ]] || die "preflight missing env file for $role under ${ENV_DIR}/env/${role}.env and empty Config.Env"
    fi
    if docker inspect "${role}-${PRE_SUFFIX}" >/dev/null 2>&1; then
      die "preflight conflict: ${role}-${PRE_SUFFIX} already exists"
    fi
  done
  local st
  st=$(journal_status)
  if [[ "$st" == "switching" || "$st" == "rollback_failed" || "$st" == "rolling_back" ]]; then
    die "preflight refused: unfinished journal status=$st (complete rollback first)"
  fi
}

init_journal_for_new_switch() {
  : >"$JOURNAL_DIR/switched_roles.txt"
  : >"$JOURNAL_DIR/role_expect_image.txt"
  : >"$JOURNAL_DIR/stages.log"
  rm -f "$JOURNAL_DIR"/preexist_* \
    "$JOURNAL_DIR"/*.runtime_before.json \
    "$JOURNAL_DIR"/*.old_image_id \
    "$JOURNAL_DIR"/*.old_container_id \
    "$JOURNAL_DIR"/*.role_meta \
    "$JOURNAL_DIR"/*.env.captured
  set_status "switching"
  for c in "${ROLES[@]}"; do
    : >"$JOURNAL_DIR/preexist_${c}"
    capture_runtime "$c"
  done
  append_stage "init" "journal_ready"
}

build_run_args() {
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

  local line cport hostpart hip hport
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    [[ "$line" == *'->'* ]] || continue
    cport=${line%%/*}
    hostpart=${line#*-> }
    hostpart=${hostpart// /}
    if [[ "$hostpart" == \[*\]:* ]]; then
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
  local cid

  build_run_args "$role"
  cid=$(container_id "$role")
  write_role_meta "$role" \
    "phase=before_rename" \
    "old_container_id=$cid" \
    "backup_name=$pre" \
    "replacement_expect=$expect" \
    "restored=0"
  append_stage "$role" "before_rename"

  if ! grep -q "^${role}=" "$JOURNAL_DIR/role_expect_image.txt" 2>/dev/null; then
    printf '%s=%s\n' "$role" "$expect" >>"$JOURNAL_DIR/role_expect_image.txt"
  fi

  docker rename "$role" "$pre" || return $?
  record_switched "$role"
  write_role_meta "$role" "phase=renamed"
  append_stage "$role" "renamed"

  if [[ "${EXIT_AFTER_RENAME:-}" == "$role" ]]; then
    echo "EXIT_AFTER_RENAME $role" >&2
    exit 9
  fi

  stop_checked "$pre" || {
    echo "STOP_FAILED $pre" >&2
    return 7
  }
  write_role_meta "$role" "phase=old_stopped"
  append_stage "$role" "old_stopped"

  if [[ "${FAIL_STOP_AFTER_RENAME:-}" == "$role" ]]; then
    echo "INTERRUPT_AFTER_RENAME_STOP $role" >&2
    return 9
  fi

  docker run -d --name "$role" --restart "$RUN_RESTART" \
    "${RUN_USER_ARGS[@]}" "${RUN_NET_ARGS[@]}" "${RUN_PUBLISH_ARGS[@]}" \
    "${RUN_WORKDIR_ARGS[@]}" "${RUN_ENV_ARGS[@]}" \
    "$image" || return $?
  write_role_meta "$role" "phase=new_started" "replacement_container_id=$(container_id "$role")"
  append_stage "$role" "new_started"

  local got
  got=$(container_image "$role") || return $?
  [[ "$got" == "$expect" ]] || {
    echo "IMAGE_MISMATCH $role got=$got expect=$expect" >&2
    return 4
  }
  append_stage "$role" "verified"
  write_role_meta "$role" "phase=verified"
  return 0
}

ensure_running() {
  local role=$1
  local st
  st=$(container_running "$role")
  if [[ "$st" == "true" ]]; then return 0; fi
  docker start "$role"
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
  want=$(container_image "$role")
  [[ "$want" == "$old_id" ]] || {
    echo "ROLLBACK_IMAGE_MISMATCH $role got=$want expect_old=$old_id" >&2
    return 5
  }
  local st
  st=$(container_running "$role")
  [[ "$st" == "true" ]] || {
    echo "ROLLBACK_NOT_RUNNING $role" >&2
    return 5
  }
  return 0
}

# Identity-aware single-role restore. Never delete a proven original.
rollback_one_role() {
  local role=$1
  local pre old_id expect_new cur_img cur_id pre_img restored
  pre=$(read_role_meta "$role" backup_name)
  [[ -n "$pre" ]] || pre="${role}-${PRE_SUFFIX}"
  old_id=$(cat "$JOURNAL_DIR/${role}.old_image_id" 2>/dev/null || true)
  expect_new=$(expect_image_for_role "$role")
  restored=$(read_role_meta "$role" restored)

  append_stage "$role" "rollback_begin"

  if [[ "$restored" == "1" ]]; then
    if verify_restored_role "$role"; then
      append_stage "$role" "rollback_already_restored"
      return 0
    fi
  fi

  if docker inspect "$role" >/dev/null 2>&1; then
    cur_img=$(container_image "$role")
    cur_id=$(container_id "$role")
    local repl_id is_replacement=0
    repl_id=$(read_role_meta "$role" replacement_container_id)
    if [[ -n "$old_id" && "$cur_img" == "$old_id" ]]; then
      if ! ensure_running "$role"; then
        echo "ROLLBACK_START_FAILED $role" >&2
        return 5
      fi
      if ! verify_restored_role "$role"; then return 5; fi
      write_role_meta "$role" "restored=1" "phase=rollback_restored"
      append_stage "$role" "rollback_restored_inplace"
      return 0
    fi
    # Proven replacement from this transaction only (ImageId and/or recorded Id).
    # Do NOT treat "not old" alone as removable — unknown foreign must refuse.
    if [[ -n "$expect_new" && "$cur_img" == "$expect_new" ]]; then is_replacement=1; fi
    if [[ -n "$repl_id" && -n "$cur_id" && "$cur_id" == "$repl_id" ]]; then is_replacement=1; fi
    if [[ "$is_replacement" -eq 1 ]]; then
      if ! docker stop "$role"; then
        echo "ROLLBACK_STOP_NEW_FAILED $role" >&2
        return 5
      fi
      if ! docker rm "$role"; then
        echo "ROLLBACK_RM_NEW_FAILED $role" >&2
        return 5
      fi
      append_stage "$role" "rollback_removed_replacement"
    else
      echo "ROLLBACK_UNKNOWN_STATE $role image=$cur_img old=$old_id expect_new=$expect_new id=$cur_id" >&2
      return 5
    fi
  fi

  if docker inspect "$pre" >/dev/null 2>&1; then
    pre_img=$(container_image "$pre")
    if [[ -n "$old_id" && "$pre_img" != "$old_id" ]]; then
      echo "ROLLBACK_BACKUP_IMAGE_MISMATCH $role backup=$pre_img expect_old=$old_id" >&2
      return 5
    fi
    if ! docker rename "$pre" "$role"; then
      echo "ROLLBACK_RENAME_FAILED $role" >&2
      return 5
    fi
    if ! docker start "$role"; then
      echo "ROLLBACK_START_FAILED $role" >&2
      return 5
    fi
  else
    if ! docker inspect "$role" >/dev/null 2>&1; then
      echo "ROLLBACK_MISSING_PRE $role" >&2
      return 5
    fi
  fi

  if ! verify_restored_role "$role"; then return 5; fi
  write_role_meta "$role" "restored=1" "phase=rollback_restored"
  append_stage "$role" "rollback_restored"
  return 0
}

rollback() {
  local st
  st=$(journal_status)
  if [[ "$st" == "rolled_back" ]]; then
    log "ROLLBACK_ALREADY_DONE"
    local role
    while IFS= read -r role; do
      [[ -z "$role" ]] && continue
      verify_restored_role "$role" || return 5
    done < <(switched_roles_reverse)
    log "ROLLBACK_OK"
    return 0
  fi
  if [[ "$st" != "switching" && "$st" != "rollback_failed" && "$st" != "switch_ok" && "$st" != "rolling_back" ]]; then
    if [[ ! -s "$JOURNAL_DIR/switched_roles.txt" ]]; then
      local any=0
      while IFS= read -r role; do
        [[ -z "$role" ]] && continue
        any=1
      done < <(roles_needing_rollback_reverse)
      if [[ "$any" -eq 0 ]]; then
        log "ROLLBACK_NOTHING_TO_DO"
        return 0
      fi
    fi
  fi

  set_status "rolling_back"
  local role
  while IFS= read -r role; do
    [[ -z "$role" ]] && continue
    if ! rollback_one_role "$role"; then
      set_status "rollback_failed"
      return 5
    fi
  done < <(roles_needing_rollback_reverse)

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
    expect=$(expect_image_for_role "$role")
    [[ -n "$expect" ]] || continue
    got=$(container_image "$role") || return 4
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
