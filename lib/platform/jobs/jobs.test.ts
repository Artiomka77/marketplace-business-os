import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  PLATFORM_JOB_TYPES,
  PLATFORM_JOB_RUN_STATUSES,
  PLATFORM_JOBS_MODES,
  buildBullMqJobContract,
  buildIdempotencyKey,
  buildJobKeys,
  canTransitionJobRun,
  classifyOzonAccrualTypeCode,
  classifyPlatformError,
  createMemoryJobRunStore,
  handlePlatformJob,
  isLegacyDefaultMode,
  resolvePlatformJobsMode,
  transitionJobRun,
  type JobRunRecord,
  type MarketplaceWorkExecutor,
  type PlatformJobPayload,
} from "./index";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

function ozonPayload(
  overrides: Partial<Extract<PlatformJobPayload, { jobType: "OZON_ACCRUAL_BY_DAY" }>> = {},
): PlatformJobPayload {
  return {
    jobType: PLATFORM_JOB_TYPES.OZON_ACCRUAL_BY_DAY,
    scope: {
      companyId: "co_1",
      companyName: "Demo",
      marketplace: "OZON",
      date: "2026-08-20",
    },
    accrualTypeCode: "18",
    ...overrides,
  };
}

function completenessPayload(): PlatformJobPayload {
  return {
    jobType: PLATFORM_JOB_TYPES.DAILY_COMPLETENESS,
    scope: {
      companyId: null,
      companyName: null,
      marketplace: "ALL",
      date: "2026-08-20",
    },
    windowDays: 7,
  };
}

function countingExecutor() {
  let calls = 0;
  const executor: MarketplaceWorkExecutor = async () => {
    calls += 1;
  };
  return {
    executor,
    get calls() {
      return calls;
    },
  };
}

describe("platform jobs foundation", () => {
  it("defaults to legacy execution mode", () => {
    assert.equal(resolvePlatformJobsMode({}), PLATFORM_JOBS_MODES.LEGACY);
    assert.equal(
      resolvePlatformJobsMode({ AVOROFIN_PLATFORM_JOBS_MODE: "queue" }),
      PLATFORM_JOBS_MODES.LEGACY,
    );
    assert.equal(
      resolvePlatformJobsMode({ AVOROFIN_PLATFORM_JOBS_MODE: "shadow" }),
      PLATFORM_JOBS_MODES.SHADOW,
    );
    assert.equal(isLegacyDefaultMode({}), true);
  });

  it("keeps legacy default and never executes marketplace work", async () => {
    const counter = countingExecutor();
    const store = createMemoryJobRunStore();
    const result = await handlePlatformJob({
      payload: ozonPayload(),
      store,
      marketplaceExecutor: counter.executor,
      env: {},
    });

    assert.equal(result.status, PLATFORM_JOB_RUN_STATUSES.SKIPPED);
    assert.equal(result.provenance?.mode, PLATFORM_JOBS_MODES.LEGACY);
    assert.equal(result.provenance?.marketplaceExecuted, false);
    assert.equal(counter.calls, 0);
  });

  it("shadow mode observes both pilots without double execution", async () => {
    const counter = countingExecutor();
    const store = createMemoryJobRunStore();

    const first = await handlePlatformJob({
      payload: ozonPayload(),
      store,
      mode: PLATFORM_JOBS_MODES.SHADOW,
      marketplaceExecutor: counter.executor,
    });
    const second = await handlePlatformJob({
      payload: ozonPayload(),
      store,
      mode: PLATFORM_JOBS_MODES.SHADOW,
      marketplaceExecutor: counter.executor,
    });
    const completeness = await handlePlatformJob({
      payload: completenessPayload(),
      store,
      mode: PLATFORM_JOBS_MODES.SHADOW,
      marketplaceExecutor: counter.executor,
    });

    assert.equal(first.status, PLATFORM_JOB_RUN_STATUSES.SUCCEEDED);
    assert.equal(first.provenance?.observedOnly, true);
    assert.equal(second.status, PLATFORM_JOB_RUN_STATUSES.DUPLICATE);
    assert.equal(completeness.status, PLATFORM_JOB_RUN_STATUSES.SUCCEEDED);
    assert.equal(completeness.jobType, PLATFORM_JOB_TYPES.DAILY_COMPLETENESS);
    assert.equal(counter.calls, 0);
  });

  it("builds stable idempotency and lock keys", () => {
    const a = buildJobKeys(
      ozonPayload({
        scope: {
          companyName: "Demo",
          marketplace: "OZON",
          date: "2026-08-20",
          companyId: "co_1",
        },
      }),
    );
    const b = buildJobKeys(ozonPayload());

    assert.equal(a.idempotencyKey, b.idempotencyKey);
    assert.equal(a.lockKey, b.lockKey);
    assert.equal(a.fingerprint, b.fingerprint);
    assert.equal(
      a.idempotencyKey,
      buildIdempotencyKey(PLATFORM_JOB_TYPES.OZON_ACCRUAL_BY_DAY, {
        companyId: "co_1",
        companyName: "Demo",
        marketplace: "OZON",
        date: "2026-08-20",
      }),
    );
  });

  it("handles duplicates and fingerprint conflicts", async () => {
    const store = createMemoryJobRunStore();
    const first = await handlePlatformJob({
      payload: ozonPayload(),
      store,
      mode: PLATFORM_JOBS_MODES.SHADOW,
    });
    assert.equal(first.status, PLATFORM_JOB_RUN_STATUSES.SUCCEEDED);

    const duplicate = await handlePlatformJob({
      payload: ozonPayload(),
      store,
      mode: PLATFORM_JOBS_MODES.SHADOW,
    });
    assert.equal(duplicate.status, PLATFORM_JOB_RUN_STATUSES.DUPLICATE);

    const sameWorkDifferentTypeMeta = await handlePlatformJob({
      payload: ozonPayload({ accrualTypeCode: "20" }),
      store,
      mode: PLATFORM_JOBS_MODES.SHADOW,
    });
    assert.equal(
      sameWorkDifferentTypeMeta.status,
      PLATFORM_JOB_RUN_STATUSES.DUPLICATE,
    );

    const conflictStore = createMemoryJobRunStore();
    const completeness = await handlePlatformJob({
      payload: completenessPayload(),
      store: conflictStore,
      mode: PLATFORM_JOBS_MODES.SHADOW,
    });
    assert.equal(completeness.status, PLATFORM_JOB_RUN_STATUSES.SUCCEEDED);

    const conflict = await handlePlatformJob({
      payload: {
        jobType: PLATFORM_JOB_TYPES.DAILY_COMPLETENESS,
        scope: {
          companyId: null,
          companyName: null,
          marketplace: "ALL",
          date: "2026-08-20",
        },
        windowDays: 3,
      },
      store: conflictStore,
      mode: PLATFORM_JOBS_MODES.SHADOW,
    });
    assert.equal(conflict.status, PLATFORM_JOB_RUN_STATUSES.FAIL_CLOSED);
    assert.equal(conflict.errorCode, "FINGERPRINT_CONFLICT");

    const persisted = await store.findByIdempotencyKey(first.idempotencyKey);
    assert.equal(persisted?.status, PLATFORM_JOB_RUN_STATUSES.SUCCEEDED);
  });

  it("classifies retryable, rate-limit and fail-closed errors", () => {
    assert.equal(
      classifyPlatformError(new Error("429 Too Many Requests")).errorClass,
      "RATE_LIMIT",
    );
    assert.equal(
      classifyPlatformError(new Error("timeout after 30000ms")).errorClass,
      "RETRYABLE",
    );
    assert.equal(
      classifyPlatformError(new Error("fail-closed: unknown ozon accrual type")).errorClass,
      "FAIL_CLOSED",
    );
    assert.equal(
      classifyPlatformError(new Error("Authorization: Bearer SUPERSECRETTOKENVALUE123")).errorMessage.includes(
        "[redacted]",
      ),
      true,
    );
  });

  it("enforces JobRun transitions", () => {
    const stamp = "2026-08-24T12:00:00.000Z";
    const base: JobRunRecord = {
      id: "jr_1",
      jobType: PLATFORM_JOB_TYPES.DAILY_COMPLETENESS,
      scope: "none|none|ALL|2026-08-20|none",
      idempotencyKey: "k",
      fingerprint: "f",
      lockKey: "l",
      status: PLATFORM_JOB_RUN_STATUSES.PENDING,
      attempts: 0,
      errorClass: null,
      errorCode: null,
      errorMessage: null,
      provenance: null,
      queuedAt: stamp,
      startedAt: null,
      finishedAt: null,
      nextAttemptAt: null,
      createdAt: stamp,
      updatedAt: stamp,
    };

    assert.equal(
      canTransitionJobRun(
        PLATFORM_JOB_RUN_STATUSES.PENDING,
        PLATFORM_JOB_RUN_STATUSES.RUNNING,
      ),
      true,
    );
    assert.equal(
      canTransitionJobRun(
        PLATFORM_JOB_RUN_STATUSES.SUCCEEDED,
        PLATFORM_JOB_RUN_STATUSES.RUNNING,
      ),
      false,
    );

    const running = transitionJobRun(
      base,
      PLATFORM_JOB_RUN_STATUSES.RUNNING,
      stamp,
    );
    assert.equal(running.status, PLATFORM_JOB_RUN_STATUSES.RUNNING);
    assert.equal(running.attempts, 1);

    const succeeded = transitionJobRun(
      running,
      PLATFORM_JOB_RUN_STATUSES.SUCCEEDED,
      stamp,
    );
    assert.equal(succeeded.status, PLATFORM_JOB_RUN_STATUSES.SUCCEEDED);
    assert.throws(() =>
      transitionJobRun(
        succeeded,
        PLATFORM_JOB_RUN_STATUSES.FAILED,
        stamp,
      ),
    );
  });

  it("preserves Ozon unknown-type fail-closed and type18/20/type71 contracts", async () => {
    assert.equal(classifyOzonAccrualTypeCode("18").decision, "KNOWN");
    assert.equal(classifyOzonAccrualTypeCode("20").decision, "KNOWN");
    assert.equal(classifyOzonAccrualTypeCode("71").decision, "KNOWN");
    assert.equal(classifyOzonAccrualTypeCode("99").decision, "FAIL_CLOSED");

    const store = createMemoryJobRunStore();
    const closed = await handlePlatformJob({
      payload: ozonPayload({ accrualTypeCode: "99" }),
      store,
      mode: PLATFORM_JOBS_MODES.SHADOW,
    });
    assert.equal(closed.status, PLATFORM_JOB_RUN_STATUSES.FAIL_CLOSED);

    const syncOzon = readFileSync(
      path.join(root, "lib/ozon/syncOzon.ts"),
      "utf8",
    );
    assert.match(syncOzon, /function classifyOzonOperation/);
    assert.match(syncOzon, /return null;/);
  });

  it("exposes BullMQ contracts for both pilots without runtime queue wiring", () => {
    const contract = buildBullMqJobContract(
      ozonPayload(),
      "jr:v1:OZON_ACCRUAL_BY_DAY:demo",
    );
    assert.equal(contract.queueName, "avorofin-platform-jobs");
    assert.equal(contract.name, "ozon-accrual-by-day");
    assert.equal(contract.opts.jobId, "jr:v1:OZON_ACCRUAL_BY_DAY:demo");

    const completeness = buildBullMqJobContract(
      completenessPayload(),
      "jr:v1:DAILY_COMPLETENESS:demo",
    );
    assert.equal(completeness.name, "daily-completeness");
  });

  it("does not wire platform jobs into existing cron schedulers", () => {
    const cronRoot = path.join(root, "app/api/cron");
    const files = readdirSync(cronRoot, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith(".ts"));

    assert.ok(files.length > 0);

    for (const relative of files) {
      const text = readFileSync(path.join(cronRoot, relative), "utf8");
      assert.equal(
        text.includes("lib/platform/jobs"),
        false,
        `cron ${relative} must not import platform jobs`,
      );
    }
  });
});
