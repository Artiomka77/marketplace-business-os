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
    dateLabel: "2026-09-28",
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
      periodLabel: "Аналогичный предыдущий период",
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
      periodLabel: "Аналогичный предыдущий период",
      companies: [
        {
          companyName: "ИП Лебедева",
          wb: baseMetrics("WB", {
            economicTurnover: 4500,
            taxableRevenue: 2000,
            adSpend: 0,
            totalCost: 1200,
            netProfitAfterTax: -3000,
            drrByEconomicTurnover: 0,
            ordersAmount: 40000,
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
    top3: [
      { article: `${companyName.slice(0, 1)}-${marketplace}-1`, qty: 5, amount: 10000 },
      { article: `${companyName.slice(0, 1)}-${marketplace}-2`, qty: 3, amount: 7000 },
      { article: `${companyName.slice(0, 1)}-${marketplace}-3`, qty: 2, amount: 4000 },
    ],
    top3Source: "TRUE_ORDERS",
    distinctOrderedArticles: 5,
    ...overrides,
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
    businessTop3CabinetCount: 4,
    businessTop3Complete: true,
    cabinets: [
      cabinet("ИП Петров", "WB", {
        spend: 23235,
        financialSpend: 23235,
        impressions: 50000,
        clicks: 1200,
        counterStatus: "COUNTERS_AVAILABLE_NONZERO",
      }),
      cabinet("ИП Петров", "OZON", {
        spend: 69591,
        financialSpend: 132404,
        financialDrr: 15,
        spendSemantics: "PERFORMANCE_PARTIAL",
        top3: [
          {
            article: "1217252162-158",
            ozonOffer: "1217252162-158",
            humanArticle: "Ади-Флис-всерый",
            size: "158",
            imageUrl: "https://cdn.example/ozon-a.jpg",
            marketplace: "OZON",
            qty: 11,
            amount: 78472,
            mappingConfidence: "EXACT",
            mappingPath: "ProductCost.vendorCode@nmId",
          },
          {
            article: "1492430240-158",
            ozonOffer: "1492430240-158",
            humanArticle: "Ади-Флис-вчерный",
            size: "158",
            imageUrl: "https://cdn.example/ozon-b.jpg",
            marketplace: "OZON",
            qty: 8,
            amount: 50000,
            mappingConfidence: "EXACT",
          },
          {
            article: "ART-OZ-3",
            ozonOffer: "ART-OZ-3",
            marketplace: "OZON",
            qty: 5,
            amount: 30000,
          },
        ],
      }),
      cabinet("ИП Лебедева", "WB", {
        spend: 0,
        financialSpend: 0,
        impressions: null,
        clicks: null,
        ctr: null,
        cpc: null,
        counterStatus: "COUNTERS_MISSING",
        top3: [],
        top3Source: "UNAVAILABLE",
      }),
      cabinet("ИП Лебедева", "OZON", {
        spend: 1945,
        financialSpend: 3406,
        spendSemantics: "PERFORMANCE_PARTIAL",
        top3: [
          { article: "Леб-арт-1", qty: 6, amount: 25000 },
          { article: "Леб-арт-2", qty: 4, amount: 18000 },
          { article: "Леб-арт-3", qty: 2, amount: 9000 },
        ],
      }),
    ],
  };
}

test("V3.1 dynamics visible on business KPIs (28 vs 27)", () => {
  const m1 = formatOwnerReportV3Message1(fixtureReport());
  assert.match(m1, /Заказы.*[▲▼]|Заказы.*-7/);
  assert.match(m1, /Экон\. оборот.*[▲▼→]/);
  assert.match(m1, /Налог\. выручка.*[▲▼→]/);
  assert.match(m1, /Себестоимость.*[🔴🟢🔽]|Себестоимость.*п\.п/);
  assert.match(m1, /Реклама.*ДРР/);
  assert.match(m1, /п\.п/);
  assert.match(m1, /Чистая прибыль.*[▲▼→]/);
  assert.match(m1, /vs 27\.09\.2026/);
});

test("V3.1 weekly/monthly date labels still carry dynamics when comparison present", () => {
  const week = fixtureReport();
  week.dateLabel = "2026-09-21 — 2026-09-27";
  week.periodLabel = "Прошлая неделя";
  week.comparison!.dateLabel = "2026-09-14 — 2026-09-20";
  const m1 = formatOwnerReportV3Message1(week);
  assert.match(m1, /Период ·/);
  assert.match(m1, /Заказы.*[▲▼→]/);
  assert.match(m1, /Экон\. оборот.*[▲▼→]/);
});

test("V3.1 WB unknown counters render н/д not zero", () => {
  const extras = extrasFixture();
  extras.cabinets[2].impressions = null;
  extras.cabinets[2].clicks = null;
  extras.cabinets[2].counterStatus = "COUNTERS_MISSING";
  const m2 = formatOwnerReportV3(fixtureReport(), extras).message2;
  assert.match(m2, /Показы\s+н\/д/);
  assert.match(m2, /Клики\s+н\/д/);
  assert.doesNotMatch(m2, /ИП Лебедева · 🟣 WB[\s\S]*Показы\s+0\b/);
});

test("V3.1 Ozon vendorCode primary + Performance vs P&L label", () => {
  const v3 = formatOwnerReportV3(fixtureReport(), extrasFixture());
  assert.match(v3.message2, /Ади-Флис-всерый/);
  assert.doesNotMatch(v3.message2, /Костюм спортивный MODNYVIKI/);
  assert.match(v3.message2, /Performance:/);
  // HTML Message2 escapes & → &amp; so Telegram renders "P&L"
  assert.match(v3.message2, /Реклама P&amp;L:/);
});

test("V3.1 business TOP-3 complete requires 4 cabinets; incomplete labeled", () => {
  const incomplete = extrasFixture();
  incomplete.businessTop3Complete = false;
  incomplete.businessTop3CabinetCount = 2;
  incomplete.businessTop3Source = "INCOMPLETE";
  const m2 = formatOwnerReportV3(fixtureReport(), incomplete).message2;
  assert.match(m2, /неполно/);
  assert.doesNotMatch(m2, /ТОП-3 ПО ВСЕМУ БИЗНЕСУ/);

  const complete = formatOwnerReportV3(fixtureReport(), extrasFixture()).message2;
  assert.match(complete, /ТОП-3 ПО ВСЕМУ БИЗНЕСУ/);
});

test("V3.1 TOP-3 aggregation + UTF-8 + two messages", () => {
  const items: TopOrderItem[] = [
    { article: "A", qty: 1, amount: 10 },
    { article: "a", qty: 2, amount: 20 },
    { article: "B", qty: 5, amount: 50 },
  ];
  const top = aggregateTop3(items);
  assert.equal(top[0].article.toUpperCase(), "B");
  assert.equal(top[1].qty, 3);

  const v3 = formatOwnerReportV3(fixtureReport(), extrasFixture());
  assert.equal(v3.messageCount, 2);
  for (const text of [v3.message1, v3.message2]) {
    for (const bad of MOJIBAKE) assert.equal(text.includes(bad), false);
  }
});

test("V3.1 company sort helper", () => {
  const sorted = ownerReportV3Math.sortCompaniesOwnerOrder([
    { companyName: "ИП Лебедева" },
    { companyName: "ИП Петров" },
  ]);
  assert.deepEqual(
    sorted.map((c) => c.companyName),
    ["ИП Петров", "ИП Лебедева"]
  );
});

test("V3.2 company + cabinet dynamics from previousReport", () => {
  const m1 = formatOwnerReportV3Message1(fixtureReport());
  assert.match(m1, /👤 ИП Петров[\s\S]*Заказы:.*[▲▼→]/);
  assert.match(m1, /👤 ИП Петров[\s\S]*🟣 WB[\s\S]*шт ·.*[▲▼→]/);
  assert.match(m1, /👤 ИП Петров[\s\S]*🔵 Ozon[\s\S]*шт ·.*[▲▼→]/);
  assert.match(m1, /👤 ИП Лебедева[\s\S]*Заказы:.*[▲▼→]/);
  assert.match(m1, /👤 ИП Лебедева[\s\S]*🟣 WB[\s\S]*шт ·.*[▲▼→]/);
  assert.match(m1, /👤 ИП Лебедева[\s\S]*🔵 Ozon[\s\S]*шт ·.*[▲▼→]/);
});

test("V3.2 Ozon TOP-3 human identity + HTML photo + no generic title", () => {
  const v3 = formatOwnerReportV3(fixtureReport(), extrasFixture());
  assert.match(v3.message2, /1217252162-158/);
  assert.match(v3.message2, /Ади-Флис-всерый/);
  assert.match(v3.message2, /р\.158/);
  assert.match(
    v3.message2,
    /<a href="https:\/\/cdn\.example\/ozon-a\.jpg">📷<\/a>/
  );
  assert.doesNotMatch(v3.message2, /Костюм спортивный/);
  assert.doesNotMatch(v3.message2, /MODNYVIKI/);
  assert.equal(
    ownerReportV3Math.escapeTelegramHtml('a<b>&"'),
    "a&lt;b&gt;&amp;&quot;"
  );
});

test("V3.3 arrow dynamics — no colored balls outside attention", () => {
  const m1 = formatOwnerReportV3Message1(fixtureReport());
  const attentionIdx = m1.indexOf("⚠️ ВНИМАНИЕ");
  const ordinary = attentionIdx >= 0 ? m1.slice(0, attentionIdx) : m1;
  assert.equal((ordinary.match(/🟢/g) || []).length, 0);
  assert.equal((ordinary.match(/🔴/g) || []).length, 0);
  assert.match(ordinary, /[▲▼]/);
});

test("V3.3 business TOP-3 family aggregation across sizes", async () => {
  const { aggregateBusinessTop3Family } = await import(
    "../../lib/telegram/ownerReportV3Loaders"
  );
  const items = [
    {
      article: "1217252162-158",
      ozonOffer: "1217252162-158",
      humanArticle: "Ади-вчерный",
      size: "158",
      qty: 9,
      amount: 66717,
      mappingConfidence: "EXACT" as const,
      marketplace: "OZON" as const,
    },
    {
      article: "1217252162-164",
      ozonOffer: "1217252162-164",
      humanArticle: "Ади-вчерный",
      size: "164",
      qty: 9,
      amount: 66716,
      mappingConfidence: "EXACT" as const,
      marketplace: "OZON" as const,
    },
    {
      article: "жилД-корич",
      qty: 24,
      amount: 124800,
      marketplace: "WB" as const,
    },
  ];
  const top = aggregateBusinessTop3Family(items);
  assert.equal(top[0].humanArticle || top[0].article, "Ади-вчерный");
  assert.equal(top[0].qty, 18);
  assert.equal(top[0].isFamilyAggregate, true);
  assert.deepEqual(top[0].familySizes, ["158", "164"]);
  const m2 = formatOwnerReportV3(fixtureReport(), {
    ...extrasFixture(),
    businessTop3: top,
    businessTop3Complete: true,
    businessTop3CabinetCount: 4,
  }).message2;
  assert.match(m2, /Ади-вчерный/);
  assert.match(m2, /разм\. 158\/164/);
  assert.doesNotMatch(m2, /1217252162-158 · 18/);
});
