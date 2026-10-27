# FIN_ACCEPT DEPLOY / ROLLBACK — executable (NOT executed on MAIN)

## Identity
- financialSourceCommit: `bf4f8b5690bdbe417afe7a95cc7beca16c043abc`
- build branch: `build/fin-accept-images-20261027_180500`
- STAMP: `20261027_180500`
- Platform: linux/amd64
- RepoDigest: NOT_PUSHED (delivery = Actions tarball artifact + local ImageId after `docker load`)
- Production / Telegram: **DO NOT RUN these commands until separately authorized**

## Types
| Field | Meaning |
|-------|---------|
| ImageId | Local `docker image inspect -f '{{.Id}}'` after load |
| tarSha256 | SHA256 of `role.tar.gz` from artifact |
| RepoDigest | Registry digest; null until push |

Fill ImageId/tarSha256 from `image-meta/ARTIFACTS_MANIFEST.json` of the successful Actions run for this stamp.

## MAIN current anchors (rollback targets; read-only proven)
| Container | NetworkMode | User | ImageId (current) |
|-----------|-------------|------|-------------------|
| avorofin-app | bridge | nextjs | sha256:7ed8f9a0705d155a0e54fe10f1b735cfe90ef614ceaf7de7df59c2fe9d74ea8d |
| avorofin-profit-readmodel-worker | bridge | (empty=root) | sha256:35fe9b67ad5bf180945d353dbda727d8e50f61b47dad46a02d500c5fd712b1ac |
| avorofin-v6-period-readmodel-worker | bridge | (empty=root) | sha256:88b8e683c44992f16ddcea2df325d1ada0eb4698ad1721e2232cc5442a48b2bb |
| avorofin-dashboard-period-snapshot-worker | host | (empty=root) | sha256:4d09f3785fd5f378f3045343a33b6aa8d7b955fb9b1282ef6699b3ec2deae42a |
| avorofin-stock-planning-snapshot-worker | host | 0 | sha256:648952f6cf11bc9169ba8ca08d25af5e333830d84aa9e9e1780feb1667088fcf |

Candidate images use `USER node` in Dockerfile.workers. Cutover **keeps MAIN users** via explicit `--user`:
- profit/v6/dashboard: `--user 0`
- stock: `--user 0`
- APP: `--user nextjs` (or exact Config.User from saved inspect)

## Download + load (authorized host as deploy@)
```bash
set -euo pipefail
STATE_DIR="${HOME}/fa-cutover-20261027_180500"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
cd "$STATE_DIR"
# Replace RUN_ID after Actions success:
RUN_ID=REPLACE_ME
gh run download "$RUN_ID" --repo Artiomka77/marketplace-business-os \
  -n "fin-accept-image-tarballs-20261027_180500" -D ./fa-images
# Artifact layout may be flat or nested; locate SHA256SUMS:
SUMS=$(find ./fa-images -name SHA256SUMS.txt | head -n1)
TAR_DIR=$(dirname "$SUMS")
cd "$TAR_DIR"
sha256sum -c SHA256SUMS.txt
docker load -i app.tar.gz
docker load -i profit.tar.gz
docker load -i v6.tar.gz
docker load -i dashboard.tar.gz
docker load -i stock.tar.gz
for t in \
  avorofin-p0-cogs-app:fin_accept_20261027_180500 \
  avorofin-p0-cogs-profit:fin_accept_20261027_180500 \
  avorofin-p0-cogs-v6:fin_accept_20261027_180500 \
  avorofin-p0-cogs-dashboard:fin_accept_20261027_180500 \
  avorofin-p0-cogs-stock:fin_accept_20261027_180500
do
  docker image inspect -f '{{.Id}} {{.RepoTags}}' "$t"
done
```

## Capture env (mode 600; never commit/log)
```bash
set -euo pipefail
STATE_DIR="${HOME}/fa-cutover-20261027_180500"
umask 077
mkdir -p "$STATE_DIR/env" "$STATE_DIR/inspect"
for c in avorofin-app avorofin-profit-readmodel-worker avorofin-v6-period-readmodel-worker \
         avorofin-dashboard-period-snapshot-worker avorofin-stock-planning-snapshot-worker; do
  docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' > "$STATE_DIR/env/${c}.env"
  chmod 600 "$STATE_DIR/env/${c}.env"
  docker inspect "$c" --format '{{json .HostConfig}}' > "$STATE_DIR/inspect/${c}.hostconfig.json"
  docker inspect "$c" --format '{{json .Config}}' > "$STATE_DIR/inspect/${c}.config.json"
done
```

## Pre-cutover gates
1. sha256sum -c on five tarballs
2. ImageId of each new tag equals ARTIFACTS_MANIFEST
3. Old ImageIds still present
4. Pause writers: disable accrual cron + marketplace-orders primary/recovery windows; leave caddy
5. Drain: wait until profit/v6/dashboard/stock have no in-flight claims (empty queue alone ≠ drained)
6. Do not run `scripts/deploy/80_proper_git_build_deploy.sh`

## Switch (order prevents dual writers)
```bash
set -euo pipefail
STATE_DIR="${HOME}/fa-cutover-20261027_180500"
TAG_APP=avorofin-p0-cogs-app:fin_accept_20261027_180500
TAG_PROFIT=avorofin-p0-cogs-profit:fin_accept_20261027_180500
TAG_V6=avorofin-p0-cogs-v6:fin_accept_20261027_180500
TAG_DASH=avorofin-p0-cogs-dashboard:fin_accept_20261027_180500
TAG_STOCK=avorofin-p0-cogs-stock:fin_accept_20261027_180500
# EXPECT_IMAGE_ID_* filled from ARTIFACTS_MANIFEST after build

# 1 profit (bridge, user 0)
docker rename avorofin-profit-readmodel-worker avorofin-profit-readmodel-worker-pre-fa180500
docker stop avorofin-profit-readmodel-worker-pre-fa180500
docker run -d --name avorofin-profit-readmodel-worker --restart unless-stopped \
  --user 0 --network bridge --workdir /app \
  --env-file "$STATE_DIR/env/avorofin-profit-readmodel-worker.env" \
  "$TAG_PROFIT"
test "$(docker inspect -f '{{.Image}}' avorofin-profit-readmodel-worker)" = "$EXPECT_IMAGE_ID_PROFIT"

# 2 v6
docker rename avorofin-v6-period-readmodel-worker avorofin-v6-period-readmodel-worker-pre-fa180500
docker stop avorofin-v6-period-readmodel-worker-pre-fa180500
docker run -d --name avorofin-v6-period-readmodel-worker --restart unless-stopped \
  --user 0 --network bridge --workdir /app \
  --env-file "$STATE_DIR/env/avorofin-v6-period-readmodel-worker.env" \
  "$TAG_V6"
test "$(docker inspect -f '{{.Image}}' avorofin-v6-period-readmodel-worker)" = "$EXPECT_IMAGE_ID_V6"

# 3 dashboard (host)
docker rename avorofin-dashboard-period-snapshot-worker avorofin-dashboard-period-snapshot-worker-pre-fa180500
docker stop avorofin-dashboard-period-snapshot-worker-pre-fa180500
docker run -d --name avorofin-dashboard-period-snapshot-worker --restart unless-stopped \
  --user 0 --network host --workdir /app \
  --env-file "$STATE_DIR/env/avorofin-dashboard-period-snapshot-worker.env" \
  "$TAG_DASH"
test "$(docker inspect -f '{{.Image}}' avorofin-dashboard-period-snapshot-worker)" = "$EXPECT_IMAGE_ID_DASH"

# 4 stock (host, user 0) — do NOT treat warmup seeding as week rebuild
docker rename avorofin-stock-planning-snapshot-worker avorofin-stock-planning-snapshot-worker-pre-fa180500
docker stop avorofin-stock-planning-snapshot-worker-pre-fa180500
docker run -d --name avorofin-stock-planning-snapshot-worker --restart unless-stopped \
  --user 0 --network host --workdir /app \
  --env-file "$STATE_DIR/env/avorofin-stock-planning-snapshot-worker.env" \
  "$TAG_STOCK"
test "$(docker inspect -f '{{.Image}}' avorofin-stock-planning-snapshot-worker)" = "$EXPECT_IMAGE_ID_STOCK"

# 5 APP last
docker rename avorofin-app avorofin-app-pre-fa180500
docker stop avorofin-app-pre-fa180500
docker run -d --name avorofin-app --restart unless-stopped \
  --user nextjs --network bridge --workdir /app \
  -p 127.0.0.1:3000:3000 \
  --env-file "$STATE_DIR/env/avorofin-app.env" \
  "$TAG_APP"
test "$(docker inspect -f '{{.Image}}' avorofin-app)" = "$EXPECT_IMAGE_ID_APP"
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login
```

On any failure: stop new writers, do not resume cron, run rollback below.

## Targeted read-model rebuild (after healthy cutover only)
Week 2026-10-19..2026-10-25, scopes Петров / Лебедева / ALL, via existing profit→V6 producers/queues.
No DELETE of FinanceTransaction / LoanPayment / primary accruals. No hand-edit totals.

## Rollback
```bash
set -euo pipefail
STATE_DIR="${HOME}/fa-cutover-20261027_180500"
# Stop new containers if present
for c in avorofin-stock-planning-snapshot-worker avorofin-dashboard-period-snapshot-worker \
         avorofin-v6-period-readmodel-worker avorofin-profit-readmodel-worker avorofin-app; do
  docker stop "$c" 2>/dev/null || true
  docker rm "$c" 2>/dev/null || true
done
# Restore pre containers (still present; do not prune)
for c in avorofin-app avorofin-profit-readmodel-worker avorofin-v6-period-readmodel-worker \
         avorofin-dashboard-period-snapshot-worker avorofin-stock-planning-snapshot-worker; do
  docker rename "${c}-pre-fa180500" "$c"
  docker start "$c"
done
# Read-model recovery path (ONE chosen): recompute week 19–25 with rolled-back profit+v6 images
# via existing producers — not image-only rollback of overwritten keys.
```

## Isolated switch/rollback mock test
See `scripts/fin_accept/test_cutover_plan_mock.sh` (docker/cron mocks; not MAIN).
