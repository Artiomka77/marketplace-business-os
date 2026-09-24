import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  filterActualFinanceTransactions,
  financeStatusForLoanPaymentPaid,
  isActualFinanceTransaction,
} from "../../lib/finance/financeActuality";
import { calculateFinanceMetricsForRows } from "../../lib/finance/financeMetrics";
import { buildExactPeriodHealScope } from "../../lib/platform/completeness/exactPeriodHeal";
import { planCompletenessSelfHeal, snapshotFromMissingReasons } from "../../lib/platform/completeness/watchdog";
import {
  acquirePlatformJobRun,
  createMemoryJobRunStore,
  createPendingJobRunRecord,
  finishPlatformJobRun,
  isStalePlatformJobRun,
  PLATFORM_JOB_RUN_STATUSES,
  PLATFORM_JOBS_SCHEMA_VERSION,
} from "../../lib/platform/jobs";
import { mondaySundayWeekContainingDate } from "../../lib/wb/closedWeekFinalizer";

describe("finance actuality contract", () => {
  it("excludes PLAN from actual metrics and keeps FACT owner/cash", () => {
    const categories = [
      {
        name: "Личное продукты",
        categoryType: "PERSONAL",
        parentName: null,
        profitTreatment: "OWNER_WITHDRAWAL",
      },
      {
        name: "Тело кредита",
        categoryType: "FINANCING",
        parentName: null,
        profitTreatment: "CREDIT_PRINCIPAL",
      },
      {
        name: "Проценты по кредиту",
        categoryType: "EXPENSE",
        parentName: null,
        profitTreatment: "CREDIT_INTEREST",
      },
      {
        name: "Реклама",
        categoryType: "EXPENSE",
        parentName: null,
        profitTreatment: "INCLUDE_IN_NET_PROFIT",
      },
      {
        name: "Оплата фулфилменту",
        categoryType: "EXPENSE",
        parentName: null,
        profitTreatment: "CASH_ONLY",
      },
    ];

    const rows = [
      {
        operationType: "PERSONAL",
        category: "Личное продукты",
        amount: 68240,
        transactionStatus: "FACT",
      },
      {
        operationType: "EXPENSE",
        category: "Реклама",
        amount: 42000,
        transactionStatus: "FACT",
      },
      {
        operationType: "EXPENSE",
        category: "Оплата фулфилменту",
        amount: 100000,
        transactionStatus: "FACT",
      },
      {
        operationType: "INCOME",
        category: "Оплата фулфилменту",
        amount: 420741,
        transactionStatus: "FACT",
        // marketplace cash income treated CASH_ONLY by fallback keywords — use ozon label
      },
      {
        operationType: "FINANCING",
        category: "Тело кредита",
        amount: 89810.17,
        transactionStatus: "PLAN",
      },
      {
        operationType: "EXPENSE",
        category: "Проценты по кредиту",
        amount: 7328.67,
        transactionStatus: "PLAN",
      },
      {
        operationType: "FINANCING",
        category: "Тело кредита",
        amount: 1,
        transactionStatus: "PLAN",
      },
    ];

    // Fix income category so fallback treats marketplace income as CASH_ONLY
    rows[3] = {
      operationType: "INCOME",
      category: "Ozon выплата",
      amount: 420741,
      transactionStatus: "FACT",
    };

    const actual = filterActualFinanceTransactions(rows);
    assert.equal(actual.every((row) => isActualFinanceTransaction(row)), true);
    assert.equal(actual.length, 4);

    const metrics = calculateFinanceMetricsForRows({
      transactions: actual,
      categories,
    });

    assert.equal(metrics.ownerWithdrawals, 68240);
    assert.equal(metrics.creditPrincipal, 0);
    assert.equal(metrics.creditInterest, 0);
    assert.equal(metrics.netProfitExpense, 42000);
    assert.equal(metrics.netCashFlow, 420741 - (68240 + 42000 + 100000));
  });

  it("maps LoanPayment.paid to FACT/PLAN finance status", () => {
    assert.equal(financeStatusForLoanPaymentPaid(true), "FACT");
    assert.equal(financeStatusForLoanPaymentPaid(false), "PLAN");
  });

  it("keeps PLAN visible for forecast-style lists while excluding from actual filter", () => {
    const plan = { transactionStatus: "PLAN" as const };
    const fact = { transactionStatus: "FACT" as const };
    assert.equal(isActualFinanceTransaction(plan), false);
    assert.equal(isActualFinanceTransaction(fact), true);
    assert.deepEqual(filterActualFinanceTransactions([plan, fact]), [fact]);
  });
});

describe("exact-period healer scopes", () => {
  it("WB historical hole 2026-08-05 repairs week 2026-08-03..09", () => {
    const week = mondaySundayWeekContainingDate("2026-08-05");
    assert.deepEqual(week, { dateFrom: "2026-08-03", dateTo: "2026-08-09" });
  });

  it("Ozon historical hole replays exact date only", () => {
    const snapshot = snapshotFromMissingReasons({
      missingReasons: [{ marketplace: "OZON", dataType: "OZON_ECONOMIC_TOTALS" }],
      date: "2026-08-20",
    });
    const plan = planCompletenessSelfHeal(snapshot);
    const scope = buildExactPeriodHealScope({
      missingDate: "2026-08-20",
      plan,
    });
    assert.equal(scope.ozonExactDate, "2026-08-20");
    assert.equal(scope.wbWeek, null);
  });

  it("multiple holes retain independent scopes", () => {
    const wb = buildExactPeriodHealScope({
      missingDate: "2026-08-05",
      plan: {
        retryWbClosedWeek: true,
        retryOzonReplay: false,
        retryDailyOperational: false,
        promotePreliminaryToFinal: false,
        markFinal: false,
        alertPersistentFailure: false,
        manualMarketplaceFilesRequired: false,
      },
    });
    const ozon = buildExactPeriodHealScope({
      missingDate: "2026-08-20",
      plan: {
        retryWbClosedWeek: false,
        retryOzonReplay: true,
        retryDailyOperational: false,
        promotePreliminaryToFinal: false,
        markFinal: false,
        alertPersistentFailure: false,
        manualMarketplaceFilesRequired: false,
      },
    });
    assert.deepEqual(wb.wbWeek, { dateFrom: "2026-08-03", dateTo: "2026-08-09" });
    assert.equal(ozon.ozonExactDate, "2026-08-20");
  });
});

describe("platform JobRun lifecycle (shared store)", () => {
  it("queued -> RUNNING sets startedAt and attempts; success finishes", async () => {
    const store = createMemoryJobRunStore();
    const pending = createPendingJobRunRecord({
      jobType: "DAILY_COMPLETENESS",
      scope: "ALL|ALL|2026-08-24|completeness",
      idempotencyKey: "jr:v1:test:success",
      fingerprint: "{}",
      lockKey: "lock:v1:test:success",
      provenance: {
        schemaVersion: PLATFORM_JOBS_SCHEMA_VERSION,
        source: "platform-jobs",
        mode: "legacy",
        actor: "test",
        stage: "platform-core-v1-stage-1a",
        observedOnly: false,
        marketplaceExecuted: false,
      },
    });
    const acquired = await acquirePlatformJobRun({ store, pending });
    assert.equal(acquired.ok, true);
    assert.equal(acquired.run.status, PLATFORM_JOB_RUN_STATUSES.RUNNING);
    assert.ok(acquired.run.startedAt);
    assert.equal(acquired.run.attempts, 1);

    const done = await finishPlatformJobRun({
      store,
      run: acquired.run,
      ok: true,
    });
    assert.equal(done.status, PLATFORM_JOB_RUN_STATUSES.SUCCEEDED);
    assert.ok(done.finishedAt);
  });

  it("retryable failure sets nextAttemptAt and is not swallowed", async () => {
    const store = createMemoryJobRunStore();
    const pending = createPendingJobRunRecord({
      jobType: "DAILY_COMPLETENESS",
      scope: "ALL|ALL|2026-08-24|completeness",
      idempotencyKey: "jr:v1:test:retry",
      fingerprint: "{}",
      lockKey: "lock:v1:test:retry",
    });
    const acquired = await acquirePlatformJobRun({ store, pending });
    assert.equal(acquired.ok, true);
    const failed = await finishPlatformJobRun({
      store,
      run: acquired.run,
      ok: false,
      retryable: true,
      errorCode: "COMPLETENESS_INCOMPLETE",
      errorMessage: "still incomplete",
    });
    assert.equal(failed.status, PLATFORM_JOB_RUN_STATUSES.FAILED);
    assert.equal(failed.errorClass, "RETRYABLE");
    assert.ok(failed.nextAttemptAt);
    assert.ok(failed.finishedAt);
  });

  it("stale RUNNING with null startedAt is reclaimable", () => {
    assert.equal(
      isStalePlatformJobRun({
        status: PLATFORM_JOB_RUN_STATUSES.RUNNING,
        startedAt: null,
      }),
      true,
    );
  });

  it("duplicate in-flight same idempotency is rejected", async () => {
    const store = createMemoryJobRunStore();
    const pending = createPendingJobRunRecord({
      jobType: "DAILY_COMPLETENESS",
      scope: "ALL|ALL|2026-08-24|completeness",
      idempotencyKey: "jr:v1:test:dup",
      fingerprint: "{}",
      lockKey: "lock:v1:test:dup",
    });
    const first = await acquirePlatformJobRun({ store, pending });
    assert.equal(first.ok, true);
    const second = await acquirePlatformJobRun({
      store,
      pending: { ...pending, id: "other" },
    });
    assert.equal(second.ok, false);
    assert.equal(second.reason, "IN_FLIGHT");
  });

  it("stale RUNNING can be reclaimed then restarted", async () => {
    const store = createMemoryJobRunStore();
    const pending = createPendingJobRunRecord({
      jobType: "DAILY_COMPLETENESS",
      scope: "ALL|ALL|2026-08-24|completeness",
      idempotencyKey: "jr:v1:test:stale",
      fingerprint: "{}",
      lockKey: "lock:v1:test:stale",
    });
    const first = await acquirePlatformJobRun({ store, pending });
    assert.equal(first.ok, true);
    // Force stale by clearing startedAt in store
    await store.save({ ...first.run, startedAt: null });
    const reclaimed = await acquirePlatformJobRun({
      store,
      pending,
      now: new Date("2026-08-25T10:00:00.000Z"),
    });
    assert.equal(reclaimed.ok, true);
    assert.equal(reclaimed.run.status, PLATFORM_JOB_RUN_STATUSES.RUNNING);
    assert.ok(reclaimed.run.startedAt);
    assert.ok(reclaimed.run.attempts >= 1);
  });
});
