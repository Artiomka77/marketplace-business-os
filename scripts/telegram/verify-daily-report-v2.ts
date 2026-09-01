import assert from "node:assert/strict";

import { formatDailyReportForTelegram } from "../../lib/telegram/dailyReport";

type DailyReport = Parameters<typeof formatDailyReportForTelegram>[0];

function marketplace(overrides: Record<string, unknown>) {
  return {
    marketplace: "WB",
    ordersQty: 0,
    ordersAmount: 0,
    orderDataLoadedDays: 1,
    orderDataExpectedDays: 1,
    ordersDataMissing: false,
    ordersDataIncomplete: false,
    ordersDataMissingReason: null,
    salesQty: 0,
    salesAmount: 0,
    salesLabel: "Экономический оборот",
    salesQtyIsReliable: true,
    salesDataMissing: false,
    salesDataMissingReason: null,
    adSpend: 0,
    adSpendSource: "WB Ads",
    adDataMissing: false,
    adDataMissingReason: null,
    drrByOrders: 0,
    drrBySales: 0,
    drrByEconomicTurnover: 0,
    drrByTaxableRevenue: 0,
    stockQty: 0,
    netProfitAfterTax: 0,
    taxableRevenue: 0,
    economicTurnover: 0,
    taxRevenueCoverageComplete: true,
    discountPointsCoverageComplete: true,
    taxesEstimated: false,
    taxCalculationMode: "FINAL_TAXABLE_REVENUE",
    netProfitStatus: "FINAL",
    ...overrides,
  };
}

function emptyFinance() {
  return {
    cashIncome: 0,
    cashOutflow: 0,
    netCashFlow: 0,
    netProfitImpact: 0,
    ownerWithdrawals: 0,
  };
}

function makeReport(overrides: Partial<DailyReport> = {}): DailyReport {
  const lebedevaWb = marketplace({
    marketplace: "WB",
    ordersQty: 23,
    ordersAmount: 115090,
    economicTurnover: 132615,
    taxableRevenue: 98326,
    adSpend: 0,
    netProfitAfterTax: 8306,
    drrByEconomicTurnover: 0,
    stockQty: 222,
  });
  const lebedevaOzon = marketplace({
    marketplace: "OZON",
    ordersQty: 27,
    ordersAmount: 196123,
    economicTurnover: 53332,
    taxableRevenue: 0,
    adSpend: 6904,
    netProfitAfterTax: 992,
    drrByEconomicTurnover: 12.9,
    stockQty: 544,
    taxRevenueCoverageComplete: true,
    discountPointsCoverageComplete: true,
  });
  const petrovWb = marketplace({
    marketplace: "WB",
    ordersQty: 255,
    ordersAmount: 1577238,
    economicTurnover: 1505451,
    taxableRevenue: 1084027,
    adSpend: 19398,
    netProfitAfterTax: 238579,
    drrByEconomicTurnover: 1.3,
    stockQty: 1325,
  });
  const petrovOzon = marketplace({
    marketplace: "OZON",
    ordersQty: 612,
    ordersAmount: 4493273,
    economicTurnover: 2416487,
    taxableRevenue: 0,
    adSpend: 240657,
    netProfitAfterTax: 341463,
    drrByEconomicTurnover: 10.0,
    stockQty: 1683,
    taxRevenueCoverageComplete: true,
    discountPointsCoverageComplete: true,
  });

  const report = {
    dateLabel: "2026-08-20",
    periodLabel: "Вчера",
    generatedAt: new Date("2026-08-21T08:00:00.000Z"),
    companies: [
      {
        companyName: "ИП Лебедева",
        wb: lebedevaWb as DailyReport["companies"][number]["wb"],
        ozon: lebedevaOzon as DailyReport["companies"][number]["ozon"],
        finance: emptyFinance(),
      },
      {
        companyName: "ИП Петров",
        wb: petrovWb as DailyReport["companies"][number]["wb"],
        ozon: petrovOzon as DailyReport["companies"][number]["ozon"],
        finance: {
          cashIncome: 0,
          cashOutflow: 288800,
          netCashFlow: -288800,
          netProfitImpact: -32800,
          ownerWithdrawals: 0,
        },
      },
    ],
    totals: {
      ordersQty: 917,
      ordersAmount: 6381724,
      orderDataLoadedDays: 4,
      orderDataExpectedDays: 4,
      salesQty: 193,
      salesAmount: 3652172,
      economicTurnover: 4107884,
      taxableRevenue: 1182353,
      adSpend: 266960,
      drrByOrders: 4.2,
      drrBySales: 7.3,
      drrByEconomicTurnover: 6.5,
      drrByTaxableRevenue: 22.6,
      stockQty: 3774,
      cashIncome: 0,
      cashOutflow: 288800,
      netCashFlow: -288800,
      netProfitImpact: 556540,
      ownerWithdrawals: 0,
    },
    warnings: [],
    dataReadiness: {
      status: "complete",
      isFinal: true,
      title: "Данные периода полные",
      shortText: "Данные полные",
      summaryText: "ok",
      issues: [],
      counts: {
        companies: 2,
        days: 1,
        expectedOrderRows: 4,
        orderRows: 4,
        wbFinanceRows: 3,
        wbSaleRows: 1,
        wbAdsRows: 1,
        ozonFinanceRows: 1,
        ozonFinanceAdRows: 1,
        ozonAdsRows: 0,
      },
    },
    comparison: {
      periodLabel: "Аналогичный предыдущий период",
      dateLabel: "2026-08-19",
      totals: {
        ordersAmountPercent: -10.4,
        salesAmountPercent: 5.5,
        economicTurnoverPercent: 7.4,
        taxableRevenuePercent: 3.1,
        adSpendPercent: -1.7,
        netCashFlowPercent: -6463.6,
        netCashFlowAmountDiff: 0,
        netProfitImpactPercent: 4.2,
        drrBySalesPointDiff: -0.5,
        drrByEconomicTurnoverPointDiff: -0.6,
      },
    },
    ...overrides,
  } as DailyReport;

  return report;
}

function check(name: string, condition: boolean) {
  assert.equal(condition, true, name);
  console.log(`${name}=PASS`);
}

function companyBlock(text: string, companyName: string) {
  const parts = text.split("━━━━━━━━━━━━━━");
  return parts.find((part) => part.includes(`\n${companyName}\n`)) ?? "";
}

const completeReport = makeReport();
const completeText = formatDailyReportForTelegram(completeReport);

check("COMPLETE_DAY_LABELS", completeText.includes("ИТОГО ПО БИЗНЕСУ"));
check(
  "CASE_B_OZON_COMPLETE_FINAL_LABELS",
  !completeText.includes("по загруженным данным") &&
    !completeText.includes("Итого (предварительно") &&
    completeText.includes("Чистая прибыль:") &&
    !completeText.includes("Предварительная чистая прибыль") &&
    completeText.includes("Итого:") &&
    completeText.includes("Реклама:") &&
    completeText.includes("Остатки:")
);

const caseA = makeReport();
caseA.companies[1].ozon.ordersDataMissing = true;
caseA.companies[1].ozon.ordersQty = 0;
caseA.companies[1].ozon.ordersAmount = 0;
caseA.companies[1].ozon.taxRevenueCoverageComplete = false;
caseA.companies[1].ozon.discountPointsCoverageComplete = false;
caseA.companies[1].ozon.taxesEstimated = true;
caseA.companies[1].ozon.taxCalculationMode = "ESTIMATED_ECONOMIC_TURNOVER";
caseA.companies[1].ozon.netProfitStatus = "PRELIMINARY";
caseA.companies[1].ozon.economicTurnover = 3420806;
caseA.companies[1].ozon.adSpend = 329577;
caseA.companies[1].ozon.stockQty = 3331;
caseA.companies[1].ozon.netProfitAfterTax = 513907;
const caseAText = formatDailyReportForTelegram(caseA);
const petrovCompanyBlock = companyBlock(caseAText, "ИП Петров");
const lebedevaCompanyBlockA = companyBlock(caseAText, "ИП Лебедева");

check(
  "CASE_A_OZON_PROFIT_PRELIMINARY",
  petrovCompanyBlock.includes("Предварительная чистая прибыль") &&
    petrovCompanyBlock.includes("по загруженным данным")
);
check(
  "CASE_A_COMPANY_TOTAL_PRELIMINARY",
  petrovCompanyBlock.includes("Итого (предварительно, по загруженным данным):")
);
check(
  "CASE_A_BUSINESS_AGGREGATE_PRELIMINARY",
  caseAText.includes("Экономический оборот:") &&
    caseAText.includes(" · по загруженным данным") &&
    caseAText.includes("Предварительная чистая прибыль:")
);
check(
  "CASE_A_FALLBACK_TURNOVER_NOT_AUTHORITATIVE",
  /Ozon[\s\S]*Экономический оборот:[\s\S]*по загруженным данным/.test(
    petrovCompanyBlock
  )
);
check(
  "CASE_A_ADS_AND_STOCK_REMAIN_VISIBLE",
  petrovCompanyBlock.includes("Реклама:") &&
    petrovCompanyBlock.includes("Остатки: 3\u00a0331 шт") &&
    !petrovCompanyBlock.includes("Реклама: данные ещё не загружены")
);
check(
  "CASE_A_COMPLETE_COMPANY_NOT_PRELIMINARY_TOTAL",
  lebedevaCompanyBlockA.includes("Итого:") &&
    !lebedevaCompanyBlockA.includes("Итого (предварительно, по загруженным данным):")
);
check(
  "CASE_A_MISSING_OZON_ORDERS_VISIBLE",
  petrovCompanyBlock.includes("Заказы: данные ещё не загружены")
);

const weeklyOnly = makeReport();
weeklyOnly.companies[0].wb.netProfitStatus = "PRELIMINARY";
weeklyOnly.companies[1].wb.netProfitStatus = "PRELIMINARY";
const weeklyOnlyText = formatDailyReportForTelegram(weeklyOnly);
check(
  "WB_WEEKLY_OPEN_NOT_LOADED_DATA_SUFFIX",
  !weeklyOnlyText.includes("по загруженным данным") &&
    !weeklyOnlyText.includes("Итого (предварительно, по загруженным данным):")
);

const caseC = makeReport();
caseC.companies[1].ozon.taxRevenueCoverageComplete = false;
caseC.companies[1].ozon.discountPointsCoverageComplete = false;
caseC.companies[1].ozon.taxesEstimated = true;
const caseCText = formatDailyReportForTelegram(caseC);
const caseCLebedeva = companyBlock(caseCText, "ИП Лебедева");
const caseCPetrov = companyBlock(caseCText, "ИП Петров");
check(
  "CASE_C_ONLY_INCOMPLETE_COMPANY_MARKED",
  caseCPetrov.includes("Итого (предварительно, по загруженным данным):") &&
    caseCLebedeva.includes("Итого:") &&
    !caseCLebedeva.includes("Итого (предварительно, по загруженным данным):")
);
check(
  "CASE_C_BUSINESS_STILL_PRELIMINARY",
  caseCText.includes("Предварительная чистая прибыль:") &&
    caseCText.includes(" · по загруженным данным")
);

console.log("VERIFY_DAILY_REPORT_V2=PASS");
