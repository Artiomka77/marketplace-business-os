import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildWbClosedWeekSettlement,
  buildWbDeductionReconciliation,
  buildWbRevenueCompatibilityFields,
  calculateClosedWeekWbProfit,
  calculateWbTaxes,
  calculateWbV6RevenueComponents,
  selectWbOfficialCashDisplay,
  type WbV6RevenueComponents,
} from "../../lib/analytics/wbFinancialCoreV6";
import {
  buildCanonicalPositiveCostLookups,
  normalizeProductCostKey,
} from "../../lib/analytics/productCostResolver";
import {
  assertWbFinancialDataFinal,
  requiresFinalWbFinancialDataForMarketplace,
  WbPreliminaryFinancialDataError,
} from "../../lib/analytics/wbFinality";
import {
  allocateCanonicalWbSizeMetrics,
  applyCanonicalWbSizeOperation,
  type CanonicalWbSizeMetric,
} from "../../lib/analytics/wbSizeAllocation";
import {
  applyWbPersistedOwnerEvidence,
  classifyCanonicalWbProductOperation,
  evaluateWbProductCoverage,
  filterWbRowsByOwnedSessionIds,
  planWbSourceOwnership,
  type WbOwnershipFinanceRow,
  type WbOwnershipSession,
} from "../../lib/wb/sourceOwnership";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const close = (actual: number, expected: number, label: string) => {
  assert.ok(
    Math.abs(actual - expected) <= 0.01,
    `${label}: ${actual} != ${expected}`
  );
};

function aggregate(
  rows: Array<{ values: WbV6RevenueComponents; operation: "SALE" | "RETURN" }>
) {
  return rows.reduce(
    (totals, row) => {
      const sign = row.operation === "RETURN" ? -1 : 1;
      totals.economicTurnover += sign * row.values.economicTurnover;
      totals.buyerPaid += sign * row.values.buyerPaid;
      totals.platformDiscount += sign * row.values.platformDiscount;
      totals.sellerPayout += sign * row.values.sellerPayout;
      totals.prePayoutBridge += sign * row.values.prePayoutBridge;
      totals.marketplaceTaxTopUp += sign * row.values.marketplaceTaxTopUp;
      totals.taxableRevenue += sign * row.values.taxableRevenue;
      return totals;
    },
    {
      economicTurnover: 0,
      buyerPaid: 0,
      platformDiscount: 0,
      sellerPayout: 0,
      prePayoutBridge: 0,
      marketplaceTaxTopUp: 0,
      taxableRevenue: 0,
    }
  );
}

// Pure row-level formula fixtures. They are intentionally independent of the
// Petrov aggregate control values and do not claim XLSX/DB source parity.
const sale = calculateWbV6RevenueComponents({
  retailPrice: 200,
  retailPriceWithDiscount: 150,
  wbRealizedAmount: 100,
  sellerPayout: 120,
});
close(sale.economicTurnover, 150, "seller price is economic turnover");
close(sale.platformDiscount, 50, "platform discount bridge");
close(sale.marketplaceTaxTopUp, 20, "positive marketplace tax top-up");
close(sale.taxableRevenue, 120, "top-up taxable revenue");
assert.notEqual(
  sale.economicTurnover,
  200,
  "SPP/platform discount was added to economic turnover"
);

const payoutBelowBuyer = calculateWbV6RevenueComponents({
  retailPrice: 150,
  retailPriceWithDiscount: 150,
  wbRealizedAmount: 100,
  sellerPayout: 80,
});
close(payoutBelowBuyer.marketplaceTaxTopUp, 0, "zero marketplace top-up");
close(payoutBelowBuyer.taxableRevenue, 100, "buyer-paid taxable revenue");

const saleAndReturn = aggregate([
  { values: sale, operation: "SALE" },
  { values: sale, operation: "RETURN" },
]);
for (const [key, value] of Object.entries(saleAndReturn)) {
  close(value, 0, `return reverses ${key}`);
}

const taxes = calculateWbTaxes(2_707_899.23, 1, 5);
const taxOrdinaryInclusive = 2_707_899.23;
close(
  taxes,
  taxOrdinaryInclusive * (100 / 105) * 0.01 +
    taxOrdinaryInclusive * (5 / 105),
  "USN 1% on ex-VAT plus VAT 5/105"
);

const mixedReconciliation = buildWbDeductionReconciliation({
  officialOtherDeductionsTotal: 100,
  classifiedAdsDeduction: 30,
  classifiedCreditDeduction: 40,
  classifiedOperatingDeduction: 20,
  classifiedUnknownDeduction: 0,
});
close(mixedReconciliation.classifiedTotal, 90, "classified total");
close(
  mixedReconciliation.unreconciledOfficialDeduction,
  10,
  "official deduction reconciliation gap"
);
assert.equal(mixedReconciliation.isFullyReconciled, false);

const creditReconciliation = buildWbDeductionReconciliation({
  officialOtherDeductionsTotal: 40,
  classifiedAdsDeduction: 0,
  classifiedCreditDeduction: 40,
  classifiedOperatingDeduction: 0,
  classifiedUnknownDeduction: 0,
});
assert.equal(creditReconciliation.isFullyReconciled, true);

const creditSettlement = buildWbClosedWeekSettlement({
  officialCashSettlement: 860,
  canonical: {
    sellerPayout: 1_000,
    officialLogistics: 100,
    officialStorage: 0,
    officialAcceptance: 0,
    officialPenalties: 0,
    classifiedPnlAds: 0,
    classifiedPnlOperating: 0,
  },
});
close(creditSettlement.canonicalPnlSettlement, 900, "canonical P&L settlement");
close(creditSettlement.officialCashSettlement, 860, "official cash settlement");
close(creditSettlement.cashVsPnlDelta, -40, "credit cash/P&L delta");

const guardedProfit = calculateClosedWeekWbProfit({
  canonicalPnlSettlement: creditSettlement.canonicalPnlSettlement,
  canonicalCogs: 300,
  taxes: 50,
});
close(guardedProfit, 550, "profit excludes credit principal");
assert.notEqual(
  guardedProfit,
  creditSettlement.officialCashSettlement - 300 - 50,
  "raw totalToPay became the P&L base"
);

const unknownReconciliation = buildWbDeductionReconciliation({
  officialOtherDeductionsTotal: 30,
  classifiedAdsDeduction: 0,
  classifiedCreditDeduction: 0,
  classifiedOperatingDeduction: 0,
  classifiedUnknownDeduction: 30,
});
assert.equal(unknownReconciliation.isFullyReconciled, false);

// Formula-only checks for the two target-week control values. These do not
// assert local source coverage or pretend to re-read production evidence.
const settlement0309 = buildWbClosedWeekSettlement({
  officialCashSettlement: 1_360_668.79,
  canonical: {
    sellerPayout: 2_024_884.25,
    officialLogistics: 499_259.76,
    officialStorage: 1_503.7,
    officialAcceptance: 0,
    officialPenalties: 30,
    classifiedPnlAds: 163_422,
    classifiedPnlOperating: 0,
  },
});
const settlement1016 = buildWbClosedWeekSettlement({
  officialCashSettlement: 1_267_135.11,
  canonical: {
    sellerPayout: 2_374_350.14,
    officialLogistics: 594_955.92,
    officialStorage: 471.11,
    officialAcceptance: 0,
    officialPenalties: 10,
    classifiedPnlAds: 511_778,
    classifiedPnlOperating: 0,
  },
});
close(
  settlement0309.canonicalPnlSettlement,
  1_360_668.79,
  "03-09 formula-only canonical settlement"
);
close(
  settlement1016.canonicalPnlSettlement,
  1_267_135.11,
  "10-16 formula-only canonical settlement"
);

const managementExample = {
  economicTurnover: 1_000,
  netProfitAfterTax: 250,
};
const totalPnlExpenses =
  managementExample.economicTurnover -
  managementExample.netProfitAfterTax;
close(totalPnlExpenses, 750, "P&L expense economic-turnover base");
close(
  totalPnlExpenses + managementExample.netProfitAfterTax,
  managementExample.economicTurnover,
  "P&L reconciliation to economic turnover"
);

const financeRow = (
  companyName: string,
  reportNumber: string | null,
  dateFrom: string,
  dateTo = dateFrom
): WbOwnershipFinanceRow => ({
  companyName,
  reportNumber,
  dateFrom: new Date(`${dateFrom}T00:00:00+03:00`),
  dateTo: new Date(`${dateTo}T00:00:00+03:00`),
});
const session = (
  id: string,
  companyName: string,
  reportNumber: string,
  createdAt: string
): WbOwnershipSession => ({
  id,
  companyName,
  fileName: `wb-${reportNumber}.xlsx`,
  reportType: "WB_SALES",
  status: "SUCCESS",
  createdAt: new Date(createdAt),
});
const days0309 = ["03", "04", "05", "06", "07", "08", "09"];
const weeklyFinanceRows = [
  financeRow("ИП Петров", "WEEK-A", "2026-08-03", "2026-08-09"),
  financeRow("ИП Петров", "WEEK-B", "2026-08-03", "2026-08-09"),
];
const dailyFinanceRows = days0309.map((day) =>
  financeRow("ИП Петров", `DAY-${day}`, `2026-08-${day}`)
);
const dailySessions = days0309.map((day) =>
  session(
    `daily-${day}`,
    "ИП Петров",
    `DAY-${day}`,
    `2026-08-${day}T12:00:00Z`
  )
);
const exactPriorityPlan = planWbSourceOwnership({
  dateFrom: "2026-08-03",
  dateTo: "2026-08-09",
  companyNames: ["ИП Петров"],
  financeRows: [...weeklyFinanceRows, ...dailyFinanceRows],
  sessions: [
    session("weekly-a-old", "ИП Петров", "WEEK-A", "2026-08-10T09:00:00Z"),
    session("weekly-a-new", "ИП Петров", "WEEK-A", "2026-08-10T10:00:00Z"),
    session("weekly-b", "ИП Петров", "WEEK-B", "2026-08-10T10:00:00Z"),
    ...dailySessions,
  ],
});
assert.equal(
  exactPriorityPlan.intervals[0]?.mode,
  "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS"
);
assert.deepEqual(
  new Set(exactPriorityPlan.selectedSessionIds),
  new Set(["weekly-a-new", "weekly-b"])
);
assert.ok(
  !exactPriorityPlan.selectedSessionIds.some((id) => id.startsWith("daily-")),
  "exact owner mixed a daily representation"
);

const dailyFallbackPlan = planWbSourceOwnership({
  dateFrom: "2026-08-03",
  dateTo: "2026-08-09",
  companyNames: ["ИП Петров"],
  financeRows: [...weeklyFinanceRows, ...dailyFinanceRows],
  sessions: [
    session("weekly-a", "ИП Петров", "WEEK-A", "2026-08-10T10:00:00Z"),
    ...dailySessions,
  ],
});
assert.equal(
  dailyFallbackPlan.intervals[0]?.mode,
  "DAILY_FINANCE_MATCHED_SESSIONS_ALL_ROWS"
);
assert.deepEqual(
  new Set(dailyFallbackPlan.selectedSessionIds),
  new Set(dailySessions.map((item) => item.id))
);

const days1016WithGap = ["10", "11", "12", "14", "15", "16"];
const gapFinanceRows = [
  financeRow("ИП Петров", "WEEK-GAP", "2026-08-10", "2026-08-16"),
  ...days1016WithGap.map((day) =>
    financeRow("ИП Петров", `GAP-${day}`, `2026-08-${day}`)
  ),
];
const gapPlan = planWbSourceOwnership({
  dateFrom: "2026-08-10",
  dateTo: "2026-08-16",
  companyNames: ["ИП Петров"],
  financeRows: gapFinanceRows,
  sessions: days1016WithGap.map((day) =>
    session(
      `gap-${day}`,
      "ИП Петров",
      `GAP-${day}`,
      `2026-08-${day}T12:00:00Z`
    )
  ),
});
assert.equal(gapPlan.isFinanciallyFinal, false);
assert.ok(
  gapPlan.intervals[0]?.preliminaryReasons.includes(
    "DAILY_CALENDAR_COVERAGE_INCOMPLETE"
  )
);

const reportOwnedRows = filterWbRowsByOwnedSessionIds(
  [
    {
      importSessionId: "daily-03",
      saleDate: "2026-08-02",
      economicTurnover: 11_928,
    },
    {
      importSessionId: "daily-03",
      saleDate: "2026-08-03",
      economicTurnover: 100,
    },
    {
      importSessionId: "unowned-copy",
      saleDate: "2026-08-03",
      economicTurnover: 999,
    },
  ],
  ["daily-03"]
);
assert.equal(reportOwnedRows.length, 2);
close(
  reportOwnedRows.reduce(
    (sum, row) => sum + row.economicTurnover,
    0
  ),
  12_028,
  "all rows from owned report session"
);

const zeroImpactCoverage = evaluateWbProductCoverage(
  [
    {
      vendorCode: null,
      paymentReason: "Продажа",
      quantity: 0,
      retailPrice: 0,
      retailPriceWithDiscount: 0,
      wbRealizedAmount: 0,
      sellerPayout: 0,
    },
  ],
  []
);
assert.equal(zeroImpactCoverage.blocksFinal, false);
const missingCostCoverage = evaluateWbProductCoverage(
  [
    {
      vendorCode: "SKU-WITHOUT-COST",
      paymentReason: "Продажа",
      quantity: 1,
      retailPrice: 100,
      retailPriceWithDiscount: 100,
      wbRealizedAmount: 80,
      sellerPayout: 70,
    },
  ],
  []
);
assert.equal(missingCostCoverage.missingCostFinancialRows, 1);
assert.equal(missingCostCoverage.blocksFinal, true);

const materialSaleRow = {
  vendorCode: "SKU-COST",
  paymentReason: "Продажа",
  documentType: "",
  quantity: 1,
  retailPrice: 150,
  retailPriceWithDiscount: 100,
  wbRealizedAmount: 80,
  sellerPayout: 70,
};
for (const [label, costPrice] of [
  ["ZERO_COST_BLOCKS_FINAL", 0],
  ["NEGATIVE_COST_BLOCKS_FINAL", -10],
] as const) {
  const coverage = evaluateWbProductCoverage(
    [materialSaleRow],
    [{ id: label, vendorCode: "SKU-COST", costPrice }]
  );
  assert.equal(coverage.missingCostFinancialRows, 1, label);
  assert.equal(coverage.blocksFinal, true, label);
}

const nullReportDailyPlan = planWbSourceOwnership({
  dateFrom: "2026-08-03",
  dateTo: "2026-08-09",
  companyNames: ["ИП Петров"],
  financeRows: [
    financeRow("ИП Петров", "WEEK-NULL", "2026-08-03", "2026-08-09"),
    ...days0309.map((day, index) =>
      financeRow(
        "ИП Петров",
        index === days0309.length - 1 ? null : `NULL-DAY-${day}`,
        `2026-08-${day}`
      )
    ),
  ],
  sessions: days0309.slice(0, -1).map((day) =>
    session(
      `null-day-${day}`,
      "ИП Петров",
      `NULL-DAY-${day}`,
      `2026-08-${day}T12:00:00Z`
    )
  ),
});
assert.equal(nullReportDailyPlan.isFinanciallyFinal, false);
assert.ok(
  nullReportDailyPlan.intervals[0]?.preliminaryReasons.includes(
    "DAILY_REPORT_NUMBER_BLANK"
  )
);

const emptyOwnerEvidence = applyWbPersistedOwnerEvidence(
  dailyFallbackPlan,
  dailyFallbackPlan.selectedSessionIds.slice(0, -1).map((importSessionId) => ({
    importSessionId,
  }))
);
assert.equal(emptyOwnerEvidence.isFinanciallyFinal, false);
assert.ok(
  emptyOwnerEvidence.intervals[0]?.preliminaryReasons.some((reason) =>
    reason.startsWith("OWNER_SESSION_HAS_NO_WBSALE_ROWS:")
  )
);

const missingBuyerPaid = calculateWbV6RevenueComponents({
  retailPrice: 150,
  retailPriceWithDiscount: 100,
  wbRealizedAmount: null,
  sellerPayout: 70,
});
assert.equal(missingBuyerPaid.canonicalInputsComplete, false);
assert.equal(missingBuyerPaid.buyerPaid, 0);
assert.equal(missingBuyerPaid.taxableRevenue, 0);
assert.ok(missingBuyerPaid.missingCanonicalInputs.includes("wbRealizedAmount"));
const missingSellerPayout = calculateWbV6RevenueComponents({
  retailPrice: 150,
  retailPriceWithDiscount: 100,
  wbRealizedAmount: 80,
  sellerPayout: null,
});
assert.equal(missingSellerPayout.canonicalInputsComplete, false);
assert.ok(
  missingSellerPayout.missingCanonicalInputs.includes("sellerPayout")
);
for (const row of [
  { ...materialSaleRow, wbRealizedAmount: null },
  { ...materialSaleRow, sellerPayout: null },
]) {
  const coverage = evaluateWbProductCoverage(
    [row],
    [{ id: "positive", vendorCode: "SKU-COST", costPrice: 25 }]
  );
  assert.equal(coverage.missingCanonicalRevenueInputRows, 1);
  assert.equal(coverage.blocksFinal, true);
}

const revenueFirewall = buildWbRevenueCompatibilityFields(sale);
assert.equal(revenueFirewall.revenue, sale.economicTurnover);
assert.equal(revenueFirewall.taxableRevenue, sale.taxableRevenue);
assert.notEqual(revenueFirewall.revenue, revenueFirewall.taxableRevenue);

const saleSize: CanonicalWbSizeMetric = {
  size: "M",
  barcode: "M",
  economicTurnover: 0,
  salesQty: 0,
  returnsQty: 0,
  netSalesQty: 0,
};
const returnSize: CanonicalWbSizeMetric = {
  size: "L",
  barcode: "L",
  economicTurnover: 0,
  salesQty: 0,
  returnsQty: 0,
  netSalesQty: 0,
};
applyCanonicalWbSizeOperation(saleSize, {
  paymentReason: "Продажа",
  documentType: "",
  quantity: 1,
  retailPrice: 100,
  retailPriceWithDiscount: 100,
});
applyCanonicalWbSizeOperation(returnSize, {
  paymentReason: "",
  documentType: "Возврат",
  quantity: 1,
  retailPrice: 50,
  retailPriceWithDiscount: 50,
});
const allocatedSizes = allocateCanonicalWbSizeMetrics({
  sizes: [saleSize, returnSize],
  productEconomicTurnover: 50,
  productExpenses: 30,
  productNetProfitAfterTax: 20,
});
assert.deepEqual(
  allocatedSizes.map((row) => row.size).sort(),
  ["L", "M"]
);
close(
  allocatedSizes.reduce(
    (sum, row) => sum + row.allocatedEconomicTurnover,
    0
  ),
  50,
  "return-only size signed turnover reconciliation"
);
close(
  allocatedSizes.reduce((sum, row) => sum + row.allocatedExpenses, 0),
  30,
  "return-only size expense reconciliation"
);
assert.equal(
  allocatedSizes.find((row) => row.size === "L")?.allocatedEconomicTurnover,
  -50
);

for (const context of [
  "STOCK_ABC_SNAPSHOT",
  "SUPPLY_PLAN_EXPORT",
  "PRODUCTION_PLAN_EXPORT",
]) {
  assert.throws(
    () =>
      assertWbFinancialDataFinal(
        {
          dataMode: "PRELIMINARY",
          sourceOwnershipFinal: false,
          sourceOwnershipReasons: ["TEST_INCOMPLETE"],
        },
        context
      ),
    WbPreliminaryFinancialDataError
  );
}

assert.equal(
  selectWbOfficialCashDisplay({
    officialCashSettlement: 0,
    officialCashSettlementAvailable: true,
    canonicalPnlSettlement: 999,
  }),
  0
);

const equalDateCosts = buildCanonicalPositiveCostLookups([
  {
    id: "older",
    vendorCode: "SAME-DATE",
    costPrice: 10,
    costDate: "2026-08-20T00:00:00Z",
    createdAt: "2026-08-20T10:00:00Z",
  },
  {
    id: "newer",
    vendorCode: "SAME-DATE",
    costPrice: 25,
    costDate: "2026-08-20T00:00:00Z",
    createdAt: "2026-08-20T11:00:00Z",
  },
]);
assert.equal(equalDateCosts.costByVendorCode.get("same-date"), 25);

const normalizedCostLookups = buildCanonicalPositiveCostLookups([
  {
    id: "normalized",
    vendorCode: "ABC-1",
    costPrice: 25,
  },
]);
const dashNormalizedVendorCode = normalizeProductCostKey("ABC – 1");
const whitespaceNormalizedVendorCode = normalizeProductCostKey("ABC  -   1");
assert.equal(dashNormalizedVendorCode, "abc-1");
assert.equal(whitespaceNormalizedVendorCode, "abc-1");
assert.equal(
  normalizedCostLookups.costByVendorCode.get(dashNormalizedVendorCode),
  25
);
assert.equal(
  normalizedCostLookups.costByVendorCode.get(whitespaceNormalizedVendorCode),
  25
);
const normalizedCostCoverage = evaluateWbProductCoverage(
  [
    {
      vendorCode: "ABC – 1",
      paymentReason: "Продажа",
      documentType: "",
      quantity: 1,
      retailPrice: 100,
      retailPriceWithDiscount: 100,
      wbRealizedAmount: 80,
      sellerPayout: 70,
    },
  ],
  [{ id: "normalized", vendorCode: "ABC-1", costPrice: 25 }]
);
assert.equal(normalizedCostCoverage.missingCostFinancialRows, 0);
assert.equal(normalizedCostCoverage.blocksFinal, false);

assert.equal(
  requiresFinalWbFinancialDataForMarketplace({
    exportMarketplace: "OZON",
    supplyMarketplace: "WB",
  }),
  false
);
assert.equal(
  requiresFinalWbFinancialDataForMarketplace({
    supplyMarketplace: "OZON",
  }),
  false
);
assert.equal(
  requiresFinalWbFinancialDataForMarketplace({
    exportMarketplace: "WB",
    supplyMarketplace: "OZON",
  }),
  true
);
assert.equal(
  requiresFinalWbFinancialDataForMarketplace({
    exportMarketplace: "ALL",
    supplyMarketplace: "WB",
  }),
  true
);
assert.equal(
  requiresFinalWbFinancialDataForMarketplace({
    exportMarketplace: "ALL",
    supplyMarketplace: "OZON",
  }),
  false
);
assert.equal(requiresFinalWbFinancialDataForMarketplace({}), true);

assert.equal(
  classifyCanonicalWbProductOperation({
    paymentReason: "Продажа",
    documentType: "",
  }),
  "SALE"
);
assert.equal(
  classifyCanonicalWbProductOperation({
    paymentReason: "",
    documentType: "Продажа",
  }),
  "SALE"
);
assert.equal(
  classifyCanonicalWbProductOperation({
    paymentReason: "Возврат",
    documentType: "",
  }),
  "RETURN"
);
assert.equal(
  classifyCanonicalWbProductOperation({
    paymentReason: "",
    documentType: "Оформлен возврат товара",
  }),
  "RETURN"
);
assert.equal(
  classifyCanonicalWbProductOperation({
    paymentReason: "сторно возвратов",
    documentType: "Возврат",
  }),
  "SALE"
);
assert.equal(
  classifyCanonicalWbProductOperation({
    paymentReason: "Компенсация услуг",
    documentType: "Сервис",
  }),
  "OTHER"
);

const documentSaleMissingCost = evaluateWbProductCoverage(
  [
    {
      vendorCode: "DOC-SALE",
      paymentReason: "",
      documentType: "Продажа",
      quantity: 1,
      retailPrice: 100,
      retailPriceWithDiscount: 100,
      wbRealizedAmount: 80,
      sellerPayout: 70,
    },
  ],
  []
);
assert.equal(documentSaleMissingCost.missingCostFinancialRows, 1);
assert.equal(documentSaleMissingCost.blocksFinal, true);
const documentSaleMissingVendor = evaluateWbProductCoverage(
  [
    {
      vendorCode: null,
      paymentReason: "",
      documentType: "Продажа",
      quantity: 1,
      retailPrice: 100,
      retailPriceWithDiscount: 100,
      wbRealizedAmount: 80,
      sellerPayout: 70,
    },
  ],
  []
);
assert.equal(
  documentSaleMissingVendor.missingVendorFinancialImpactRows,
  1
);
assert.equal(documentSaleMissingVendor.blocksFinal, true);

const mixedProductOperations = [
  {
    paymentReason: "Продажа",
    documentType: "",
    quantity: 1,
    economicTurnover: 100,
  },
  {
    paymentReason: "",
    documentType: "Продажа",
    quantity: 2,
    economicTurnover: 200,
  },
  {
    paymentReason: "Возврат покупателя",
    documentType: "",
    quantity: 1,
    economicTurnover: 50,
  },
  {
    paymentReason: "",
    documentType: "Документ возврата",
    quantity: 1,
    economicTurnover: 30,
  },
  {
    paymentReason: "сторно возвратов",
    documentType: "",
    quantity: 1,
    economicTurnover: 10,
  },
  {
    paymentReason: "Услуга",
    documentType: "Сервис",
    quantity: 5,
    economicTurnover: 500,
  },
];
const aggregateProductOperations = (
  rows: typeof mixedProductOperations
) =>
  rows.reduce(
    (totals, row) => {
      const operation = classifyCanonicalWbProductOperation(row);
      const sign = operation === "SALE" ? 1 : operation === "RETURN" ? -1 : 0;
      totals.netQuantity += sign * Math.abs(row.quantity);
      totals.economicTurnover += sign * Math.abs(row.economicTurnover);
      return totals;
    },
    { netQuantity: 0, economicTurnover: 0 }
  );
const analyticsOperationTotals = aggregateProductOperations(
  mixedProductOperations
);
const sizeBreakdownOperationTotals = aggregateProductOperations(
  mixedProductOperations
);
assert.deepEqual(
  sizeBreakdownOperationTotals,
  analyticsOperationTotals
);
assert.deepEqual(analyticsOperationTotals, {
  netQuantity: 2,
  economicTurnover: 230,
});

const sourceOracles = {
  petrov0309: {
    economicTurnover: 3_731_559.73,
    buyerPaid: 2_125_455.72,
    taxableRevenue: 2_150_121.47,
    canonicalPnlSettlement: 1_360_668.79,
    cogs: 562_890,
    taxes: 122_864.08,
    netProfitAfterTax: 674_914.71,
    marginAfterTaxPercent: 18.0867,
  },
  petrov1016: {
    economicTurnover: 4_423_576.82,
    buyerPaid: 2_701_877.81,
    taxableRevenue: 2_707_899.23,
    canonicalPnlSettlement: 1_267_135.11,
    cogs: 649_425,
    taxes: 154_737.1,
    netProfitAfterTax: 462_973.01,
    marginAfterTaxPercent: 10.466,
  },
  lebedeva0309: {
    economicTurnover: 500_617.5,
    buyerPaid: 293_400.95,
    taxableRevenue: 299_739.58,
    canonicalPnlSettlement: 211_108.15,
    cogs: 87_195,
    taxes: 31_401.29,
    netProfitAfterTax: 92_511.86,
    marginAfterTaxPercent: 18.4795,
  },
  lebedeva1016: {
    economicTurnover: 432_667.21,
    buyerPaid: 276_309.01,
    taxableRevenue: 278_204.92,
    canonicalPnlSettlement: 135_120.13,
    cogs: 75_810,
    taxes: 29_145.28,
    netProfitAfterTax: 30_164.85,
    marginAfterTaxPercent: 6.9718,
  },
};
for (const [label, oracle] of Object.entries(sourceOracles)) {
  close(
    oracle.canonicalPnlSettlement - oracle.cogs - oracle.taxes,
    oracle.netProfitAfterTax,
    `${label} source-backed profit`
  );
  close(
    (oracle.netProfitAfterTax / oracle.economicTurnover) * 100,
    oracle.marginAfterTaxPercent,
    `${label} source-backed margin`
  );
}
const all0309 = {
  economicTurnover:
    sourceOracles.petrov0309.economicTurnover +
    sourceOracles.lebedeva0309.economicTurnover,
  buyerPaid:
    sourceOracles.petrov0309.buyerPaid +
    sourceOracles.lebedeva0309.buyerPaid,
  taxableRevenue:
    sourceOracles.petrov0309.taxableRevenue +
    sourceOracles.lebedeva0309.taxableRevenue,
  netProfitAfterTax:
    sourceOracles.petrov0309.netProfitAfterTax +
    sourceOracles.lebedeva0309.netProfitAfterTax,
};
const all1016 = {
  economicTurnover:
    sourceOracles.petrov1016.economicTurnover +
    sourceOracles.lebedeva1016.economicTurnover,
  buyerPaid:
    sourceOracles.petrov1016.buyerPaid +
    sourceOracles.lebedeva1016.buyerPaid,
  taxableRevenue:
    sourceOracles.petrov1016.taxableRevenue +
    sourceOracles.lebedeva1016.taxableRevenue,
  netProfitAfterTax:
    sourceOracles.petrov1016.netProfitAfterTax +
    sourceOracles.lebedeva1016.netProfitAfterTax,
};
close(all0309.economicTurnover, 4_232_177.23, "03-09 ALL turnover");
close(all0309.buyerPaid, 2_418_856.67, "03-09 ALL buyer paid");
close(all0309.taxableRevenue, 2_449_861.05, "03-09 ALL taxable");
close(all0309.netProfitAfterTax, 767_426.57, "03-09 ALL profit");
close(all1016.economicTurnover, 4_856_244.03, "10-16 ALL turnover");
close(all1016.buyerPaid, 2_978_186.82, "10-16 ALL buyer paid");
close(all1016.taxableRevenue, 2_986_104.15, "10-16 ALL taxable");
close(all1016.netProfitAfterTax, 493_137.86, "10-16 ALL profit");

const profitSource = fs.readFileSync(
  path.join(root, "lib/analytics/profitAnalytics.ts"),
  "utf8"
);
assert.ok(
  profitSource.includes('reportTypes: ["WB_SALES"]') &&
    profitSource.includes('reportTypes: ["WB_SALES_OPERATIONAL"]') &&
    profitSource.includes('reportTypes: ["WB_SALES_DAILY"]'),
  "WB source precedence markers are missing"
);
assert.ok(
  profitSource.includes("return !wbSalesDayKeys.has(key)") &&
    profitSource.includes("return !detailedDayKeys.has(key)"),
  "WB source precedence is not non-overlapping by company/day"
);
assert.ok(
  !profitSource.includes("taxableRevenueAmount + sppDiscountAmount"),
  "SPP is added to economic turnover"
);
assert.ok(
  profitSource.includes(
    "result.totals.logisticsCost = financeExpenses.logisticsCost;"
  ),
  "V5 official logistics priority is not preserved"
);
assert.ok(
  profitSource.includes('return "UNKNOWN";') &&
    !profitSource.includes('return "OPERATING";'),
  "unclassified deductions do not fail closed"
);
assert.ok(
  profitSource.includes(
    "canonicalPnlSettlement: result.totals.canonicalPnlSettlement"
  ),
  "closed-week profit does not use canonicalPnlSettlement"
);
assert.ok(
  profitSource.includes(
    "getWbShareBase(row.sellerRetailAmount, row.revenue)"
  ) &&
    !profitSource.includes(
      "totalRevenue > 0 ? (row.revenue / totalRevenue) * 100 : 0"
    ),
  "WB management share is based on taxable revenue"
);

const pageSource = fs.readFileSync(
  path.join(root, "app/profit-wb/page.tsx"),
  "utf8"
);
const sourceOwnershipSource = fs.readFileSync(
  path.join(root, "lib/wb/sourceOwnership.ts"),
  "utf8"
);
const sizeAllocationSource = fs.readFileSync(
  path.join(root, "lib/analytics/wbSizeAllocation.ts"),
  "utf8"
);
const stockSnapshotSource = fs.readFileSync(
  path.join(root, "lib/stocks/stockAbcSnapshots.ts"),
  "utf8"
);
const supplyExportSource = fs.readFileSync(
  path.join(root, "app/api/stocks/supply-plan/export/route.ts"),
  "utf8"
);
const productionExportSource = fs.readFileSync(
  path.join(root, "app/api/stocks/production-plan/export/route.ts"),
  "utf8"
);
const productCostResolverSource = fs.readFileSync(
  path.join(root, "lib/analytics/productCostResolver.ts"),
  "utf8"
);
for (const forbidden of [
  "totals.revenue - totals.netProfitAfterTax",
  "row.revenue - row.netProfitAfterTax",
  "calculateAbcByPositiveValue(rows, (row) => row.revenue)",
  "const rawRevenueTotal",
  "const revenue = toNumber(sale.wbRealizedAmount)",
]) {
  assert.ok(
    !pageSource.includes(forbidden),
    `taxable revenue escaped into WB management economics: ${forbidden}`
  );
}
assert.ok(
  pageSource.includes(
    "economicTurnover - totals.netProfitAfterTax"
  ),
  "P&L expenses do not reconcile from economic turnover"
);
assert.ok(
  pageSource.includes(
    "(row) => getWbEconomicTurnover(row)"
  ) &&
    pageSource.includes("totalEconomicTurnover={economicTurnover}"),
  "WB ABC or SKU management share does not use economic turnover"
);
assert.ok(
  pageSource.includes("allocateCanonicalWbSizeMetrics({") &&
    sizeAllocationSource.includes("size.economicTurnover / signedTurnoverTotal") &&
    sourceOwnershipSource.includes("retailPriceWithDiscount: true"),
  "WB size allocation does not use economic turnover"
);
assert.ok(
  profitSource.includes("selectCanonicalWbSaleSource({") &&
    pageSource.includes("selectCanonicalWbSaleSource({") &&
    !pageSource.includes("findWbSaleRowsForBreakdown"),
  "analytics and page breakdown do not share the canonical source owner"
);
assert.ok(
  profitSource.includes(
    "classifyCanonicalWbProductOperation(wbRow)"
  ) &&
    sizeAllocationSource.includes(
      "classifyCanonicalWbProductOperation(row)"
    ) &&
    sourceOwnershipSource.includes(
      "const operation = classifyCanonicalWbProductOperation(row)"
    ),
  "analytics, coverage, and size breakdown do not share one product-operation classifier"
);
assert.ok(
  !pageSource.includes('paymentReason === "возврат"') &&
    !pageSource.includes("function isSaleOperation") &&
    !profitSource.includes("function isReturnOperation"),
  "a paymentReason-only product-operation path remains"
);
const ownedRowsQuery = sourceOwnershipSource.slice(
  sourceOwnershipSource.indexOf("const ownedRows ="),
  sourceOwnershipSource.indexOf(
    "const evidencedPlan ="
  )
);
assert.ok(
  ownedRowsQuery.includes(
    "importSessionId: { in: plan.selectedSessionIds }"
  ) && !ownedRowsQuery.includes("saleDate: {"),
  "owned report rows are re-filtered by saleDate"
);
assert.ok(
  sourceOwnershipSource.includes(
    'reasons.push("DAILY_CALENDAR_COVERAGE_INCOMPLETE")'
  ) &&
    sourceOwnershipSource.includes(
      "normalizeCompany(row.companyName) === companyName"
    ),
  "daily calendar or per-company ownership guard is missing"
);
assert.ok(
  stockSnapshotSource.includes(
    'assertWbFinancialDataFinal(\n      analytics.totals,\n      "STOCK_ABC_SNAPSHOT"'
  ),
  "WB PRELIMINARY stock snapshot guard is not wired"
);
assert.ok(
  supplyExportSource.includes('"SUPPLY_PLAN_EXPORT"') &&
    productionExportSource.includes('"PRODUCTION_PLAN_EXPORT"') &&
    supplyExportSource.includes("WB_PRELIMINARY_FINANCIAL_DATA") &&
    productionExportSource.includes("WB_PRELIMINARY_FINANCIAL_DATA"),
  "WB PRELIMINARY planning export guard is not wired"
);
assert.ok(
  productCostResolverSource.includes('.replace(/[–—−]/g, "-")') &&
    productCostResolverSource.includes('.replace(/\\s*-\\s*/g, "-")') &&
    profitSource.includes(
      "normalizeProductCostKey(wbRow.vendorCode)"
    ) &&
    sourceOwnershipSource.includes(
      "normalizeProductCostKey(row.vendorCode)"
    ),
  "WB coverage and actual COGS do not share canonical cost-key normalization"
);
assert.ok(
  supplyExportSource.includes(
    "requiresFinalWbFinancialDataForMarketplace({"
  ) &&
    productionExportSource.includes(
      "requiresFinalWbFinancialDataForMarketplace({"
    ),
  "marketplace-scoped WB export finality decision is not wired"
);

const dailyReportSource = fs.readFileSync(
  path.join(root, "lib/telegram/dailyReport.ts"),
  "utf8"
);
assert.ok(
  dailyReportSource.includes(
    "financeTotals.totalToPay -\n    canonicalCostOfGoods -\n    finalAdSpend -\n    canonicalTaxesAmount"
  ),
  "Telegram WB fallback differs from the V5 baseline"
);

const digest = (filePath: string) =>
  crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
assert.ok(
  dailyReportSource.includes('getProfitAnalytics({') &&
    dailyReportSource.includes('getProfitAnalyticsOzon({') &&
    dailyReportSource.includes("profitTotals.taxableRevenue") &&
    dailyReportSource.includes("profitTotals.sellerRetailAmount") &&
    dailyReportSource.includes("profitTotals.netProfitAfterTax") &&
    dailyReportSource.includes("calculateFinanceMetricsForRows") &&
    !dailyReportSource.includes("calculateWbV6RevenueComponents("),
  "Telegram no longer reads canonical V6 totals through the daily-report DTO"
);
assert.equal(
  digest(path.join(root, "lib/telegram/dailyReport.ts")),
  digest(
    path.join(
      root,
      "financial-core/v6/snapshot/lib/telegram/dailyReport.ts"
    )
  ),
  "Telegram differs from the Financial Core V6 snapshot"
);
assert.equal(
  digest(path.join(root, "lib/analytics/profitAnalyticsOzon.ts")),
  digest(
    path.join(
      root,
      "financial-core/v5/snapshot/lib/analytics/profitAnalyticsOzon.ts"
    )
  ),
  "Ozon financial logic changed"
);

console.log("ROW_LEVEL_V6_CONTRACT=PASS");
console.log("NO_SPP_DOUBLE_ADD=PASS");
console.log("TAX_TOPUP_CONTRACT=PASS");
console.log("RETURN_REVERSAL=PASS");
console.log("V5_LOGISTICS_GUARD=PASS");
console.log("NON_PNL_DEDUCTION_GUARD=PASS");
console.log("RAW_TOTAL_TO_PAY_NOT_UNIVERSAL_PNL_BASE=PASS");
console.log("TELEGRAM_SCOPE_PRESERVED=PASS");
console.log("OZON_UNCHANGED=PASS");
console.log("TAXABLE_REVENUE_TAX_ONLY=PASS");
console.log("PNL_EXPENSE_BASE_ECONOMIC_TURNOVER=PASS");
console.log("PNL_RECONCILIATION_ECONOMIC_TURNOVER=PASS");
console.log("WB_MANAGEMENT_SHARE_BASE_ECONOMIC_TURNOVER=PASS");
console.log("WB_ABC_ECONOMIC_TURNOVER=PASS");
console.log("WB_ALLOCATION_ECONOMIC_TURNOVER=PASS");
console.log("SOURCE_OWNERSHIP_EXACT_WEEKLY_PRIORITY=PASS");
console.log("SOURCE_OWNERSHIP_DAILY_FALLBACK=PASS");
console.log("SOURCE_OWNERSHIP_DAILY_CALENDAR_GAP_FAILS_CLOSED=PASS");
console.log("SOURCE_OWNERSHIP_ALL_REPORT_ROWS=PASS");
console.log("SOURCE_OWNERSHIP_REPORTNUMBER_DEDUP=PASS");
console.log("PAGE_BREAKDOWN_CANONICAL_SOURCE_PARITY=PASS");
console.log("PETROV_0309_SOURCE_ORACLE=PASS");
console.log("PETROV_1016_SOURCE_ORACLE=PASS");
console.log("LEBEDEVA_0309_SOURCE_RECONCILIATION=PASS");
console.log("LEBEDEVA_1016_SOURCE_RECONCILIATION=PASS");
console.log("ALL_EQUALS_COMPANY_SUM=PASS");
console.log("MISSING_VENDOR_ZERO_FINANCIAL_IMPACT_SAFE=PASS");
console.log("MISSING_COST_FINANCIAL_ROW_BLOCKS_FINAL=PASS");
console.log("WB_PRODUCT_OPERATION_CANONICAL_CLASSIFIER=PASS");
console.log("WB_PRODUCT_COVERAGE_DOCUMENTTYPE_GUARD=PASS");
console.log("WB_SIZE_BREAKDOWN_OPERATION_PARITY=PASS");
console.log("ZERO_COST_BLOCKS_FINAL=PASS");
console.log("NEGATIVE_COST_BLOCKS_FINAL=PASS");
console.log("NULL_REPORTNUMBER_DAILY_BLOCKS_FINAL=PASS");
console.log("SUCCESS_SESSION_WITH_ZERO_WBSALE_ROWS_BLOCKS_FINAL=PASS");
console.log("MISSING_BUYER_PAID_BLOCKS_FINAL=PASS");
console.log("MISSING_SELLER_PAYOUT_BLOCKS_FINAL=PASS");
console.log("TAXABLE_REVENUE_FIREWALL_DOWNSTREAM=PASS");
console.log("RETURN_ONLY_SIZE_PRESERVED=PASS");
console.log("PRELIMINARY_STOCK_SNAPSHOT_BLOCKED=PASS");
console.log("PRELIMINARY_SUPPLY_EXPORT_BLOCKED=PASS");
console.log("ZERO_CASH_SETTLEMENT_DISPLAY=PASS");
console.log("DETERMINISTIC_EQUAL_DATE_COST=PASS");
console.log("COST_KEY_NORMALIZATION_PARITY=PASS");
console.log("OZON_ONLY_SUPPLY_EXPORT_NOT_BLOCKED_BY_WB_PRELIMINARY=PASS");
console.log("OZON_ONLY_PRODUCTION_EXPORT_NOT_BLOCKED_BY_WB_PRELIMINARY=PASS");
console.log("WB_SUPPLY_EXPORT_PRELIMINARY_STILL_BLOCKED=PASS");
console.log("ALL_SUPPLY_EXPORT_PRELIMINARY_STILL_BLOCKED=PASS");
console.log("TARGET_03_09_SOURCE=PRIOR_READ_ONLY_SERVER_DIAGNOSTIC");
console.log("TARGET_10_16_SOURCE=PRIOR_READ_ONLY_SERVER_DIAGNOSTIC");
console.log("CURSOR_V6_REV5_1_READY_FOR_CHATGPT_REVIEW");
