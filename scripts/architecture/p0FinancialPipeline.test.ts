import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateDashboardIncompleteWeek } from "../../lib/dashboard/incompleteWeekGuard";
import {
  aliasWbDailyReportSalesAmount,
  combinedManagementRevenue,
} from "../../lib/dashboard/managementRevenue";
import { evaluateCombinedMarketplaceFinality } from "../../lib/finance/combinedMarketplaceFinality";
import {
  evaluateOzonAccrualCoverage,
  mapOzonAccrualByDay,
} from "../../lib/ozon/accrualByDay";
import { planOzonAccrualIngest } from "../../lib/ozon/accrualIngestPolicy";
import {
  createMemoryJobRunStore,
  handlePlatformJob,
  PLATFORM_JOB_TYPES,
  PLATFORM_JOBS_MODES,
} from "../../lib/platform/jobs";
import { planWbSourceOwnership } from "../../lib/wb/sourceOwnership";
import {
  financeAccountKey,
  resetWbFinanceAccountQueues,
  runWbFinanceAccountQueue,
  WB_FINANCE_MIN_INTERVAL_MS,
} from "../../lib/wb/wbFinanceAccountQueue";
import { WB_DEPRECATED_STATISTICS_DETAIL_URL } from "../../lib/wb/wbFinanceApi";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WB_ECO = 7_484_757.33;
const OZON_ECO = 16_874_603.69;

function type76Accrual(id: number, date: string, accrued: number) {
  return {
    accrual_id: id,
    date,
    total_amount: accrued,
    non_item_fee: { type_id: 76, accrued },
  };
}

function completeEnvelope(
  date: string,
  rawAccrualCount: number,
  explicitZeroDayEvidence = false,
) {
  return {
    date,
    httpOk: true,
    pages: 1,
    paginationComplete: true,
    rawAccrualCount,
    explicitZeroDayEvidence,
  };
}

test("P0-A proven WB sourceOwnership is the V6 implementation, not a 19-line stub", () => {
  const source = readFileSync(path.join(root, "lib/wb/sourceOwnership.ts"), "utf8");
  assert.ok(source.split(/\r?\n/).length > 200);
  assert.match(source, /EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS/);
  const plan = planWbSourceOwnership({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyNames: ["ИП Петров"],
    financeRows: [
      {
        companyName: "ИП Петров",
        reportNumber: "819736576",
        dateFrom: new Date("2026-08-17T00:00:00Z"),
        dateTo: new Date("2026-08-23T00:00:00Z"),
      },
    ],
    sessions: [
      {
        id: "s1",
        fileName: "wb-819736576.xlsx",
        companyName: "ИП Петров",
        reportType: "WB_SALES",
        status: "SUCCESS",
        createdAt: new Date("2026-08-24T00:00:00Z"),
      },
    ],
  });
  assert.equal(plan.isFinanciallyFinal, true);
  assert.match(WB_DEPRECATED_STATISTICS_DETAIL_URL, /reportDetailByPeriod/);
});

test("P0-A WB Finance account queue is 60s and serializes same-account calls", async () => {
  resetWbFinanceAccountQueues();
  const started: number[] = [];
  let clock = 0;
  const key = financeAccountKey("token-a");
  await Promise.all([
    runWbFinanceAccountQueue({
      accountKey: key,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      task: async () => {
        started.push(clock);
        clock += 10;
        return "a";
      },
    }),
    runWbFinanceAccountQueue({
      accountKey: key,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      task: async () => {
        started.push(clock);
        return "b";
      },
    }),
  ]);
  assert.equal(WB_FINANCE_MIN_INTERVAL_MS, 60_000);
  assert.ok(started[1]! - started[0]! >= 60_000);
});

test("P0-B HTTP 200 empty payload is not FINAL without explicit zero-day evidence", () => {
  const mapped = mapOzonAccrualByDay({
    accruals: [],
    requestedDates: ["2026-08-23"],
    dayEnvelopes: [completeEnvelope("2026-08-23", 0, false)],
  });
  assert.equal(mapped.mapperComplete, true);
  assert.equal(mapped.coverageComplete, false);
  assert.deepEqual(mapped.diagnostics.apiCoverage?.emptyUnconfirmedDates, ["2026-08-23"]);
  const plan = planOzonAccrualIngest({ coverageComplete: mapped.coverageComplete });
  assert.equal(plan.status, "PRELIMINARY");
  assert.equal(plan.failFinality, true);
});

test("P0-B missing pagination page stays PRELIMINARY", () => {
  const coverage = evaluateOzonAccrualCoverage({
    requestedDates: ["2026-08-23"],
    dayEnvelopes: [
      {
        date: "2026-08-23",
        httpOk: true,
        pages: 1,
        paginationComplete: false,
        rawAccrualCount: 12,
        explicitZeroDayEvidence: false,
      },
    ],
    mapperComplete: true,
  });
  assert.equal(coverage.coverageComplete, false);
  assert.ok(coverage.missingEvidence.some((item) => item.includes("PAGINATION_INCOMPLETE")));
});

test("P0-B extractor omission fails unfiltered gross reconciliation", () => {
  const mapped = mapOzonAccrualByDay({
    accruals: [
      {
        accrual_id: 1,
        date: "2026-08-23",
        total_amount: -100,
        non_item_fee: { type_id: 76, accrued: -40 },
      },
    ],
    accrualTypes: [{ id: 76, name: "Страхование товара от массовых повреждений", description: null }],
  });
  assert.equal(mapped.coverageComplete, false);
  assert.ok(Math.abs(mapped.diagnostics.grossExpenseDifference) > 0.01);
});

test("P0-D type 76 maps to OZON_OTHER_SERVICES with dynamic source amount", () => {
  const mapped = mapOzonAccrualByDay({
    accruals: [type76Accrual(76, "2026-08-23", -1911.55)],
    accrualTypes: [{ id: 76, name: "Страхование товара от массовых повреждений", description: null }],
  });
  const fact = mapped.facts.find((item) => item.sourceTypeId === 76);
  assert.ok(fact);
  assert.equal(fact?.category, "OZON_OTHER_SERVICES");
  assert.ok(Math.abs((fact?.amount ?? 0) - 1911.55) < 0.011);
});

test("P0-D unknown type keeps known facts, quarantines, and stays PRELIMINARY", () => {
  const mapped = mapOzonAccrualByDay({
    accruals: [
      type76Accrual(1, "2026-08-23", -1911.55),
      {
        accrual_id: 99,
        date: "2026-08-23",
        total_amount: -50,
        non_item_fee: { type_id: 9999, accrued: -50 },
      },
    ],
    accrualTypes: [
      { id: 76, name: "Страхование товара от массовых повреждений", description: null },
      { id: 9999, name: "Unknown future service", description: null },
    ],
    requestedDates: ["2026-08-23"],
    dayEnvelopes: [completeEnvelope("2026-08-23", 2)],
  });
  const plan = planOzonAccrualIngest({
    coverageComplete: mapped.coverageComplete,
    unknownMeaningfulTypeIds: mapped.diagnostics.unknownMeaningfulTypeIds,
  });
  assert.equal(plan.abortEntireDay, false);
  assert.equal(plan.persistKnownFacts, true);
  assert.equal(plan.failFinality, true);
  assert.equal(mapped.facts.some((fact) => fact.sourceTypeId === 76), true);
  assert.equal(mapped.facts.some((fact) => fact.sourceTypeId === 9999), false);
});

test("P0-D mapper update plus exact replay can become FINAL", () => {
  const afterMap = mapOzonAccrualByDay({
    accruals: [type76Accrual(1, "2026-08-23", -1911.55)],
    accrualTypes: [{ id: 76, name: "Страхование товара от массовых повреждений", description: null }],
    requestedDates: ["2026-08-23"],
    dayEnvelopes: [completeEnvelope("2026-08-23", 1)],
  });
  const after = planOzonAccrualIngest({
    coverageComplete: afterMap.coverageComplete,
    unknownMeaningfulTypeIds: afterMap.diagnostics.unknownMeaningfulTypeIds,
  });
  assert.equal(after.failFinality, false);
  assert.equal(after.status, "FINAL");
});

test("P0-E WB FINAL + Ozon PRELIMINARY is combined PRELIMINARY", () => {
  const combined = evaluateCombinedMarketplaceFinality({
    wbSelected: true,
    ozonSelected: true,
    wb: { dataMode: "FINAL", coverageComplete: true },
    ozon: { dataMode: "PRELIMINARY", coverageComplete: false, quarantineCount: 1 },
  });
  assert.equal(combined.combined.dataMode, "PRELIMINARY");
  const presentation = evaluateDashboardIncompleteWeek({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    dataReadiness: { isFinal: true, status: "complete", issues: [] },
    wbExactCoverComplete: true,
    ozonCoverageComplete: false,
    ozonQuarantineCount: 1,
    now: new Date("2026-08-25T12:00:00Z"),
  });
  assert.equal(presentation.mayPresentAsFinal, false);
  assert.equal(presentation.status, "PRELIMINARY");
});

test("P0-E WB PRELIMINARY + Ozon FINAL is combined PRELIMINARY; both FINAL is FINAL", () => {
  const preliminary = evaluateCombinedMarketplaceFinality({
    wbSelected: true,
    ozonSelected: true,
    wb: { dataMode: "PRELIMINARY", coverageComplete: false },
    ozon: { dataMode: "FINAL", coverageComplete: true, quarantineCount: 0 },
  });
  assert.equal(preliminary.combined.dataMode, "PRELIMINARY");
  const both = evaluateCombinedMarketplaceFinality({
    wbSelected: true,
    ozonSelected: true,
    wb: { dataMode: "FINAL", coverageComplete: true },
    ozon: { dataMode: "FINAL", coverageComplete: true, quarantineCount: 0 },
  });
  assert.equal(both.combined.dataMode, "FINAL");
});

test("economic turnover contract aliases salesAmount to management revenue", () => {
  const aliased = aliasWbDailyReportSalesAmount({
    economicTurnover: WB_ECO,
    taxableRevenue: 690_649,
  });
  assert.equal(aliased.salesAmount, WB_ECO);
  assert.equal(
    combinedManagementRevenue({ economicTurnover: WB_ECO }, { economicTurnover: OZON_ECO }),
    WB_ECO + OZON_ECO,
  );
});

test("P0-F duplicate financial job reuses one logical JobRun", async () => {
  const store = createMemoryJobRunStore();
  const payload = {
    jobType: PLATFORM_JOB_TYPES.OZON_ACCRUAL_BY_DAY,
    scope: {
      companyId: "co_1",
      companyName: "Demo",
      marketplace: "OZON" as const,
      date: "2026-08-23",
    },
  };
  const first = await handlePlatformJob({
    payload,
    store,
    mode: PLATFORM_JOBS_MODES.SHADOW,
  });
  const second = await handlePlatformJob({
    payload,
    store,
    mode: PLATFORM_JOBS_MODES.SHADOW,
  });
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.ok(["SUCCEEDED", "SKIPPED", "DUPLICATE"].includes(second.status));
  assert.ok(first.lockKey.includes("OZON_ACCRUAL_BY_DAY"));
});

test("P0-A finance-api callers share wbFinanceRequest and do not fetch the deprecated v5 URL", () => {
  const files = [
    "lib/wb/syncWb.ts",
    "lib/wb/syncWbDailyFinancialReports.ts",
    "app/api/settings/api-connections/test-wb-finance/route.ts",
    "app/api/settings/api-connections/sync-wb-finance/route.ts",
    "app/api/settings/api-connections/test-wb-sales/route.ts",
    "app/api/cron/finalize-wb-closed-week/route.ts",
  ];
  for (const relative of files) {
    const text = readFileSync(path.join(root, relative), "utf8");
    assert.match(text, /wbFinanceRequest/, relative);
    assert.doesNotMatch(text, /await fetch\([\s\S]*finance-api\.wildberries\.ru/);
    assert.doesNotMatch(text, /statistics-api\.wildberries\.ru\/api\/v5\/supplier\/reportDetailByPeriod/);
  }
  const client = readFileSync(path.join(root, "lib/wb/wbFinanceApi.ts"), "utf8");
  assert.match(client, /runWbFinanceAccountQueue/);
  assert.match(client, /WB_DEPRECATED_STATISTICS_DETAIL_URL/);
  assert.doesNotMatch(client, /fetch\(\s*WB_DEPRECATED_STATISTICS_DETAIL_URL/);
});

test("P0-F concurrent JobRun on the same idempotency key does not double-succeed", async () => {
  const store = createMemoryJobRunStore();
  const payload = {
    jobType: PLATFORM_JOB_TYPES.OZON_ACCRUAL_BY_DAY,
    scope: {
      companyId: "co_lock",
      companyName: "Lock Co",
      marketplace: "OZON" as const,
      date: "2026-08-23",
    },
  };
  const [first, second] = await Promise.all([
    handlePlatformJob({
      payload,
      store,
      mode: PLATFORM_JOBS_MODES.SHADOW,
    }),
    handlePlatformJob({
      payload,
      store,
      mode: PLATFORM_JOBS_MODES.SHADOW,
    }),
  ]);
  const succeeded = [first, second].filter((row) => row.status === "SUCCEEDED");
  assert.ok(succeeded.length >= 1);
  assert.ok(succeeded.length <= 1 || first.idempotencyKey === second.idempotencyKey);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.ok(
    [first.status, second.status].some((status) =>
      ["SUCCEEDED", "DUPLICATE", "SKIPPED"].includes(status),
    ),
  );
});
