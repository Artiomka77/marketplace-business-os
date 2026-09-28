import assert from "node:assert/strict";
import test from "node:test";

import type { DailyReport } from "../../lib/telegram/dailyReport";
import {
  formatOwnerReportV3,
  formatOwnerReportV3Message1,
  ownerReportV3Math,
  type OwnerReportV3Extras,
  type TopOrderItem,
} from "../../lib/telegram/ownerReportV3";
import { aggregateTop3 } from "../../lib/telegram/ownerReportV3Loaders";

const MOJIBAKE = ["рџ", "вЂ", "С‚С‹СЃ", "РјР»РЅ", "\uFFFD", "РџРµСЂ", "Р—Р°Рє"];

function baseMetrics(marketplace: "WB" | "OZON", overrides: Record<string, unknown> = {}) {
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
    salesLabel: "Экономический оборот",
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

function fixtureReport(): DailyReport {
  return {
    dateLabel: "2026-09-27",
    periodLabel: "Вчера",
    companies: [
      {
        companyName: "ИП Лебедева",
        wb: baseMetrics("WB", {
          economicTurnover: 5039,
          taxableRevenue: 2103,
          adSpend: 0,
          totalCost: 1450,
          netProfitAfterTax: -3205,
          drrByEconomicTurnover: 0,
          ordersAmount: 43734,
          stockQty: 282,
        }),
        ozon: baseMetrics("OZON", {
          economicTurnover: 19824,
          taxableRevenue: 7595,
          adSpend: 2146,
          totalCost: 3000,
          netProfitAfterTax: 2638,
          drrByEconomicTurnover: 10.8,
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
          adSpend: 0,
          totalCost: 40000,
          netProfitAfterTax: 11557,
          drrByEconomicTurnover: 0,
          ordersAmount: 200000,
          stockQty: 3500,
        }),
        ozon: baseMetrics("OZON", {
          economicTurnover: 80000,
          taxableRevenue: 40000,
          adSpend: 12000,
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
      ordersQty: 40,
      ordersAmount: 401549,
      orderDataLoadedDays: 4,
      orderDataExpectedDays: 4,
      salesQty: 0,
      salesAmount: 263795,
      economicTurnover: 263795,
      taxableRevenue: 138853,
      totalCost: 59450,
      adSpend: 14146,
      drrByOrders: 3.5,
      drrBySales: 5.4,
      drrByEconomicTurnover: 5.4,
      drrByTaxableRevenue: 10.2,
      stockQty: 5018,
      cashIncome: 50000,
      cashOutflow: 20000,
      netCashFlow: 29000,
      netProfitImpact: 18990,
      ownerWithdrawals: 10500,
    },
    warnings: [],
    dataReadiness: null,
    comparison: {
      periodLabel: "Аналогичный предыдущий период",
      dateLabel: "2026-09-26",
      totals: {
        ordersAmountPercent: 5,
        salesAmountPercent: 3,
        economicTurnoverPercent: 3,
        taxableRevenuePercent: 2,
        adSpendPercent: -1,
        netCashFlowPercent: 10,
        netProfitImpactPercent: 4,
        ownerWithdrawalsPercent: 0,
      },
    },
  };
}

function extrasFixture(): OwnerReportV3Extras {
  return {
    businessTop3: [
      { article: "ART-A", qty: 20, amount: 90000 },
      { article: "ART-B", qty: 15, amount: 70000 },
      { article: "ART-C", qty: 10, amount: 50000 },
    ],
    businessTop3Source: "TRUE_ORDERS",
    cabinets: [
      {
        companyName: "ИП Петров",
        marketplace: "WB",
        spend: 0,
        impressions: 1000,
        clicks: 50,
        ctr: 5,
        cpc: 0,
        adOrders: null,
        cpo: null,
        economicTurnover: 158932,
        drr: 0,
        top3: [
          { article: "P-WB-1", qty: 5, amount: 30000 },
          { article: "P-WB-2", qty: 3, amount: 20000 },
          { article: "P-WB-3", qty: 2, amount: 10000 },
        ],
        top3Source: "TRUE_ORDERS",
      },
      {
        companyName: "ИП Петров",
        marketplace: "OZON",
        spend: 12000,
        impressions: 8000,
        clicks: 200,
        ctr: 2.5,
        cpc: 60,
        adOrders: 10,
        cpo: 1200,
        economicTurnover: 80000,
        drr: 15,
        top3: [
          { article: "P-OZ-1", qty: 8, amount: 40000 },
          { article: "P-OZ-2", qty: 4, amount: 20000 },
          { article: "P-OZ-3", qty: 2, amount: 10000 },
        ],
        top3Source: "TRUE_ORDERS",
      },
      {
        companyName: "ИП Лебедева",
        marketplace: "WB",
        spend: 0,
        impressions: 0,
        clicks: 0,
        ctr: null,
        cpc: null,
        adOrders: null,
        cpo: null,
        economicTurnover: 5039,
        drr: 0,
        top3: [],
        top3Source: "UNAVAILABLE",
      },
      {
        companyName: "ИП Лебедева",
        marketplace: "OZON",
        spend: 2146,
        impressions: 3000,
        clicks: 80,
        ctr: 2.67,
        cpc: 26.825,
        adOrders: 3,
        cpo: 715.333,
        economicTurnover: 19824,
        drr: 10.8,
        top3: [{ article: "L-OZ-1", qty: 6, amount: 25000 }],
        top3Source: "TRUE_ORDERS",
      },
    ],
  };
}

test("A/B Message1 core fields + Petrov-then-Lebedeva order", () => {
  const report = fixtureReport();
  const m1 = formatOwnerReportV3Message1(report);
  for (const marker of [
    "Заказы",
    "Экон. оборот",
    "Налог. выручка",
    "Себестоимость",
    "оборота",
    "Реклама",
    "ДРР",
    "Чистая прибыль",
    "маржа",
    "ДДС",
    "Вывод",
    "После вывода",
    "Остатки",
  ]) {
    assert.match(m1, new RegExp(marker));
  }
  const petrov = m1.indexOf("👤 ИП Петров");
  const lebedeva = m1.indexOf("👤 ИП Лебедева");
  assert.ok(petrov >= 0 && lebedeva >= 0 && petrov < lebedeva);
  const petrovWb = m1.indexOf("🟣 WB", petrov);
  const petrovOzon = m1.indexOf("🔵 Ozon", petrov);
  assert.ok(petrovWb >= 0 && petrovOzon > petrovWb && petrovOzon < lebedeva);
});

test("C/D/E COGS share, DRR, margin arithmetic", () => {
  assert.equal(ownerReportV3Math.share(59450, 263795)?.toFixed(4), ((59450 / 263795) * 100).toFixed(4));
  assert.equal(ownerReportV3Math.margin(18990, 263795)?.toFixed(4), ((18990 / 263795) * 100).toFixed(4));
  assert.equal(ownerReportV3Math.safeDiv(14146, 263795), 14146 / 263795);
  assert.equal(ownerReportV3Math.safeDiv(1, 0), null);
  assert.equal(ownerReportV3Math.share(100, 0), null);
});

test("F/G TOP-3 aggregation + per-cabinet isolation", () => {
  const items: TopOrderItem[] = [
    { article: "A", qty: 1, amount: 10, marketplace: "WB" },
    { article: "a", qty: 2, amount: 20, marketplace: "OZON" },
    { article: "B", qty: 5, amount: 50 },
    { article: "C", qty: 1, amount: 5 },
  ];
  const top = aggregateTop3(items);
  assert.equal(top[0].article.toUpperCase(), "B");
  assert.equal(top[1].article.toUpperCase(), "A");
  assert.equal(top[1].qty, 3);
  assert.equal(top[1].amount, 30);

  const v3 = formatOwnerReportV3(fixtureReport(), extrasFixture());
  const m2 = v3.message2;
  assert.match(m2, /ТОП-3 ПО ВСЕМУ БИЗНЕСУ/);
  assert.match(m2, /ART-A/);
  const businessIdx = m2.indexOf("ТОП-3 ПО ВСЕМУ БИЗНЕСУ");
  const petrovIdx = m2.indexOf("ИП Петров · 🟣 WB");
  assert.ok(businessIdx < petrovIdx);
  assert.match(m2, /P-WB-1/);
  assert.match(m2, /P-OZ-1/);
});

test("H/I Ad metrics + unavailable optional does not break core", () => {
  const v3 = formatOwnerReportV3(fixtureReport(), extrasFixture());
  assert.equal(v3.messageCount, 2);
  assert.match(v3.message2, /РЕКЛАМА/);
  assert.match(v3.message2, /Показы/);
  assert.match(v3.message2, /Клики/);
  // cart/organic omitted when unavailable
  assert.doesNotMatch(v3.message2, /Корзины/);
  assert.doesNotMatch(v3.message2, /органика/);
  assert.match(v3.message1, /Себестоимость/);
});

test("K UTF-8 clean dual messages", () => {
  const v3 = formatOwnerReportV3(fixtureReport(), extrasFixture());
  for (const text of [v3.message1, v3.message2]) {
    for (const bad of MOJIBAKE) {
      assert.equal(text.includes(bad), false, `mojibake ${bad}`);
    }
    assert.equal(text.includes("\uFFFD"), false);
  }
});

test("L deterministic message split", () => {
  const v3 = formatOwnerReportV3(fixtureReport(), extrasFixture());
  assert.equal(v3.messageCount, 2);
  assert.match(v3.message1, /сводка собственника/);
  assert.match(v3.message2, /товары и реклама/);
  assert.doesNotMatch(v3.message1, /ТОП-3 ПО ВСЕМУ БИЗНЕСУ/);
  assert.doesNotMatch(v3.message2, /ИТОГО ПО БИЗНЕСУ/);
});

test("N company sort helper", () => {
  const sorted = ownerReportV3Math.sortCompaniesOwnerOrder([
    { companyName: "ИП Лебедева" },
    { companyName: "ИП Петров" },
    { companyName: "ООО Other" },
  ]);
  assert.deepEqual(
    sorted.map((c) => c.companyName),
    ["ИП Петров", "ИП Лебедева", "ООО Other"]
  );
});
