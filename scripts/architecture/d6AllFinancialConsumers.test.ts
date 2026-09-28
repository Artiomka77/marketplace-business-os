import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  isProfitAnalyticsUnavailable,
  isWbPnlUnavailable,
  makeUnavailableProfitAnalyticsResult,
  resolveWbPnlAvailability,
  WB_PNL_UNAVAILABLE_REASON,
} from "../../lib/analytics/profitAnalytics";
import { formatDailyReportForTelegram, type DailyReport } from "../../lib/telegram/dailyReport";
import { assertWbFinancialDataFinal } from "../../lib/analytics/wbFinality";

const root = process.cwd();

function readRepo(rel: string) {
  return readFileSync(join(root, rel), "utf8");
}

test("shared contract: SOURCE_COMPLETE stays AVAILABLE", () => {
  const availability = resolveWbPnlAvailability({
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    source: { isFinanciallyFinal: true, intervals: [] },
  });
  assert.equal(availability.status, "AVAILABLE");
  assert.equal(availability.kind, "FINAL");
});

test("shared contract: SOURCE_COMPLETE true zero is still AVAILABLE", () => {
  const availability = resolveWbPnlAvailability({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    source: { isFinanciallyFinal: true, intervals: [] },
  });
  assert.equal(availability.status, "AVAILABLE");
  assert.equal(isWbPnlUnavailable(availability), false);
});

test("shared contract: SOURCE_INCOMPLETE long range is UNAVAILABLE with null totals", () => {
  const availability = resolveWbPnlAvailability({
    dateFrom: "2026-01-01",
    dateTo: "2026-09-05",
    source: {
      isFinanciallyFinal: false,
      intervals: [{ preliminaryReasons: ["SOURCE_INCOMPLETE"] }],
    },
  });
  assert.equal(availability.status, "UNAVAILABLE");
  if (availability.status !== "UNAVAILABLE") throw new Error("expected UNAVAILABLE");
  const result = makeUnavailableProfitAnalyticsResult({
    wbPnlAvailability: availability,
    independentAdsCost: 123,
  });
  assert.equal(result.totals, null);
  assert.equal(result.comparison, null);
  assert.equal(result.previousTotals, null);
  assert.equal(result.rows.length, 0);
  assert.equal(result.independentAds.separatedFromPnl, true);
  assert.equal(result.independentAds.adsCost, 123);
  assert.equal(isProfitAnalyticsUnavailable(result), true);
  assert.notEqual(JSON.stringify(result.totals), "0");
});

test("shared contract: source=null is LEGACY_NO_DATE_RANGE AVAILABLE", () => {
  const availability = resolveWbPnlAvailability({
    dateFrom: "2026-01-01",
    dateTo: "2026-09-05",
    source: null,
  });
  assert.equal(availability.status, "AVAILABLE");
  assert.equal(availability.kind, "LEGACY_NO_DATE_RANGE");
});

test("shared contract: no-date-range is LEGACY_NO_DATE_RANGE AVAILABLE", () => {
  const availability = resolveWbPnlAvailability({
    dateFrom: null,
    dateTo: null,
    source: {
      isFinanciallyFinal: false,
      intervals: [{ preliminaryReasons: ["SOURCE_INCOMPLETE"] }],
    },
  });
  assert.equal(availability.status, "AVAILABLE");
  assert.equal(availability.kind, "LEGACY_NO_DATE_RANGE");
});

test("assertWbFinancialDataFinal throws on null totals", () => {
  assert.throws(() => assertWbFinancialDataFinal(null, "TEST_NULL_TOTALS"));
});

test("ABC fail-closed: skips WB rows and shows unavailable banner", () => {
  const src = readRepo("app/abc/page.tsx");
  const adapter = readRepo("lib/waveC/insightsAbcAdapter.ts");
  assert.match(adapter, /isProfitAnalyticsUnavailable/);
  assert.match(src, /data-testid="abc-wb-pnl-unavailable"/);
  assert.match(adapter, /companyWbUnavailable/);
  assert.doesNotMatch(src, /wb\.totals\.revenue/);
});

test("Insights fail-closed: custom long range cannot use wb.totals when unavailable", () => {
  const src = readRepo("app/insights/page.tsx");
  const adapter = readRepo("lib/waveC/insightsAbcAdapter.ts");
  assert.match(adapter, /isProfitAnalyticsUnavailable/);
  assert.match(src, /data-testid="insights-wb-pnl-unavailable"/);
  assert.match(src, /wbUnavailable \? "недоступно"/);
  assert.match(src, /Рекомендации по прибыли WB не формируются из нулей/);
});

test("plan-fact mixed marketplace: combined null when WB unavailable, Ozon numeric", () => {
  const src = readRepo("app/finance/plan-fact/page.tsx");
  const manifest = readRepo("financial-core/v6/manifest.json");
  assert.match(src, /loadPeriodFinancePack/);
  assert.match(manifest, /await getProfitAnalytics/);
  assert.doesNotMatch(src, /await getProfitAnalytics/);
  assert.match(src, /isProfitAnalyticsUnavailable/);
  assert.match(src, /combinedPnlUnavailable/);
  assert.match(src, /data-testid="plan-fact-wb-pnl-unavailable"/);
  assert.match(src, /wbRevenue = wbUnavailable \? null/);
  assert.match(src, /wbRevenue == null \|\| ozonRevenue == null/);
  assert.doesNotMatch(src, /\(wbRevenue \?\? 0\)/);
});

test("analytics API exposes totals null instead of spreading zero-filled P&L", () => {
  const src = readRepo("app/api/analytics/profit/route.ts");
  assert.match(src, /wbPnlUnavailable: result\.totals === null/);
  assert.match(src, /totals: result\.totals/);
  assert.doesNotMatch(src, /\.\.\.result/);
});

test("Telegram render-only: WB unavailable does not print fake 0 combined P&L", () => {
  const report = {
    dateLabel: "2026-01-01 — 2026-09-05",
    periodLabel: "YTD",
    companies: [
      {
        companyName: "ИП Петров",
        wb: {
          marketplace: "WB",
          ordersQty: 10,
          ordersAmount: 1000,
          orderDataLoadedDays: 1,
          orderDataExpectedDays: 1,
          ordersDataMissing: false,
          ordersDataIncomplete: false,
          ordersDataMissingReason: null,
          salesQty: 0,
          salesAmount: 0,
          salesLabel: "Экономический оборот",
          salesQtyIsReliable: false,
          salesDataMissing: true,
          salesDataMissingReason: "WB финансовые данные неполны",
          adSpend: 50,
          adSpendSource: "WB Ads (не полный P&L)",
          adDataMissing: false,
          adDataMissingReason: null,
          drrByOrders: 0,
          drrBySales: 0,
          drrByEconomicTurnover: 0,
          drrByTaxableRevenue: 0,
          stockQty: 3,
          netProfitAfterTax: 0,
          netProfitUnavailable: true,
          financialUnavailable: true,
          financialUnavailableReason: "D6_UNSAFE_WB_OWNERSHIP_MODE",
        },
        ozon: {
          marketplace: "OZON",
          ordersQty: 2,
          ordersAmount: 200,
          orderDataLoadedDays: 1,
          orderDataExpectedDays: 1,
          ordersDataMissing: false,
          ordersDataIncomplete: false,
          ordersDataMissingReason: null,
          salesQty: 2,
          salesAmount: 200,
          salesLabel: "Ozon",
          salesQtyIsReliable: true,
          salesDataMissing: false,
          salesDataMissingReason: null,
          adSpend: 10,
          adSpendSource: "Ozon Ads",
          adDataMissing: false,
          adDataMissingReason: null,
          drrByOrders: 5,
          drrBySales: 5,
          drrByEconomicTurnover: 5,
          drrByTaxableRevenue: 5,
          stockQty: 1,
          netProfitAfterTax: 80,
        },
        combinedDataMode: "PRELIMINARY",
        finance: {
          cashIncome: 0,
          cashOutflow: 0,
          netCashFlow: 0,
          netProfitImpact: 0,
          ownerWithdrawals: 0,
        },
      },
    ],
    totals: {
      ordersQty: 12,
      ordersAmount: 1200,
      orderDataLoadedDays: 2,
      orderDataExpectedDays: 2,
      salesQty: 2,
      salesAmount: 200,
      economicTurnover: 200,
      taxableRevenue: 200,
      adSpend: 10,
      drrByOrders: 0,
      drrBySales: 0,
      drrByEconomicTurnover: 0,
      drrByTaxableRevenue: 0,
      stockQty: 4,
      cashIncome: 0,
      cashOutflow: 0,
      netCashFlow: 0,
      netProfitImpact: 80,
      ownerWithdrawals: 0,
    },
    warnings: [],
    dataReadiness: null,
    comparison: null,
    wbFinancialUnavailable: true,
    combinedFinancialUnavailable: true,
  } as DailyReport;

  const text = formatDailyReportForTelegram(report);
  assert.match(text, /WB финансовые данные неполны/);
  assert.match(text, /недоступн/);
  assert.doesNotMatch(text, /Чистая прибыль после налогов: 0/);
  assert.match(text, /Ozon/);
  assert.equal(text.includes("api.telegram.org"), false);
});

test("Profit WB still early-returns before totals when unavailable", () => {
  const src = readRepo("app/profit-wb/page.tsx");
  assert.match(src, /data-testid="wb-pnl-unavailable"/);
  assert.match(src, /analytics\.totals === null/);
  assert.match(src, /data-testid="wb-pnl-available"/);
});
