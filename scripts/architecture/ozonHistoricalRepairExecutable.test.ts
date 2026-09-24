import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createMemoryOzonAccrualStore } from "../../lib/ozon/syncOzonAccrualByDay";
import {
  OWNER_EXECUTE_MARKER,
  assertSourceTargetExactMatch,
  buildPrepareCacheManifestSha,
  executePostBatch,
  executeSourceTargetsFromCache,
  executeStandaloneStatuses,
  parseMode,
  regressionNormalInvalidationStillDefault,
  repairOnlyRequiresDeferred,
  requireExplicit,
  sealPreparedTarget,
  validateExecuteBinding,
  type PrepareCache,
  type SourceTarget,
  type SnapshotKey,
  type V2Target,
} from "../financialRepair/runOzonHistoricalFinancialRepair";

function sha(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

function minimalAccrual(date: string, amount = -15) {
  return {
    accrual_id: Number(date.replace(/-/g, "")),
    date,
    total_amount: amount,
    non_item_fee: { type_id: 84, accrued: amount },
  };
}

test("EXECUTABLE: mutation helpers exist and EXECUTE rejects defaults", () => {
  assert.equal(parseMode("EXECUTE_FROM_CACHE"), "EXECUTE_FROM_CACHE");
  assert.throws(() => requireExplicit("operationId", "UNSET"));
  assert.throws(() => requireExplicit("operationId", undefined));
  assert.equal(regressionNormalInvalidationStillDefault(), true);
  assert.equal(repairOnlyRequiresDeferred(), true);
});

test("SOURCE_DRIFT always STOP", () => {
  assert.throws(
    () =>
      assertSourceTargetExactMatch({
        sealed: {
          companyId: "c",
          companyName: "ИП Петров",
          date: "2026-07-06",
          rawResponseHash: "aaa",
          pageHashes: ["p1"],
          rowCount: 1,
          fullMapperResultHash: "m1",
        },
        observed: {
          rawResponseHash: "bbb",
          pageHashes: ["p1"],
          rowCount: 1,
          fullMapperResultHash: "m1",
        },
      }),
    /SOURCE_DRIFT=YES/
  );
});

test("ephemeral E2E: PREPARE cache -> EXECUTE_FROM_CACHE idempotent resume", async () => {
  const dates = ["2026-07-06", "2026-07-11"]; // miniature stand-in; full 78 covered by orchestrated e2e script
  const targets: SourceTarget[] = [];
  const cacheTargets = [];
  for (const date of dates) {
    const accruals = [minimalAccrual(date)];
    const pageHashes = [sha(JSON.stringify(accruals))];
    const rawResponseHash = sha(JSON.stringify({ accruals, date }));
    const sealed: SourceTarget = {
      companyId: "cmp_test",
      companyName: "ИП Петров",
      date,
      rawResponseHash,
      pageHashes,
      rowCount: 1,
      fullMapperResultHash: "TEST",
      ACCOUNT_AUTHORITY_ID: "conn_test",
    };
    const prepared = sealPreparedTarget({
      sealed,
      accruals,
      requestedDates: [date],
      dayEnvelopes: [
        {
          date,
          httpOk: true,
          pages: 1,
          paginationComplete: true,
          rawAccrualCount: 1,
          explicitZeroDayEvidence: false,
        } as never,
      ],
      pagesByDay: { [date]: 1 },
      rawResponseHash,
      pageHashes,
    });
    targets.push(prepared.sealed);
    cacheTargets.push(prepared);
  }

  const snapshotKeys: SnapshotKey[] = [
    {
      companyScope: "ALL",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      formulaVersion: "FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1",
    },
  ];
  const v2Targets: V2Target[] = [
    {
      dbId: "v2_july",
      period: "2026-07",
      scope: "ALL",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      expectedCanonicalWb: 15708958.04,
      expectedCanonicalOzon: 29465148.86,
      expectedTotal: 45174106.9,
    },
    {
      dbId: "v2_aug",
      period: "2026-08",
      scope: "ALL",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
      expectedCanonicalWb: 27649638.17,
      expectedCanonicalOzon: 64190278.77,
      expectedTotal: 91839916.94,
    },
  ];

  const cache: PrepareCache = {
    version: "AVOROFIN_OZON_HISTORICAL_REPAIR_PREPARE_CACHE_V1",
    createdAt: new Date().toISOString(),
    sourceBackfillManifestSha256: "s",
    statusOnlyManifestSha256: "t",
    snapshotTargetManifestSha256: "u",
    v2TargetManifestSha256: "v",
    targets: cacheTargets,
    statusOnly: Array.from({ length: 10 }, (_, i) => ({
      company: "ИП Петров",
      date: `2026-08-${String(9 + i).padStart(2, "0")}`,
      importSessionId: `imp_${i}`,
    })),
    snapshotKeys,
    v2Targets,
    noCredentials: true,
  };
  assert.ok(buildPrepareCacheManifestSha(cache).length === 64);

  const store = createMemoryOzonAccrualStore();
  const completed = new Set<string>();

  const first = await executeSourceTargetsFromCache({
    cache,
    adapters: {
      store,
      inspectTargetState: async (t) =>
        completed.has(`${t.companyName}|${t.date}`)
          ? { state: "NOOP_COMPLETE" }
          : { state: "MISSING" },
    },
  });
  assert.equal(first.persisted, 2);
  assert.equal(first.separateStatusUpserts, 0);
  for (const t of targets) completed.add(`${t.companyName}|${t.date}`);

  // crash after raw: simulate RAW_PERSISTED_RESUME for a third synthetic day via store raw map
  const store2 = createMemoryOzonAccrualStore();
  // first persist one target
  const oneCache: PrepareCache = { ...cache, targets: [cacheTargets[0]!] };
  await executeSourceTargetsFromCache({
    cache: oneCache,
    adapters: { store: store2 },
  });
  const rawIds = [...store2.rawById.keys()];
  assert.equal(rawIds.length, 1);

  // Force canonical path again via resume (idempotent-ish)
  const resume = await executeSourceTargetsFromCache({
    cache: oneCache,
    adapters: {
      store: store2,
      inspectTargetState: async () => ({ state: "RAW_PERSISTED_RESUME", rawId: rawIds[0] }),
    },
  });
  assert.equal(resume.resumed, 1);

  // full rerun NOOP
  const rerun = await executeSourceTargetsFromCache({
    cache,
    adapters: {
      store,
      inspectTargetState: async (t) =>
        completed.has(`${t.companyName}|${t.date}`)
          ? { state: "NOOP_COMPLETE" }
          : { state: "MISSING" },
    },
  });
  assert.equal(rerun.noopComplete, 2);
  assert.equal(rerun.persisted, 0);

  const status = await executeStandaloneStatuses({
    targets: cache.statusOnly,
    upsert: async () => "WRITTEN",
  });
  assert.equal(status.written, 10);

  const post = await executePostBatch({
    snapshotKeys,
    expectedDeleteCount: 1,
    expectedRequeueCount: 1,
    v2Targets,
    applySnapshotPostBatch: async (keys) => ({ deleted: keys.length, requeued: keys.length }),
    rebuildV2Targets: async (ts) => ({ rebuilt: ts.length }),
  });
  assert.equal(post.snapshotDeleted, 1);
  assert.equal(post.v2Rebuilt, 2);
});

test("EXECUTE binding rejects self-accepting file defaults", () => {
  const dir = join(process.cwd(), ".tmp-repair-bind-test");
  mkdirSync(dir, { recursive: true });
  const files = {
    sourceBackfillPath: join(dir, "s.json"),
    statusOnlyPath: join(dir, "t.json"),
    snapshotPath: join(dir, "u.json"),
    v2Path: join(dir, "v.json"),
    prepareCacheManifestPath: join(dir, "c.json"),
  };
  for (const [k, p] of Object.entries(files)) writeFileSync(p, JSON.stringify({ k }) + "\n");
  assert.throws(() =>
    validateExecuteBinding(
      {
        operationId: "op",
        approvalBindingSha256: "a",
        sourceBackfillManifestSha256: "WRONG",
        statusOnlyManifestSha256: sha(readFileSync(files.statusOnlyPath)),
        snapshotTargetManifestSha256: sha(readFileSync(files.snapshotPath)),
        v2TargetManifestSha256: sha(readFileSync(files.v2Path)),
        expectedPreDeployAppImageSha256: "sha256:old",
        expectedCandidateAppImageSha256: "sha256:new",
        expectedRepairRunnerImageSha256: "sha256:runner",
        sourceBackfillTargetCount: 78,
        statusStandaloneTargetCount: 10,
        snapshotPostBatchDeleteCount: 35,
        snapshotPostBatchRequeueCount: 35,
        v2NumericMutationTargetCount: 2,
        executeMarker: OWNER_EXECUTE_MARKER,
        prepareCacheManifestSha256: sha(readFileSync(files.prepareCacheManifestPath)),
        mutationTimeAppImageSha256: "sha256:new",
      },
      files
    )
  );
});
