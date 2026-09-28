import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDailyReportForTelegram,
  type DailyReport,
} from "../../lib/telegram/dailyReport";

function baseMetrics(marketplace: "WB" | "OZON", overrides: Record<string, unknown> = {}) {
  return {
    marketplace,
    ordersQty: 10,
    ordersAmount: 10000,
    orderDataLoadedDays: 1,
    orderDataExpectedDays: 1,
    ordersDataMissing: false,
    ordersDataIncomplete: false,
    ordersDataMissingReason: null,
    salesQty: 0,
    salesAmount: 0,
    salesLabel: "Экономический оборот",
    salesQtyIsReliable: false,
    salesDataMissing: false,
    salesDataMissingReason: null,
    adSpend: 50000,
    adSpendSource: "test",
    adDataMissing: false,
    adDataMissingReason: null,
    drrByOrders: 0,
    drrBySales: 0,
    drrByEconomicTurnover: 0,
    drrByTaxableRevenue: 0,
    stockQty: 5,
    netProfitAfterTax: 0,
    ...overrides,
  };
}

function reportFrom(companies: DailyReport["companies"]): DailyReport {
  return {
    dateLabel: "2026-09-08",
    periodLabel: "день",
    companies,
    totals: {
      ordersQty: 20,
      ordersAmount: 20000,
      orderDataLoadedDays: 2,
      orderDataExpectedDays: 2,
      salesQty: 0,
      salesAmount: 0,
      economicTurnover: 0,
      taxableRevenue: 0,
      adSpend: 100000,
      drrByOrders: 0,
      drrBySales: 0,
      drrByEconomicTurnover: 0,
      drrByTaxableRevenue: 0,
      stockQty: 10,
      cashIncome: 0,
      cashOutflow: 0,
      netCashFlow: 0,
      netProfitImpact: 0,
      ownerWithdrawals: 0,
    },
    warnings: [],
    dataReadiness: null,
    comparison: null,
    combinedFinancialUnavailable: companies.some(
      (c) => c.wb.financialUnavailable || c.ozon.financialUnavailable,
    ),
  };
}

test("telegram render: missing Ozon no fake zero / no partial DRR alert", () => {
  const missingOzon = baseMetrics("OZON", {
    financialUnavailable: true,
    financialUnavailableReason: "MISSING_OZON_ACCRUAL_DAY_STATUS",
    netProfitUnavailable: true,
    taxRevenueCoverageComplete: false,
    discountPointsCoverageComplete: false,
    ozonEconomicsWarning: "Ожидаем данные начислений Ozon",
    economicTurnover: undefined,
    taxableRevenue: undefined,
    netProfitAfterTax: 0,
    adSpend: 1057332,
    drrByEconomicTurnover: 7204.5,
  });
  const readyWb = baseMetrics("WB", {
    economicTurnover: 100000,
    netProfitAfterTax: 1000,
    drrByEconomicTurnover: 5,
    adSpend: 1000,
  });

  const text = formatDailyReportForTelegram(
    reportFrom([
      {
        companyName: "ИП Петров",
        wb: readyWb as any,
        ozon: missingOzon as any,
        combinedDataMode: "PRELIMINARY",
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
        wb: readyWb as any,
        ozon: {
          ...missingOzon,
          adSpend: 100,
          netProfitAfterTax: -40478,
          economicTurnover: 0,
          taxableRevenue: 0,
        } as any,
        combinedDataMode: "PRELIMINARY",
        finance: {
          cashIncome: 0,
          cashOutflow: 0,
          netCashFlow: 0,
          netProfitImpact: 0,
          ownerWithdrawals: 0,
        },
      },
    ]),
  );

  assert.equal(text.includes("7204"), false);
  assert.equal(text.includes("-40"), false);
  assert.match(text, /Ожидаем данные начислений Ozon/);
  assert.match(text, /не равны 0/);
  assert.equal(/ДРР 7204/.test(text), false);
  // Hard mojibake markers must not appear in newly rendered UTF-8 text
  assert.equal(text.includes("РѕР¶РёРґР°РµРј"), false);
  assert.equal(text.includes("╨"), false);
  assert.equal(text.includes("тАФ"), false);
});

test("telegram render: both READY keeps numeric P&L", () => {
  const readyOzon = baseMetrics("OZON", {
    economicTurnover: 20000,
    taxableRevenue: 18000,
    netProfitAfterTax: 3000,
    adSpend: 1000,
    drrByEconomicTurnover: 5,
    taxRevenueCoverageComplete: true,
    discountPointsCoverageComplete: true,
    netProfitStatus: "FINAL",
  });
  const readyWb = baseMetrics("WB", {
    economicTurnover: 100000,
    netProfitAfterTax: 1000,
    drrByEconomicTurnover: 5,
    adSpend: 1000,
    netProfitStatus: "FINAL",
  });
  const text = formatDailyReportForTelegram(
    reportFrom([
      {
        companyName: "ИП Петров",
        wb: readyWb as any,
        ozon: readyOzon as any,
        combinedDataMode: "FINAL",
        finance: {
          cashIncome: 0,
          cashOutflow: 0,
          netCashFlow: 0,
          netProfitImpact: 0,
          ownerWithdrawals: 0,
        },
      },
    ]),
  );
  assert.match(text, /20000|20[\s\u00a0]?000/);
  assert.equal(text.includes("неполны"), false);
});
