import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { PrismaClient } from "@prisma/client";

import { createMemoryOzonAccrualStore } from "../../lib/ozon/syncOzonAccrualByDay";
import {
  applyExactSnapshotUnionOnce,
  assertCredentialAuthorityMatch,
  collectV2MatrixRows,
  computeCertificationRawResponseHash,
  computeOzonAccrualPayloadSha256,
  computeV2PeriodRowFingerprint,
  inspectOzonSourceTargetState,
  installOzonNetworkTripwire,
  rebuildV2PeriodTargets,
  runProductionAdapterReadinessGate,
  type OzonRepairFetchRange,
  type ProductionMutationAdapters,
  type RepairSourceTarget,
} from "../../lib/ozon/financialRepairProductionAdapters";
import {
  OWNER_APPROVAL_ALLOWED_KEYS,
  assertBindingMatchesOwnerApproval,
  parseOwnerApprovalText,
  resolveOwnerApprovalImmutableBinding,
  verifyAndParseOwnerApprovalFile,
} from "../../lib/ozon/ownerApprovalBinding";
import {
  OWNER_EXECUTE_MARKER,
  assertSourceTargetExactMatch,
  buildPrepareCacheManifestSha,
  createEphemeralMutationAdapters,
  executePostBatch,
  executeSourceTargetsFromCache,
  executeStandaloneStatuses,
  parseMode,
  preparePrepareCacheLive,
  regressionNormalInvalidationStillDefault,
  repairOnlyRequiresDeferred,
  requireExplicit,
  resolveSealedPrepareCacheContentSha,
  resolveVerifyPhase,
  runCli,
  runFullRepairPreMutationGate,
  sealPreparedTarget,
  validateExecuteBinding,
  type PrepareCache,
  type SourceTarget,
  type StatusOnlyTarget,
  type SnapshotKey,
  type V2Target,
} from "../financialRepair/runOzonHistoricalFinancialRepair";

function sha(s: string | Uint8Array) {
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

/* ------------------------------------------------------------------ *
 * Production-shaped fixtures: 78 / 10 / 35 / 6
 * ------------------------------------------------------------------ */

/** The 6 sealed V2 matrix rows: 2 ALL mutation targets + 4 kept UNAVAILABLE. */
const v2MatrixFixture: V2Target[] = [
  {
    dbId: "cmtq2w4hs00v801dsqc1jd3qs",
    period: "2026-07",
    scope: "ALL",
    dateFrom: "2026-07-01",
    dateTo: "2026-07-31",
    formulaVersion: "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2",
    expectedCanonicalWb: 15708958.04,
    expectedCanonicalOzon: 29465148.86,
    expectedTotal: 45174106.9,
    currentRowFingerprint: "77c40f5db970d5f5f2697f525a3a990f6ac53d5c4a031d74f849ef61ee4fd057",
    currentDataMode: "PRELIMINARY",
    currentCoverageStatus: "COMPLETE",
  },
  {
    dbId: "cmtog1h33005201dsjboxzm4x",
    period: "2026-08",
    scope: "ALL",
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    formulaVersion: "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2",
    expectedCanonicalWb: 27649638.17,
    expectedCanonicalOzon: 64190278.77,
    expectedTotal: 91839916.94,
    currentRowFingerprint: "9bd61609cc0c4ab51439c5692c74e51d8d13af65e672a3dfa8cb6a09f0cde429",
    currentDataMode: "PRELIMINARY",
    currentCoverageStatus: "COMPLETE",
  },
  {
    dbId: "cmtq2w4cm00v701dskjm7uhva",
    period: "2026-07",
    scope: "ИП Петров",
    dateFrom: "2026-07-01",
    dateTo: "2026-07-31",
    formulaVersion: "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2",
    expectedCanonicalWb: 13838095.96,
    expectedCanonicalOzon: "MUST_REMAIN_UNAVAILABLE",
    expectedTotal: "MUST_REMAIN_UNAVAILABLE",
    currentRowFingerprint: "786778dc2bdccee3badb44c0b5bf3ecda33a77e4343b50f3a082e5f581cfb1e7",
    currentDataMode: "PRELIMINARY",
    currentCoverageStatus: "COMPLETE",
  },
  {
    dbId: "cmtq2vzxp00v601dskhbbstmo",
    period: "2026-07",
    scope: "ИП Лебедева",
    dateFrom: "2026-07-01",
    dateTo: "2026-07-31",
    formulaVersion: "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2",
    expectedCanonicalWb: 1870862.08,
    expectedCanonicalOzon: "MUST_REMAIN_UNAVAILABLE",
    expectedTotal: "MUST_REMAIN_UNAVAILABLE",
    currentRowFingerprint: "ba4cf239195158bcdcc7fb3828f4bac884c93502b8aaf88fd6653525c3590dae",
    currentDataMode: "PRELIMINARY",
    currentCoverageStatus: "COMPLETE",
  },
  {
    dbId: "cmtog1h13005101dspx2ugixo",
    period: "2026-08",
    scope: "ИП Петров",
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    formulaVersion: "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2",
    expectedCanonicalWb: 25301401.41,
    expectedCanonicalOzon: "MUST_REMAIN_UNAVAILABLE",
    expectedTotal: "MUST_REMAIN_UNAVAILABLE",
    currentRowFingerprint: "750e27de7292dbb70256be40696f77d87a33bb737b06208a44ea834821bdb19a",
    currentDataMode: "PRELIMINARY",
    currentCoverageStatus: "COMPLETE",
  },
  {
    dbId: "cmtog1fm9005001dsklwdd94u",
    period: "2026-08",
    scope: "ИП Лебедева",
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    formulaVersion: "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2",
    expectedCanonicalWb: 2348236.76,
    expectedCanonicalOzon: "MUST_REMAIN_UNAVAILABLE",
    expectedTotal: "MUST_REMAIN_UNAVAILABLE",
    currentRowFingerprint: "88613e4b6b215139607ec6dabbaa04b8d07068106bf6161035b412f8bf1b6489",
    currentDataMode: "PRELIMINARY",
    currentCoverageStatus: "COMPLETE",
  },
];

/** 2 companies x 39 days = the 78 sealed source targets, plus 10 / 35 / 2. */
function buildFullRepairFixture(): {
  cache: PrepareCache;
  sourceTargets: SourceTarget[];
  statusTargets: StatusOnlyTarget[];
  snapshotKeys: SnapshotKey[];
} {
  const companies = ["ИП Петров", "ИП Лебедева"];
  const sourceTargets: SourceTarget[] = [];
  const cacheTargets = [];
  for (let day = 0; day < 39; day += 1) {
    const date = new Date(Date.UTC(2026, 5, 1) + day * 86_400_000).toISOString().slice(0, 10);
    for (const companyName of companies) {
      const accruals = [minimalAccrual(date)];
      const pageHashes = [sha(JSON.stringify({ companyName, accruals }))];
      const rawResponseHash = sha(JSON.stringify({ companyName, accruals, date }));
      const prepared = sealPreparedTarget({
        sealed: {
          companyId: `cmp_${companyName}`,
          companyName,
          date,
          rawResponseHash,
          pageHashes,
          rowCount: 1,
          fullMapperResultHash: "TEST",
          ACCOUNT_AUTHORITY_ID: `conn_${companyName}`,
        },
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
      sourceTargets.push(prepared.sealed);
      cacheTargets.push(prepared);
    }
  }

  const statusTargets: StatusOnlyTarget[] = Array.from({ length: 10 }, (_, i) => {
    const date = `2026-08-${String(9 + i).padStart(2, "0")}`;
    return {
      company: "ИП Петров",
      date,
      importSessionId: `impozapi_${i}`,
      expectedPayloadSha256: sha(`ephemeral-status-gate|${date}`),
    };
  });
  const snapshotKeys: SnapshotKey[] = Array.from({ length: 35 }, (_, i) => ({
    companyScope: "ALL",
    dateFrom: "2026-01-01",
    dateTo: new Date(Date.UTC(2026, 6, 1) + i * 86_400_000).toISOString().slice(0, 10),
    formulaVersion: "FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1",
  }));

  return {
    sourceTargets,
    statusTargets,
    snapshotKeys,
    cache: {
      version: "AVOROFIN_OZON_HISTORICAL_REPAIR_PREPARE_CACHE_V1",
      createdAt: "2026-09-25T00:00:00.000Z",
      sourceBackfillManifestSha256: "s",
      statusOnlyManifestSha256: "t",
      snapshotTargetManifestSha256: "u",
      v2TargetManifestSha256: "v",
      targets: cacheTargets,
      statusOnly: statusTargets,
      snapshotKeys,
      v2Targets: v2MatrixFixture.slice(0, 2),
      v2MatrixRows: v2MatrixFixture,
      noCredentials: true,
    },
  };
}

/** Same grammar and key set as the sealed owner approval text. */
function ownerApprovalFixtureFor(manifests: {
  sourceBackfillManifestSha256: string;
  statusOnlyManifestSha256: string;
  snapshotTargetManifestSha256: string;
  v2TargetManifestSha256: string;
}): string {
  return [
    "AVOROFIN FINANCIAL PRODUCTION EXECUTION OWNER APPROVAL",
    "STAMP=20260925_1130",
    "",
    "PRE_DEPLOY_CURRENT_APP_IMAGE_SHA256=sha256:pre",
    "CANDIDATE_APP_IMAGE_SHA256=sha256:candidate",
    "ROLLBACK_APP_IMAGE_SHA256=sha256:pre",
    "CANDIDATE_REPAIR_RUNNER_IMAGE_SHA256=sha256:runner",
    "",
    `SOURCE_BACKFILL_MANIFEST_SHA256=${manifests.sourceBackfillManifestSha256}`,
    "SOURCE_BACKFILL_TARGET_COUNT=78",
    `STATUS_ONLY_MANIFEST_SHA256=${manifests.statusOnlyManifestSha256}`,
    "STATUS_STANDALONE_REPAIR_COUNT=10",
    "STATUS_INTRINSIC_COUNT=78",
    "STATUS_DUPLICATE_SEPARATE_COUNT=0",
    `SNAPSHOT_POST_BATCH_MANIFEST_SHA256=${manifests.snapshotTargetManifestSha256}`,
    "SNAPSHOT_TARGET_KEY_COUNT=35",
    `V2_POST_BATCH_MANIFEST_SHA256=${manifests.v2TargetManifestSha256}`,
    "V2_MATRIX_ROW_COUNT=6",
    "V2_NUMERIC_MUTATION_TARGET_COUNT=2",
    "V2_NONMUTATED_UNAVAILABLE_ROW_COUNT=4",
    "V2_NON_NULL_FINGERPRINT_COUNT=6",
    "PROFIT_RM_EXPLICIT_TARGET_COUNT=0",
    "",
    "EXECUTE_FROM_CACHE_OZON_NETWORK_CALL_COUNT=0",
    "PRODUCTION_MUTATION=NO",
    "STAGE1B=NO",
    "",
  ].join("\n");
}

const OWNER_APPROVAL_FIXTURE = ownerApprovalFixtureFor({
  sourceBackfillManifestSha256: sha("source-manifest"),
  statusOnlyManifestSha256: sha("status-manifest"),
  snapshotTargetManifestSha256: sha("snapshot-manifest"),
  v2TargetManifestSha256: sha("v2-manifest"),
});

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
    prepareCacheManifestPath: join(dir, "PREPARE_CACHE.sha256.txt"),
  };
  for (const [k, p] of Object.entries(files)) {
    writeFileSync(p, k === "prepareCacheManifestPath" ? sha(k) + "\n" : JSON.stringify({ k }) + "\n");
  }
  const binding = {
    operationId: "op",
    approvalBindingSha256: "a",
    sourceBackfillManifestSha256: sha(readFileSync(files.sourceBackfillPath)),
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
    prepareCacheContentSha256: sha("prepareCacheManifestPath"),
    prepareCacheManifestSha256: sha("prepareCacheManifestPath"),
    mutationTimeAppImageSha256: "sha256:new",
  };

  assert.throws(
    () => validateExecuteBinding({ ...binding, sourceBackfillManifestSha256: "WRONG" }, files),
    /sourceBackfillManifestSha256 file mismatch/
  );

  // The prepare-cache sidecar is compared by CONTENT, never by its own bytes.
  assert.throws(
    () =>
      validateExecuteBinding(
        {
          ...binding,
          prepareCacheContentSha256: sha(readFileSync(files.prepareCacheManifestPath)),
          prepareCacheManifestSha256: sha(readFileSync(files.prepareCacheManifestPath)),
        },
        files
      ),
    /prepareCacheContentSha256 mismatch/,
    "binding the sidecar's own file sha must be refused, not accepted"
  );

  validateExecuteBinding(binding, files);
});

/* ------------------------------------------------------------------ *
 * Production adapters
 * ------------------------------------------------------------------ */

type FakeSql = { sql: string; values: unknown[] };

function recordSql(strings: TemplateStringsArray, values: unknown[]): FakeSql {
  return { sql: strings.join(" ? ").replace(/\s+/g, " ").trim(), values };
}

function fakeInspectClient(answers: {
  sessions?: Array<{ id: string; status: string; payloadSha256: string | null }>;
  dayStatus?: Array<{
    importSessionId: string;
    dataMode: string;
    coverageComplete: boolean;
    phase: string;
    payloadSha256: string | null;
  }>;
  factCount?: number;
}): PrismaClient {
  return {
    async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      const { sql } = recordSql(strings, values);
      if (sql.includes('FROM "ImportSession"')) return answers.sessions ?? [];
      if (sql.includes('FROM "OzonAccrualDayStatus"')) return answers.dayStatus ?? [];
      if (sql.includes('FROM "OzonFinancialCategoryFact"')) {
        return [{ count: answers.factCount ?? 0 }];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as PrismaClient;
}

const inspectTarget: RepairSourceTarget = {
  companyId: "cmp_test",
  companyName: "ИП Петров",
  date: "2026-07-06",
  rawResponseHash: "raw",
  pageHashes: ["p"],
  rowCount: 1,
  fullMapperResultHash: "m",
};

test("ADAPTERS: certification rawResponseHash recipe is the sealed manifest recipe", () => {
  const pageHashes = [sha("page-1"), sha("page-2")];
  assert.equal(
    computeCertificationRawResponseHash({
      date: "2026-07-06",
      pageHashes,
      count: 842,
      paginationComplete: true,
    }),
    sha(
      JSON.stringify({
        date: "2026-07-06",
        pageHashes,
        count: 842,
        paginationComplete: true,
      })
    )
  );
});

test("ADAPTERS: inspectTargetState resolves every real Prisma state", async () => {
  const payloadSha = sha("payload");

  assert.equal(
    (await inspectOzonSourceTargetState({ target: inspectTarget, client: fakeInspectClient({}) })).state,
    "MISSING"
  );

  const resume = await inspectOzonSourceTargetState({
    target: inspectTarget,
    client: fakeInspectClient({
      sessions: [{ id: "impozapi_raw", status: "RAW_PERSISTED", payloadSha256: payloadSha }],
    }),
    expectedPayloadSha256: payloadSha,
  });
  assert.equal(resume.state, "RAW_PERSISTED_RESUME");
  assert.equal(resume.rawId, "impozapi_raw");

  const noop = await inspectOzonSourceTargetState({
    target: inspectTarget,
    client: fakeInspectClient({
      sessions: [{ id: "impozapi_ok", status: "SUCCESS", payloadSha256: payloadSha }],
      dayStatus: [
        {
          importSessionId: "impozapi_ok",
          dataMode: "FINAL",
          coverageComplete: true,
          phase: "CANONICAL",
          payloadSha256: payloadSha,
        },
      ],
    }),
    expectedPayloadSha256: payloadSha,
  });
  assert.equal(noop.state, "NOOP_COMPLETE");

  // A canonical session whose day status is not FINAL must STOP, not silently rewrite.
  assert.equal(
    (
      await inspectOzonSourceTargetState({
        target: inspectTarget,
        client: fakeInspectClient({
          sessions: [{ id: "impozapi_ok", status: "SUCCESS", payloadSha256: payloadSha }],
        }),
      })
    ).state,
    "CONFLICT"
  );

  // Payload drift between DB and sealed cache must STOP.
  assert.equal(
    (
      await inspectOzonSourceTargetState({
        target: inspectTarget,
        client: fakeInspectClient({
          sessions: [{ id: "impozapi_ok", status: "SUCCESS", payloadSha256: payloadSha }],
          dayStatus: [
            {
              importSessionId: "impozapi_ok",
              dataMode: "FINAL",
              coverageComplete: true,
              phase: "CANONICAL",
              payloadSha256: sha("other"),
            },
          ],
        }),
        expectedPayloadSha256: payloadSha,
      })
    ).state,
    "CONFLICT"
  );

  // Duplicates and orphan canonical facts must STOP.
  assert.equal(
    (
      await inspectOzonSourceTargetState({
        target: inspectTarget,
        client: fakeInspectClient({
          sessions: [
            { id: "a", status: "SUCCESS", payloadSha256: null },
            { id: "b", status: "SUCCESS", payloadSha256: null },
          ],
        }),
      })
    ).state,
    "CONFLICT"
  );
  assert.equal(
    (
      await inspectOzonSourceTargetState({
        target: inspectTarget,
        client: fakeInspectClient({ factCount: 12 }),
      })
    ).state,
    "CONFLICT"
  );
});

test("ADAPTERS: NOOP and RESUME demand an exact payload sha, null is CONFLICT", async () => {
  const payloadSha = sha("payload");
  const finalDayStatus = (payloadSha256: string | null) => [
    {
      importSessionId: "impozapi_ok",
      dataMode: "FINAL",
      coverageComplete: true,
      phase: "CANONICAL",
      payloadSha256,
    },
  ];

  // NOOP: a null hash on either the session or the day status is unprovable.
  assert.equal(
    (
      await inspectOzonSourceTargetState({
        target: inspectTarget,
        client: fakeInspectClient({
          sessions: [{ id: "impozapi_ok", status: "SUCCESS", payloadSha256: null }],
          dayStatus: finalDayStatus(payloadSha),
        }),
        expectedPayloadSha256: payloadSha,
      })
    ).state,
    "CONFLICT",
    "canonical ImportSession without a payloadSha256 may never be skipped"
  );
  assert.equal(
    (
      await inspectOzonSourceTargetState({
        target: inspectTarget,
        client: fakeInspectClient({
          sessions: [{ id: "impozapi_ok", status: "SUCCESS", payloadSha256: payloadSha }],
          dayStatus: finalDayStatus(null),
        }),
        expectedPayloadSha256: payloadSha,
      })
    ).state,
    "CONFLICT",
    "day status without a payloadSha256 may never be skipped"
  );
  assert.equal(
    (
      await inspectOzonSourceTargetState({
        target: inspectTarget,
        client: fakeInspectClient({
          sessions: [{ id: "impozapi_ok", status: "SUCCESS", payloadSha256: sha("other") }],
          dayStatus: finalDayStatus(payloadSha),
        }),
        expectedPayloadSha256: payloadSha,
      })
    ).state,
    "CONFLICT",
    "ImportSession payload drift must STOP even when the day status agrees"
  );
  assert.equal(
    (
      await inspectOzonSourceTargetState({
        target: inspectTarget,
        client: fakeInspectClient({
          sessions: [{ id: "impozapi_ok", status: "SUCCESS", payloadSha256: payloadSha }],
          dayStatus: finalDayStatus(payloadSha),
        }),
      })
    ).state,
    "CONFLICT",
    "no sealed payload sha means no provable NOOP"
  );

  // RESUME: same rule for the surviving RAW_PERSISTED session.
  assert.equal(
    (
      await inspectOzonSourceTargetState({
        target: inspectTarget,
        client: fakeInspectClient({
          sessions: [{ id: "impozapi_raw", status: "RAW_PERSISTED", payloadSha256: null }],
        }),
        expectedPayloadSha256: payloadSha,
      })
    ).state,
    "CONFLICT",
    "RAW_PERSISTED without a payloadSha256 may never be resumed"
  );
  assert.equal(
    (
      await inspectOzonSourceTargetState({
        target: inspectTarget,
        client: fakeInspectClient({
          sessions: [{ id: "impozapi_raw", status: "RAW_PERSISTED", payloadSha256: payloadSha }],
        }),
      })
    ).state,
    "CONFLICT",
    "no sealed payload sha means no provable resume"
  );
  assert.equal(
    (
      await inspectOzonSourceTargetState({
        target: inspectTarget,
        client: fakeInspectClient({
          sessions: [{ id: "impozapi_raw", status: "RAW_PERSISTED", payloadSha256: payloadSha }],
        }),
        expectedPayloadSha256: payloadSha,
      })
    ).state,
    "RAW_PERSISTED_RESUME"
  );
});

test("ADAPTERS: exact-key snapshot union deletes and requeues once per unique key", async () => {
  const executed: FakeSql[] = [];
  const client = {
    async $transaction(fn: (tx: unknown) => Promise<unknown>) {
      const tx = {
        async $executeRawUnsafe(sql: string) {
          executed.push({ sql, values: [] });
          return 0;
        },
        async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
          const entry = recordSql(strings, values);
          executed.push(entry);
          return entry.sql.startsWith("DELETE") ? 1 : 1;
        },
        async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
          executed.push(recordSql(strings, values));
          return [{ count: 0 }];
        },
      };
      return fn(tx);
    },
  } as unknown as PrismaClient;

  const duplicated: SnapshotKey[] = [
    {
      companyScope: "ALL",
      dateFrom: "2026-01-01",
      dateTo: "2026-08-06",
      formulaVersion: "FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1",
    },
    {
      companyScope: "ALL",
      dateFrom: "2026-01-01",
      dateTo: "2026-08-06",
      formulaVersion: "FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1",
    },
    {
      companyScope: "ИП Петров",
      dateFrom: "2026-01-01",
      dateTo: "2026-08-14",
      formulaVersion: "FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1",
    },
  ];

  const result = await applyExactSnapshotUnionOnce({ keys: duplicated, client });
  assert.equal(result.deleted, 2);
  assert.equal(result.requeued, 2);
  assert.equal(result.rowsDeleted, 2);
  assert.equal(result.jobsInserted, 2);
  assert.equal(result.keys.length, 2);

  const deletes = executed.filter((e) => e.sql.startsWith("DELETE"));
  const inserts = executed.filter((e) => e.sql.startsWith("INSERT"));
  assert.equal(deletes.length, 2, "one exact-key delete per unique key");
  assert.equal(inserts.length, 2, "one requeue upsert per unique key");
  assert.ok(
    executed.some((e) => e.sql.includes('LOCK TABLE "DashboardPeriodSnapshotJob"')),
    "must take the same table locks as the normal invalidation path"
  );
  assert.ok(
    inserts.every((e) => e.values.includes(995_000) && e.values.includes("PENDING")),
    "requeue must reuse SNAPSHOT_REQUEUE_PRIORITY and PENDING"
  );
});

test("ADAPTERS: V2 rebuild queues ALL scope and refuses anything else", async () => {
  const allTargets: V2Target[] = [
    {
      dbId: "v2_july",
      period: "2026-07",
      scope: "ALL",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-31",
      expectedCanonicalWb: 1,
      expectedCanonicalOzon: 2,
      expectedTotal: 3,
    },
    {
      dbId: "v2_aug",
      period: "2026-08",
      scope: "ALL",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-31",
      expectedCanonicalWb: 1,
      expectedCanonicalOzon: 2,
      expectedTotal: 3,
    },
  ];

  const queued = await rebuildV2PeriodTargets({
    targets: allTargets,
    repository: { requestRebuild: async () => "queued_prisma" },
  });
  assert.equal(queued.rebuilt, 2);

  await assert.rejects(
    () =>
      rebuildV2PeriodTargets({
        targets: [{ ...allTargets[0]!, scope: "ИП Петров" }],
        repository: { requestRebuild: async () => "queued_prisma" },
      }),
    /V2_SCOPE_REFUSED/
  );

  await assert.rejects(
    () =>
      rebuildV2PeriodTargets({
        targets: allTargets,
        repository: { requestRebuild: async () => "rejected_d6_unsafe" },
      }),
    /V2_REBUILD_NOT_QUEUED/
  );
});

test("ADAPTERS: tripwire counts Ozon requests, blocks them, and restores fetch", async () => {
  const original = globalThis.fetch;
  const reached: string[] = [];
  const stub = (async (input: unknown) => {
    reached.push(String(input));
    return new Response("ok");
  }) as unknown as typeof fetch;
  globalThis.fetch = stub;

  try {
    const counting = installOzonNetworkTripwire({ mode: "COUNT" });
    await globalThis.fetch("https://example.test/health");
    assert.equal(counting.count(), 0, "non-Ozon traffic is not counted");
    await globalThis.fetch("https://api-seller.ozon.ru/v1/finance/accrual/by-day");
    assert.equal(counting.count(), 1);
    assert.equal(counting.totalCount(), 2);
    assert.throws(
      () => counting.assertZero("EXECUTE_FROM_CACHE"),
      /OZON_NETWORK_CALLS_DURING_EXECUTE_FROM_CACHE=1/
    );
    counting.restore();
    assert.equal(globalThis.fetch, stub, "restore puts the previous fetch back");
    assert.equal(reached.length, 2);

    const blocking = installOzonNetworkTripwire({ mode: "BLOCK" });
    await assert.rejects(
      () => globalThis.fetch("https://api-seller.ozon.ru/v1/finance/accrual/by-day"),
      /OZON_NETWORK_BLOCKED_DURING_CACHE_ONLY_PHASE/
    );
    blocking.restore();
    assert.equal(reached.length, 2, "blocked Ozon call never reached the underlying fetch");
  } finally {
    globalThis.fetch = original;
  }
});

test("GATE: readiness gate refuses unbound adapters and prior Ozon traffic", async () => {
  const adapters = createEphemeralMutationAdapters();

  const ok = await runProductionAdapterReadinessGate({
    adapters,
    profile: "EPHEMERAL_MEMORY",
    tripwire: { count: () => 0 },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.databaseWriteIntent, "EPHEMERAL_ONLY");
  assert.equal(ok.ozonNetworkCallsBeforeMutation, 0);

  const partial: Partial<ProductionMutationAdapters> = { store: adapters.store };
  await assert.rejects(
    () =>
      runProductionAdapterReadinessGate({
        adapters: partial,
        profile: "EPHEMERAL_MEMORY",
        tripwire: { count: () => 0 },
      }),
    /ADAPTER_READINESS_GATE=FAILED[\s\S]*adapter_bound_inspectTargetState/
  );

  await assert.rejects(
    () =>
      runProductionAdapterReadinessGate({
        adapters,
        profile: "EPHEMERAL_MEMORY",
        tripwire: { count: () => 3 },
      }),
    /no_ozon_network_before_mutation/
  );
});

test("PREPARE live: injected fetch seals the cache and stops on source drift", async () => {
  const date = "2026-07-06";
  const accruals = [minimalAccrual(date)];
  const bodyText = JSON.stringify({ result: { accruals } });
  const pageHashes = [sha(bodyText)];

  const fetchRange = (async (p: {
    dateFrom: string;
    onCall?: (call: Record<string, unknown>) => void;
  }) => {
    p.onCall?.({
      endpoint: "/v1/finance/accrual/by-day",
      requestBody: { date: p.dateFrom },
      attempt: 1,
      httpStatus: 200,
      ok: true,
      retryAfter: null,
      responseBodySha256: sha(bodyText),
      responseBodyBytes: bodyText.length,
    });
    return {
      accruals,
      requestedDates: [p.dateFrom],
      dayEnvelopes: [
        {
          date: p.dateFrom,
          httpOk: true,
          pages: 1,
          paginationComplete: true,
          rawAccrualCount: accruals.length,
          explicitZeroDayEvidence: false,
        },
      ],
      pagesByDay: { [p.dateFrom]: 1 },
    };
  }) as unknown as OzonRepairFetchRange;

  const sealed: SourceTarget = {
    companyId: "cmp_test",
    companyName: "ИП Петров",
    date,
    rawResponseHash: computeCertificationRawResponseHash({
      date,
      pageHashes,
      count: accruals.length,
      paginationComplete: true,
    }),
    pageHashes,
    rowCount: 1,
    fullMapperResultHash: "TEST",
    ACCOUNT_AUTHORITY_ID: "conn_test",
    clientIdSha256: sha("client-1"),
  };

  const manifestShas = {
    sourceBackfillManifestSha256: "s",
    statusOnlyManifestSha256: "t",
    snapshotTargetManifestSha256: "u",
    v2TargetManifestSha256: "v",
  };
  const getCredentials = async () => ({ clientId: "client-1", apiKey: "key-1" });

  const prepared = await preparePrepareCacheLive({
    sourceTargets: [sealed],
    statusOnly: [],
    snapshotKeys: [],
    v2Targets: [],
    manifestShas,
    getCredentials,
    fetchRange,
  });
  assert.equal(prepared.cache.targets.length, 1);
  assert.equal(prepared.ozonApiCalls, 1);
  assert.match(prepared.cache.targets[0]!.sealed.fullMapperResultHash, /^[0-9a-f]{64}$/);
  assert.equal(prepared.cache.targets[0]!.observed.expectedStatus, "FINAL");

  // rowCount drift must STOP before the payload can be cached.
  await assert.rejects(
    () =>
      preparePrepareCacheLive({
        sourceTargets: [{ ...sealed, rowCount: 999 }],
        statusOnly: [],
        snapshotKeys: [],
        v2Targets: [],
        manifestShas,
        getCredentials,
        fetchRange,
      }),
    /SOURCE_DRIFT=YES[\s\S]*rowCount/
  );

  // Fetching under the wrong Ozon account must STOP.
  assert.throws(
    () =>
      assertCredentialAuthorityMatch({
        target: sealed,
        credentials: { clientId: "client-2", apiKey: "key-1" },
      }),
    /SOURCE_DRIFT=YES[\s\S]*clientIdSha256/
  );
});

test("EXECUTE_FROM_CACHE: full CLI run gates, mutates, and makes zero Ozon calls", async () => {
  const dir = join(process.cwd(), ".tmp-repair-execute-cli");
  mkdirSync(dir, { recursive: true });

  const companies = ["ИП Петров", "ИП Лебедева"];
  const cacheTargets = [];
  const sourceTargets: SourceTarget[] = [];
  for (let day = 0; day < 39; day += 1) {
    const date = new Date(Date.UTC(2026, 5, 1) + day * 86_400_000).toISOString().slice(0, 10);
    for (const companyName of companies) {
      const accruals = [minimalAccrual(date)];
      const pageHashes = [sha(JSON.stringify({ companyName, accruals }))];
      const rawResponseHash = sha(JSON.stringify({ companyName, accruals, date }));
      const prepared = sealPreparedTarget({
        sealed: {
          companyId: `cmp_${companyName}`,
          companyName,
          date,
          rawResponseHash,
          pageHashes,
          rowCount: 1,
          fullMapperResultHash: "TEST",
          ACCOUNT_AUTHORITY_ID: `conn_${companyName}`,
        },
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
      sourceTargets.push(prepared.sealed);
      cacheTargets.push(prepared);
    }
  }
  assert.equal(cacheTargets.length, 78);

  const statusTargets: StatusOnlyTarget[] = Array.from({ length: 10 }, (_, i) => {
    const date = `2026-08-${String(9 + i).padStart(2, "0")}`;
    return {
      company: "ИП Петров",
      date,
      importSessionId: `impozapi_${i}`,
      expectedPayloadSha256: sha(`ephemeral-status-gate|${date}`),
    };
  });
  const snapshotKeys: SnapshotKey[] = Array.from({ length: 35 }, (_, i) => ({
    companyScope: "ALL",
    dateFrom: "2026-01-01",
    dateTo: new Date(Date.UTC(2026, 6, 1) + i * 86_400_000).toISOString().slice(0, 10),
    formulaVersion: "FINANCIAL_CORE_V4_PERIOD_SNAPSHOT_V1",
  }));
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

  const paths = {
    source: join(dir, "source.json"),
    status: join(dir, "status.json"),
    snapshot: join(dir, "snapshot.json"),
    v2: join(dir, "v2.json"),
    cache: join(dir, "PREPARE_CACHE.json"),
    cacheManifest: join(dir, "PREPARE_CACHE.sha256.txt"),
  };
  writeFileSync(paths.source, JSON.stringify({ targets: sourceTargets }, null, 2) + "\n");
  writeFileSync(paths.status, JSON.stringify({ targets: statusTargets }, null, 2) + "\n");
  writeFileSync(paths.snapshot, JSON.stringify({ keys: snapshotKeys }, null, 2) + "\n");
  writeFileSync(paths.v2, JSON.stringify({ targets: v2Targets }, null, 2) + "\n");

  const cache: PrepareCache = {
    version: "AVOROFIN_OZON_HISTORICAL_REPAIR_PREPARE_CACHE_V1",
    createdAt: "2026-09-24T00:00:00.000Z",
    sourceBackfillManifestSha256: sha(readFileSync(paths.source)),
    statusOnlyManifestSha256: sha(readFileSync(paths.status)),
    snapshotTargetManifestSha256: sha(readFileSync(paths.snapshot)),
    v2TargetManifestSha256: sha(readFileSync(paths.v2)),
    targets: cacheTargets,
    statusOnly: statusTargets,
    snapshotKeys,
    v2Targets,
    noCredentials: true,
  };
  const cacheContentSha = buildPrepareCacheManifestSha(cache);
  writeFileSync(paths.cache, JSON.stringify(cache, null, 2) + "\n");
  writeFileSync(paths.cacheManifest, cacheContentSha + "\n");
  assert.equal(resolveSealedPrepareCacheContentSha(paths.cacheManifest), cacheContentSha);

  const outDir = join(dir, "out");
  const argv = [
    "--mode=EXECUTE_FROM_CACHE",
    "--operationId=OP_TEST",
    "--approvalBindingSha256=approval",
    `--sourceBackfillManifestSha256=${sha(readFileSync(paths.source))}`,
    `--statusOnlyManifestSha256=${sha(readFileSync(paths.status))}`,
    `--snapshotTargetManifestSha256=${sha(readFileSync(paths.snapshot))}`,
    `--v2TargetManifestSha256=${sha(readFileSync(paths.v2))}`,
    "--expectedPreDeployAppImageSha256=sha256:old",
    "--expectedCandidateAppImageSha256=sha256:new",
    "--expectedRepairRunnerImageSha256=sha256:runner",
    "--mutationTimeAppImageSha256=sha256:new",
    "--sourceBackfillTargetCount=78",
    "--statusStandaloneTargetCount=10",
    "--snapshotPostBatchDeleteCount=35",
    "--snapshotPostBatchRequeueCount=35",
    "--v2NumericMutationTargetCount=2",
    `--executeMarker=${OWNER_EXECUTE_MARKER}`,
    // Exactly the wrapper's shape: the CONTENT sha read out of the sidecar, and
    // the sidecar path itself.
    `--prepareCacheManifestSha256=${cacheContentSha}`,
    `--sourceManifest=${paths.source}`,
    `--statusManifest=${paths.status}`,
    `--snapshotManifest=${paths.snapshot}`,
    `--v2Manifest=${paths.v2}`,
    `--prepareCache=${paths.cache}`,
    `--prepareCacheManifest=${paths.cacheManifest}`,
    `--outDir=${outDir}`,
  ];

  const previous = process.env.EPHEMERAL_MEMORY_STORE;
  process.env.EPHEMERAL_MEMORY_STORE = "1";
  try {
    assert.equal(await runCli(argv), 0);
  } finally {
    if (previous === undefined) delete process.env.EPHEMERAL_MEMORY_STORE;
    else process.env.EPHEMERAL_MEMORY_STORE = previous;
  }

  const result = JSON.parse(
    readFileSync(join(outDir, "EXECUTE_FROM_CACHE_RESULT.json"), "utf8")
  ) as {
    OZON_NETWORK_CALLS: number;
    adapterReadiness: { ok: boolean; profile: string; ozonNetworkCallsBeforeMutation: number };
    preMutationGate: {
      ok: boolean;
      WRITES_PERFORMED: number;
      inspectedSourceTargets: number;
      statusStandaloneTargets: number;
      snapshotUniqueKeys: number;
      profitReadModelTargets: number;
    };
    sourceResult: { persisted: number; separateStatusUpserts: number; intrinsicStatuses: number };
    statusResult: { written: number };
    post: { snapshotDeleted: number; snapshotRequeued: number; v2Rebuilt: number };
  };

  assert.equal(result.OZON_NETWORK_CALLS, 0, "EXECUTE_FROM_CACHE must perform zero Ozon calls");
  assert.equal(result.adapterReadiness.ok, true);
  assert.equal(result.preMutationGate.ok, true);
  assert.equal(result.preMutationGate.WRITES_PERFORMED, 0);
  assert.equal(result.preMutationGate.inspectedSourceTargets, 78);
  assert.equal(result.preMutationGate.statusStandaloneTargets, 10);
  assert.equal(result.preMutationGate.snapshotUniqueKeys, 35);
  assert.equal(result.preMutationGate.profitReadModelTargets, 0);
  assert.equal(result.adapterReadiness.profile, "EPHEMERAL_MEMORY");
  assert.equal(result.adapterReadiness.ozonNetworkCallsBeforeMutation, 0);
  assert.equal(result.sourceResult.persisted, 78);
  assert.equal(result.sourceResult.intrinsicStatuses, 78);
  assert.equal(result.sourceResult.separateStatusUpserts, 0);
  assert.equal(result.statusResult.written, 10);
  assert.equal(result.post.snapshotDeleted, 35);
  assert.equal(result.post.snapshotRequeued, 35);
  assert.equal(result.post.v2Rebuilt, 2);
});

test("PRODUCTION: no adapter phase is a placeholder throw", () => {
  const runnerSource = readFileSync(
    join(process.cwd(), "scripts", "financialRepair", "runOzonHistoricalFinancialRepair.ts"),
    "utf8"
  );
  for (const banned of [
    "adapter not injected",
    "requires production prisma invalidation helper injection",
    "requires production producer injection",
  ]) {
    assert.ok(
      !runnerSource.includes(banned),
      `runner must not fail production mutation with a placeholder: ${banned}`
    );
  }
  assert.ok(
    runnerSource.includes("runProductionAdapterReadinessGate"),
    "runner must run the pre-mutation readiness gate"
  );
  assert.ok(
    runnerSource.includes("createProductionMutationAdapters"),
    "runner must bind the real Prisma adapters"
  );

  // The payload hash used for idempotency must match the ingest store's recipe.
  assert.match(
    computeOzonAccrualPayloadSha256({
      companyName: "ИП Петров",
      dateFrom: "2026-07-06",
      dateTo: "2026-07-06",
      dayEnvelopes: [],
      rawAccruals: [],
    }),
    /^[0-9a-f]{64}$/
  );
});

/* ------------------------------------------------------------------ *
 * V2 row fingerprints
 * ------------------------------------------------------------------ */

test("V2: the row fingerprint reproduces the sealed certification vector", () => {
  // Row cmtog1fm9005001dsklwdd94u from V2_CURRENT_ROW_FINGERPRINTS_READONLY.json.
  assert.equal(
    computeV2PeriodRowFingerprint({
      id: "cmtog1fm9005001dsklwdd94u",
      companyScope: "ИП Лебедева",
      dateFrom: "2026-08-01T00:00:00.000Z",
      dateTo: "2026-08-31T00:00:00.000Z",
      formulaVersion: "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2",
      dataMode: "PRELIMINARY",
      coverageStatus: "COMPLETE",
      sourceFingerprint: "fb133ebb4040af7d312103bbe9715066a64a206f6f85216fdbca1e3fcc2d87d6",
      payloadChecksum: "fb133ebb4040af7d312103bbe9715066a64a206f6f85216fdbca1e3fcc2d87d6",
      generatedAt: "2026-09-24T11:35:31.392Z",
      updatedAt: "2026-09-24T11:38:56.127Z",
    }),
    "88613e4b6b215139607ec6dabbaa04b8d07068106bf6161035b412f8bf1b6489"
  );

  // Row cmtq2w4hs00v801dsqc1jd3qs (July ALL), with Date objects rather than strings.
  assert.equal(
    computeV2PeriodRowFingerprint({
      id: "cmtq2w4hs00v801dsqc1jd3qs",
      companyScope: "ALL",
      dateFrom: new Date("2026-07-01T00:00:00.000Z"),
      dateTo: new Date("2026-07-31T00:00:00.000Z"),
      formulaVersion: "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2",
      dataMode: "PRELIMINARY",
      coverageStatus: "COMPLETE",
      sourceFingerprint: "1668c8c428d6cf6787336d810acc14fd196039fa381bbf0e531f3c845f872d80",
      payloadChecksum: "ca201006c6794a2e057416bfd708338fb5154ba13275ab0578dce9fe59389768",
      generatedAt: new Date("2026-09-24T08:09:33.654Z"),
      updatedAt: new Date("2026-09-24T08:11:19.015Z"),
    }),
    "77c40f5db970d5f5f2697f525a3a990f6ac53d5c4a031d74f849ef61ee4fd057"
  );

  // Any covered column changing must change the fingerprint.
  assert.notEqual(
    computeV2PeriodRowFingerprint({
      id: "cmtog1fm9005001dsklwdd94u",
      companyScope: "ИП Лебедева",
      dateFrom: "2026-08-01T00:00:00.000Z",
      dateTo: "2026-08-31T00:00:00.000Z",
      formulaVersion: "FINANCIAL_CORE_V6_PERIOD_READMODEL_V2",
      dataMode: "FINAL",
      coverageStatus: "COMPLETE",
      sourceFingerprint: "fb133ebb4040af7d312103bbe9715066a64a206f6f85216fdbca1e3fcc2d87d6",
      payloadChecksum: "fb133ebb4040af7d312103bbe9715066a64a206f6f85216fdbca1e3fcc2d87d6",
      generatedAt: "2026-09-24T11:35:31.392Z",
      updatedAt: "2026-09-24T11:38:56.127Z",
    }),
    "88613e4b6b215139607ec6dabbaa04b8d07068106bf6161035b412f8bf1b6489"
  );

  assert.equal(
    collectV2MatrixRows({
      targets: [v2MatrixFixture[0]!, v2MatrixFixture[1]!],
      keepUnavailable: v2MatrixFixture.slice(2),
    }).length,
    6
  );
});

/* ------------------------------------------------------------------ *
 * All-target pre-mutation gate
 * ------------------------------------------------------------------ */

function gateAdapters(overrides?: Partial<ProductionMutationAdapters>) {
  return { ...createEphemeralMutationAdapters(), ...overrides };
}

test("GATE: a conflict on the LAST source target stops with zero writes", async () => {
  const { cache, statusTargets, snapshotKeys } = buildFullRepairFixture();
  const lastTarget = cache.targets.at(-1)!.sealed;
  const inspected: string[] = [];

  const store = createMemoryOzonAccrualStore();
  const adapters = gateAdapters({
    store,
    inspectTargetStateForGate: async (target) => {
      inspected.push(`${target.companyName}|${target.date}`);
      return target.companyName === lastTarget.companyName && target.date === lastTarget.date
        ? { state: "CONFLICT", reason: "duplicate canonical ImportSession rows (2)" }
        : { state: "MISSING", reason: "no source rows for the day" };
    },
  });

  await assert.rejects(
    () =>
      runFullRepairPreMutationGate({
        cache,
        statusTargets,
        snapshotKeys,
        v2Targets: v2MatrixFixture.slice(0, 2),
        v2MatrixRows: v2MatrixFixture,
        adapters,
      }),
    (error: Error) => {
      assert.match(error.message, /FULL_REPAIR_PRE_MUTATION_GATE=FAILED/);
      assert.match(error.message, /WRITES_PERFORMED=0/);
      assert.match(error.message, /CONFLICTING_SOURCE_STATE on 1 target/);
      assert.match(error.message, new RegExp(lastTarget.date));
      return true;
    }
  );

  assert.equal(inspected.length, 78, "all 78 sources are inspected before the decision");
  assert.equal(
    inspected.at(-1),
    `${lastTarget.companyName}|${lastTarget.date}`,
    "the conflicting target is the last one, so 77 clean targets preceded it"
  );
  assert.equal(store.rawById.size, 0, "a gate failure must leave zero persisted rows");
  assert.equal(store.canonicalWrites.length, 0);
  assert.equal(store.dayStatuses.size, 0);
});

test("GATE: blast radius counts and V2 fingerprints must match the approved plan", async () => {
  const { cache, statusTargets, snapshotKeys } = buildFullRepairFixture();
  const base = {
    cache,
    statusTargets,
    snapshotKeys,
    v2Targets: v2MatrixFixture.slice(0, 2),
    v2MatrixRows: v2MatrixFixture,
  };

  const ok = await runFullRepairPreMutationGate({ ...base, adapters: gateAdapters() });
  assert.equal(ok.ok, true);
  assert.equal(ok.WRITES_PERFORMED, 0);
  assert.equal(ok.inspectedSourceTargets, 78);
  assert.equal(ok.sourceStates.MISSING, 78);
  assert.equal(ok.statusStandaloneTargets, 10);
  assert.equal(ok.snapshotUniqueKeys, 35);
  assert.equal(ok.v2MatrixRows, 6);
  assert.equal(ok.v2FingerprintsMatched, 6);
  assert.equal(ok.profitReadModelTargets, 0);

  await assert.rejects(
    () =>
      runFullRepairPreMutationGate({
        ...base,
        statusTargets: statusTargets.slice(0, 9),
        adapters: gateAdapters(),
      }),
    /standalone status targets 9, expected 10/
  );
  await assert.rejects(
    () =>
      runFullRepairPreMutationGate({
        ...base,
        snapshotKeys: snapshotKeys.slice(0, 34),
        adapters: gateAdapters(),
      }),
    /unique snapshot keys 34, expected 35/
  );
  await assert.rejects(
    () =>
      runFullRepairPreMutationGate({
        ...base,
        v2MatrixRows: v2MatrixFixture.slice(0, 5),
        adapters: gateAdapters(),
      }),
    /V2 matrix rows 5, expected 6/
  );
  await assert.rejects(
    () =>
      runFullRepairPreMutationGate({
        ...base,
        adapters: gateAdapters({
          readV2MatrixFingerprints: async (rows) =>
            rows.map((row, index) => ({
              dbId: row.dbId,
              period: row.period,
              scope: row.scope,
              found: index !== 5,
              sealedFingerprint: row.currentRowFingerprint ?? null,
              observedFingerprint: index === 5 ? null : (row.currentRowFingerprint ?? null),
              observedDataMode: null,
              observedCoverageStatus: null,
              match: index !== 5,
            })),
        }),
      }),
    /V2_ROW_FINGERPRINT_DRIFT/
  );
  await assert.rejects(
    () =>
      runFullRepairPreMutationGate({
        ...base,
        adapters: gateAdapters({ countProfitReadModelTargets: async () => 3 }),
      }),
    /profit read-model targets 3, expected 0/
  );
});

test("GATE: unbound standalone status payload sha256 blocks before any write", async () => {
  const { cache, statusTargets, snapshotKeys } = buildFullRepairFixture();
  const base = {
    cache,
    statusTargets: statusTargets.map((target) => ({
      ...target,
      expectedPayloadSha256: "PLACEHOLDER_REQUIRES_LIVE_PREPARE_BIND",
    })),
    snapshotKeys,
    v2Targets: v2MatrixFixture.slice(0, 2),
    v2MatrixRows: v2MatrixFixture,
  };

  await assert.rejects(
    () => runFullRepairPreMutationGate({ ...base, adapters: gateAdapters() }),
    (error: Error) => {
      assert.match(error.message, /FULL_REPAIR_PRE_MUTATION_GATE=FAILED/);
      assert.match(error.message, /STANDALONE_STATUS_CONFLICT/);
      assert.match(error.message, /expectedPayloadSha256 missing or not live-bound/);
      return true;
    },
  );
});

/* ------------------------------------------------------------------ *
 * Owner approval runtime binding
 * ------------------------------------------------------------------ */

test("APPROVAL: strict whitelist parser rejects duplicates, unknown critical keys and junk", () => {
  const approval = parseOwnerApprovalText(OWNER_APPROVAL_FIXTURE);
  assert.equal(approval.values.SOURCE_BACKFILL_TARGET_COUNT, "78");
  assert.equal(approval.banners[0], "AVOROFIN FINANCIAL PRODUCTION EXECUTION OWNER APPROVAL");
  assert.match(approval.sha256, /^[0-9a-f]{64}$/);

  assert.throws(
    () => parseOwnerApprovalText(`${OWNER_APPROVAL_FIXTURE}\nSOURCE_BACKFILL_TARGET_COUNT=79\n`),
    /duplicate key SOURCE_BACKFILL_TARGET_COUNT/
  );
  assert.throws(
    () => parseOwnerApprovalText(`${OWNER_APPROVAL_FIXTURE}\nROGUE_IMAGE_SHA256=deadbeef\n`),
    /unknown critical key ROGUE_IMAGE_SHA256/
  );
  assert.throws(
    () => parseOwnerApprovalText(`${OWNER_APPROVAL_FIXTURE}\n$(rm -rf /)\n`),
    /neither KEY=VALUE nor a banner/
  );
  assert.throws(() => parseOwnerApprovalText("\n\n"), /declares no whitelisted keys/);

  // An unknown but harmless key is parsed and deliberately left unbound.
  const tolerant = parseOwnerApprovalText(`${OWNER_APPROVAL_FIXTURE}\nNOTE_FOR_HUMANS=hello\n`);
  assert.deepEqual([...tolerant.ignoredKeys], ["NOTE_FOR_HUMANS"]);

  // Nothing in the whitelist may collide with the critical-unknown trap.
  assert.equal(new Set(OWNER_APPROVAL_ALLOWED_KEYS).size, OWNER_APPROVAL_ALLOWED_KEYS.length);
});

test("APPROVAL: runner binds immutable fields from the approval and refuses CLI drift", () => {
  const dir = join(process.cwd(), ".tmp-repair-approval");
  mkdirSync(dir, { recursive: true });
  const approvalPath = join(dir, "OWNER_APPROVAL.txt");
  writeFileSync(approvalPath, OWNER_APPROVAL_FIXTURE);
  const approvalSha = sha(readFileSync(approvalPath));

  assert.throws(
    () => verifyAndParseOwnerApprovalFile({ path: approvalPath, expectedSha256: sha("nope") }),
    /OWNER_APPROVAL_SHA_MISMATCH/
  );
  const approval = verifyAndParseOwnerApprovalFile({
    path: approvalPath,
    expectedSha256: approvalSha,
  });
  const immutable = resolveOwnerApprovalImmutableBinding(approval);

  assert.equal(immutable.approvalBindingSha256, approvalSha);
  assert.equal(immutable.sourceBackfillTargetCount, 78);
  assert.equal(immutable.statusStandaloneTargetCount, 10);
  assert.equal(immutable.snapshotPostBatchDeleteCount, 35);
  assert.equal(immutable.snapshotPostBatchRequeueCount, 35);
  assert.equal(immutable.v2NumericMutationTargetCount, 2);
  assert.equal(immutable.v2MatrixRowCount, 6);
  assert.equal(immutable.v2NonNullFingerprintCount, 6);
  assert.equal(immutable.profitExplicitTargetCount, 0);
  assert.equal(immutable.executeMarker, OWNER_EXECUTE_MARKER);
  try {
    (immutable as { executeMarker: string }).executeMarker = "tampered";
  } catch {
    // frozen under strict mode; the assertion below covers both cases
  }
  assert.equal(immutable.executeMarker, OWNER_EXECUTE_MARKER, "the binding is immutable");

  const cliBinding: Record<string, string | number> = {
    approvalBindingSha256: approvalSha,
    sourceBackfillManifestSha256: immutable.sourceBackfillManifestSha256,
    statusOnlyManifestSha256: immutable.statusOnlyManifestSha256,
    snapshotTargetManifestSha256: immutable.snapshotTargetManifestSha256,
    v2TargetManifestSha256: immutable.v2TargetManifestSha256,
    expectedPreDeployAppImageSha256: immutable.expectedPreDeployAppImageSha256,
    expectedCandidateAppImageSha256: immutable.expectedCandidateAppImageSha256,
    expectedRepairRunnerImageSha256: immutable.expectedRepairRunnerImageSha256,
    sourceBackfillTargetCount: 78,
    statusStandaloneTargetCount: 10,
    snapshotPostBatchDeleteCount: 35,
    snapshotPostBatchRequeueCount: 35,
    v2NumericMutationTargetCount: 2,
    executeMarker: OWNER_EXECUTE_MARKER,
  };
  assertBindingMatchesOwnerApproval({ binding: cliBinding, approvalBinding: immutable });

  for (const field of [
    "sourceBackfillManifestSha256",
    "expectedCandidateAppImageSha256",
    "sourceBackfillTargetCount",
  ] as const) {
    assert.throws(
      () =>
        assertBindingMatchesOwnerApproval({
          binding: { ...cliBinding, [field]: "TAMPERED" },
          approvalBinding: immutable,
        }),
      new RegExp(`OWNER_APPROVAL_BINDING_MISMATCH[\\s\\S]*${field}`),
      `${field} must be taken from the approval, not the command line`
    );
  }

  const evidence = {
    OWNER_APPROVAL_RUNTIME_BINDING: "PASS",
    CURRENT_TASK_DATABASE_WRITE: "NO",
    parser: "lib/ozon/ownerApprovalBinding.ts",
    parserStrategy: "STRICT_KEY_VALUE_WHITELIST_NO_EVAL_NO_SOURCE",
    approvalSha256: approvalSha,
    whitelistedKeyCount: OWNER_APPROVAL_ALLOWED_KEYS.length,
    parsedKeyCount: approval.keys.length,
    ignoredNonCriticalKeys: [...approval.ignoredKeys],
    immutableFieldsBoundFromApproval: Object.keys(immutable).sort(),
    boundValues: {
      sourceBackfillTargetCount: immutable.sourceBackfillTargetCount,
      statusStandaloneTargetCount: immutable.statusStandaloneTargetCount,
      snapshotPostBatchDeleteCount: immutable.snapshotPostBatchDeleteCount,
      snapshotPostBatchRequeueCount: immutable.snapshotPostBatchRequeueCount,
      v2NumericMutationTargetCount: immutable.v2NumericMutationTargetCount,
      v2MatrixRowCount: immutable.v2MatrixRowCount,
      v2NonNullFingerprintCount: immutable.v2NonNullFingerprintCount,
      profitExplicitTargetCount: immutable.profitExplicitTargetCount,
      executeMarker: immutable.executeMarker,
    },
    rejections: [
      "OWNER_APPROVAL_SHA_MISMATCH",
      "duplicate key",
      "unknown critical key",
      "line is neither KEY=VALUE nor a banner",
      "OWNER_APPROVAL_BINDING_MISMATCH",
    ],
    generatedAt: new Date().toISOString(),
  };
  const evidencePath = join(
    process.env.E2E_OUT ? resolve(process.env.E2E_OUT) : process.cwd(),
    "OWNER_APPROVAL_RUNTIME_BINDING_TEST.json"
  );
  const body = JSON.stringify(evidence, null, 2) + "\n";
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, body);
  writeFileSync(`${evidencePath}.sha256.txt`, sha(body) + "\n");
  assert.equal(
    (JSON.parse(readFileSync(evidencePath, "utf8")) as { OWNER_APPROVAL_RUNTIME_BINDING: string })
      .OWNER_APPROVAL_RUNTIME_BINDING,
    "PASS"
  );
});

/* ------------------------------------------------------------------ *
 * Wrapper arg shape + two-stage VERIFY
 * ------------------------------------------------------------------ */

test("WRAPPER SHAPE: EXECUTE accepts the sidecar CONTENT sha and an approval file", async () => {
  const dir = join(process.cwd(), ".tmp-repair-wrapper-shape");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const { cache, sourceTargets, statusTargets, snapshotKeys } = buildFullRepairFixture();
  const v2Targets = v2MatrixFixture.slice(0, 2);
  const paths = {
    source: join(dir, "source.json"),
    status: join(dir, "status.json"),
    snapshot: join(dir, "snapshot.json"),
    v2: join(dir, "v2.json"),
    cache: join(dir, "prepare-cache", "PREPARE_CACHE.json"),
    // The wrapper mounts the sidecar exactly under this name.
    cacheSidecar: join(dir, "prepare-cache", "PREPARE_CACHE.sha256.txt"),
    approval: join(dir, "OWNER_APPROVAL.txt"),
  };
  mkdirSync(join(dir, "prepare-cache"), { recursive: true });
  writeFileSync(paths.source, JSON.stringify({ targets: sourceTargets }, null, 2) + "\n");
  writeFileSync(paths.status, JSON.stringify({ targets: statusTargets }, null, 2) + "\n");
  writeFileSync(paths.snapshot, JSON.stringify({ keys: snapshotKeys }, null, 2) + "\n");
  writeFileSync(
    paths.v2,
    JSON.stringify({ targets: v2Targets, keepUnavailable: v2MatrixFixture.slice(2) }, null, 2) + "\n"
  );

  const boundCache: PrepareCache = {
    ...cache,
    sourceBackfillManifestSha256: sha(readFileSync(paths.source)),
    statusOnlyManifestSha256: sha(readFileSync(paths.status)),
    snapshotTargetManifestSha256: sha(readFileSync(paths.snapshot)),
    v2TargetManifestSha256: sha(readFileSync(paths.v2)),
    v2Targets,
    v2MatrixRows: v2MatrixFixture,
  };
  const cacheContentSha = buildPrepareCacheManifestSha(boundCache);
  writeFileSync(paths.cache, JSON.stringify(boundCache, null, 2) + "\n");
  // PREPARE writes the CONTENT sha, with a trailing newline, exactly like this.
  writeFileSync(paths.cacheSidecar, cacheContentSha + "\n");
  assert.notEqual(
    sha(readFileSync(paths.cacheSidecar)),
    cacheContentSha,
    "the sidecar's own file sha is necessarily a different value"
  );

  const approvalText = ownerApprovalFixtureFor({
    sourceBackfillManifestSha256: sha(readFileSync(paths.source)),
    statusOnlyManifestSha256: sha(readFileSync(paths.status)),
    snapshotTargetManifestSha256: sha(readFileSync(paths.snapshot)),
    v2TargetManifestSha256: sha(readFileSync(paths.v2)),
  });
  writeFileSync(paths.approval, approvalText);
  const approvalSha = sha(readFileSync(paths.approval));

  const outDir = join(dir, "out");
  // Argument order and spelling mirror runApprovedFinancialRepairProduction.sh.
  const argv = [
    "--mode=EXECUTE_FROM_CACHE",
    "--operationId=OP_WRAPPER_SHAPE",
    `--approvalBindingSha256=${approvalSha}`,
    `--approvalFile=${paths.approval}`,
    `--approvalSha256=${approvalSha}`,
    `--sourceBackfillManifestSha256=${sha(readFileSync(paths.source))}`,
    `--statusOnlyManifestSha256=${sha(readFileSync(paths.status))}`,
    `--snapshotTargetManifestSha256=${sha(readFileSync(paths.snapshot))}`,
    `--v2TargetManifestSha256=${sha(readFileSync(paths.v2))}`,
    "--expectedPreDeployAppImageSha256=sha256:pre",
    "--expectedCandidateAppImageSha256=sha256:candidate",
    "--expectedRepairRunnerImageSha256=sha256:runner",
    "--mutationTimeAppImageSha256=sha256:candidate",
    "--sourceBackfillTargetCount=78",
    "--statusStandaloneTargetCount=10",
    "--snapshotPostBatchDeleteCount=35",
    "--snapshotPostBatchRequeueCount=35",
    "--v2NumericMutationTargetCount=2",
    `--executeMarker=${OWNER_EXECUTE_MARKER}`,
    `--prepareCacheManifestSha256=${cacheContentSha}`,
    `--sourceManifest=${paths.source}`,
    `--statusManifest=${paths.status}`,
    `--snapshotManifest=${paths.snapshot}`,
    `--v2Manifest=${paths.v2}`,
    `--prepareCache=${paths.cache}`,
    `--prepareCacheManifest=${paths.cacheSidecar}`,
    `--outDir=${outDir}`,
  ];

  const previous = process.env.EPHEMERAL_MEMORY_STORE;
  process.env.EPHEMERAL_MEMORY_STORE = "1";
  try {
    assert.equal(await runCli(argv), 0);

    const result = JSON.parse(
      readFileSync(join(outDir, "EXECUTE_FROM_CACHE_RESULT.json"), "utf8")
    ) as {
      ownerApprovalBound: boolean;
      preMutationGate: { ok: boolean; v2MatrixRows: number; v2FingerprintsMatched: number };
      sourceResult: { persisted: number };
    };
    assert.equal(result.ownerApprovalBound, true);
    assert.equal(result.preMutationGate.ok, true);
    assert.equal(result.preMutationGate.v2MatrixRows, 6, "all 6 V2 rows are gated, not just 2");
    assert.equal(result.preMutationGate.v2FingerprintsMatched, 6);
    assert.equal(result.sourceResult.persisted, 78);

    // An approval whose sha does not match the bytes stops before any binding.
    await assert.rejects(
      () =>
        runCli([
          ...argv.filter((arg) => !arg.startsWith("--approvalSha256=")),
          `--approvalSha256=${sha("tampered")}`,
          `--outDir=${join(dir, "out-bad-sha")}`,
        ]),
      /OWNER_APPROVAL_SHA_MISMATCH/
    );

    // A command line that disagrees with the approval is refused.
    await assert.rejects(
      () =>
        runCli([
          ...argv.filter((arg) => !arg.startsWith("--expectedCandidateAppImageSha256=")),
          "--expectedCandidateAppImageSha256=sha256:someone-elses-app",
          `--outDir=${join(dir, "out-bad-binding")}`,
        ]),
      /OWNER_APPROVAL_BINDING_MISMATCH[\s\S]*expectedCandidateAppImageSha256/
    );

    // Passing the sidecar's file sha instead of the CONTENT sha is refused.
    await assert.rejects(
      () =>
        runCli([
          ...argv.filter((arg) => !arg.startsWith("--prepareCacheManifestSha256=")),
          `--prepareCacheManifestSha256=${sha(readFileSync(paths.cacheSidecar))}`,
          `--outDir=${join(dir, "out-bad-cache-sha")}`,
        ]),
      /prepareCacheContentSha256 mismatch/
    );
  } finally {
    if (previous === undefined) delete process.env.EPHEMERAL_MEMORY_STORE;
    else process.env.EPHEMERAL_MEMORY_STORE = previous;
  }
});

test("VERIFY: two stages are addressable by mode and by --verifyPhase", () => {
  assert.equal(parseMode("VERIFY_MUTATION_POSTCONDITIONS"), "VERIFY_MUTATION_POSTCONDITIONS");
  assert.equal(parseMode("VERIFY_FINAL_FINANCIAL_OUTPUT"), "VERIFY_FINAL_FINANCIAL_OUTPUT");
  assert.equal(resolveVerifyPhase("VERIFY"), "ALL");
  assert.equal(
    resolveVerifyPhase("VERIFY_MUTATION_POSTCONDITIONS"),
    "MUTATION_POSTCONDITIONS"
  );
  assert.equal(
    resolveVerifyPhase("VERIFY_FINAL_FINANCIAL_OUTPUT"),
    "FINAL_FINANCIAL_OUTPUT"
  );
  assert.equal(resolveVerifyPhase("VERIFY", "FINAL_FINANCIAL_OUTPUT"), "FINAL_FINANCIAL_OUTPUT");
  assert.equal(
    resolveVerifyPhase("VERIFY", "VERIFY_MUTATION_POSTCONDITIONS"),
    "MUTATION_POSTCONDITIONS"
  );
  assert.throws(() => resolveVerifyPhase("VERIFY", "SOMETHING_ELSE"), /Unknown verifyPhase/);
  assert.throws(() => parseMode("VERIFY_EVERYTHING"), /Unknown mode/);
});

