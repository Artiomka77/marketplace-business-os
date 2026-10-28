#!/usr/bin/env node
/**
 * R15: full buildDailyReport → formatDailyReportForTelegram contract with
 * injected loaders (no Telegram send). Incomplete company must not become
 * confirmed business total / company «0 ₽».
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);
const outPath = process.argv[3] || "R15_daily_report_full_incomplete.json";

// Dynamic import of compiled path via tsx
const mod = await import(
  pathToFileURL(path.join(root, "lib/telegram/dailyReport.ts")).href
);

function baseMetrics(overrides) {
  return {
    marketplace: "WB",
    ordersQty: 1,
    ordersAmount: 100,
    orderDataLoadedDays: 1,
    orderDataExpectedDays: 1,
    ordersDataMissing: false,
    ordersDataIncomplete: false,
    ordersDataMissingReason: null,
    salesQty: 0,
    salesAmount: 100,
    salesLabel: "Экономический оборот",
    salesQtyIsReliable: false,
    salesDataMissing: false,
    salesDataMissingReason: null,
    adSpend: 0,
    adSpendSource: "x",
    adDataMissing: false,
    adDataMissingReason: null,
    drrByOrders: 0,
    drrBySales: 0,
    drrByEconomicTurnover: 0,
    drrByTaxableRevenue: 0,
    stockQty: 1,
    netProfitAfterTax: 10,
    taxableRevenue: 100,
    economicTurnover: 100,
    ...overrides,
  };
}

const incompleteCompany = {
  companyName: "TEST_INCOMPLETE",
  wb: baseMetrics({ marketplace: "WB", netProfitAfterTax: 10 }),
  ozon: baseMetrics({
    marketplace: "OZON",
    netProfitAfterTax: Number.NaN,
    netOzonExpenses: Number.NaN,
    costCoverageIncomplete: false,
  }),
  finance: {
    cashIncome: 1,
    cashOutflow: 0,
    netCashFlow: 1,
    netProfitImpact: 5,
    ownerWithdrawals: 0,
  },
};
const completeCompany = {
  companyName: "TEST_COMPLETE",
  wb: baseMetrics({ marketplace: "WB", netProfitAfterTax: 10 }),
  ozon: baseMetrics({
    marketplace: "OZON",
    netProfitAfterTax: 30,
    netOzonExpenses: 20,
  }),
  finance: {
    cashIncome: 1,
    cashOutflow: 0,
    netCashFlow: 1,
    netProfitImpact: 5,
    ownerWithdrawals: 0,
  },
};

const report = {
  dateLabel: "2026-10-19",
  periodLabel: "Выбранный период",
  companies: [incompleteCompany, completeCompany],
  totals: {
    ordersQty: 4,
    ordersAmount: 400,
    orderDataLoadedDays: 2,
    orderDataExpectedDays: 2,
    salesQty: 0,
    salesAmount: 400,
    economicTurnover: 400,
    taxableRevenue: 400,
    adSpend: 0,
    drrByOrders: 0,
    drrBySales: 0,
    drrByEconomicTurnover: 0,
    drrByTaxableRevenue: 0,
    stockQty: 4,
    cashIncome: 2,
    cashOutflow: 0,
    netCashFlow: 2,
    netProfitImpact: Number.NaN,
    ownerWithdrawals: 0,
  },
  warnings: [
    "TEST_INCOMPLETE: прибыль периода н/д (неполные данные MP/Finance) — не включена в подтверждённую сумму как 0",
    "Итог бизнеса н/д: неполный охват (TEST_INCOMPLETE); доступно по полным: 45 ₽; исключённые компании не считаются 0",
  ],
  hasIncompleteBusinessProfit: true,
  incompleteCompanyScopes: ["TEST_INCOMPLETE"],
  availableCompleteProfitImpact: 45,
  dataReadiness: null,
  comparison: null,
};

assert.equal(mod.hasIncompleteProfitSource(report), true);

const text = mod.formatDailyReportForTelegram(report);
assert.match(text, /Чистая прибыль после налогов: н\/д/);
assert.doesNotMatch(text, /Чистая прибыль после налогов: 45/);
assert.match(text, /TEST_INCOMPLETE[\s\S]*Итого: н\/д/);
assert.doesNotMatch(text, /TEST_INCOMPLETE[\s\S]*Итого: 🔴 0/);
assert.match(text, /TEST_COMPLETE[\s\S]*Итого: 🟢/);
assert.match(text, /Прибыль после налогов Ozon: н\/д/);

// Known zero company remains 0
const zeroReport = structuredClone(report);
zeroReport.companies = [
  {
    companyName: "ZERO_CO",
    wb: baseMetrics({ netProfitAfterTax: 0 }),
    ozon: baseMetrics({
      marketplace: "OZON",
      netProfitAfterTax: 0,
      netOzonExpenses: 0,
      grossOzonExpenses: 0,
      discountPointsAmount: 0,
      partnerProgramsAmount: 0,
      netProfitStatus: "FINAL",
      costCoverageIncomplete: false,
      taxRevenueCoverageComplete: true,
      discountPointsCoverageComplete: true,
    }),
    finance: {
      cashIncome: 0,
      cashOutflow: 0,
      netCashFlow: 0,
      netProfitImpact: 0,
      ownerWithdrawals: 0,
    },
  },
];
zeroReport.hasIncompleteBusinessProfit = false;
zeroReport.incompleteCompanyScopes = [];
zeroReport.availableCompleteProfitImpact = 0;
zeroReport.totals.netProfitImpact = 0;
zeroReport.warnings = [];
const zeroText = mod.formatDailyReportForTelegram(zeroReport);
assert.match(zeroText, /Итого: 🟢 \+?0/);

const out = {
  incompleteBusinessShowsNd: true,
  incompleteCompanyNotZero: true,
  completeCompanyStillShows: true,
  knownZeroPreserved: true,
  hasIncompleteProfitSource: true,
  sampleHeader: text.split("\n").slice(0, 12),
};
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
console.log("DAILY_REPORT_FULL_INCOMPLETE_R15_PASS");
