#!/usr/bin/env bash
# Boot five MAIN roles from accepted R15 images on disposable DB (isolation only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
: "${DATABASE_URL:?}"
TAR_ROOT="${R15_IMAGE_TARBALLS:-/tmp/r15_image_tarballs}"
STAMP="${IMAGE_STAMP:-20261028_R15}"
DB_DOCKER="$DATABASE_URL"
DB_DOCKER="$(python3 - <<'PY' "$DATABASE_URL"
import sys
from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse
u=sys.argv[1]
for h in ("127.0.0.1","localhost"):
  u=u.replace("@"+h+":","@host.docker.internal:")
p=urlparse(u); q=dict(parse_qsl(p.query, keep_blank_values=True)); q["sslmode"]="disable"
print(urlunparse(p._replace(query=urlencode(q))))
PY
)"

find_tar() {
  local role="$1"
  # Prefer explicit portable NEW app (accepted R15 Next) over artifact app.tar.gz
  # which historically may be tagged as telegram:c01_new_r15.
  if [[ "$role" == "app" ]]; then
    for cand in \
      "${TELEGRAM_APP_TAR:-}" \
      "$TAR_ROOT/app_fin_accept_${STAMP}.tar.gz" \
      "$TAR_ROOT/image-tarballs/app_fin_accept_${STAMP}.tar.gz" \
      "$TAR_ROOT/image-tarballs/app.tar.gz" \
      "$TAR_ROOT/app.tar.gz"; do
      [[ -n "$cand" && -f "$cand" ]] && { echo "$cand"; return 0; }
    done
    return 1
  fi
  if [[ -f "$TAR_ROOT/image-tarballs/${role}.tar.gz" ]]; then
    echo "$TAR_ROOT/image-tarballs/${role}.tar.gz"
  elif [[ -f "$TAR_ROOT/${role}.tar.gz" ]]; then
    echo "$TAR_ROOT/${role}.tar.gz"
  else
    return 1
  fi
}

retag_latest_to() {
  local want="$1"
  if docker image inspect "$want" >/dev/null 2>&1; then
    return 0
  fi
  # Tag whatever was just loaded (last Loaded image line) to the expected role tag.
  local loaded
  loaded="$(awk '/Loaded image:/{print $3}' "$load_log" | tail -1)"
  [[ -n "$loaded" ]] || return 1
  docker tag "$loaded" "$want"
  echo "RETAGGED $loaded -> $want"
}

load_log=/tmp/iso_boot_load_$$.txt
: > "$load_log"
for role in app profit v6 dashboard stock; do
  tar="$(find_tar "$role")" || { echo "missing tar for $role under $TAR_ROOT"; exit 2; }
  echo "LOAD $role from $tar"
  gzip -dc "$tar" | docker load | tee -a "$load_log"
  want="avorofin-p0-cogs-${role}:fin_accept_${STAMP}"
  retag_latest_to "$want" || { echo "FAIL retag $role to $want"; exit 3; }
  docker image inspect "$want" >/dev/null
done

ENVF=/tmp/iso_main_role.env
cat > "$ENVF" <<EOF
DATABASE_URL=$DB_DOCKER
WAVE_B_PROFIT_TARGET_DATABASE_URL=$DB_DOCKER
V6_READMODEL_TARGET_DATABASE_URL=$DB_DOCKER
WAVE_B_TARGET_DB_MODE=SAME_PRODUCTION_DB
WAVE_B_PROFIT_WORKER_MODE=queue
V6_READMODEL_WORKER_MODE=queue
DASHBOARD_SNAPSHOT_WORKER_MODE=queue
NODE_ENV=production
EOF
chmod 600 "$ENVF"

start_one() {
  local name="$1" image="$2"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --restart unless-stopped \
    --add-host=host.docker.internal:host-gateway \
    --env-file "$ENVF" \
    "$image"
  echo "STARTED $name"
}

start_one avorofin-app "avorofin-p0-cogs-app:fin_accept_${STAMP}"
start_one avorofin-profit-readmodel-worker "avorofin-p0-cogs-profit:fin_accept_${STAMP}"
start_one avorofin-v6-period-readmodel-worker "avorofin-p0-cogs-v6:fin_accept_${STAMP}"
start_one avorofin-dashboard-period-snapshot-worker "avorofin-p0-cogs-dashboard:fin_accept_${STAMP}"
start_one avorofin-stock-planning-snapshot-worker "avorofin-p0-cogs-stock:fin_accept_${STAMP}"

# Seed EXPECT_* from loaded images
mkdir -p "${FA_STATE:-/tmp/fa}/meta"
python3 - <<PY
import json, pathlib, subprocess, os
roles=["app","profit","v6","dashboard","stock"]
stamp=os.environ.get("IMAGE_STAMP","20261028_R15")
out={}
for r in roles:
  tag=f"avorofin-p0-cogs-{r}:fin_accept_{stamp}"
  iid=subprocess.check_output(["docker","image","inspect","-f","{{.Id}}",tag], text=True).strip()
  out[r]={"ImageId": iid, "tag": tag}
path=pathlib.Path(os.environ.get("FA_STATE","/tmp/fa"))/"meta"/"ARTIFACTS_MANIFEST.json"
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(out, indent=2)+"\n", encoding="utf-8")
print("MANIFEST_FROM_LOADED", path)
PY
echo "ISO_BOOT_MAIN_ROLES_OK"
