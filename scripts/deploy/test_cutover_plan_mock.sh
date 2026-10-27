#!/usr/bin/env bash
# Mock of cutover_five_roles.sh — journal only switched roles; verify all five.
set -euo pipefail
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
log() { printf '%s\n' "$*"; }

fail_mid=0
missing_old=0
bad_new_id=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fail-mid) fail_mid=1; shift ;;
    --missing-old) missing_old=1; shift ;;
    --bad-new-id) bad_new_id=1; shift ;;
    *) echo "unknown $1" >&2; exit 2 ;;
  esac
done

STATE="$ROOT/state"
mkdir -p "$STATE/env" "$STATE/bins" "$STATE/containers" "$STATE/journal"
PATH="$STATE/bins:$PATH"
export MOCK_STATE="$STATE"
export MOCK_BAD_NEW_ID="$bad_new_id"
export CUTOVER_JOURNAL_DIR="$STATE/journal"
export CUTOVER_ENV_DIR="$STATE"
export CUTOVER_PRE_SUFFIX="pre-fa-cutover"
export IMAGE_APP=avorofin-p0-cogs-app:fin_accept_r08
export IMAGE_PROFIT=avorofin-p0-cogs-profit:fin_accept_r08
export IMAGE_V6=avorofin-p0-cogs-v6:fin_accept_r08
export IMAGE_DASHBOARD=avorofin-p0-cogs-dashboard:fin_accept_r08
export IMAGE_STOCK=avorofin-p0-cogs-stock:fin_accept_r08
export EXPECT_APP=sha256:app_ok
export EXPECT_PROFIT=sha256:profit_ok
export EXPECT_V6=sha256:v6_ok
export EXPECT_DASHBOARD=sha256:dash_ok
export EXPECT_STOCK=sha256:stock_ok
if [[ "$fail_mid" == "1" ]]; then
  export FAIL_AFTER_ROLE=avorofin-profit-readmodel-worker
fi

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
    mv "$STATE_DIR/containers/$old" "$STATE_DIR/containers/$new"
    ;;
  stop|start) ;;
  rm) rm -f "$STATE_DIR/containers/$1" ;;
  port) echo "0.0.0.0:3000" ;;
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
    if [[ "$fmt" == "{{.Image}}" ]]; then
      grep '^image=' "$STATE_DIR/containers/$name" | cut -d= -f2
    elif [[ "$fmt" == "{{.Config.User}}" ]]; then
      grep '^user=' "$STATE_DIR/containers/$name" | cut -d= -f2-
    elif [[ "$fmt" == "{{.HostConfig.NetworkMode}}" ]]; then
      grep '^network=' "$STATE_DIR/containers/$name" | cut -d= -f2-
    else
      echo "{}"
    fi
    ;;
  run)
    name=""; image=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --name) name=${2:?}; shift 2 ;;
        -d|--detach) shift ;;
        --restart|--user|--network|--workdir|--env-file|-p|--publish) shift 2 ;;
        -*) shift ;;
        *) image=$1; break ;;
      esac
    done
    test -n "$name" || { echo "docker run missing --name" >&2; exit 1; }
    user="node"; network="bridge"
    if [[ "$name" == avorofin-app ]]; then user="nextjs"; fi
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
      echo "user=$user"
      echo "network=$network"
    } >"$STATE_DIR/containers/$name"
    ;;
  *) echo "unhandled docker $cmd" >&2; exit 1 ;;
esac
EOF
chmod +x "$STATE/bins/docker"

ROLES=(avorofin-app avorofin-profit-readmodel-worker avorofin-v6-period-readmodel-worker
       avorofin-dashboard-period-snapshot-worker avorofin-stock-planning-snapshot-worker)

for c in "${ROLES[@]}"; do
  if [[ "$missing_old" == "1" && "$c" == avorofin-app ]]; then continue; fi
  user=node; network=bridge
  if [[ "$c" == avorofin-app ]]; then user=nextjs; fi
  {
    echo "image=sha256:old_$c"
    echo "user=$user"
    echo "network=$network"
  } >"$STATE/containers/$c"
  echo "X=1" >"$STATE/env/${c}.env"
done

CUTOVER_SRC="$(cd "$(dirname "$0")" && pwd)/cutover_five_roles.sh"

set +e
bash "$CUTOVER_SRC" switch
ec=$?
set -e
if [[ $ec -ne 0 ]]; then
  log "SWITCH_FAILED ec=$ec — running rollback"
  if ! bash "$CUTOVER_SRC" rollback; then
    log "ROLLBACK_FAILED"
    exit 1
  fi
  for c in "${ROLES[@]}"; do
    if [[ "$missing_old" == "1" && "$c" == avorofin-app ]]; then continue; fi
    [[ -f "$STATE/containers/$c" ]] || { echo "FINAL_STATE_MISSING $c" >&2; exit 6; }
  done
  log "ROLLBACK_OK ec=$ec"
  exit 0
fi
log "SWITCH_OK"
