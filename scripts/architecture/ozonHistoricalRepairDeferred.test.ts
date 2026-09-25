import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldInvalidateProfit,
  shouldInvalidateSnapshots,
  separateStatusUpsertForSourceBackfillAllowed,
  postBatchV2PromotionAllowed,
} from "../../lib/ozon/historicalRepairInvalidationPolicy";
import {
  OWNER_EXECUTE_MARKER,
  parseMode,
  requireExplicit,
  resolveVerifyPhase,
  validateExecuteBinding,
  regressionNormalInvalidationStillDefault,
  repairOnlyRequiresDeferred,
  type ExecuteBinding,
} from "../financialRepair/runOzonHistoricalFinancialRepair";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

function sha(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

test("NORMAL ingest still invalidates snapshots and profit", () => {
  assert.equal(shouldInvalidateSnapshots("NORMAL"), true);
  assert.equal(shouldInvalidateProfit("NORMAL"), true);
  assert.equal(shouldInvalidateSnapshots(), true);
});

test("DEFERRED_OWNER_REPAIR does not per-target invalidate", () => {
  assert.equal(shouldInvalidateSnapshots("DEFERRED_OWNER_REPAIR"), false);
  assert.equal(shouldInvalidateProfit("DEFERRED_OWNER_REPAIR"), false);
});

test("78 intrinsic statuses are not separately rewritten", () => {
  assert.equal(separateStatusUpsertForSourceBackfillAllowed(), false);
});

test("only ALL V2 rows may be numerically promoted", () => {
  assert.equal(postBatchV2PromotionAllowed("ALL"), true);
  assert.equal(postBatchV2PromotionAllowed("ИП Петров"), false);
  assert.equal(postBatchV2PromotionAllowed("ИП Лебедева"), false);
});

test("regression: NORMAL remains default; repair-only requires deferred", () => {
  assert.equal(regressionNormalInvalidationStillDefault(), true);
  assert.equal(repairOnlyRequiresDeferred(), true);
});

test("EXECUTE binding fail-closed on manifest mismatch; marker required", () => {
  assert.equal(parseMode(undefined), "DRY_RUN");
  assert.equal(parseMode("EXECUTE_FROM_CACHE"), "EXECUTE_FROM_CACHE");
  assert.throws(() => requireExplicit("x", undefined));

  const dir = join(process.cwd(), ".tmp-deferred-bind");
  mkdirSync(dir, { recursive: true });
  const files = {
    sourceBackfillPath: join(dir, "s.json"),
    statusOnlyPath: join(dir, "t.json"),
    snapshotPath: join(dir, "u.json"),
    v2Path: join(dir, "v.json"),
    prepareCacheManifestPath: join(dir, "PREPARE_CACHE.sha256.txt"),
  };
  for (const [key, path] of Object.entries(files)) {
    writeFileSync(path, key === "prepareCacheManifestPath" ? sha("cache") + "\n" : "{}\n");
  }

  const binding: ExecuteBinding = {
    operationId: "op",
    approvalBindingSha256: "a",
    sourceBackfillManifestSha256: sha("{}\n"),
    statusOnlyManifestSha256: sha("{}\n"),
    snapshotTargetManifestSha256: sha("{}\n"),
    v2TargetManifestSha256: sha("{}\n"),
    expectedPreDeployAppImageSha256: "sha256:old",
    expectedCandidateAppImageSha256: "sha256:new",
    expectedRepairRunnerImageSha256: "sha256:runner",
    sourceBackfillTargetCount: 78,
    statusStandaloneTargetCount: 10,
    snapshotPostBatchDeleteCount: 35,
    snapshotPostBatchRequeueCount: 35,
    v2NumericMutationTargetCount: 2,
    executeMarker: OWNER_EXECUTE_MARKER,
    prepareCacheContentSha256: sha("cache"),
    prepareCacheManifestSha256: sha("cache"),
    mutationTimeAppImageSha256: "sha256:new",
  };

  validateExecuteBinding(binding, files);
  assert.throws(
    () => validateExecuteBinding({ ...binding, sourceBackfillManifestSha256: "WRONG" }, files),
    /sourceBackfillManifestSha256 file mismatch/
  );
  assert.throws(
    () => validateExecuteBinding({ ...binding, executeMarker: "SOMETHING_ELSE" }, files),
    /executeMarker mismatch/
  );
  assert.throws(
    () => validateExecuteBinding({ ...binding, mutationTimeAppImageSha256: "sha256:stale" }, files),
    /MUTATION_TIME_REQUIRED_APP_IMAGE/
  );
  // The prepare-cache binding is a CONTENT sha, so the sidecar's file sha fails.
  assert.throws(
    () =>
      validateExecuteBinding(
        {
          ...binding,
          prepareCacheContentSha256: sha(sha("cache") + "\n"),
          prepareCacheManifestSha256: sha(sha("cache") + "\n"),
        },
        files
      ),
    /prepareCacheContentSha256 mismatch/
  );
});

test("VERIFY is addressable as two stages", () => {
  assert.equal(parseMode("VERIFY_MUTATION_POSTCONDITIONS"), "VERIFY_MUTATION_POSTCONDITIONS");
  assert.equal(parseMode("VERIFY_FINAL_FINANCIAL_OUTPUT"), "VERIFY_FINAL_FINANCIAL_OUTPUT");
  assert.equal(resolveVerifyPhase("VERIFY"), "ALL");
  assert.equal(resolveVerifyPhase("VERIFY_MUTATION_POSTCONDITIONS"), "MUTATION_POSTCONDITIONS");
  assert.equal(resolveVerifyPhase("VERIFY_FINAL_FINANCIAL_OUTPUT"), "FINAL_FINANCIAL_OUTPUT");
});
