import assert from "node:assert/strict";
import test from "node:test";

import {
  aliasWbDailyReportSalesAmount,
  combinedManagementRevenue,
  drrPercent,
  marketplaceManagementRevenue,
} from "../../lib/dashboard/managementRevenue";
import { evaluateDashboardIncompleteWeek } from "../../lib/dashboard/incompleteWeekGuard";
import { planOzonAccrualIngest } from "../../lib/ozon/accrualIngestPolicy";
import { mapOzonAccrualByDay } from "../../lib/ozon/accrualByDay";
import { planCompletenessSelfHeal } from "../../lib/platform/completeness/watchdog";
import {
  buildFinancePeriodDetailsBody,
  extractReportIds,
  isWbFinanceScopeDenied,
  nextRrdId,
  wbFinanceRequest,
  WB_DEPRECATED_STATISTICS_DETAIL_URL,
  WB_FINANCE_REPORTS_LIST_URL,
} from "../../lib/wb/wbFinanceApi";
import {
  closedWeekDashboardRule,
  planWbClosedWeekFinalize,
} from "../../lib/wb/closedWeekFinalizer";
import { planWbSourceOwnership } from "../../lib/wb/sourceOwnership";

const WB_ECO = 7_484_757.33;
const WB_TAXABLE = 690_649;
const OZON_ECO = 16_874_603.69;
const ADS = 2_014_983;

function type76Accrual(id: number, date: string, accrued: number) {
  return {
    accrual_id: id,
    date,
    total_amount: accrued,
    non_item_fee: { type_id: 76, accrued },
  };
}

test("WB Finance list/details helpers use current sales-reports endpoints and paginate rrdId", () => {
  assert.equal(
    WB_FINANCE_REPORTS_LIST_URL,
    "https://finance-api.wildberries.ru/api/finance/v1/sales-reports/list",
  );
  assert.match(WB_DEPRECATED_STATISTICS_DETAIL_URL, /reportDetailByPeriod/);
  const body = buildFinancePeriodDetailsBody({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    period: "weekly",
    rrdId: 10,
  });
  assert.equal(body.period, "weekly");
  assert.equal(nextRrdId([{ rrdId: 10 }, { rrdId: 25 }]), 25);
  assert.deepEqual(
    extractReportIds([{ id: 819736576 }, { reportId: "819736580" }]),
    ["819736576", "819736580"],
  );
});

test("WB 429 retries then succeeds", async () => {
  let attempts = 0;
  const result = await wbFinanceRequest({
    url: "https://example.test/finance",
    token: "redacted",
    body: {},
    maxAttempts: 3,
    sleep: async () => undefined,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("rate", { status: 429, headers: { "Retry-After": "1" } });
      }
      return Response.json([{ id: 819736576 }]);
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.ok, true);
});

test("WB Finance 401/403 is a credential/scope gate, not fake success", () => {
  assert.equal(isWbFinanceScopeDenied(401), true);
  assert.equal(isWbFinanceScopeDenied(403), true);
  assert.equal(isWbFinanceScopeDenied(200), false);
});

test("closed-week exact report IDs are additive and idempotent", () => {
  const first = planWbClosedWeekFinalize({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    listedReports: [
      { reportId: "819736576" },
      { reportId: "819736580" },
      { reportId: "819766432" },
      { reportId: "819766433" },
    ],
    expectedReportIds: ["819736576", "819736580", "819766432", "819766433"],
  });
  assert.deepEqual(first.idsToFetch, ["819736576", "819736580", "819766432", "819766433"]);
  assert.equal(first.status, "PRELIMINARY");
  assert.equal(first.manualFilesRequired, false);

  const second = planWbClosedWeekFinalize({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    listedReports: first.listedReports,
    expectedReportIds: ["819736576", "819736580", "819766432", "819766433"],
    persistedReportIds: first.reportIds,
  });
  assert.deepEqual(second.idsToFetch, []);
  assert.equal(second.complete, true);
  assert.equal(second.status, "FINAL");
  assert.equal(second.ownerIfComplete, "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS");
});

test("missing one closed-week report stays PRELIMINARY and must not present latest day as the week", () => {
  const plan = planWbClosedWeekFinalize({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    listedReports: [{ reportId: "819736576" }],
    expectedReportIds: ["819736576", "819736580"],
  });
  const rule = closedWeekDashboardRule(plan);
  assert.equal(plan.status, "PRELIMINARY");
  assert.equal(rule.mayPresentAsFinal, false);
  assert.equal(rule.fallbackToLatestDayForbidden, true);
});

test("weekly exact finance sessions outrank daily finance sessions", () => {
  const weekFrom = new Date("2026-08-17T00:00:00.000Z");
  const weekTo = new Date("2026-08-23T00:00:00.000Z");
  const plan = planWbSourceOwnership({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyNames: ["ИП Петров"],
    financeRows: [
      { companyName: "ИП Петров", reportNumber: "819736576", dateFrom: weekFrom, dateTo: weekTo },
      { companyName: "ИП Петров", reportNumber: "819736580", dateFrom: weekFrom, dateTo: weekTo },
      { companyName: "ИП Петров", reportNumber: "daily17", dateFrom: weekFrom, dateTo: weekFrom },
    ],
    sessions: [
      {
        id: "w1",
        fileName: "wb_819736576.xlsx",
        companyName: "ИП Петров",
        reportType: "WB_SALES",
        status: "SUCCESS",
        createdAt: new Date("2026-08-24T00:00:00.000Z"),
      },
      {
        id: "w2",
        fileName: "wb_819736580.xlsx",
        companyName: "ИП Петров",
        reportType: "WB_SALES",
        status: "SUCCESS",
        createdAt: new Date("2026-08-24T00:00:00.000Z"),
      },
      {
        id: "d1",
        fileName: "wb_daily17.xlsx",
        companyName: "ИП Петров",
        reportType: "WB_SALES",
        status: "SUCCESS",
        createdAt: new Date("2026-08-18T00:00:00.000Z"),
      },
    ],
  });
  assert.equal(plan.intervals[0]?.mode, "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS");
  assert.equal(plan.isFinanciallyFinal, true);
});

test("Dashboard uses eco for WB and Ozon; salesAmount aliases eco; tax stays separate", () => {
  const wb = { economicTurnover: WB_ECO, salesAmount: WB_TAXABLE, taxableRevenue: WB_TAXABLE };
  const ozon = { economicTurnover: OZON_ECO, salesAmount: OZON_ECO };
  assert.equal(marketplaceManagementRevenue(wb), WB_ECO);
  assert.equal(marketplaceManagementRevenue(ozon), OZON_ECO);
  const combined = combinedManagementRevenue(wb, ozon);
  assert.ok(combined != null && Math.abs(combined - 24_359_361.02) < 0.02);
  const aliased = aliasWbDailyReportSalesAmount({
    economicTurnover: WB_ECO,
    taxableRevenue: WB_TAXABLE,
  });
  assert.equal(aliased.salesAmount, WB_ECO);
  assert.equal(aliased.taxableRevenue, WB_TAXABLE);
  assert.notEqual(aliased.salesAmount, aliased.taxableRevenue);
  const drr = drrPercent(ADS, combined ?? 0);
  assert.ok(drr !== null && Math.abs(drr - 8.27) < 0.05);
});

test("Dashboard incomplete closed week is not shown as FINAL", () => {
  const presentation = evaluateDashboardIncompleteWeek({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    wbExactCoverComplete: false,
    dataReadiness: { isFinal: false, status: "preliminary", issues: [] },
    now: new Date("2026-08-24T12:00:00Z"),
  });
  assert.equal(presentation.mayPresentAsFinal, false);
  assert.equal(presentation.status, "INCOMPLETE");
});

test("closed week promotes to FINAL when exact reports arrive", () => {
  const before = planWbClosedWeekFinalize({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    listedReports: [{ reportId: "819736576" }, { reportId: "819736580" }],
    expectedReportIds: ["819736576", "819736580"],
  });
  assert.equal(before.status, "PRELIMINARY");
  const after = planWbClosedWeekFinalize({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    listedReports: [{ reportId: "819736576" }, { reportId: "819736580" }],
    expectedReportIds: ["819736576", "819736580"],
    persistedReportIds: ["819736576", "819736580"],
  });
  assert.equal(after.status, "FINAL");
  const heal = planCompletenessSelfHeal({
    wbClosedWeekComplete: after.complete,
    wbExactOwner: true,
    ozonCoverageComplete: true,
    ozonUnknownQuarantine: false,
    openDayDailyComplete: true,
  });
  assert.equal(heal.promotePreliminaryToFinal, true);
  assert.equal(heal.manualMarketplaceFilesRequired, false);
});

test("type 76 maps to OZON_OTHER_SERVICES with dynamic source amount and canonical expense sign", () => {
  const mapped = mapOzonAccrualByDay({
    accruals: [
      type76Accrual(1, "2026-08-23", -1911.55),
      type76Accrual(2, "2026-08-24", -842.17),
    ],
    accrualTypes: [{ id: 76, name: "Страхование товара от массовых повреждений", description: null }],
  });
  const facts = mapped.facts.filter((fact) => fact.sourceTypeId === 76);
  assert.equal(facts.length, 2);
  assert.equal(facts[0]?.category, "OZON_OTHER_SERVICES");
  assert.ok(Math.abs((facts[0]?.amount ?? 0) - 1911.55) < 0.011);
  assert.ok(Math.abs((facts[1]?.amount ?? 0) - 842.17) < 0.011);
  assert.notEqual(facts[0]?.amount, facts[1]?.amount);
  assert.ok((facts[0]?.amount ?? 0) > 0);
});

test("unknown Ozon type is quarantined, known facts remain, finality fails, ingest continues", () => {
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
  });
  const plan = planOzonAccrualIngest({
    coverageComplete: mapped.coverageComplete,
    unknownMeaningfulTypeIds: mapped.diagnostics.unknownMeaningfulTypeIds.map((item) => ({
      typeId: item.typeId,
      rows: item.rows,
      amount: item.amount,
      name: item.name,
    })),
  });
  assert.equal(plan.abortEntireDay, false);
  assert.equal(plan.persistKnownFacts, true);
  assert.equal(plan.failFinality, true);
  assert.equal(plan.replayAfterMapperUpdate, true);
  assert.equal(mapped.facts.some((fact) => fact.sourceTypeId === 76), true);
  assert.equal(mapped.facts.some((fact) => fact.sourceTypeId === 9999), false);
  assert.equal(mapped.coverageComplete, false);
});

test("replay after mapper update clears type 76 quarantine", () => {
  const before = planOzonAccrualIngest({
    coverageComplete: false,
    unknownMeaningfulTypeIds: [{ typeId: 76, amount: -1911.55, name: "insurance" }],
  });
  assert.equal(before.replayAfterMapperUpdate, true);
  const afterMap = mapOzonAccrualByDay({
    accruals: [type76Accrual(1, "2026-08-23", -1911.55)],
    accrualTypes: [{ id: 76, name: "Страхование товара от массовых повреждений", description: null }],
  });
  const after = planOzonAccrualIngest({
    coverageComplete: afterMap.coverageComplete,
    unknownMeaningfulTypeIds: afterMap.diagnostics.unknownMeaningfulTypeIds,
  });
  assert.equal(after.failFinality, false);
  assert.equal(after.status, "FINAL");
  assert.equal(after.quarantine.length, 0);
});
