#!/usr/bin/env bash
# Acceptance suite for cutover_five_roles.sh (R09).
# Asserts separate-process rollback restores OLD image IDs; HostIp bindings; root user.
set -euo pipefail

ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
log() { printf '%s\n' "$*"; }
fail() { echo "ASSERT_FAIL: $*" >&2; exit 1; }

CASE="${1:-all}"

STATE="$ROOT/state"
mkdir -p "$STATE/env" "$STATE/bins" "$STATE/containers" "$STATE/journal" "$STATE/images"
PATH="$STATE/bins:$PATH"
export MOCK_STATE="$STATE"
export CUTOVER_JOURNAL_DIR="$STATE/journal"
export CUTOVER_ENV_DIR="$STATE"
export CUTOVER_PRE_SUFFIX="pre-fa-cutover"
export IMAGE_APP=avorofin-p0-cogs-app:fin_accept_r09
export IMAGE_PROFIT=avorofin-p0-cogs-profit:fin_accept_r09
export IMAGE_V6=avorofin-p0-cogs-v6:fin_accept_r09
export IMAGE_DASHBOARD=avorofin-p0-cogs-dashboard:fin_accept_r09
export IMAGE_STOCK=avorofin-p0-cogs-stock:fin_accept_r09
export EXPECT_APP=sha256:app_ok
export EXPECT_PROFIT=sha256:profit_ok
export EXPECT_V6=sha256:v6_ok
export EXPECT_DASHBOARD=sha256:dash_ok
export EXPECT_STOCK=sha256:stock_ok

CUTOVER_SRC="$(cd "$(dirname "$0")" && pwd)/cutover_five_roles.sh"
ROLES=(avorofin-app avorofin-profit-readmodel-worker avorofin-v6-period-readmodel-worker
       avorofin-dashboard-period-snapshot-worker avorofin-stock-planning-snapshot-worker)

install_docker_mock() {
  cat >"$STATE/bins/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STATE_DIR="${MOCK_STATE:?}"
cmd=${1:-}
shift || true
case "$cmd" in
  rename)
    old=$1; new=$2
    test -f "$STATE_DIR/containers/$old" || { echo "missing $old" >&2; exit 1; }
    if [[ -f "$STATE_DIR/containers/$new" ]]; then echo "conflict $new" >&2; exit 1; fi
    mv "$STATE_DIR/containers/$old" "$STATE_DIR/containers/$new"
    ;;
  stop)
    name=$1
    test -f "$STATE_DIR/containers/$name" || { echo "missing $name" >&2; exit 1; }
    if [[ "${MOCK_FAIL_STOP:-}" == "$name" ]]; then echo "stop failed $name" >&2; exit 1; fi
    # mark stopped
    grep -v '^running=' "$STATE_DIR/containers/$name" >"$STATE_DIR/containers/$name.tmp" || true
    mv "$STATE_DIR/containers/$name.tmp" "$STATE_DIR/containers/$name"
    echo "running=false" >>"$STATE_DIR/containers/$name"
    ;;
  start)
    name=$1
    test -f "$STATE_DIR/containers/$name" || { echo "missing $name" >&2; exit 1; }
    if [[ "${MOCK_FAIL_START:-}" == "$name" ]]; then echo "start failed $name" >&2; exit 1; fi
    grep -v '^running=' "$STATE_DIR/containers/$name" >"$STATE_DIR/containers/$name.tmp" || true
    mv "$STATE_DIR/containers/$name.tmp" "$STATE_DIR/containers/$name"
    echo "running=true" >>"$STATE_DIR/containers/$name"
    ;;
  rm)
    rm -f "$STATE_DIR/containers/$1"
    ;;
  port)
    name=$1
    if [[ -f "$STATE_DIR/containers/$name" ]] && grep -q '^port=' "$STATE_DIR/containers/$name"; then
      while IFS= read -r pl; do
        hip=${pl%%:*}; rest=${pl#*:}; hport=${rest%%:*}; cport=${rest#*:}
        echo "${cport}/tcp -> ${hip}:${hport}"
      done < <(grep '^port=' "$STATE_DIR/containers/$name" | cut -d= -f2-)
    fi
    ;;
  image)
    sub=${1:-}; shift || true
    if [[ "$sub" != "inspect" ]]; then echo "unhandled docker image $sub" >&2; exit 1; fi
    fmt=""; name=""
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "-f" ]]; then fmt=$2; shift 2; continue; fi
      name=$1; shift || true
    done
    # tag -> id map
    case "$name" in
      avorofin-p0-cogs-app:fin_accept_r09) id=sha256:app_ok ;;
      avorofin-p0-cogs-profit:fin_accept_r09) id=sha256:profit_ok ;;
      avorofin-p0-cogs-v6:fin_accept_r09) id=sha256:v6_ok ;;
      avorofin-p0-cogs-dashboard:fin_accept_r09) id=sha256:dash_ok ;;
      avorofin-p0-cogs-stock:fin_accept_r09) id=sha256:stock_ok ;;
      *)
        if [[ -f "$STATE_DIR/images/$name" ]]; then id=$(cat "$STATE_DIR/images/$name"); else echo "no such image $name" >&2; exit 1; fi
        ;;
    esac
    if [[ "$fmt" == "{{.Id}}" ]]; then echo "$id"; else echo "{}"; fi
    ;;
  inspect)
    fmt=""; name=""
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "-f" ]]; then fmt=$2; shift 2; continue; fi
      name=$1; shift || true
    done
    if [[ ! -f "$STATE_DIR/containers/$name" ]]; then
      echo "No such container: $name" >&2
      exit 1
    fi
    case "$fmt" in
      "{{.Image}}") grep '^image=' "$STATE_DIR/containers/$name" | tail -1 | cut -d= -f2 ;;
      "{{.Id}}") grep '^id=' "$STATE_DIR/containers/$name" | tail -1 | cut -d= -f2 ;;
      "{{.Config.User}}") grep '^user=' "$STATE_DIR/containers/$name" | tail -1 | cut -d= -f2- ;;
      "{{.HostConfig.NetworkMode}}") grep '^network=' "$STATE_DIR/containers/$name" | tail -1 | cut -d= -f2- ;;
      "{{.Config.WorkingDir}}") grep '^workdir=' "$STATE_DIR/containers/$name" | tail -1 | cut -d= -f2- ;;
      "{{.HostConfig.RestartPolicy.Name}}") grep '^restart=' "$STATE_DIR/containers/$name" | tail -1 | cut -d= -f2- ;;
      "{{json .Config.Entrypoint}}") echo '["docker-entrypoint.sh"]' ;;
      "{{json .Config.Cmd}}")
        case "$name" in
          avorofin-app) echo '["node","server.js"]' ;;
          avorofin-profit-readmodel-worker) echo '["node","--import","tsx","scripts/dashboard/runProfitReadModelWorker.ts"]' ;;
          avorofin-v6-period-readmodel-worker) echo '["node","--import","tsx","scripts/dashboard/runV6PeriodReadModelWorker.ts"]' ;;
          *) echo '["node","--import","tsx","scripts/dashboard/runDashboardPeriodSnapshotWorker.ts"]' ;;
        esac
        ;;
      "{{json .Mounts}}") echo '[]' ;;
      "{{len .Config.Env}}")
        if [[ -f "$STATE_DIR/env_len_override_$name" ]]; then
          cat "$STATE_DIR/env_len_override_$name"
        else
          echo 6
        fi
        ;;
      "{{range .Config.Env}}{{println .}}{{end}}")
        if [[ -f "$STATE_DIR/env_len_override_$name" ]] && [[ "$(cat "$STATE_DIR/env_len_override_$name")" == "0" ]]; then
          :
        else
          echo "DATABASE_URL=postgresql://x"
          echo "NODE_ENV=production"
          echo "HOSTNAME=mock"
          echo "WAVE_B_PROFIT_WORKER_MODE=queue-once"
          echo "V6_READMODEL_WORKER_MODE=queue-once"
          echo "V6_READMODEL_TARGET_DATABASE_URL=postgresql://x"
          echo "DASHBOARD_SNAPSHOT_WORKER_MODE=continuous"
        fi
        ;;
      "{{.State.Running}}")
        if grep -q '^running=false' "$STATE_DIR/containers/$name"; then echo false; else echo true; fi
        ;;
      *) echo "{}" ;;
    esac
    ;;
  run)
    printf "RUN_ARGS %s\n" "$*" >> "$STATE_DIR/run_calls.txt"
    name=""; image=""; user=""; network="bridge"; workdir="/app"; restart="unless-stopped"
    declare -a pubs=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --name) name=${2:?}; shift 2 ;;
        -d|--detach) shift ;;
        --restart) restart=$2; shift 2 ;;
        --user) user=$2; shift 2 ;;
        --network) network=$2; shift 2 ;;
        --workdir) workdir=$2; shift 2 ;;
        --env-file) shift 2 ;;
        -p|--publish) pubs+=("$2"); shift 2 ;;
        -*) shift ;;
        *) image=$1; break ;;
      esac
    done
    test -n "$name" || { echo "docker run missing --name" >&2; exit 1; }
    expect="$image"
    case "$name" in
      avorofin-app) expect="${EXPECT_APP}" ;;
      avorofin-profit-readmodel-worker) expect="${EXPECT_PROFIT}" ;;
      avorofin-v6-period-readmodel-worker) expect="${EXPECT_V6}" ;;
      avorofin-dashboard-period-snapshot-worker) expect="${EXPECT_DASHBOARD}" ;;
      avorofin-stock-planning-snapshot-worker) expect="${EXPECT_STOCK}" ;;
    esac
    if [[ "${MOCK_BAD_NEW_ID:-0}" == "1" && "$name" == avorofin-profit-readmodel-worker ]]; then
      expect="sha256:WRONG"
    fi
    {
      echo "image=$expect"
      echo "id=sha256:new_${name}_$$"
      echo "user=$user"
      echo "network=$network"
      echo "workdir=$workdir"
      echo "restart=$restart"
      echo "running=true"
      for p in "${pubs[@]+"${pubs[@]}"}"; do echo "port=$p"; done
    } >"$STATE_DIR/containers/$name"
    ;;
  *) echo "unhandled docker $cmd" >&2; exit 1 ;;
esac
EOF
  chmod +x "$STATE/bins/docker"
}

reset_state() {
  rm -rf "$STATE/containers" "$STATE/journal" "$STATE/env" "$STATE/run_calls.txt"
  mkdir -p "$STATE/containers" "$STATE/journal" "$STATE/env" "$STATE/bins"
  : >"$STATE/run_calls.txt"
}

seed_containers() {
  local missing_old=${1:-0}
  reset_state
  for c in "${ROLES[@]}"; do
    if [[ "$missing_old" == "1" && "$c" == avorofin-app ]]; then continue; fi
    local user="" network=bridge
    local ports=""
    if [[ "$c" == avorofin-app ]]; then
      user=nextjs
      ports="port=127.0.0.1:3000:3000"
      network=bridge
    elif [[ "$c" == avorofin-dashboard-period-snapshot-worker || "$c" == avorofin-stock-planning-snapshot-worker ]]; then
      user=""   # root workers
      network=host
    else
      user=""   # root workers
      network=bridge
    fi
    {
      echo "image=sha256:old_$c"
      echo "id=sha256:cid_old_$c"
      echo "user=$user"
      echo "network=$network"
      echo "workdir=/app"
      echo "restart=unless-stopped"
      echo "running=true"
      if [[ -n "$ports" ]]; then echo "$ports"; fi
    } >"$STATE/containers/$c"
    mkdir -p "$STATE/env"
    echo "DATABASE_URL=postgresql://x" >"$STATE/env/${c}.env"
  done
}

assert_old_images() {
  local c got
  for c in "${ROLES[@]}"; do
    [[ -f "$STATE/containers/$c" ]] || fail "missing $c after rollback"
    got=$(grep '^image=' "$STATE/containers/$c" | tail -1 | cut -d= -f2)
    [[ "$got" == "sha256:old_$c" ]] || fail "$c image=$got want=sha256:old_$c"
  done
}

assert_new_images() {
  local c got want
  declare -A map=(
    [avorofin-app]=sha256:app_ok
    [avorofin-profit-readmodel-worker]=sha256:profit_ok
    [avorofin-v6-period-readmodel-worker]=sha256:v6_ok
    [avorofin-dashboard-period-snapshot-worker]=sha256:dash_ok
    [avorofin-stock-planning-snapshot-worker]=sha256:stock_ok
  )
  for c in "${ROLES[@]}"; do
    got=$(grep '^image=' "$STATE/containers/$c" | tail -1 | cut -d= -f2)
    want=${map[$c]}
    [[ "$got" == "$want" ]] || fail "$c image=$got want=$want"
  done
}

case_normal_switch_separate_rollback() {
  log "CASE normal_switch_separate_rollback"
  install_docker_mock
  seed_containers 0
  bash "$CUTOVER_SRC" switch
  assert_new_images
  local j
  j=$(grep -c . "$STATE/journal/switched_roles.txt" || true)
  [[ "$j" == "5" ]] || fail "journal=$j want=5"
  # NEW process rollback (fresh bash)
  bash "$CUTOVER_SRC" rollback
  assert_old_images
  # journal must still list switched roles (not wiped)
  j=$(grep -c . "$STATE/journal/switched_roles.txt" || true)
  [[ "$j" == "5" ]] || fail "journal wiped after rollback j=$j"
  [[ "$(cat "$STATE/journal/status")" == "rolled_back" ]] || fail "status not rolled_back"
  # idempotent
  bash "$CUTOVER_SRC" rollback | tee "$STATE/idempotent.txt"
  grep -q ROLLBACK_ALREADY_DONE "$STATE/idempotent.txt" || grep -q ROLLBACK_OK "$STATE/idempotent.txt" || fail "idempotent rollback"
  assert_old_images
  log "PASS normal_switch_separate_rollback"
}

case_bindings_and_root_user() {
  log "CASE bindings_and_root_user"
  install_docker_mock
  seed_containers 0
  bash "$CUTOVER_SRC" switch
  grep -F 'RUN_ARGS' "$STATE/run_calls.txt" | grep avorofin-app | grep -F '127.0.0.1:3000:3000' \
    || fail "APP lost HostIp binding"
  grep -F 'RUN_ARGS' "$STATE/run_calls.txt" | grep avorofin-profit-readmodel-worker | grep -E -- '--user 0' \
    || fail "profit missing explicit --user 0 for empty Config.User"
  grep -F 'RUN_ARGS' "$STATE/run_calls.txt" | grep avorofin-stock-planning-snapshot-worker | grep -E -- '--network host' \
    || fail "stock network not host"
  bash "$CUTOVER_SRC" rollback
  assert_old_images
  log "PASS bindings_and_root_user"
}

case_bad_new_id() {
  log "CASE bad_new_id"
  install_docker_mock
  seed_containers 0
  export MOCK_BAD_NEW_ID=1
  set +e
  bash "$CUTOVER_SRC" switch
  ec=$?
  set -e
  [[ $ec -ne 0 ]] || fail "expected switch failure"
  assert_old_images
  unset MOCK_BAD_NEW_ID
  log "PASS bad_new_id"
}

case_fail_after_each_role() {
  local role
  local order=(avorofin-profit-readmodel-worker avorofin-v6-period-readmodel-worker
    avorofin-dashboard-period-snapshot-worker avorofin-stock-planning-snapshot-worker avorofin-app)
  for role in "${order[@]}"; do
    log "CASE fail_after_$role"
    rm -rf "$STATE/containers" "$STATE/journal" "$STATE/env" "$STATE/bins" "$STATE/run_calls.txt"
    mkdir -p "$STATE/containers" "$STATE/journal" "$STATE/env" "$STATE/bins"
    install_docker_mock
    seed_containers 0
    export FAIL_AFTER_ROLE="$role"
    set +e
    out=$(bash "$CUTOVER_SRC" switch 2>&1)
    ec=$?
    set -e
    printf '%s\n' "$out"
    [[ $ec -ne 0 ]] || fail "expected fail after $role ec=$ec"
    echo "$out" | grep -q FAIL_MID_TRIGGERED || fail "missing FAIL_MID for $role"
    echo "$out" | grep -q ROLLBACK_OK || fail "missing ROLLBACK_OK for $role"
    assert_old_images
    unset FAIL_AFTER_ROLE
    log "PASS fail_after_$role"
  done
}

case_missing_env_preflight() {
  log "CASE missing_env_preflight"
  install_docker_mock
  seed_containers 0
  rm -f "$STATE/env/avorofin-app.env"
  # Also empty Config.Env: mock returns len via marker file
  echo 0 >"$STATE/env_len_override_avorofin-app"
  set +e
  bash "$CUTOVER_SRC" switch >"$STATE/out.txt" 2>"$STATE/err.txt"
  ec=$?
  set -e
  rm -f "$STATE/env_len_override_avorofin-app"
  [[ $ec -ne 0 ]] || fail "expected preflight fail"
  grep -qi 'missing env' "$STATE/err.txt" || fail "expected missing env message"
  for c in "${ROLES[@]}"; do
    [[ -f "$STATE/containers/${c}-pre-fa-cutover" ]] && fail "mutated despite preflight"
  done
  assert_old_images
  log "PASS missing_env_preflight"
}

case_missing_old_preflight() {
  log "CASE missing_old_preflight"
  install_docker_mock
  seed_containers 1
  set +e
  bash "$CUTOVER_SRC" switch >"$STATE/out.txt" 2>"$STATE/err.txt"
  ec=$?
  set -e
  [[ $ec -ne 0 ]] || fail "expected missing container preflight fail"
  grep -qi 'missing container' "$STATE/err.txt" || fail "expected missing container message"
  log "PASS missing_old_preflight"
}

case_stop_failure_rollback() {
  log "CASE stop_failure_on_rollback"
  install_docker_mock
  seed_containers 0
  bash "$CUTOVER_SRC" switch
  assert_new_images
  export MOCK_FAIL_STOP=avorofin-app
  set +e
  bash "$CUTOVER_SRC" rollback >"$STATE/out.txt" 2>"$STATE/err.txt"
  ec=$?
  set -e
  [[ $ec -ne 0 ]] || fail "expected rollback fail"
  grep -q ROLLBACK_FAILED "$STATE/out.txt" || fail "expected ROLLBACK_FAILED"
  [[ "$(cat "$STATE/journal/status")" == "rollback_failed" ]] || fail "status rollback_failed"
  unset MOCK_FAIL_STOP
  # journal preserved
  [[ -s "$STATE/journal/switched_roles.txt" ]] || fail "journal wiped on failed rollback"
  log "PASS stop_failure_on_rollback"
}

case_interrupt_after_rename() {
  log "CASE interrupt_after_rename"
  install_docker_mock
  seed_containers 0
  export FAIL_STOP_AFTER_RENAME=avorofin-profit-readmodel-worker
  set +e
  bash "$CUTOVER_SRC" switch
  ec=$?
  set -e
  [[ $ec -ne 0 ]] || fail "expected interrupt failure"
  assert_old_images
  unset FAIL_STOP_AFTER_RENAME
  log "PASS interrupt_after_rename"
}

# R11: partial rollback then NEW process retry must not destroy restored originals.
case_retry_after_partial_restore() {
  log "CASE retry_after_partial_restore"
  install_docker_mock
  seed_containers 0
  bash "$CUTOVER_SRC" switch
  assert_new_images
  export MOCK_FAIL_START=avorofin-stock-planning-snapshot-worker
  set +e
  bash "$CUTOVER_SRC" rollback >"$STATE/out1.txt" 2>"$STATE/err1.txt"
  first_ec=$?
  set -e
  [[ $first_ec -ne 0 ]] || fail "expected first rollback fail"
  grep -q ROLLBACK_FAILED "$STATE/out1.txt" || fail "expected ROLLBACK_FAILED"
  [[ "$(cat "$STATE/journal/status")" == "rollback_failed" ]] || fail "status rollback_failed"
  # APP should already be restored original
  got=$(grep '^image=' "$STATE/containers/avorofin-app" | tail -1 | cut -d= -f2)
  [[ "$got" == "sha256:old_avorofin-app" ]] || fail "APP not restored after partial: $got"
  unset MOCK_FAIL_START
  # NEW process retry
  set +e
  bash "$CUTOVER_SRC" rollback >"$STATE/out2.txt" 2>"$STATE/err2.txt"
  second_ec=$?
  set -e
  [[ $second_ec -eq 0 ]] || fail "retry rollback failed ec=$second_ec err=$(cat "$STATE/err2.txt")"
  grep -q ROLLBACK_OK "$STATE/out2.txt" || fail "expected ROLLBACK_OK on retry"
  assert_old_images
  # APP still present
  [[ -f "$STATE/containers/avorofin-app" ]] || fail "APP missing after retry"
  log "PASS retry_after_partial_restore"
}

# R11: crash after rename (no in-process rollback) → new process recovers.
case_exit_after_rename_new_process() {
  log "CASE exit_after_rename_new_process"
  install_docker_mock
  seed_containers 0
  export EXIT_AFTER_RENAME=avorofin-profit-readmodel-worker
  set +e
  bash "$CUTOVER_SRC" switch >"$STATE/out.txt" 2>"$STATE/err.txt"
  ec=$?
  set -e
  unset EXIT_AFTER_RENAME
  [[ $ec -ne 0 ]] || fail "expected exit after rename"
  grep -q EXIT_AFTER_RENAME "$STATE/err.txt" || fail "missing EXIT_AFTER_RENAME"
  # Profit should be under backup name; working name absent
  [[ -f "$STATE/containers/avorofin-profit-readmodel-worker-pre-fa-cutover" ]] || fail "missing backup after rename exit"
  [[ ! -f "$STATE/containers/avorofin-profit-readmodel-worker" ]] || fail "working name still present"
  # NEW process rollback restores
  bash "$CUTOVER_SRC" rollback
  assert_old_images
  log "PASS exit_after_rename_new_process"
}

case_refuse_unknown_original_mismatch() {
  log "CASE refuse_unknown_original_mismatch"
  install_docker_mock
  seed_containers 0
  bash "$CUTOVER_SRC" switch
  # Corrupt APP to unknown image under working name (not old, not expect)
  {
    echo "image=sha256:UNKNOWN_FOREIGN"
    echo "id=sha256:foreign"
    echo "user=nextjs"
    echo "network=bridge"
    echo "workdir=/app"
    echo "restart=unless-stopped"
    echo "running=true"
    echo "port=127.0.0.1:3000:3000"
  } >"$STATE/containers/avorofin-app"
  set +e
  bash "$CUTOVER_SRC" rollback >"$STATE/out.txt" 2>"$STATE/err.txt"
  ec=$?
  set -e
  [[ $ec -ne 0 ]] || fail "expected refuse unknown"
  grep -Eq 'ROLLBACK_UNKNOWN_STATE|ROLLBACK_ORIGINAL_UNAVAILABLE' "$STATE/err.txt" || fail "expected refuse"
  # Must NOT have deleted the unknown container
  [[ -f "$STATE/containers/avorofin-app" ]] || fail "destroyed unknown container"
  got=$(grep '^image=' "$STATE/containers/avorofin-app" | tail -1 | cut -d= -f2)
  [[ "$got" == "sha256:UNKNOWN_FOREIGN" ]] || fail "mutated unknown image"
  log "PASS refuse_unknown_original_mismatch"
}

case_missing_backup_refuses_without_destroy() {
  log "CASE missing_backup_refuses_without_destroy"
  install_docker_mock
  seed_containers 0
  bash "$CUTOVER_SRC" switch
  local app_id
  app_id=$(grep '^id=' "$STATE/containers/avorofin-app" | tail -1 | cut -d= -f2)
  rm -f "$STATE/containers/avorofin-app-pre-fa-cutover"
  set +e
  bash "$CUTOVER_SRC" rollback >"$STATE/out.txt" 2>"$STATE/err.txt"
  ec=$?
  set -e
  [[ $ec -ne 0 ]] || fail "expected rollback fail"
  grep -q ROLLBACK_ORIGINAL_UNAVAILABLE "$STATE/err.txt" || fail "expected ORIGINAL_UNAVAILABLE"
  [[ -f "$STATE/containers/avorofin-app" ]] || fail "destroyed working APP"
  got=$(grep '^id=' "$STATE/containers/avorofin-app" | tail -1 | cut -d= -f2)
  [[ "$got" == "$app_id" ]] || fail "APP id changed after refuse"
  log "PASS missing_backup_refuses_without_destroy"
}

case_foreign_same_new_image_refuses() {
  log "CASE foreign_same_new_image_refuses"
  install_docker_mock
  seed_containers 0
  bash "$CUTOVER_SRC" switch
  # Same EXPECT ImageId, different container ID — not this transaction's replacement.
  sed -i 's/^id=.*/id=sha256:foreign_same_new_image/' "$STATE/containers/avorofin-app"
  set +e
  bash "$CUTOVER_SRC" rollback >"$STATE/out.txt" 2>"$STATE/err.txt"
  ec=$?
  set -e
  [[ $ec -ne 0 ]] || fail "expected refuse"
  grep -Eq 'ROLLBACK_UNKNOWN_STATE|ROLLBACK_ORIGINAL_UNAVAILABLE' "$STATE/err.txt" || fail "expected refuse msg"
  [[ -f "$STATE/containers/avorofin-app" ]] || fail "destroyed foreign APP"
  got=$(grep '^id=' "$STATE/containers/avorofin-app" | tail -1 | cut -d= -f2)
  [[ "$got" == "sha256:foreign_same_new_image" ]] || fail "foreign id mutated"
  log "PASS foreign_same_new_image_refuses"
}

case_foreign_same_old_image_refuses() {
  log "CASE foreign_same_old_image_refuses"
  install_docker_mock
  seed_containers 0
  bash "$CUTOVER_SRC" switch
  sed -i 's/^id=.*/id=sha256:foreign_same_old_image/;s/^image=.*/image=sha256:old_avorofin-app/' "$STATE/containers/avorofin-app"
  set +e
  bash "$CUTOVER_SRC" rollback >"$STATE/out.txt" 2>"$STATE/err.txt"
  ec=$?
  set -e
  [[ $ec -ne 0 ]] || fail "expected refuse"
  grep -Eq 'ROLLBACK_UNKNOWN_STATE|ROLLBACK_ORIGINAL_UNAVAILABLE|ROLLBACK_CONTAINER_ID_MISMATCH' "$STATE/err.txt" || fail "expected refuse"
  # Real original must remain under backup; foreign under working not accepted as restored.
  [[ -f "$STATE/containers/avorofin-app-pre-fa-cutover" ]] || fail "lost real backup"
  bak=$(grep '^id=' "$STATE/containers/avorofin-app-pre-fa-cutover" | tail -1 | cut -d= -f2)
  [[ "$bak" == "sha256:cid_old_avorofin-app" ]] || fail "backup id wrong"
  got=$(grep '^id=' "$STATE/containers/avorofin-app" | tail -1 | cut -d= -f2)
  [[ "$got" == "sha256:foreign_same_old_image" ]] || fail "foreign destroyed"
  log "PASS foreign_same_old_image_refuses"
}

case_crash_before_record_new_process() {
  log "CASE crash_before_record_new_process"
  install_docker_mock
  seed_containers 0
  # Inject kill immediately after rename mv in mock docker.
  local mock="$STATE/bins/docker"
  node -e '
const fs=require("fs");
const p=process.argv[1];
let s=fs.readFileSync(p,"utf8");
const target="    mv \"$STATE_DIR/containers/$old\" \"$STATE_DIR/containers/$new\"\n";
if(!s.includes(target)) throw new Error("rename target missing");
if(!s.includes("MOCK_KILL_ON_RENAME")) {
  s=s.replace(target, target+"    if [[ \"${MOCK_KILL_ON_RENAME:-}\" == \"$old\" ]]; then kill -KILL \"$PPID\"; fi\n");
  fs.writeFileSync(p,s);
}
' "$mock"
  export MOCK_KILL_ON_RENAME=avorofin-profit-readmodel-worker
  set +e
  bash "$CUTOVER_SRC" switch
  ec=$?
  set -e
  unset MOCK_KILL_ON_RENAME
  [[ $ec -ne 0 ]] || fail "expected crash exit"
  [[ -f "$STATE/containers/avorofin-profit-readmodel-worker-pre-fa-cutover" ]] || fail "missing backup after crash"
  bash "$CUTOVER_SRC" rollback
  assert_old_images
  for c in "${ROLES[@]}"; do
    got=$(grep '^id=' "$STATE/containers/$c" | tail -1 | cut -d= -f2)
    [[ "$got" == "sha256:cid_old_$c" ]] || fail "$c id=$got"
  done
  log "PASS crash_before_record_new_process"
}

case_crash_before_record_changed_suffix() {
  log "CASE crash_before_record_changed_suffix"
  install_docker_mock
  seed_containers 0
  local mock="$STATE/bins/docker"
  node -e '
const fs=require("fs");
const p=process.argv[1];
let s=fs.readFileSync(p,"utf8");
const target="    mv \"$STATE_DIR/containers/$old\" \"$STATE_DIR/containers/$new\"\n";
if(!s.includes(target)) throw new Error("rename target missing");
if(!s.includes("MOCK_KILL_ON_RENAME")) {
  s=s.replace(target, target+"    if [[ \"${MOCK_KILL_ON_RENAME:-}\" == \"$old\" ]]; then kill -KILL \"$PPID\"; fi\n");
  fs.writeFileSync(p,s);
}
' "$mock"
  export MOCK_KILL_ON_RENAME=avorofin-profit-readmodel-worker
  set +e
  bash "$CUTOVER_SRC" switch
  set -e
  unset MOCK_KILL_ON_RENAME
  export CUTOVER_PRE_SUFFIX=changed-in-new-shell
  bash "$CUTOVER_SRC" rollback
  unset CUTOVER_PRE_SUFFIX
  export CUTOVER_PRE_SUFFIX=pre-fa-cutover
  assert_old_images
  for c in "${ROLES[@]}"; do
    got=$(grep '^id=' "$STATE/containers/$c" | tail -1 | cut -d= -f2)
    [[ "$got" == "sha256:cid_old_$c" ]] || fail "$c id=$got after changed suffix"
  done
  log "PASS crash_before_record_changed_suffix"
}

run_all() {
  case_normal_switch_separate_rollback
  case_bindings_and_root_user
  case_bad_new_id
  case_fail_after_each_role
  case_missing_env_preflight
  case_missing_old_preflight
  case_stop_failure_rollback
  case_interrupt_after_rename
  case_retry_after_partial_restore
  case_exit_after_rename_new_process
  case_refuse_unknown_original_mismatch
  case_missing_backup_refuses_without_destroy
  case_foreign_same_new_image_refuses
  case_foreign_same_old_image_refuses
  case_crash_before_record_new_process
  case_crash_before_record_changed_suffix
  log "ALL_CUTOVER_ACCEPTANCE_PASS"
}

case "$CASE" in
  all) run_all ;;
  normal) case_normal_switch_separate_rollback ;;
  bindings) case_bindings_and_root_user ;;
  *) echo "unknown case $CASE" >&2; exit 2 ;;
esac
