#!/bin/bash
# FIN_CLOSE proper deploy: reproducible git-archive image, smoke before cutover.
# Protects production secrets/backups/runtime from rsync wipe.
set -euo pipefail
OUT=/tmp/fin_close_proper
TAG=avorofin-p0-cogs-app:20261022_fin_close_proper
CTX=/tmp/fin_close_proper_ctx
ENV_FILE=/opt/avorofin/.env.production
mkdir -p "$OUT" "$CTX"
rm -rf "${CTX:?}"/*

# Reproducible context = git archive ONLY (no OPT hybrid, no route deletion)
tar -xf /tmp/fin_close_proper_ctx.tar -C "$CTX"
if [ -d "$CTX/src" ]; then SRC="$CTX/src"; else SRC="$CTX"; fi
cd "$SRC"

echo "GIT_COMMIT=$(cat "$OUT/git_commit.txt" 2>/dev/null || true)" | tee "$OUT/build_meta.txt"
test -f scripts/financial-core/verify-financial-core-v6.mjs
test -f financial-core/v6/manifest.json
test -f app/finance/page.tsx
test -f app/api/cron/sync-ozon-accruals/route.ts
test -f app/api/templates/product-cost/route.ts
test -f app/api/media/wb-image/route.ts
test -f app/api/read-model/status/route.ts
grep -n getEffectiveFinanceTransactions app/finance/page.tsx app/finance/cashflow/page.tsx app/finance/plan-fact/page.tsx | tee "$OUT/source_grep.txt" | head -20
grep -q ignoreBuildErrors next.config.ts && { echo "FORBIDDEN ignoreBuildErrors"; exit 2; } || echo "next.config OK no ignoreBuildErrors" | tee -a "$OUT/build_meta.txt"
grep -q 'FIN_CLOSE verify stub' scripts/financial-core/verify-financial-core-v6.mjs && { echo "FORBIDDEN verify stub"; exit 2; } || echo "verify script OK" | tee -a "$OUT/build_meta.txt"
test -d app/api/cron/sync-ozon-accruals
test -d app/api/templates

python3 - <<'PY' | tee -a "$OUT/build_meta.txt"
import json
from pathlib import Path
d=json.loads(Path("package.json").read_text())
assert d["scripts"].get("prebuild")=="npm run financial-core:verify", d["scripts"]
assert "prisma generate" in d["scripts"].get("build",""), d["scripts"]
print("package scripts OK", d["scripts"]["build"], d["scripts"]["prebuild"])
PY

if [ ! -f Dockerfile ]; then echo "NO Dockerfile in archive"; exit 5; fi

# Hard gate: production env must exist before any container that needs it
if [ ! -f "$ENV_FILE" ]; then
  echo "FATAL: missing $ENV_FILE — refuse smoke/cutover (no restart)" | tee "$OUT/env_gate.txt"
  exit 4
fi
# Integrity without printing secrets
python3 - <<PY | tee "$OUT/env_gate.txt"
from pathlib import Path
p=Path("$ENV_FILE")
raw=p.read_bytes()
lines=[ln for ln in raw.decode("utf-8","replace").splitlines() if ln.strip() and not ln.strip().startswith("#")]
keys=[]; empty=0
for ln in lines:
    if "=" not in ln: continue
    k,v=ln.split("=",1)
    keys.append(k.strip())
    if not v.strip().strip('"').strip("'"): empty+=1
need=["DATABASE_URL","CRON_SECRET","LOCAL_AUTH_SECRET"]
missing=[n for n in need if n not in keys]
mode=oct(p.stat().st_mode & 0o777)
print(f"ENV_EXISTS=yes BYTES={len(raw)} KEYS={len(keys)} EMPTY={empty} MODE={mode}")
print("MISSING=" + (",".join(missing) if missing else "none"))
if missing or empty or len(keys)<8:
    raise SystemExit("ENV_INTEGRITY_FAIL")
print("ENV_INTEGRITY=OK")
PY

echo "BUILD_START $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee "$OUT/build.log"
set +e
docker build -t "$TAG" -f Dockerfile . >> "$OUT/build.log" 2>&1
BUILD_EXIT=$?
set -e
echo "BUILD_EXIT=$BUILD_EXIT" | tee -a "$OUT/build.log"
tail -80 "$OUT/build.log"
if [ "$BUILD_EXIT" -ne 0 ]; then
  echo BUILD_FAILED | tee -a "$OUT/build_meta.txt"
  exit "$BUILD_EXIT"
fi

docker image inspect "$TAG" --format 'ID={{.Id}} Created={{.Created}} Size={{.Size}}' | tee "$OUT/image_inspect.txt"

# Smoke container on alternate port BEFORE replacing live app
SMOKE=avorofin-app-smoke-proper
docker rm -f "$SMOKE" 2>/dev/null || true
docker inspect avorofin-app --format '{{range .Config.Env}}{{println .}}{{end}}' > "$OUT/prev_env.txt"
chmod 600 "$OUT/prev_env.txt"
python3 - <<'PY' > "$OUT/runtime_flags.env"
from pathlib import Path
prev=Path("/tmp/fin_close_proper/prev_env.txt").read_text().splitlines()
keep_prefixes=("DASHBOARD_V6_","WAVE_B_","V6_","DATABASE_POOL_","YTD_","LOCAL_AUTH_","TELEGRAM_","CRON_","DEBUG_","NEXT_PUBLIC_","OPENAI_","DATABASE_URL","V6_READMODEL_TARGET_DATABASE_URL")
seen=set()
for line in prev:
    if "=" not in line: continue
    k=line.split("=",1)[0]
    if any(k==p.rstrip("_") or k.startswith(p) for p in keep_prefixes):
        if k not in seen:
            print(line); seen.add(k)
PY
chmod 600 "$OUT/runtime_flags.env"

docker run -d --name "$SMOKE" --network bridge \
  -p 127.0.0.1:3001:3000 \
  --env-file "$ENV_FILE" \
  --env-file "$OUT/runtime_flags.env" \
  -e NODE_ENV=production -e PORT=3000 \
  "$TAG"

sleep 15
set +e
HOME_CODE=$(curl -sk -o /tmp/smoke_home.html -w '%{http_code}' http://127.0.0.1:3001/ || echo 000)
FIN_CODE=$(curl -sk -o /tmp/smoke_fin.html -w '%{http_code}' http://127.0.0.1:3001/finance || echo 000)
TEMPL_CODE=$(curl -sk -o /tmp/smoke_templ.html -w '%{http_code}' http://127.0.0.1:3001/api/templates/product-cost || echo 000)
RM_CODE=$(curl -sk -o /tmp/smoke_rm.html -w '%{http_code}' http://127.0.0.1:3001/api/read-model/status || echo 000)
LOGS=$(docker logs --tail 80 "$SMOKE" 2>&1)
echo "$LOGS" | tee "$OUT/smoke_logs.txt" >/dev/null
printf 'home=%s finance=%s templates=%s readmodel=%s\n' "$HOME_CODE" "$FIN_CODE" "$TEMPL_CODE" "$RM_CODE" | tee "$OUT/smoke_http.txt"
set -e

if echo "$LOGS" | grep -q "Cannot read properties of undefined (reading 'findMany')"; then
  echo SMOKE_FAIL_FINDMANY | tee "$OUT/smoke_result.txt"
  docker rm -f "$SMOKE" || true
  exit 3
fi
if echo "$LOGS" | grep -qiE 'Error: Cannot find module|Module not found'; then
  echo SMOKE_FAIL_MODULE | tee "$OUT/smoke_result.txt"
  docker rm -f "$SMOKE" || true
  exit 3
fi
for code in "$HOME_CODE" "$FIN_CODE" "$TEMPL_CODE" "$RM_CODE"; do
  case "$code" in
    200|301|302|303|307|401|403) ;;
    *) echo "SMOKE_FAIL_HTTP $code" | tee "$OUT/smoke_result.txt"; docker rm -f "$SMOKE" || true; exit 3 ;;
  esac
done
echo SMOKE_OK | tee "$OUT/smoke_result.txt"

# Cut over live app only after smoke OK
PREV=avorofin-app
docker rename "$PREV" avorofin-app-pre-proper 2>/dev/null || true
docker stop avorofin-app-pre-proper 2>/dev/null || true
docker rm -f "$SMOKE" 2>/dev/null || true

docker run -d --name avorofin-app --restart unless-stopped \
  --network bridge \
  -p 127.0.0.1:3000:3000 \
  --env-file "$ENV_FILE" \
  --env-file "$OUT/runtime_flags.env" \
  -e NODE_ENV=production -e PORT=3000 \
  "$TAG"

sleep 15
docker ps --filter name=avorofin-app --format '{{.Names}} {{.Image}} {{.Status}}' | tee "$OUT/deploy_ps.txt"
curl -sk -o /dev/null -w 'home=%{http_code}\n' https://ardelo.su/ | tee -a "$OUT/deploy_ps.txt"
curl -sk -o /dev/null -w 'finance=%{http_code}\n' https://ardelo.su/finance | tee -a "$OUT/deploy_ps.txt"

docker exec avorofin-app sh -c '
  grep -l getEffective /app/.next/server/chunks/ssr/app_finance*.js | head
  ls /app/.next/server/app/api/cron/sync-ozon-accruals 2>/dev/null | head
  ls /app/.next/server/app/api/templates 2>/dev/null | head
' | tee "$OUT/chunk_api_proof.txt"

# Sync OPT source tree WITHOUT --delete.
# Never wipe production secrets, backups, runtime, logs, or local overlays.
mkdir -p /opt/avorofin
rsync -a \
  --exclude node_modules \
  --exclude .next \
  --exclude .git \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '*.env' \
  --exclude 'backups/' \
  --exclude 'server-logs/' \
  --exclude 'uploads/' \
  --exclude 'data/' \
  --exclude '*.backup*' \
  --exclude '*.bak*' \
  --exclude 'Caddyfile*' \
  --exclude 'compose.yaml' \
  --exclude 'docker-compose*.yml' \
  "$SRC"/ /opt/avorofin/ || true

# Scrub temporary env dumps written by this script (keep production file)
python3 - <<'PY'
from pathlib import Path
for p in [Path("/tmp/fin_close_proper/prev_env.txt"), Path("/tmp/fin_close_proper/runtime_flags.env")]:
    if p.exists():
        n=p.stat().st_size
        p.write_bytes(b"\0"*n)
        p.unlink()
print("TEMP_ENV_SCRUBBED")
PY

echo DEPLOY_PROPER_OK | tee -a "$OUT/deploy_ps.txt"
