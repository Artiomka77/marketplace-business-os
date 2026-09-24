#!/usr/bin/env bash
# FUTURE production wrapper — DO NOT RUN NOW.
# Implements PRE / DEPLOY / PREPARE / QUIESCE / EXECUTE / POST-BATCH / RESTORE / VERIFY / ROLLBACK.
set -euo pipefail

die() { echo "FATAL: $*" >&2; exit 1; }

: "${OWNER_APPROVAL_FILE:?}"
: "${OWNER_APPROVAL_SHA256:?}"
: "${SOURCE_MANIFEST:?}"
: "${STATUS_MANIFEST:?}"
: "${SNAPSHOT_MANIFEST:?}"
: "${V2_MANIFEST:?}"
: "${PREPARE_CACHE:?}"
: "${PREPARE_CACHE_MANIFEST:?}"
: "${OPERATION_ID:?}"
: "${APPROVAL_BINDING_SHA256:?}"
: "${SOURCE_BACKFILL_MANIFEST_SHA256:?}"
: "${STATUS_ONLY_MANIFEST_SHA256:?}"
: "${SNAPSHOT_TARGET_MANIFEST_SHA256:?}"
: "${V2_TARGET_MANIFEST_SHA256:?}"
: "${PRE_DEPLOY_APP_IMAGE:?}"
: "${CANDIDATE_APP_IMAGE:?}"
: "${REPAIR_RUNNER_IMAGE:?}"
: "${PREPARE_CACHE_MANIFEST_SHA256:?}"
: "${SECRET_ENV_FILE:?}"

sha_file() { sha256sum "$1" | awk '{print $1}'; }

echo "=== PRE: verify owner approval + manifests (no DB writes) ==="
test -f "$OWNER_APPROVAL_FILE" || die "missing owner approval"
test "$(sha_file "$OWNER_APPROVAL_FILE")" = "$OWNER_APPROVAL_SHA256" || die "owner approval sha mismatch"
test "$(sha_file "$SOURCE_MANIFEST")" = "$SOURCE_BACKFILL_MANIFEST_SHA256" || die "source manifest sha"
test "$(sha_file "$STATUS_MANIFEST")" = "$STATUS_ONLY_MANIFEST_SHA256" || die "status manifest sha"
test "$(sha_file "$SNAPSHOT_MANIFEST")" = "$SNAPSHOT_TARGET_MANIFEST_SHA256" || die "snapshot manifest sha"
test "$(sha_file "$V2_MANIFEST")" = "$V2_TARGET_MANIFEST_SHA256" || die "v2 manifest sha"
test "$(sha_file "$PREPARE_CACHE_MANIFEST")" = "$PREPARE_CACHE_MANIFEST_SHA256" || die "prepare cache manifest sha"
test "$SOURCE_BACKFILL_MANIFEST_SHA256" != "6f11a0d69daf2497e0bc6872bab67ded248c3196c08f22cfc31bba69565bf647" || die "stale banned hash"

CURRENT_APP=$(docker inspect -f '{{.Image}}' avorofin-app)
test "$CURRENT_APP" = "$PRE_DEPLOY_APP_IMAGE" || die "pre-deploy APP image drift: $CURRENT_APP"

echo "=== DEPLOY: load/deploy exact candidate APP (host-specific; placeholder) ==="
# Host operator loads $CANDIDATE_APP_IMAGE and switches avorofin-app to it.
# Then prove:
MUTATION_APP=$(docker inspect -f '{{.Image}}' avorofin-app)
test "$MUTATION_APP" = "$CANDIDATE_APP_IMAGE" || die "mutation-time APP is not candidate"

echo "=== PREPARE: launch repair-runner PREPARE (still no DB writes) ==="
docker run --rm --network none \
  -v "$(pwd)/manifests:/manifests:ro" \
  "$REPAIR_RUNNER_IMAGE" \
  --mode=PREPARE \
  --sourceManifest=/manifests/source.json \
  --statusManifest=/manifests/status.json \
  --snapshotManifest=/manifests/snapshot.json \
  --v2Manifest=/manifests/v2.json \
  --prepareCacheIn=/manifests/prepare-cache-in.json \
  --prepareCacheOut=/manifests/prepare-cache-out \
  || die "PREPARE failed"

echo "=== QUIESCE: stop APP + affected workers (mechanism B) ==="
for c in avorofin-app avorofin-profit-readmodel-worker avorofin-v6-period-readmodel-worker avorofin-dashboard-period-snapshot-worker; do
  docker stop "$c"
  test "$(docker inspect -f '{{.State.Status}}' "$c")" = "exited" || die "failed to stop $c"
done
# stock worker remains running (STOCK_PLANNING only)

echo "=== EXECUTE_FROM_CACHE ==="
docker run --rm \
  --env-file "$SECRET_ENV_FILE" \
  -v "$(pwd)/manifests:/manifests:ro" \
  -v "$(pwd)/out:/out" \
  "$REPAIR_RUNNER_IMAGE" \
  --mode=EXECUTE_FROM_CACHE \
  --operationId="$OPERATION_ID" \
  --approvalBindingSha256="$APPROVAL_BINDING_SHA256" \
  --sourceBackfillManifestSha256="$SOURCE_BACKFILL_MANIFEST_SHA256" \
  --statusOnlyManifestSha256="$STATUS_ONLY_MANIFEST_SHA256" \
  --snapshotTargetManifestSha256="$SNAPSHOT_TARGET_MANIFEST_SHA256" \
  --v2TargetManifestSha256="$V2_TARGET_MANIFEST_SHA256" \
  --expectedPreDeployAppImageSha256="$PRE_DEPLOY_APP_IMAGE" \
  --expectedCandidateAppImageSha256="$CANDIDATE_APP_IMAGE" \
  --expectedRepairRunnerImageSha256="$REPAIR_RUNNER_IMAGE" \
  --mutationTimeAppImageSha256="$CANDIDATE_APP_IMAGE" \
  --sourceBackfillTargetCount=78 \
  --statusStandaloneTargetCount=10 \
  --snapshotPostBatchDeleteCount=35 \
  --snapshotPostBatchRequeueCount=35 \
  --v2NumericMutationTargetCount=2 \
  --executeMarker=OWNER_EXECUTE_OZON_HISTORICAL_FINANCIAL_REPAIR_V1 \
  --prepareCacheManifestSha256="$PREPARE_CACHE_MANIFEST_SHA256" \
  --sourceManifest=/manifests/source.json \
  --statusManifest=/manifests/status.json \
  --snapshotManifest=/manifests/snapshot.json \
  --v2Manifest=/manifests/v2.json \
  --prepareCache=/manifests/PREPARE_CACHE.json \
  --prepareCacheManifest=/manifests/PREPARE_CACHE.sha256.txt \
  --outDir=/out \
  || die "EXECUTE failed"

echo "=== RESTORE exact containers ==="
for c in avorofin-app avorofin-profit-readmodel-worker avorofin-v6-period-readmodel-worker avorofin-dashboard-period-snapshot-worker; do
  docker start "$c"
done

echo "=== VERIFY ==="
docker run --rm --env-file "$SECRET_ENV_FILE" "$REPAIR_RUNNER_IMAGE" --mode=VERIFY --outDir=/out || true

echo "=== STOP. NO Stage1B. shred secret env file ==="
shred -u "$SECRET_ENV_FILE" 2>/dev/null || rm -f "$SECRET_ENV_FILE"
echo "WRAPPER_COMPLETE_NO_STAGE1B"
