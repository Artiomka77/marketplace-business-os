import assert from "node:assert/strict";
import test from "node:test";

import type { DailyReport } from "../../lib/telegram/dailyReport";
import { formatPercentChange } from "../../lib/telegram/dailyReport";
import {
  formatOwnerReportV3,
  formatOwnerReportV3Message1,
  type OwnerReportV3Extras,
} from "../../lib/telegram/ownerReportV3";
import {
  buildDynamicsComparabilityMatrix,
  companySnapshotForTests,
  compareSnapshots,
  isSuspectedIncompleteOzonCogsZero,
  marketplaceSnapshotForTests,
} from "../../lib/telegram/ownerReportV3Dynamics";

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

function fixture(): DailyReport {
  return {
    dateLabel: "2026-09-28",
    periodLabel: "Вчера",
    companies: [
      {
        companyName: "ИП Лебедева",
        wb: baseMetrics("WB", {
          economicTurnover: 24198,
          taxableRevenue: 14739,
          adSpend: 0,
          totalCost: 4345,
          netProfitAfterTax: 4062,
          drrByEconomicTurnover: 0,
          ordersAmount: 43979,
          stockQty: 282,
        }),
        ozon: baseMetrics("OZON", {
          economicTurnover: 19824,
          taxableRevenue: 7595,
          adSpend: 3406,
          totalCost: 3000,
          netProfitAfterTax: 2638,
          drrByEconomicTurnover: 17.2,
          ordersAmount: 67815,
          stockQty: 436,
        }),
        combinedDataMode: "FINAL",
        finance: {
          cashIncome: 0,
          cashOutflow: 0,
          netCashFlow: -1000,
          netProfitImpact: 0,
          ownerWithdrawals: 500,
        },
      },
      {
        companyName: "ИП Петров",
        wb: baseMetrics("WB", {
          economicTurnover: 158932,
          taxableRevenue: 89155,
          adSpend: 23235,
          totalCost: 40000,
          netProfitAfterTax: 11557,
          drrByEconomicTurnover: 14.6,
          ordersAmount: 200000,
          stockQty: 3500,
        }),
        ozon: baseMetrics("OZON", {
          economicTurnover: 80000,
          taxableRevenue: 40000,
          adSpend: 132404,
          totalCost: 15000,
          netProfitAfterTax: 8000,
          drrByEconomicTurnover: 15,
          ordersAmount: 90000,
          stockQty: 800,
        }),
        combinedDataMode: "FINAL",
        finance: {
          cashIncome: 50000,
          cashOutflow: 20000,
          netCashFlow: 30000,
          netProfitImpact: 0,
          ownerWithdrawals: 10000,
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
    comparison: {
      periodLabel: "prev",
      dateLabel: "2026-09-27",
      totals: {
        ordersAmountPercent: -7.1,
        salesAmountPercent: 1.3,
        economicTurnoverPercent: 1.3,
        taxableRevenuePercent: 0.1,
        adSpendPercent: -1.6,
        netCashFlowPercent: 10,
        netCashFlowCurrent: 29000,
        netCashFlowPrevious: 26363,
        netProfitImpactPercent: 22.9,
        totalCostPercent: -4.4,
        cogsSharePointDiff: -0.7,
        marginPointDiff: 1.3,
        afterOwnerWithdrawalPercent: 25,
        drrBySalesPointDiff: -0.4,
        drrByEconomicTurnoverPointDiff: -0.4,
      },
    },
    previousReport: {
      dateLabel: "2026-09-27",
      periodLabel: "prev",
      companies: [
        {
          companyName: "ИП Лебедева",
          wb: baseMetrics("WB", {
            economicTurnover: 5039,
            taxableRevenue: 2103,
            adSpend: 0,
            totalCost: 835,
            netProfitAfterTax: -3205,
            drrByEconomicTurnover: 0,
            ordersAmount: 43734,
            stockQty: 280,
          }),
          ozon: baseMetrics("OZON", {
            economicTurnover: 18000,
            taxableRevenue: 7000,
            adSpend: 3000,
            totalCost: 2800,
            netProfitAfterTax: 2000,
            drrByEconomicTurnover: 16.7,
            ordersAmount: 60000,
            stockQty: 430,
          }),
          combinedDataMode: "FINAL",
          finance: {
            cashIncome: 0,
            cashOutflow: 0,
            netCashFlow: -900,
            netProfitImpact: 0,
            ownerWithdrawals: 500,
          },
        },
        {
          companyName: "ИП Петров",
          wb: baseMetrics("WB", {
            economicTurnover: 150000,
            taxableRevenue: 85000,
            adSpend: 24000,
            totalCost: 42000,
            netProfitAfterTax: 10000,
            drrByEconomicTurnover: 16,
            ordersAmount: 220000,
            stockQty: 3400,
          }),
          ozon: baseMetrics("OZON", {
            economicTurnover: 75000,
            taxableRevenue: 38000,
            adSpend: 130000,
            totalCost: 14000,
            netProfitAfterTax: 7000,
            drrByEconomicTurnover: 17,
            ordersAmount: 95000,
            stockQty: 790,
          }),
          combinedDataMode: "FINAL",
          finance: {
            cashIncome: 48000,
            cashOutflow: 19000,
            netCashFlow: 29000,
            netProfitImpact: 0,
            ownerWithdrawals: 10000,
          },
        },
      ],
      totals: {
        ordersQty: 450,
        ordersAmount: 3125000,
        orderDataLoadedDays: 4,
        orderDataExpectedDays: 4,
        salesQty: 0,
        salesAmount: 1060000,
        economicTurnover: 1060000,
        taxableRevenue: 381400,
        totalCost: 144600,
        adSpend: 161000,
        drrByOrders: 5.2,
        drrBySales: 15.2,
        drrByEconomicTurnover: 15.2,
        drrByTaxableRevenue: 42,
        stockQty: 4900,
        cashIncome: 48000,
        cashOutflow: 19000,
        netCashFlow: 26363,
        netProfitImpact: 68500,
        ownerWithdrawals: 10500,
      },
      warnings: [],
      dataReadiness: null,
    },
  };
}

function cabinet(
  companyName: string,
  marketplace: "WB" | "OZON",
  overrides: Partial<OwnerReportV3Extras["cabinets"][0]> = {}
): OwnerReportV3Extras["cabinets"][0] {
  return {
    companyName,
    marketplace,
    spend: 1000,
    financialSpend: 1000,
    financialDrr: 5,
    spendSemantics: "SAME_AS_PNL",
    impressions: 100,
    clicks: 10,
    ctr: 10,
    cpc: 100,
    adOrders: null,
    cpo: null,
    counterStatus: "COUNTERS_AVAILABLE_NONZERO",
    economicTurnover: 20000,
    drr: 5,
    top3: [],
    top3Source: "UNAVAILABLE",
    ...overrides,
  };
}

test("V3.4 high valid percent not suppressed + sign-crossing RUB", () => {
  const m1 = formatOwnerReportV3Message1(fixture());
  const leb = m1.slice(m1.indexOf("👤 ИП Лебедева"));
  const wb = leb.slice(leb.indexOf("🟣 WB"), leb.indexOf("🔵 Ozon"));
  assert.match(wb, /Оборот.*▲380/);
  assert.match(wb, /Налог\..*▲600/);
  assert.match(wb, /COGS.*▲420/);
  assert.match(wb, /Прибыль.*\+4/);
  assert.match(wb, /▲7[\s\u00a0]?267/);
  assert.doesNotMatch(wb, /▲226/);
  assert.match(wb, /п\.п/);
});

test("V3.4 fake historical Ozon COGS zero not comparable", () => {
  assert.equal(isSuspectedIncompleteOzonCogsZero(0, 880735), true);
  const cur = fixture();
  const oz = cur.companies[0].ozon;
  oz.totalCost = 880735;
  oz.economicTurnover = 6_880_000;
  const prevOz = { ...oz, totalCost: 0, economicTurnover: 5_000_000 };
  const dyn = compareSnapshots(
    marketplaceSnapshotForTests(oz),
    marketplaceSnapshotForTests(prevOz as typeof oz)
  );
  assert.equal(dyn.totalCostPercent, null);
  assert.equal(dyn.cogsSharePointDiff, null);
});

test("V3.4 unavailable denominator -> DRR unavailable; partial company", () => {
  const cur = fixture();
  cur.companies[1].ozon.financialUnavailable = true;
  cur.companies[1].ozon.adSpend = 7_152_814;
  const snap = companySnapshotForTests(cur.companies[1]);
  assert.equal(snap.economicTurnover, null);
  assert.equal(snap.drr, null);
  const m1 = formatOwnerReportV3Message1(cur);
  const petrov = m1.slice(m1.indexOf("👤 ИП Петров"), m1.indexOf("👤 ИП Лебедева"));
  assert.match(petrov, /Оборот: н\/д/);
  assert.match(petrov, /WB известно:/);
  assert.match(petrov, /ДРР н\/д/);
  assert.doesNotMatch(petrov.split("🟣")[0], /ДРР 0%/);
});

test("V3.4 Message2 DRR unavailable when eco missing", () => {
  const cur = fixture();
  const extras: OwnerReportV3Extras = {
    businessTop3: [],
    businessTop3Source: "TRUE_ORDERS",
    businessTop3CabinetCount: 4,
    businessTop3Complete: true,
    cabinets: [
      cabinet("ИП Петров", "WB"),
      cabinet("ИП Петров", "OZON", {
        spendSemantics: "PERFORMANCE_PARTIAL",
        financialSpend: 7_152_814,
        economicTurnover: 0,
        financialDrr: null,
        drr: null,
      }),
      cabinet("ИП Лебедева", "WB", {
        impressions: null,
        clicks: null,
        counterStatus: "COUNTERS_MISSING",
      }),
      cabinet("ИП Лебедева", "OZON"),
    ],
  };
  const m2 = formatOwnerReportV3(cur, extras).message2;
  assert.match(m2, /ДРР н\/д/);
  assert.doesNotMatch(m2, /ДРР 0%/);
});

test("V3.4 true zero remains zero; large percent visible", () => {
  assert.match(formatPercentChange(380.2), /▲380/);
  assert.match(formatPercentChange(0), /→0%/);
  assert.equal(formatPercentChange(null), "нет базы");
});

test("V3.4 comparability matrix per level/metric", () => {
  const cur = fixture();
  const matrix = buildDynamicsComparabilityMatrix(cur, cur.previousReport!);
  assert.ok(matrix.length >= 50);
  const cell = matrix.find(
    (c) =>
      c.level.includes("Лебед") &&
      c.level.includes("WB") &&
      c.metric === "economicTurnover"
  );
  assert.ok(cell, `missing cell; levels=${[...new Set(matrix.map((m) => m.level))].join("|")}`);
  assert.equal(cell!.comparable, true);
  assert.ok(cell!.reason.length > 0);
});

test("V3.4 monthly historical TOP-3 unavailable message", () => {
  const cur = fixture();
  cur.dateLabel = "2026-08-01 — 2026-08-31";
  cur.periodLabel = "Прошлый месяц";
  const extras: OwnerReportV3Extras = {
    businessTop3: [],
    businessTop3Source: "UNAVAILABLE",
    businessTop3CabinetCount: 0,
    businessTop3Complete: false,
    cabinets: [
      cabinet("ИП Петров", "WB"),
      cabinet("ИП Петров", "OZON"),
      cabinet("ИП Лебедева", "WB"),
      cabinet("ИП Лебедева", "OZON"),
    ],
  };
  const m2 = formatOwnerReportV3(cur, extras).message2;
  assert.match(m2, /исторический SKU-срез/);
  assert.match(m2, /TOP-3 недоступен для этого периода/);
});
