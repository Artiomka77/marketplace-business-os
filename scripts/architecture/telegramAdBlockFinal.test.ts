import assert from "node:assert/strict";
import test from "node:test";

import type { DailyReport } from "../../lib/telegram/dailyReport";
import {
  formatOwnerPeriodLabel,
  formatOwnerReportV3,
  formatOwnerReportV3Message1,
  type CabinetAdFunnel,
  type OwnerReportV3Extras,
} from "../../lib/telegram/ownerReportV3";

function baseMetrics(
  marketplace: "WB" | "OZON",
  overrides: Record<string, unknown> = {}
) {
  return {
    marketplace,
    ordersQty: 10,
    ordersAmount: 50000,
    orderDataLoadedDays: 1,
    orderDataExpectedDays: 1,
    ordersDataMissing: false,
    ordersDataIncomplete: false,
    ordersDataMissingReason: null,
    salesQty: 0,
    salesAmount: 100000,
    salesLabel: "Economic",
    salesQtyIsReliable: false,
    salesDataMissing: false,
    salesDataMissingReason: null,
    adSpend: 5000,
    adSpendSource: "test",
    adDataMissing: false,
    adDataMissingReason: null,
    drrByOrders: 10,
    drrBySales: 5,
    drrByEconomicTurnover: 5,
    drrByTaxableRevenue: 10,
    stockQty: 100,
    netProfitAfterTax: 12000,
    totalCost: 20000,
    taxableRevenue: 50000,
    economicTurnover: 100000,
    netProfitStatus: "FINAL" as const,
    taxRevenueCoverageComplete: true,
    discountPointsCoverageComplete: true,
    financialUnavailable: false,
    netProfitUnavailable: false,
    ...overrides,
  };
}

function fixtureReport(overrides: Partial<DailyReport> = {}): DailyReport {
  return {
    dateLabel: "2026-09-28",
    periodLabel: "Вчера",
    companies: [
      {
        companyName: "ИП Петров",
        wb: baseMetrics("WB", {
          adSpend: 159374,
          drrByEconomicTurnover: 12.9,
          economicTurnover: 1231587,
        }),
        ozon: baseMetrics("OZON", {
          adSpend: 132404,
          drrByEconomicTurnover: 14.5,
          economicTurnover: 910503,
        }),
        combinedDataMode: "FINAL",
        finance: {
          cashIncome: 0,
          cashOutflow: 0,
          netCashFlow: 0,
          netProfitImpact: 0,
          ownerWithdrawals: 0,
        },
      },
      {
        companyName: "ИП Лебедева",
        wb: baseMetrics("WB", {
          adSpend: 0,
          drrByEconomicTurnover: 0,
          economicTurnover: 24198,
        }),
        ozon: baseMetrics("OZON", {
          adSpend: 3406,
          drrByEconomicTurnover: 22.7,
          economicTurnover: 15032,
        }),
        combinedDataMode: "FINAL",
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
      ordersQty: 421,
      ordersAmount: 2903000,
      orderDataLoadedDays: 4,
      orderDataExpectedDays: 4,
      salesQty: 0,
      salesAmount: 1075000,
      economicTurnover: 1075000,
      taxableRevenue: 381800,
      totalCost: 138300,
      adSpend: 159045,
      drrByOrders: 5.5,
      drrBySales: 14.8,
      drrByEconomicTurnover: 14.8,
      drrByTaxableRevenue: 41.6,
      stockQty: 5018,
      cashIncome: 50000,
      cashOutflow: 20000,
      netCashFlow: 29000,
      netProfitImpact: 84200,
      ownerWithdrawals: 10500,
    },
    warnings: [],
    dataReadiness: null,
    comparison: null,
    previousReport: null,
    combinedFinancialUnavailable: false,
    ...overrides,
  } as DailyReport;
}

function wbCabinet(overrides: Partial<CabinetAdFunnel> = {}): CabinetAdFunnel {
  return {
    companyName: "ИП Петров",
    marketplace: "WB",
    spend: 172776,
    financialSpend: 159374,
    financialDrr: 12.9,
    spendSemantics: "FUNNEL_ONLY",
    cabinetSpendComplete: true,
    impressions: null,
    clicks: null,
    ctr: null,
    cpc: null,
    adOrders: null,
    cpo: null,
    counterStatus: "COUNTERS_MISSING",
    economicTurnover: 1231587,
    drr: null,
    top3: [],
    top3Source: "UNAVAILABLE",
    ...overrides,
  };
}

function ozonCabinet(overrides: Partial<CabinetAdFunnel> = {}): CabinetAdFunnel {
  return {
    companyName: "ИП Петров",
    marketplace: "OZON",
    spend: 69591,
    financialSpend: 132404,
    financialDrr: 14.5,
    spendSemantics: "PERFORMANCE_PARTIAL",
    impressions: 268362,
    clicks: 6005,
    ctr: 2.2,
    cpc: 12,
    adOrders: 28,
    cpo: 2485,
    counterStatus: "COUNTERS_AVAILABLE_NONZERO",
    economicTurnover: 910503,
    drr: 7.6,
    top3: [],
    top3Source: "UNAVAILABLE",
    ...overrides,
  };
}

function extrasWith(cabinets: CabinetAdFunnel[]): OwnerReportV3Extras {
  return {
    businessTop3: [],
    businessTop3Source: "UNAVAILABLE",
    businessTop3CabinetCount: 0,
    businessTop3Complete: false,
    cabinets,
  };
}

test("AD_BLOCK period labels: week range + month name", () => {
  assert.equal(
    formatOwnerPeriodLabel("2026-09-21 — 2026-09-27", "Выбранный период"),
    "21.09–27.09.2026"
  );
  assert.equal(
    formatOwnerPeriodLabel("2026-08-01 — 2026-08-31", "Выбранный период"),
    "Август 2026"
  );
  assert.equal(formatOwnerPeriodLabel("2026-09-28", "Вчера"), "28.09.2026");

  const week = fixtureReport({
    dateLabel: "2026-09-21 — 2026-09-27",
    periodLabel: "Выбранный период",
    comparison: {
      periodLabel: "Аналогичный предыдущий период",
      dateLabel: "2026-09-14 — 2026-09-20",
      totals: {
        ordersAmountPercent: null,
        salesAmountPercent: null,
        economicTurnoverPercent: null,
        taxableRevenuePercent: null,
        totalCostPercent: null,
        adSpendPercent: null,
        drrByEconomicTurnoverPointDiff: null,
        netProfitImpactPercent: null,
        netCashFlowPercent: null,
        ownerWithdrawalsPercent: null,
        afterOwnerWithdrawalPercent: null,
        marginPointDiff: null,
      },
      companies: [],
    } as DailyReport["comparison"],
  });
  const m1 = formatOwnerReportV3Message1(week);
  assert.match(m1, /Период · 21\.09–27\.09\.2026/);
  assert.match(m1, /vs 14\.09–20\.09\.2026/);
  assert.doesNotMatch(m1, /Период · 21\.09\.2026$/m);

  const month = fixtureReport({
    dateLabel: "2026-08-01 — 2026-08-31",
    periodLabel: "Выбранный период",
    comparison: null,
  });
  const mm = formatOwnerReportV3Message1(month);
  assert.match(mm, /Период · Август 2026/);
  assert.doesNotMatch(mm, /Период · 01\.08\.2026/);
});

test("AD_BLOCK WB cabinet labeled; P&L matches; no second DRR", () => {
  const report = fixtureReport();
  const extras = extrasWith([
    wbCabinet({
      financialSpend: 159374,
      financialDrr: 12.9,
      spend: 172776,
      cabinetSpendComplete: true,
    }),
    ozonCabinet(),
  ]);
  const { message1, message2 } = formatOwnerReportV3(report, extras);
  assert.match(message1, /📣 Реклама[\s\S]*?159[\s\u00A0\u202F]*374[\s\S]*?ДРР 12,9%/);
  // Message1 company WB line
  assert.match(message1, /🟣 WB[\s\S]*?Реклама 159[\s\u00A0\u202F]*374[\s\S]*?ДРР 12,9%/);
  assert.match(message2, /Кабинет WB:/);
  assert.match(message2, /Расход\s+172[\s\u00A0\u202F]*776[\s\u00A0\u202F]*₽/);
  assert.match(
    message2,
    /Реклама P&amp;L: 159[\s\u00A0\u202F]*374[\s\u00A0\u202F]*₽ · ДРР 12,9%/
  );
  assert.doesNotMatch(
    message2,
    /Расход\s+172[\s\u00A0\u202F]*776[\s\u00A0\u202F]*₽ · ДРР/
  );
  assert.match(message2, /Performance:/);
  assert.match(message2, /Рекл\. заказы/);
});

test("AD_BLOCK WB cabinet unavailable -> spend н/д; P&L still shown", () => {
  const report = fixtureReport();
  report.companies[0].wb.adSpend = 23235;
  report.companies[0].wb.drrByEconomicTurnover = 18.5;
  report.companies[0].wb.economicTurnover = 125315;
  const extras = extrasWith([
    wbCabinet({
      companyName: "ИП Петров",
      spend: 0,
      cabinetSpendComplete: false,
      financialSpend: 23235,
      financialDrr: 18.5,
      economicTurnover: 125315,
    }),
  ]);
  const m2 = formatOwnerReportV3(report, extras).message2;
  assert.match(m2, /Кабинет WB:/);
  assert.match(m2, /Расход\s+н\/д/);
  assert.match(
    m2,
    /Реклама P&amp;L: 23[\s\u00A0\u202F]*235[\s\u00A0\u202F]*₽ · ДРР 18,5%/
  );
  assert.match(m2, /Показы\s+н\/д/);
});

test("AD_BLOCK monthly partial eco -> P&L DRR н/д", () => {
  const extras = extrasWith([
    wbCabinet({
      financialSpend: 1357257,
      financialDrr: null,
      economicTurnover: 0,
      spend: 1211148,
      cabinetSpendComplete: true,
    }),
  ]);
  const m2 = formatOwnerReportV3(fixtureReport(), extras).message2;
  assert.match(
    m2,
    /Реклама P&amp;L: 1[\s\u00A0\u202F]*357[\s\u00A0\u202F]*257[\s\u00A0\u202F]*₽ · ДРР н\/д/
  );
  assert.doesNotMatch(
    m2,
    /Расход\s+1[\s\u00A0\u202F]*211[\s\u00A0\u202F]*148[\s\u00A0\u202F]*₽ · ДРР/
  );
});
