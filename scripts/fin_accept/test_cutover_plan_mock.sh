#!/usr/bin/env bash
# Isolated mock of switch/rollback command shape. Does NOT touch MAIN.
set -euo pipefail
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
log() { printf '%s\n' "$*"; }

fail_mid=0
missing_old=0
bad_new_id=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fail-mid) fail_mid=1 ;;
    --missing-old) missing_old=1 ;;
    --bad-new-id) bad_new_id=1 ;;
    *) echo "unknown $1" >&2; exit 2 ;;
  esac
  shift
done

STATE="$ROOT/state"
mkdir -p "$STATE/env" "$STATE/bins" "$STATE/containers"
PATH="$STATE/bins:$PATH"

# Mock docke
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
  stop|start|rm)
    c=$1
    test -f "$STATE_DIR/containers/$c" || test -f "$STATE_DIR/containers/${c}" || true
    ;;
  run)
    # parse --name
    name=""
    image=""
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "--name" ]]; then name=$2; shift 2; continue; fi
      if [[ "$1" == "-d" || "$1" == "--restart" || "$1" == "--user" || "$1" == "--network" || "$1" == "--workdir" || "$1" == "--env-file" || "$1" == "-p" ]]; then
        shift 2; continue
      fi
      if [[ "$1" == -* ]]; then shift; continue; fi
      image=$1; break
    done
    echo "image=$image" >"$STATE_DIR/containers/$name"
    if [[ "${MOCK_BAD_NEW_ID:-0}" == "1" && "$name" == avorofin-profit-readmodel-worker ]]; then
      echo "image=sha256:WRONG" >"$STATE_DIR/containers/$name"
    fi
    ;;
  inspect)
    # docker inspect -f '{{.Image}}' name
    fmt=""
    name=""
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "-f" ]]; then fmt=$2; shift 2; continue; fi
      name=$1; shift || true
    done
    if [[ "$fmt" == "{{.Image}}" ]]; then
      grep '^image=' "$STATE_DIR/containers/$name" | cut -d= -f2
    else
      echo "{}"
    fi
    ;;
  image)
    exit 0
    ;;
  *)
    echo "unhandled docker $cmd" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$STATE/bins/docker"

export MOCK_STATE="$STATE"
export MOCK_BAD_NEW_ID="$bad_new_id"
EXPECT_IMAGE_ID_PROFIT=sha256:profit_ok
EXPECT_IMAGE_ID_V6=sha256:v6_ok
EXPECT_IMAGE_ID_DASH=sha256:dash_ok
EXPECT_IMAGE_ID_STOCK=sha256:stock_ok
EXPECT_IMAGE_ID_APP=sha256:app_ok

# seed old containers
for c in avorofin-app avorofin-profit-readmodel-worker avorofin-v6-period-readmodel-worker \
         avorofin-dashboard-period-snapshot-worker avorofin-stock-planning-snapshot-worker; do
  if [[ "$missing_old" == "1" && "$c" == avorofin-app ]]; then
    continue
  fi
  echo "image=sha256:old_$c" >"$STATE/containers/$c"
  echo "X=1" >"$STATE/env/${c}.env"
done

switch() {
  local STATE_DIR="$STATE"
  docker rename avorofin-profit-readmodel-worker avorofin-profit-readmodel-worker-pre-fa180500
  docker stop avorofin-profit-readmodel-worker-pre-fa180500
  docker run -d --name avorofin-profit-readmodel-worker --restart unless-stopped \
    --user 0 --network bridge --workdir /app \
    --env-file "$STATE_DIR/env/avorofin-profit-readmodel-worker.env" \
    avorofin-p0-cogs-profit:fin_accept_20261027_180500
  # force expected id write for happy path
  if [[ "${MOCK_BAD_NEW_ID}" != "1" ]]; then
    echo "image=$EXPECT_IMAGE_ID_PROFIT" >"$STATE_DIR/containers/avorofin-profit-readmodel-worker"
  fi
  test "$(docker inspect -f '{{.Image}}' avorofin-profit-readmodel-worker)" = "$EXPECT_IMAGE_ID_PROFIT"
  if [[ "$fail_mid" == "1" ]]; then
    log "FAIL_MID_TRIGGERED"
    return 3
  fi
  docker rename avorofin-app avorofin-app-pre-fa180500
  docker stop avorofin-app-pre-fa180500
  docker run -d --name avorofin-app --restart unless-stopped \
    --user nextjs --network bridge --workdir /app \
    -p 127.0.0.1:3000:3000 \
    --env-file "$STATE_DIR/env/avorofin-app.env" \
    avorofin-p0-cogs-app:fin_accept_20261027_180500
  echo "image=$EXPECT_IMAGE_ID_APP" >"$STATE_DIR/containers/avorofin-app"
  test "$(docker inspect -f '{{.Image}}' avorofin-app)" = "$EXPECT_IMAGE_ID_APP"
}

rollback() {
  local STATE_DIR="$STATE"
  for c in avorofin-stock-planning-snapshot-worker avorofin-dashboard-period-snapshot-worker \
           avorofin-v6-period-readmodel-worker avorofin-profit-readmodel-worker avorofin-app; do
    docker stop "$c" 2>/dev/null || true
    docker rm "$c" 2>/dev/null || true
    rm -f "$STATE_DIR/containers/$c"
  done
  for c in avorofin-app avorofin-profit-readmodel-worker; do
    if [[ -f "$STATE_DIR/containers/${c}-pre-fa180500" ]]; then
      docker rename "${c}-pre-fa180500" "$c"
      docker start "$c"
    fi
  done
}

set +e
switch
ec=$?
set -e
if [[ $ec -ne 0 ]]; then
  log "SWITCH_FAILED ec=$ec — running rollback"
  rollback
  test -f "$STATE/containers/avorofin-profit-readmodel-worker-pre-fa180500" && exit 1 || true
  test -f "$STATE/containers/avorofin-profit-readmodel-worker" || test -f "$STATE/containers/avorofin-app"
  log "ROLLBACK_OK ec=$ec"
  exit 0
fi
log "SWITCH_OK"
ls "$STATE/containers" | tee "$STATE/final_names.txt"
