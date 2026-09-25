import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { PrismaClient } from "@prisma/client";

import { createMemoryOzonAccrualStore } from "../../lib/ozon/syncOzonAccrualByDay";
import {
  applyExactSnapshotUnionOnce,
  assertCredentialAuthorityMatch,
  computeCertificationRawResponseHash,
  computeOzonAccrualPayloadSha256,
  inspectOzonSourceTargetState,
  installOzonNetworkTripwire,
  rebuildV2PeriodTargets,
  runProductionAdapterReadinessGate,
  type OzonRepairFetchRange,
  type ProductionMutationAdapters,
  type RepairSourceTarget,
} from "../../lib/ozon/financialRepairProductionAdapters";
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
  runCli,
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

  const statusTargets: StatusOnlyTarget[] = Array.from({ length: 10 }, (_, i) => ({
    company: "ИП Петров",
    date: `2026-08-${String(9 + i).padStart(2, "0")}`,
    importSessionId: `impozapi_${i}`,
  }));
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
    `--prepareCacheManifestSha256=${sha(readFileSync(paths.cacheManifest))}`,
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
    sourceResult: { persisted: number; separateStatusUpserts: number; intrinsicStatuses: number };
    statusResult: { written: number };
    post: { snapshotDeleted: number; snapshotRequeued: number; v2Rebuilt: number };
  };

  assert.equal(result.OZON_NETWORK_CALLS, 0, "EXECUTE_FROM_CACHE must perform zero Ozon calls");
  assert.equal(result.adapterReadiness.ok, true);
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

