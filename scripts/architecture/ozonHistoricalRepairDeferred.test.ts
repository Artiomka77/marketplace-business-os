import assert from "node:assert/strict";
import test from "node:test";

import {
  shouldInvalidateProfit,
  shouldInvalidateSnapshots,
  separateStatusUpsertForSourceBackfillAllowed,
  postBatchV2PromotionAllowed,
} from "../../lib/ozon/historicalRepairInvalidationPolicy";
import {
  planHistoricalRepair,
  OWNER_EXECUTE_MARKER,
  type RepairRunnerInputs,
  type RepairRunnerManifests,
} from "../financialRepair/runOzonHistoricalFinancialRepair";

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

test("runner preflight fail-closed on manifest mismatch", () => {
  const manifests: RepairRunnerManifests = {
    sourceBackfill: {
      SOURCE_BACKFILL_TARGET_COUNT: 78,
      targets: Array.from({ length: 78 }, (_, i) => ({
        companyName: "ИП Петров",
        companyId: "c",
        date: `2026-07-${String((i % 31) + 1).padStart(2, "0")}`,
        rawResponseHash: "a",
      })),
    },
    statusOnly: {
      STANDALONE_STATUS_ONLY_REPAIR: 10,
      targets: Array.from({ length: 10 }, (_, i) => ({
        company: "ИП Петров",
        date: `2026-08-${String(9 + i).padStart(2, "0")}`,
        importSessionId: `s${i}`,
      })),
    },
    postBatch: {
      V2_NUMERIC_MUTATION_TARGET_COUNT: 2,
      PROFIT_RM_EXPLICIT_TARGET_COUNT: 0,
      SNAPSHOT_EXPLICIT_TARGET_COUNT: 0,
      v2Targets: [
        { period: "2026-07", scope: "ALL", dbId: "a" },
        { period: "2026-08", scope: "ALL", dbId: "b" },
      ],
      profitTargets: [],
      snapshotTargets: [],
    },
  };
  const inputs: RepairRunnerInputs = {
    operationId: "op1",
    sourceBackfillManifestSha256: "aaa",
    statusOnlyManifestSha256: "bbb",
    postBatchTargetsSha256: "ccc",
    expectedProductionAppImageSha256: "sha256:prod",
    sourceBackfillTargetCount: 78,
    statusStandaloneTargetCount: 10,
  };
  const bad = planHistoricalRepair({
    inputs,
    manifests,
    sourceBackfillFileSha256: "WRONG",
    statusOnlyFileSha256: "bbb",
    postBatchFileSha256: "ccc",
    currentProductionAppImageSha256: "sha256:prod",
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.failures.some((f) => /sourceBackfillManifestSha256/.test(f)));
  assert.equal(bad.plan.separateStatusUpsertsForSourceBackfill, 0);
  assert.equal(bad.plan.standaloneStatusOnly, 10);
  assert.equal(bad.mode, "DRY_RUN");
});

test("runner defaults DRY_RUN; EXECUTE requires exact marker", () => {
  const manifests: RepairRunnerManifests = {
    sourceBackfill: {
      SOURCE_BACKFILL_TARGET_COUNT: 78,
      targets: Array.from({ length: 78 }, () => ({
        companyName: "ИП Петров",
        companyId: "c",
        date: "2026-07-01",
        rawResponseHash: "a",
      })),
    },
    statusOnly: {
      STANDALONE_STATUS_ONLY_REPAIR: 10,
      targets: Array.from({ length: 10 }, () => ({
        company: "ИП Петров",
        date: "2026-08-09",
        importSessionId: "s",
      })),
    },
    postBatch: {
      V2_NUMERIC_MUTATION_TARGET_COUNT: 2,
      PROFIT_RM_EXPLICIT_TARGET_COUNT: 0,
      SNAPSHOT_EXPLICIT_TARGET_COUNT: 0,
      v2Targets: [
        { period: "2026-07", scope: "ALL", dbId: "a" },
        { period: "2026-08", scope: "ALL", dbId: "b" },
      ],
      profitTargets: [],
      snapshotTargets: [],
    },
  };
  const base: RepairRunnerInputs = {
    operationId: "op1",
    sourceBackfillManifestSha256: "aaa",
    statusOnlyManifestSha256: "bbb",
    postBatchTargetsSha256: "ccc",
    expectedProductionAppImageSha256: "sha256:prod",
    sourceBackfillTargetCount: 78,
    statusStandaloneTargetCount: 10,
  };
  const dry = planHistoricalRepair({
    inputs: base,
    manifests,
    sourceBackfillFileSha256: "aaa",
    statusOnlyFileSha256: "bbb",
    postBatchFileSha256: "ccc",
    currentProductionAppImageSha256: "sha256:prod",
  });
  assert.equal(dry.mode, "DRY_RUN");
  assert.equal(dry.ok, true);

  const exec = planHistoricalRepair({
    inputs: { ...base, executeMarker: OWNER_EXECUTE_MARKER },
    manifests,
    sourceBackfillFileSha256: "aaa",
    statusOnlyFileSha256: "bbb",
    postBatchFileSha256: "ccc",
    currentProductionAppImageSha256: "sha256:prod",
  });
  assert.equal(exec.mode, "EXECUTE");
  assert.equal(exec.ok, true);
});
