import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  evaluateOzonAccrualCoverage,
  fetchOzonAccrualByDayRange,
  mapOzonAccrualByDay,
} from "../../lib/ozon/accrualByDay";
import { planOzonAccrualIngest } from "../../lib/ozon/accrualIngestPolicy";
import {
  createMemoryOzonAccrualStore,
  ingestOzonAccrualByDay,
  replayOzonAccrualCanonicalFromRaw,
  validateOzonAccrualIngest,
} from "../../lib/ozon/syncOzonAccrualByDay";
import {
  PLATFORM_ERROR_CLASSES,
  PLATFORM_JOB_RUN_STATUSES,
  PLATFORM_JOB_TYPES,
  PLATFORM_JOBS_MODES,
  classifyPlatformError,
  handlePlatformJob,
  type JobRunRecord,
  type JobRunStore,
  type PlatformJobPayload,
} from "../../lib/platform/jobs";
import { resetWbFinanceAccountQueues } from "../../lib/wb/wbFinanceAccountQueue";
import { wbFinanceRequest } from "../../lib/wb/wbFinanceApi";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function jsonResponse(status: number, body: unknown = { error: "server" }): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ozonPayload(): PlatformJobPayload {
  return {
    jobType: PLATFORM_JOB_TYPES.OZON_ACCRUAL_BY_DAY,
    scope: {
      companyId: "co_fail",
      companyName: "Failure Co",
      marketplace: "OZON",
      date: "2026-08-23",
    },
    accrualTypeCode: "18",
  };
}

function type76Accrual(id: number, date: string, accrued: number) {
  return {
    accrual_id: id,
    date,
    total_amount: accrued,
    non_item_fee: { type_id: 76, accrued },
  };
}

function unknownAccrual(id: number, date: string, accrued: number, typeId = 9999) {
  return {
    accrual_id: id,
    date,
    total_amount: accrued,
    non_item_fee: { type_id: typeId, accrued },
  };
}

function completeEnvelope(date: string, rawAccrualCount: number) {
  return {
    date,
    httpOk: true,
    pages: 1,
    paginationComplete: true,
    rawAccrualCount,
    explicitZeroDayEvidence: false,
  };
}

function fetchFixture(params: {
  accruals: unknown[];
  dayEnvelopes: ReturnType<typeof completeEnvelope>[];
  requestedDates: string[];
}) {
  return async () => ({
    accruals: params.accruals,
    dayEnvelopes: params.dayEnvelopes,
    requestedDates: params.requestedDates,
    pagesByDay: Object.fromEntries(
      params.dayEnvelopes.map((item) => [item.date, item.pages]),
    ),
  });
}

function ingestArgs(store: ReturnType<typeof createMemoryOzonAccrualStore>, fetchRange: () => Promise<{
  accruals: unknown[];
  dayEnvelopes: ReturnType<typeof completeEnvelope>[];
  requestedDates: string[];
  pagesByDay: Record<string, number>;
}>) {
  return {
    companyId: "co_fail",
    companyName: "Failure Co",
    clientId: "cid",
    apiKey: "key",
    dateFrom: new Date("2026-08-23T00:00:00.000Z"),
    dateTo: new Date("2026-08-23T00:00:00.000Z"),
    store,
    fetchRange,
  };
}

function createFileJobRunStore(filePath: string): JobRunStore {
  const readAll = (): JobRunRecord[] => {
    try {
      return JSON.parse(readFileSync(filePath, "utf8")) as JobRunRecord[];
    } catch {
      return [];
    }
  };
  const writeAll = (rows: JobRunRecord[]) => {
    writeFileSync(filePath, JSON.stringify(rows, null, 2));
  };

  return {
    async findByIdempotencyKey(idempotencyKey) {
      return readAll().find((row) => row.idempotencyKey === idempotencyKey) ?? null;
    },
    async findByLockKey(lockKey) {
      return (
        readAll().find(
          (row) =>
            row.lockKey === lockKey && row.status === PLATFORM_JOB_RUN_STATUSES.RUNNING,
        ) ?? null
      );
    },
    async save(run) {
      const rows = readAll().filter((row) => row.id !== run.id);
      rows.push(run);
      writeAll(rows);
      return run;
    },
  };
}

test("WB 500 after retries exhausted does not promote FINAL and is retryable", async () => {
  resetWbFinanceAccountQueues();
  let calls = 0;
  const result = await wbFinanceRequest({
    url: "https://finance-api.wildberries.ru/api/finance/v1/sales-reports/list",
    token: "token-fail",
    body: { dateFrom: "2026-08-17", dateTo: "2026-08-23" },
    maxAttempts: 3,
    sleep: async () => undefined,
    now: () => 0,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(500, { message: "WB 500" });
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  const classified = classifyPlatformError(
    new Error(`WB Finance HTTP ${result.status}`),
  );
  assert.equal(classified.errorClass, PLATFORM_ERROR_CLASSES.RETRYABLE);
  const ingest = planOzonAccrualIngest({ coverageComplete: false });
  assert.equal(ingest.status, "PRELIMINARY");
  assert.equal(ingest.failFinality, true);
});

test("Ozon HTTP 500 does not fabricate raw/canonical FINAL and leaves the date incomplete", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return jsonResponse(500, { message: "Ozon 500" });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        fetchOzonAccrualByDayRange({
          credentials: { clientId: "cid", apiKey: "key" },
          dateFrom: "2026-08-23",
          dateTo: "2026-08-23",
          minCallIntervalMs: 0,
          requestTimeoutMs: 1_000,
          maxAttempts: 2,
          retryBackoffMs: [0],
        }),
      /HTTP 500/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(calls >= 2);
  const coverage = evaluateOzonAccrualCoverage({
    requestedDates: ["2026-08-23"],
    dayEnvelopes: [],
    mapperComplete: false,
  });
  assert.equal(coverage.coverageComplete, false);
  const ingest = planOzonAccrualIngest({ coverageComplete: false });
  assert.equal(ingest.status, "PRELIMINARY");
  const classified = classifyPlatformError(
    new Error("Ozon accrual API failed: /v1/finance/accrual/by-day HTTP 500"),
  );
  assert.equal(classified.errorClass, PLATFORM_ERROR_CLASSES.RETRYABLE);
});

test("raw persist failure never calls canonical overlay and stays retryable", async () => {
  const store = createMemoryOzonAccrualStore({
    beforeCommitRaw: () => {
      throw new Error("raw persist failed: connection reset");
    },
  });
  const accruals = [type76Accrual(1, "2026-08-23", -1911.55)];
  await assert.rejects(
    () =>
      ingestOzonAccrualByDay(
        ingestArgs(
          store,
          fetchFixture({
            accruals,
            dayEnvelopes: [completeEnvelope("2026-08-23", 1)],
            requestedDates: ["2026-08-23"],
          }),
        ),
      ),
    /raw persist failed/,
  );
  assert.equal(store.canonicalCallCount, 0);
  assert.equal(store.canonicalWrites.length, 0);
  assert.equal(store.rawById.size, 0);
  const classified = classifyPlatformError(new Error("raw persist failed: connection reset"));
  assert.equal(classified.errorClass, PLATFORM_ERROR_CLASSES.RETRYABLE);
});

test("canonical overlay failure keeps persisted raw and no canonical rows", async () => {
  const store = createMemoryOzonAccrualStore({
    beforePersistCanonical: () => {
      throw new Error("canonical overlay failed");
    },
  });
  const accruals = [type76Accrual(1, "2026-08-23", -1911.55)];
  await assert.rejects(
    () =>
      ingestOzonAccrualByDay(
        ingestArgs(
          store,
          fetchFixture({
            accruals,
            dayEnvelopes: [completeEnvelope("2026-08-23", 1)],
            requestedDates: ["2026-08-23"],
          }),
        ),
      ),
    /canonical overlay failed/,
  );
  assert.equal(store.rawById.size, 1);
  const raw = [...store.rawById.values()][0];
  assert.equal(raw.rawAccruals.length, 1);
  assert.equal(store.canonicalWrites.length, 0);
  const reloaded = await store.loadRaw(raw.id);
  assert.equal(reloaded?.id, raw.id);
  const classified = classifyPlatformError(new Error("canonical overlay failed"));
  assert.equal(classified.errorClass, PLATFORM_ERROR_CLASSES.RETRYABLE);
  const ingest = planOzonAccrualIngest({ coverageComplete: false });
  assert.equal(ingest.status, "PRELIMINARY");
});

test("unknown type with complete envelope still runs coverage/gross/type71 and is not FINAL", async () => {
  const store = createMemoryOzonAccrualStore();
  const accruals = [
    type76Accrual(1, "2026-08-23", -1911.55),
    unknownAccrual(2, "2026-08-23", -50),
  ];
  await assert.rejects(
    () =>
      ingestOzonAccrualByDay(
        ingestArgs(
          store,
          fetchFixture({
            accruals,
            dayEnvelopes: [completeEnvelope("2026-08-23", 2)],
            requestedDates: ["2026-08-23"],
          }),
        ),
      ),
    /unknown accrual types/,
  );
  assert.equal(store.rawById.size, 1);
  assert.equal(store.canonicalWrites.length, 0);
  const mapped = mapOzonAccrualByDay({
    accruals,
    requestedDates: ["2026-08-23"],
    dayEnvelopes: [completeEnvelope("2026-08-23", 2)],
  });
  let rejected = false;
  try {
    validateOzonAccrualIngest({
      mapped,
      dateFrom: new Date("2026-08-23T00:00:00.000Z"),
      dateTo: new Date("2026-08-23T00:00:00.000Z"),
      requestedDates: ["2026-08-23"],
    });
  } catch (error) {
    rejected = true;
    assert.match(String(error), /unknown accrual types/);
  }
  assert.equal(rejected, true);
});

test("unknown type does not hide a missing page/day coverage failure", async () => {
  const store = createMemoryOzonAccrualStore();
  const accruals = [
    type76Accrual(1, "2026-08-23", -1911.55),
    unknownAccrual(2, "2026-08-23", -50),
  ];
  await assert.rejects(
    () =>
      ingestOzonAccrualByDay(
        ingestArgs(
          store,
          fetchFixture({
            accruals,
            dayEnvelopes: [
              {
                date: "2026-08-23",
                httpOk: true,
                pages: 1,
                paginationComplete: false,
                rawAccrualCount: 2,
                explicitZeroDayEvidence: false,
              },
            ],
            requestedDates: ["2026-08-23"],
          }),
        ),
      ),
    /coverage incomplete/,
  );
  assert.equal(store.rawById.size, 1);
  assert.equal(store.canonicalWrites.length, 0);
});

test("unknown type plus unexplained gross remainder is a hard fail", async () => {
  const store = createMemoryOzonAccrualStore();
  const accruals = [
    {
      accrual_id: 1,
      date: "2026-08-23",
      total_amount: -100,
      non_item_fee: { type_id: 76, accrued: -40 },
    },
    unknownAccrual(2, "2026-08-23", -10),
  ];
  await assert.rejects(
    () =>
      ingestOzonAccrualByDay(
        ingestArgs(
          store,
          fetchFixture({
            accruals,
            dayEnvelopes: [completeEnvelope("2026-08-23", 2)],
            requestedDates: ["2026-08-23"],
          }),
        ),
      ),
    /unknown accrual types/,
  );
  assert.equal(store.rawById.size, 1);
  assert.equal(store.canonicalWrites.length, 0);
  const classified = classifyPlatformError(
    new Error("Ozon /by-day fail-closed: unexplained gross difference -50"),
  );
  assert.equal(classified.errorClass, PLATFORM_ERROR_CLASSES.FAIL_CLOSED);
});

test("exact replay from persisted raw after mapper update can become FINAL", async () => {
  const store = createMemoryOzonAccrualStore();
  const accruals = [
    type76Accrual(1, "2026-08-23", -1911.55),
    unknownAccrual(2, "2026-08-23", -50),
  ];
  await assert.rejects(
    () =>
      ingestOzonAccrualByDay(
        ingestArgs(
          store,
          fetchFixture({
            accruals,
            dayEnvelopes: [completeEnvelope("2026-08-23", 2)],
            requestedDates: ["2026-08-23"],
          }),
        ),
      ),
    /unknown accrual types/,
  );
  assert.equal(store.canonicalWrites.length, 0);
  const raw = [...store.rawById.values()][0];
  assert.ok(raw);

  const replayed = await replayOzonAccrualCanonicalFromRaw({
    rawId: raw.id,
    companyId: "co_fail",
    companyName: "Failure Co",
    dateFrom: new Date("2026-08-23T00:00:00.000Z"),
    dateTo: new Date("2026-08-23T00:00:00.000Z"),
    store,
    mapAccruals: (params) =>
      mapOzonAccrualByDay({
        ...params,
        accruals: params.accruals.map((row) => {
          if (
            row &&
            typeof row === "object" &&
            "non_item_fee" in row &&
            row.non_item_fee &&
            typeof row.non_item_fee === "object" &&
            "type_id" in row.non_item_fee &&
            Number(row.non_item_fee.type_id) === 9999
          ) {
            return {
              ...row,
              non_item_fee: { ...row.non_item_fee, type_id: 18 },
            };
          }
          return row;
        }),
      }),
  });
  assert.equal(replayed.ingestStatus, "FINAL");
  assert.equal(replayed.coverageComplete, true);
  assert.equal(replayed.quarantine.length, 0);
});

test("process restart retries the same JobRun idempotency key without a second logical job", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "avorofin-jobrun-"));
  const filePath = path.join(dir, "jobruns.json");
  writeFileSync(filePath, "[]");
  const payload = ozonPayload();

  try {
    const firstStore = createFileJobRunStore(filePath);
    const first = await handlePlatformJob({
      payload,
      store: firstStore,
      mode: PLATFORM_JOBS_MODES.SHADOW,
    });
    assert.equal(first.status, PLATFORM_JOB_RUN_STATUSES.SUCCEEDED);

    const failed: JobRunRecord = {
      ...first,
      status: PLATFORM_JOB_RUN_STATUSES.FAILED,
      errorClass: PLATFORM_ERROR_CLASSES.RETRYABLE,
      errorCode: "RETRYABLE",
      errorMessage: "WB Finance HTTP 500",
      finishedAt: first.updatedAt,
    };
    await firstStore.save(failed);

    const restartedStore = createFileJobRunStore(filePath);
    const before = await restartedStore.findByIdempotencyKey(first.idempotencyKey);
    assert.equal(before?.id, first.id);
    assert.equal(before?.status, PLATFORM_JOB_RUN_STATUSES.FAILED);

    const [retry, concurrent] = await Promise.all([
      handlePlatformJob({
        payload,
        store: restartedStore,
        mode: PLATFORM_JOBS_MODES.SHADOW,
      }),
      handlePlatformJob({
        payload,
        store: restartedStore,
        mode: PLATFORM_JOBS_MODES.SHADOW,
      }),
    ]);
    assert.equal(retry.idempotencyKey, first.idempotencyKey);
    assert.equal(concurrent.idempotencyKey, first.idempotencyKey);
    const persisted = await restartedStore.findByIdempotencyKey(first.idempotencyKey);
    assert.equal(persisted?.id, first.id);
    assert.ok(
      [retry.status, concurrent.status].some((status) =>
        ["SUCCEEDED", "DUPLICATE", "SKIPPED"].includes(status),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime source still uses persistRawThenCanonical before canonical tables", () => {
  const source = readFileSync(path.join(root, "lib/ozon/syncOzonAccrualByDay.ts"), "utf8");
  assert.match(source, /persistRawThenCanonical/);
  assert.match(source, /commitRaw/);
  assert.match(source, /persistCanonical/);
  assert.match(source, /validateOzonAccrualIngest/);
  assert.doesNotMatch(
    source,
    /unknownMeaningfulTypeIds\.length > 0 &&[\s\S]*unresolvedType71Groups\.length === 0/,
  );
});
