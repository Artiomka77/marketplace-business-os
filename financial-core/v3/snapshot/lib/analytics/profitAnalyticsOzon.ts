import { prisma } from "@/lib/prisma";

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;

  if (typeof value === "object" && "toNumber" in value) {
    return (value as { toNumber: () => number }).toNumber();
  }

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function startOfDay(value: string) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function nextDayStart(value: string) {
  const date = startOfDay(value);
  date.setDate(date.getDate() + 1);
  return date;
}

function clampRate(value: unknown, allowedRates: number[], fallback: number) {
  const rate = toNumber(value);
  return allowedRates.includes(rate) ? rate : fallback;
}

function calculateVatTax(revenue: number, vatRate: number) {
  if (vatRate <= 0) return 0;
  return revenue * (vatRate / (100 + vatRate));
}

function isOzonFinanceClickAdOperation(operationType: unknown) {
  const value = normalizeText(operationType);

  return (
    value.includes("оплата за клик") ||
    value.includes("cpc") ||
    value.includes("click")
  );
}

function isOzonFinanceOrderAdOperation(operationType: unknown) {
  const value = normalizeText(operationType);

  return (
    value.includes("оплата за заказ") ||
    value.includes("продвижение с оплатой за заказ") ||
    value.includes("реклама оплата за заказ") ||
    value.includes("cpo") ||
    (value.includes("заказ") &&
      (value.includes("продвиж") ||
        value.includes("реклам") ||
        value.includes("оплат")))
  );
}

function isOzonFinanceAdOperation(operationType: unknown) {
  const value = normalizeText(operationType);

  return (
    isOzonFinanceClickAdOperation(operationType) ||
    isOzonFinanceOrderAdOperation(operationType) ||
    (value.includes("реклам") && !value.includes("сторно"))
  );
}

function getOzonFinanceAdAmount(row: OzonFinanceRecord) {
  const totalAmount = Math.abs(toNumber(row.totalAmount));
  const salesAmount = Math.abs(toNumber(row.salesAmount));

  return totalAmount > 0 ? totalAmount : salesAmount;
}

function isOzonNonOperatingFinanceOperation(operationType: unknown) {
  const value = normalizeText(operationType);

  return (
    value.includes("займ") ||
    value.includes("факторинг") ||
    value.includes("кредит") ||
    value.includes("финансирован") ||
    value.includes("loan") ||
    value.includes("factor")
  );
}

function hasOzonFinanceClickAdRows(rows: OzonFinanceRecord[]) {
  return rows.some((row) => isOzonFinanceClickAdOperation(row.operationType));
}

function calculatePreviousPeriod(
  dateFrom?: string | null,
  dateTo?: string | null,
) {
  if (!dateFrom || !dateTo) return null;

  const from = startOfDay(dateFrom);
  const to = startOfDay(dateTo);
  const diffMs = to.getTime() - from.getTime();
  const days = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)) + 1);

  const previousTo = new Date(from);
  previousTo.setDate(previousTo.getDate() - 1);

  const previousFrom = new Date(previousTo);
  previousFrom.setDate(previousFrom.getDate() - (days - 1));

  return {
    dateFrom: previousFrom,
    dateTo: previousTo,
  };
}

function createComparison(current: number, previous: number) {
  const diff = current - previous;

  return {
    current,
    previous,
    diff,
    diffPercent: previous !== 0 ? (diff / previous) * 100 : 0,
  };
}

function createDateWhere(dateFrom?: string | null, dateTo?: string | null) {
  return dateFrom || dateTo
    ? {
        ...(dateFrom ? { gte: startOfDay(dateFrom) } : {}),
        ...(dateTo ? { lt: nextDayStart(dateTo) } : {}),
      }
    : undefined;
}

function createDateWhereFromDates(
  dateFrom?: Date | null,
  dateTo?: Date | null,
) {
  if (!dateFrom || !dateTo) return undefined;

  const toExclusive = new Date(dateTo);
  toExclusive.setDate(toExclusive.getDate() + 1);

  return {
    gte: dateFrom,
    lt: toExclusive,
  };
}

function formatDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function dateKeyToDayNumber(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function expectedDateKeys(dateFrom: string, dateTo: string) {
  const result: string[] = [];
  const current = startOfDay(dateFrom);
  const end = startOfDay(dateTo);

  while (current.getTime() <= end.getTime()) {
    result.push(formatDateKey(current));
    current.setDate(current.getDate() + 1);
  }

  return result;
}

function findMissingDateKeys(expected: string[], actual: Set<string>) {
  return expected.filter((dateKey) => !actual.has(dateKey));
}

type PeriodSummaryInterval = {
  dateFrom: Date | string;
  dateTo: Date | string;
};

function getPeriodSummaryDateKey(value: Date | string) {
  return value instanceof Date
    ? formatDateKey(value)
    : String(value).slice(0, 10);
}

function selectExactPeriodSummaryCoverage<T extends PeriodSummaryInterval>(
  rows: T[],
  dateFrom: string,
  dateTo: string,
) {
  const selectedStart = dateKeyToDayNumber(dateFrom);
  const selectedEnd = dateKeyToDayNumber(dateTo);

  const normalized = rows
    .map((row) => {
      const startKey = getPeriodSummaryDateKey(row.dateFrom);
      const endKey = getPeriodSummaryDateKey(row.dateTo);
      const start = dateKeyToDayNumber(startKey);
      const end = dateKeyToDayNumber(endKey);

      return {
        row,
        start: Math.min(start, end),
        end: Math.max(start, end),
      };
    })
    .filter(
      (item) =>
        item.start >= selectedStart &&
        item.end <= selectedEnd,
    );

  const rowsByStart = new Map<number, typeof normalized>();

  for (const item of normalized) {
    const current = rowsByStart.get(item.start) ?? [];
    current.push(item);
    rowsByStart.set(item.start, current);
  }

  for (const items of rowsByStart.values()) {
    items.sort((left, right) => right.end - left.end);
  }

  const bestByNextDay = new Map<number, T[]>();
  bestByNextDay.set(selectedStart, []);

  for (
    let dayNumber = selectedStart;
    dayNumber <= selectedEnd;
    dayNumber += 1
  ) {
    const currentPath = bestByNextDay.get(dayNumber);

    if (!currentPath) {
      continue;
    }

    for (const item of rowsByStart.get(dayNumber) ?? []) {
      const nextDay = item.end + 1;
      const candidatePath = [...currentPath, item.row];
      const existingPath = bestByNextDay.get(nextDay);

      if (!existingPath || candidatePath.length < existingPath.length) {
        bestByNextDay.set(nextDay, candidatePath);
      }
    }
  }

  return bestByNextDay.get(selectedEnd + 1) ?? null;
}

function getMissingPeriodSummaryDays<T extends PeriodSummaryInterval>(
  rows: T[],
  dateFrom: string,
  dateTo: string,
) {
  const expected = expectedDateKeys(dateFrom, dateTo);
  const selectedStart = dateKeyToDayNumber(dateFrom);
  const selectedEnd = dateKeyToDayNumber(dateTo);
  const covered = new Set<string>();

  for (const row of rows) {
    const startKey = getPeriodSummaryDateKey(row.dateFrom);
    const endKey = getPeriodSummaryDateKey(row.dateTo);
    const start = dateKeyToDayNumber(startKey);
    const end = dateKeyToDayNumber(endKey);

    if (start < selectedStart || end > selectedEnd) {
      continue;
    }

    for (let dayNumber = start; dayNumber <= end; dayNumber += 1) {
      const date = new Date(dayNumber * 86_400_000);
      covered.add(formatDateKey(date));
    }
  }

  return findMissingDateKeys(expected, covered);
}

function signedOzonExpenseAmount(value: unknown) {
  // Ozon charges usually come with a negative sign. Refunds/cancellations are positive.
  // Management expense must be signed: charge => positive expense, reversal => negative expense.
  return -toNumber(value);
}

export type OzonProfitAnalyticsRow = {
  nmId: string;
  vendorCode: string;
  subject: string;

  salesQty: number;
  returnsQty: number;
  netSalesQty: number;

  revenue: number;
  revenueSharePercent: number;

  sellerPayout: number;

  wbCommission: number;

  logisticsCost: number;
  deliveryCost: number;
  fboCost: number;
  storageCost: number;
  acceptanceCost: number;

  penaltiesAmount: number;
  deductions: number;

  paymentServiceCost: number;

  adsCost: number;
  drrPercent: number;

  costPrice: number;
  totalCost: number;

  marginProfit: number;
  marginProfitPercent: number;

  taxesAmount: number;

  netProfitAfterTax: number;
  marginAfterTaxPercent: number;

  abcByProfit: "A" | "B" | "C";
};

export type OzonProfitTotals = {
  salesQty: number;
  returnsQty: number;
  netSalesQty: number;

  revenue: number;
  realizedAmount: number;
  returnedAmount: number;
  taxableRevenue: number;
  partnerProgramsAmount: number;
  discountPointsAmount: number;
  economicTurnover: number;
  expenseShareBase: number;
  taxRevenueSource: string;
  taxRevenueCoverageComplete: boolean;
  taxRevenueMissingDays: string[];
  discountPointsSource: string;
  discountPointsCoverageComplete: boolean;
  discountPointsMissingDays: string[];

  taxCalculationMode:
    | "FINAL_TAXABLE_REVENUE"
    | "ESTIMATED_ECONOMIC_TURNOVER";
  taxCalculationBase: number;
  taxesEstimated: boolean;
  netProfitStatus: "FINAL" | "PRELIMINARY";

  sellerPayout: number;

  wbCommission: number;

  logisticsCost: number;
  deliveryCost: number;
  fboCost: number;
  storageCost: number;
  acceptanceCost: number;

  penaltiesAmount: number;
  deductions: number;

  paymentServiceCost: number;

  adsCost: number;
  clickAdsCost: number;
  orderAdsCost: number;
  otherAdsCost: number;
  drrPercent: number;
  undistributedAdsCost: number;

  totalCost: number;

  grossOzonExpenses: number;
  discountPointsCompensation: number;
  netOzonExpenses: number;
  partnerServicesCost: number;
  otherServicesCost: number;
  compensationAmount: number;
  excludedLoansFactoringAmount: number;

  marginProfit: number;
  marginProfitPercent: number;

  taxesAmount: number;

  netProfitAfterTax: number;
  marginAfterTaxPercent: number;

  usnRate: number;
  vatRate: number;
};

type OzonProfitAnalyticsComparison = {
  revenue: ReturnType<typeof createComparison>;
  economicTurnover: ReturnType<typeof createComparison>;
  discountPointsAmount: ReturnType<typeof createComparison>;
  clickAdsCost: ReturnType<typeof createComparison>;
  orderAdsCost: ReturnType<typeof createComparison>;
  sellerPayout: ReturnType<typeof createComparison>;
  totalCost: ReturnType<typeof createComparison>;
  wbCommission: ReturnType<typeof createComparison>;
  logisticsCost: ReturnType<typeof createComparison>;
  adsCost: ReturnType<typeof createComparison>;
  grossOzonExpenses: ReturnType<typeof createComparison>;
  netOzonExpenses: ReturnType<typeof createComparison>;
  taxesAmount: ReturnType<typeof createComparison>;
  marginProfit: ReturnType<typeof createComparison>;
  netProfitAfterTax: ReturnType<typeof createComparison>;
};

type OzonProfitAnalyticsResult = {
  rows: OzonProfitAnalyticsRow[];
  totals: OzonProfitTotals;
  previousRows: OzonProfitAnalyticsRow[];
  previousTotals: OzonProfitTotals;
  comparison: OzonProfitAnalyticsComparison;
};

const OZON_COMPANY_NAMES = ["ИП Петров", "ИП Лебедева"];

type CostRecord = {
  vendorCode: string;
  costPrice: unknown;
};

type OzonFinanceRecord = {
  accrualDate: Date | null;
  operationType: string | null;
  sku: string | null;
  vendorCode: string | null;
  quantity: number | null;
  salesAmount: unknown;
  ozonCommission: unknown;
  logisticsCost: unknown;
  reverseLogisticsCost: unknown;
  totalAmount: unknown;
};

type OzonAdsRecord = {
  reportDate: Date | null;
  sku: string | null;
  spend: unknown;
};

type OzonRealizationSummaryRecord = {
  realizedAmount: unknown;
  returnedAmount: unknown;
  taxableRevenue: unknown;
  partnerProgramsAmount: unknown;
  source?: string;
  coverageComplete?: boolean;
  missingDays?: string[];
  rows?: number;
};

type OzonDiscountPointsSummaryRecord = {
  pointsAccrued: unknown;
  pointsWrittenOff: unknown;
  totalPaidByPoints: unknown;
  source?: string;
  coverageComplete?: boolean;
  missingDays?: string[];
  rows?: number;
};

type OzonFinancialCategoryFactRecord = {
  category: string | null;
  amount: unknown;
  sourceOperationType?: string | null;
  sourceOperationCode?: string | null;
  sourceServiceName?: string | null;
};

type OzonProductRecord = {
  vendorCode: string | null;
  sku: string | null;
};

function buildCostByVendorCode(costs: CostRecord[]) {
  const costByVendorCode = new Map<string, number>();

  for (const cost of costs) {
    const vendorCode = normalizeText(cost.vendorCode);
    if (!vendorCode) continue;

    if (!costByVendorCode.has(vendorCode)) {
      costByVendorCode.set(vendorCode, toNumber(cost.costPrice));
    }
  }

  return costByVendorCode;
}

function buildOzonProductLookup(ozonProducts: OzonProductRecord[]) {
  const normalizedVendorCodeBySku = new Map<string, string>();
  const displayVendorCodeBySku = new Map<string, string>();

  for (const product of ozonProducts) {
    const sku = normalizeText(product.sku);
    const normalizedVendorCode = normalizeText(product.vendorCode);
    const displayVendorCode = cleanText(product.vendorCode);

    if (!sku || !normalizedVendorCode) continue;

    if (!normalizedVendorCodeBySku.has(sku)) {
      normalizedVendorCodeBySku.set(sku, normalizedVendorCode);
      displayVendorCodeBySku.set(
        sku,
        displayVendorCode || normalizedVendorCode,
      );
    }
  }

  return {
    normalizedVendorCodeBySku,
    displayVendorCodeBySku,
  };
}

function buildAdsCostByVendorCode(
  adsRows: OzonAdsRecord[],
  ozonProducts: OzonProductRecord[],
) {
  const { normalizedVendorCodeBySku } = buildOzonProductLookup(ozonProducts);

  const adsCostByVendorCode = new Map<string, number>();
  let undistributedAdsCost = 0;

  for (const ad of adsRows) {
    const sku = normalizeText(ad.sku);
    const spend = toNumber(ad.spend);

    if (!sku || spend === 0) continue;

    const vendorCode = normalizedVendorCodeBySku.get(sku) ?? sku;

    if (!vendorCode) {
      undistributedAdsCost += spend;
      continue;
    }

    adsCostByVendorCode.set(
      vendorCode,
      (adsCostByVendorCode.get(vendorCode) ?? 0) + spend,
    );
  }

  return {
    adsCostByVendorCode,
    undistributedAdsCost,
  };
}

function getOzonCategoryAmount(
  facts: OzonFinancialCategoryFactRecord[],
  category: string,
) {
  return facts.reduce(
    (sum, fact) =>
      sum + (fact.category === category ? toNumber(fact.amount) : 0),
    0,
  );
}


const OZON_FACTS_PARTIAL_GUARD_MIN_RATIO = 0.5;

function isOzonFactSuspiciouslyLowerThanPeriodTotal(
  factAmount: number,
  periodAmount: number,
) {
  const fact = Math.abs(factAmount);
  const period = Math.abs(periodAmount);

  if (period <= 0.005 || fact <= 0.005) return false;

  return fact < period * OZON_FACTS_PARTIAL_GUARD_MIN_RATIO;
}

function areOzonFinancialCategoryFactsLikelyPartial(
  totals: OzonProfitTotals,
  facts: OzonFinancialCategoryFactRecord[],
) {
  const commission = getOzonCategoryAmount(facts, "OZON_COMMISSION");
  const delivery = getOzonCategoryAmount(facts, "OZON_DELIVERY");
  const fbo = getOzonCategoryAmount(facts, "OZON_FBO");
  const advertising = getOzonCategoryAmount(facts, "OZON_ADVERTISING");

  const checks = [
    {
      hasFacts: hasOzonCategoryFact(facts, "OZON_COMMISSION"),
      factAmount: commission,
      periodAmount: totals.wbCommission,
    },
    {
      hasFacts:
        hasOzonCategoryFact(facts, "OZON_DELIVERY") ||
        hasOzonCategoryFact(facts, "OZON_FBO"),
      factAmount: delivery + fbo,
      periodAmount: totals.logisticsCost,
    },
    {
      hasFacts: hasOzonCategoryFact(facts, "OZON_ADVERTISING"),
      factAmount: advertising,
      periodAmount: totals.adsCost,
    },
  ];

  return checks.some(
    (check) =>
      check.hasFacts &&
      isOzonFactSuspiciouslyLowerThanPeriodTotal(
        check.factAmount,
        check.periodAmount,
      ),
  );
}

function hasOzonFinancialCategoryFacts(
  facts: OzonFinancialCategoryFactRecord[],
) {
  return facts.some((fact) => Math.abs(toNumber(fact.amount)) > 0.005);
}

function hasOzonCategoryFact(
  facts: OzonFinancialCategoryFactRecord[],
  category: string,
) {
  return facts.some(
    (fact) =>
      fact.category === category && Math.abs(toNumber(fact.amount)) > 0.005,
  );
}

function applyOzonFinancialCategoryFactsToTotals(
  totals: OzonProfitTotals,
  facts: OzonFinancialCategoryFactRecord[],
) {
  if (!hasOzonFinancialCategoryFacts(facts)) return false;

  // OzonFinancialCategoryFact может оказаться не просто частичным по категориям,
  // а частичным по датам: например, в таблицу попал только последний день периода.
  // В таком случае нельзя перезаписывать недельные суммы из OzonFinance дневными facts,
  // иначе комиссия, логистика, реклама и прибыль будут сильно искажены.
  if (areOzonFinancialCategoryFactsLikelyPartial(totals, facts)) return false;

  const hasCommissionFacts = hasOzonCategoryFact(facts, "OZON_COMMISSION");
  const hasDeliveryFacts = hasOzonCategoryFact(facts, "OZON_DELIVERY");
  const hasFboFacts = hasOzonCategoryFact(facts, "OZON_FBO");
  const hasAdvertisingFacts = hasOzonCategoryFact(facts, "OZON_ADVERTISING");
  const hasPartnerServicesFacts = hasOzonCategoryFact(
    facts,
    "OZON_PARTNER_SERVICES",
  );
  const hasOtherServicesFacts = hasOzonCategoryFact(
    facts,
    "OZON_OTHER_SERVICES",
  );
  const hasCompensationFacts = hasOzonCategoryFact(facts, "OZON_COMPENSATION");

  const commission = getOzonCategoryAmount(facts, "OZON_COMMISSION");
  const delivery = getOzonCategoryAmount(facts, "OZON_DELIVERY");
  const fbo = getOzonCategoryAmount(facts, "OZON_FBO");
  const advertising = getOzonCategoryAmount(facts, "OZON_ADVERTISING");
  const partnerServices = getOzonCategoryAmount(facts, "OZON_PARTNER_SERVICES");
  const otherServices = getOzonCategoryAmount(facts, "OZON_OTHER_SERVICES");
  const compensation = getOzonCategoryAmount(facts, "OZON_COMPENSATION");
  const excludedLoansFactoring =
    getOzonCategoryAmount(facts, "EXCLUDED_LOANS_FACTORING") +
    getOzonCategoryAmount(facts, "EXCLUDED_CREDIT") +
    getOzonCategoryAmount(facts, "EXCLUDED_TRANSFER");

  // Важно: OzonFinancialCategoryFact может быть загружен частично.
  // Например, в базе уже есть рекламные списания, но ещё нет комиссии/логистики.
  // Раньше наличие любых facts затирало комиссии/логистику нулями и завышало прибыль.
  // Поэтому каждую категорию перезаписываем только тогда, когда по ней есть fact.
  if (hasCommissionFacts) {
    totals.wbCommission = commission;
  }

  if (hasDeliveryFacts) {
    totals.deliveryCost = delivery;
  }

  if (hasFboFacts) {
    totals.fboCost = fbo;
  }

  if (hasDeliveryFacts || hasFboFacts) {
    totals.logisticsCost = totals.deliveryCost + totals.fboCost;
  }

  if (hasAdvertisingFacts) {
    totals.adsCost = advertising;
  }

  const financeClickAdsFromFacts = facts.reduce((sum, fact) => {
    const operationType = normalizeText(fact.sourceOperationType);
    const operationCode = normalizeText(fact.sourceOperationCode);

    if (
      fact.category === "OZON_ADVERTISING" &&
      (operationCode.includes("operationmarketplacecostperclick") ||
        operationType.includes("оплата за клик"))
    ) {
      return sum + toNumber(fact.amount);
    }

    return sum;
  }, 0);

  const financeOrderAdsFromFacts = facts.reduce((sum, fact) => {
    const operationType = normalizeText(fact.sourceOperationType);
    const operationCode = normalizeText(fact.sourceOperationCode);

    if (
      fact.category === "OZON_ADVERTISING" &&
      (operationCode.includes("operationpromotionwithcostperorder") ||
        operationType.includes("продвижение с оплатой за заказ"))
    ) {
      return sum + toNumber(fact.amount);
    }

    return sum;
  }, 0);

  const financeOtherAdsFromFacts = Math.max(
    0,
    advertising - financeClickAdsFromFacts - financeOrderAdsFromFacts,
  );

  const hasFinanceAdDetails =
    hasAdvertisingFacts &&
    advertising > 0 &&
    financeClickAdsFromFacts +
      financeOrderAdsFromFacts +
      financeOtherAdsFromFacts >
      0;

  if (hasFinanceAdDetails) {
    totals.clickAdsCost = financeClickAdsFromFacts;
    totals.orderAdsCost = financeOrderAdsFromFacts;
    totals.otherAdsCost = financeOtherAdsFromFacts;
  } else if (hasAdvertisingFacts) {
    totals.otherAdsCost = Math.max(
      0,
      advertising - totals.clickAdsCost - totals.orderAdsCost,
    );
  }

  if (hasPartnerServicesFacts) {
    totals.partnerServicesCost = partnerServices;
  }

  if (hasOtherServicesFacts) {
    totals.otherServicesCost = otherServices;
  }

  if (hasCompensationFacts) {
    totals.compensationAmount = compensation;
  }

  totals.excludedLoansFactoringAmount = excludedLoansFactoring;

  if (
    hasPartnerServicesFacts ||
    hasOtherServicesFacts ||
    hasCompensationFacts
  ) {
    totals.penaltiesAmount = 0;
    totals.deductions =
      totals.partnerServicesCost +
      totals.otherServicesCost -
      totals.compensationAmount;
  }

  return true;
}

function calculateOzonGrossExpenses(totals: OzonProfitTotals) {
  return (
    totals.wbCommission +
    totals.logisticsCost +
    totals.adsCost +
    totals.penaltiesAmount +
    totals.deductions
  );
}

function calculateOzonNetExpensesAfterDiscountPoints(totals: OzonProfitTotals) {
  return totals.grossOzonExpenses - totals.discountPointsCompensation;
}

function recalculateOzonRowsFromEconomicModel(
  rows: OzonProfitAnalyticsRow[],
  totals: OzonProfitTotals,
  usnRate: number,
  vatRate: number,
) {
  const positiveRevenueTotal = rows.reduce(
    (sum, row) => sum + Math.max(0, row.revenue),
    0,
  );

  const positiveQtyTotal = rows.reduce(
    (sum, row) => sum + Math.max(0, row.netSalesQty),
    0,
  );

  const currentMappedAds = rows.reduce((sum, row) => sum + row.adsCost, 0);
  const adsToAllocate = totals.adsCost - currentMappedAds;

  for (const row of rows) {
    const share =
      positiveRevenueTotal > 0
        ? Math.max(0, row.revenue) / positiveRevenueTotal
        : positiveQtyTotal > 0
          ? Math.max(0, row.netSalesQty) / positiveQtyTotal
          : rows.length > 0
            ? 1 / rows.length
            : 0;

    const allocatedDiscountPoints = totals.discountPointsAmount * share;
    const allocatedPartnerPrograms = totals.partnerProgramsAmount * share;
    const allocatedAds = adsToAllocate * share;

    row.adsCost += allocatedAds;

    const rowEconomicTurnover =
      row.revenue + allocatedDiscountPoints + allocatedPartnerPrograms;

    const rowGrossOzonExpenses =
      row.wbCommission +
      row.logisticsCost +
      row.adsCost +
      row.penaltiesAmount +
      row.deductions;

    const usnTax = row.revenue > 0 ? row.revenue * (usnRate / 100) : 0;
    const vatTax = row.revenue > 0 ? calculateVatTax(row.revenue, vatRate) : 0;

    row.taxesAmount = usnTax + vatTax;
    row.marginProfit =
      rowEconomicTurnover - row.totalCost - rowGrossOzonExpenses;
    row.netProfitAfterTax = row.marginProfit - row.taxesAmount;

    row.drrPercent =
      rowEconomicTurnover > 0 ? (row.adsCost / rowEconomicTurnover) * 100 : 0;
    row.marginProfitPercent =
      rowEconomicTurnover > 0
        ? (row.marginProfit / rowEconomicTurnover) * 100
        : 0;
    row.marginAfterTaxPercent =
      rowEconomicTurnover > 0
        ? (row.netProfitAfterTax / rowEconomicTurnover) * 100
        : 0;
  }
}

function applyOzonEconomicModel(
  result: { rows: OzonProfitAnalyticsRow[]; totals: OzonProfitTotals },
  realizationSummary: OzonRealizationSummaryRecord | null | undefined,
  discountPointsSummary: OzonDiscountPointsSummaryRecord | null | undefined,
  financialCategoryFacts: OzonFinancialCategoryFactRecord[] = [],
  usnRate: number,
  vatRate: number,
) {
  const oldTotalRevenue = result.totals.revenue;
  const hasOzonEconomicActivity = Math.abs(oldTotalRevenue) > 0.005;
  const realizationCoverageComplete = hasOzonEconomicActivity
    ? Boolean(realizationSummary) && realizationSummary?.coverageComplete !== false
    : true;
  const discountCoverageComplete = hasOzonEconomicActivity
    ? Boolean(discountPointsSummary) && discountPointsSummary?.coverageComplete !== false
    : true;

  const taxableRevenue = realizationCoverageComplete
    ? toNumber(realizationSummary?.taxableRevenue)
    : 0;
  const realizedAmount = realizationCoverageComplete
    ? toNumber(realizationSummary?.realizedAmount)
    : 0;
  const returnedAmount = realizationCoverageComplete
    ? toNumber(realizationSummary?.returnedAmount)
    : 0;
  const partnerProgramsAmount = realizationCoverageComplete
    ? toNumber(realizationSummary?.partnerProgramsAmount)
    : 0;
  const discountPointsAmount = discountCoverageComplete
    ? toNumber(discountPointsSummary?.totalPaidByPoints) ||
      toNumber(discountPointsSummary?.pointsWrittenOff) ||
      toNumber(discountPointsSummary?.pointsAccrued)
    : 0;

  result.totals.taxRevenueSource = realizationCoverageComplete
    ? realizationSummary?.source ?? "NONE"
    : realizationSummary?.source ?? "MISSING_OZON_ACCRUALS_REPORT";
  result.totals.taxRevenueCoverageComplete = realizationCoverageComplete;
  result.totals.taxRevenueMissingDays = realizationSummary?.missingDays ?? [];
  result.totals.discountPointsSource = discountCoverageComplete
    ? discountPointsSummary?.source ?? "NONE"
    : discountPointsSummary?.source ?? "MISSING_OZON_ACCRUALS_REPORT";
  result.totals.discountPointsCoverageComplete = discountCoverageComplete;
  result.totals.discountPointsMissingDays = discountPointsSummary?.missingDays ?? [];

  if (taxableRevenue > 0) {
    const ratio = oldTotalRevenue > 0 ? taxableRevenue / oldTotalRevenue : 0;

    for (const row of result.rows) {
      row.revenue = oldTotalRevenue > 0 ? row.revenue * ratio : 0;
    }

    result.totals.revenue = taxableRevenue;
    result.totals.taxableRevenue = taxableRevenue;
    result.totals.realizedAmount = realizedAmount;
    result.totals.returnedAmount = returnedAmount;
    result.totals.partnerProgramsAmount = partnerProgramsAmount;
  } else {
    // Налоговая выручка ещё не закрыта отчётом начислений.
    // Управленческая экономика продолжает считаться от экономического оборота.
    // Точный налог будет заменён после появления отчёта реализации.
    result.totals.taxableRevenue = 0;
  }

  result.totals.discountPointsAmount = discountPointsAmount;
  result.totals.discountPointsCompensation = discountPointsAmount;

  const economicTurnover =
    result.totals.taxableRevenue + discountPointsAmount + partnerProgramsAmount;

  result.totals.economicTurnover =
    economicTurnover > 0 ? economicTurnover : result.totals.revenue;
  result.totals.expenseShareBase =
    result.totals.economicTurnover > 0
      ? result.totals.economicTurnover
      : result.totals.revenue;

  result.totals.taxCalculationMode = realizationCoverageComplete
    ? "FINAL_TAXABLE_REVENUE"
    : "ESTIMATED_ECONOMIC_TURNOVER";
  result.totals.taxCalculationBase = realizationCoverageComplete
    ? result.totals.revenue
    : result.totals.economicTurnover;
  result.totals.taxesEstimated = !realizationCoverageComplete;
  result.totals.netProfitStatus = realizationCoverageComplete
    ? "FINAL"
    : "PRELIMINARY";

  result.totals.taxesAmount =
    result.totals.taxCalculationBase * (usnRate / 100) +
    calculateVatTax(result.totals.taxCalculationBase, vatRate);

  applyOzonFinancialCategoryFactsToTotals(
    result.totals,
    financialCategoryFacts,
  );

  result.totals.grossOzonExpenses = calculateOzonGrossExpenses(result.totals);
  result.totals.netOzonExpenses = calculateOzonNetExpensesAfterDiscountPoints(
    result.totals,
  );

  result.totals.marginProfit =
    result.totals.economicTurnover -
    result.totals.totalCost -
    result.totals.grossOzonExpenses;

  result.totals.netProfitAfterTax =
    result.totals.marginProfit - result.totals.taxesAmount;

  recalculateOzonRowsFromEconomicModel(
    result.rows,
    result.totals,
    usnRate,
    vatRate,
  );

  result.totals.marginProfitPercent =
    result.totals.expenseShareBase > 0
      ? (result.totals.marginProfit / result.totals.expenseShareBase) * 100
      : 0;

  result.totals.marginAfterTaxPercent =
    result.totals.expenseShareBase > 0
      ? (result.totals.netProfitAfterTax / result.totals.expenseShareBase) * 100
      : 0;

  result.totals.drrPercent =
    result.totals.expenseShareBase > 0
      ? (result.totals.adsCost / result.totals.expenseShareBase) * 100
      : 0;

  for (const row of result.rows) {
    row.revenueSharePercent =
      result.totals.revenue > 0
        ? (row.revenue / result.totals.revenue) * 100
        : 0;
  }

  calculateAbcByProfit(result.rows);
  result.rows.sort((a, b) => b.marginProfit - a.marginProfit);

  return result;
}

function createEmptyTotals(
  usnRate: number,
  vatRate: number,
  undistributedAdsCost = 0,
): OzonProfitTotals {
  return {
    salesQty: 0,
    returnsQty: 0,
    netSalesQty: 0,

    revenue: 0,
    realizedAmount: 0,
    returnedAmount: 0,
    taxableRevenue: 0,
    partnerProgramsAmount: 0,
    discountPointsAmount: 0,
    economicTurnover: 0,
    expenseShareBase: 0,
    taxRevenueSource: "OZON_FINANCE_FALLBACK",
    taxRevenueCoverageComplete: true,
    taxRevenueMissingDays: [],
    discountPointsSource: "NONE",
    discountPointsCoverageComplete: true,
    discountPointsMissingDays: [],

    taxCalculationMode: "FINAL_TAXABLE_REVENUE",
    taxCalculationBase: 0,
    taxesEstimated: false,
    netProfitStatus: "FINAL",

    sellerPayout: 0,

    wbCommission: 0,

    logisticsCost: 0,
    deliveryCost: 0,
    fboCost: 0,
    storageCost: 0,
    acceptanceCost: 0,

    penaltiesAmount: 0,
    deductions: 0,

    paymentServiceCost: 0,

    adsCost: 0,
    clickAdsCost: 0,
    orderAdsCost: 0,
    otherAdsCost: 0,
    drrPercent: 0,
    undistributedAdsCost,

    totalCost: 0,

    grossOzonExpenses: 0,
    discountPointsCompensation: 0,
    netOzonExpenses: 0,
    partnerServicesCost: 0,
    otherServicesCost: 0,
    compensationAmount: 0,
    excludedLoansFactoringAmount: 0,

    marginProfit: 0,
    marginProfitPercent: 0,

    taxesAmount: 0,

    netProfitAfterTax: 0,
    marginAfterTaxPercent: 0,

    usnRate,
    vatRate,
  };
}

function finalizeOzonTotals(totals: OzonProfitTotals) {
  totals.expenseShareBase =
    totals.economicTurnover > 0 ? totals.economicTurnover : totals.revenue;

  totals.grossOzonExpenses = calculateOzonGrossExpenses(totals);

  totals.netOzonExpenses = calculateOzonNetExpensesAfterDiscountPoints(totals);

  totals.marginProfit =
    totals.economicTurnover - totals.totalCost - totals.grossOzonExpenses;

  totals.netProfitAfterTax = totals.marginProfit - totals.taxesAmount;

  totals.marginProfitPercent =
    totals.expenseShareBase > 0
      ? (totals.marginProfit / totals.expenseShareBase) * 100
      : 0;

  totals.marginAfterTaxPercent =
    totals.expenseShareBase > 0
      ? (totals.netProfitAfterTax / totals.expenseShareBase) * 100
      : 0;

  totals.drrPercent =
    totals.expenseShareBase > 0
      ? (totals.adsCost / totals.expenseShareBase) * 100
      : 0;

  return totals;
}

function mergeOzonTotals(
  totalsList: OzonProfitTotals[],
  usnRate: number,
  vatRate: number,
) {
  const result = createEmptyTotals(usnRate, vatRate);

  const keys: (keyof OzonProfitTotals)[] = [
    "salesQty",
    "returnsQty",
    "netSalesQty",
    "revenue",
    "realizedAmount",
    "returnedAmount",
    "taxableRevenue",
    "partnerProgramsAmount",
    "discountPointsAmount",
    "economicTurnover",
    "sellerPayout",
    "wbCommission",
    "logisticsCost",
    "deliveryCost",
    "fboCost",
    "storageCost",
    "acceptanceCost",
    "penaltiesAmount",
    "deductions",
    "paymentServiceCost",
    "adsCost",
    "clickAdsCost",
    "orderAdsCost",
    "otherAdsCost",
    "undistributedAdsCost",
    "totalCost",
    "grossOzonExpenses",
    "discountPointsCompensation",
    "netOzonExpenses",
    "partnerServicesCost",
    "otherServicesCost",
    "compensationAmount",
    "excludedLoansFactoringAmount",
    "marginProfit",
    "taxCalculationBase",
    "taxesAmount",
    "netProfitAfterTax",
  ];

  for (const totals of totalsList) {
    for (const key of keys) {
      result[key] = (toNumber(result[key]) + toNumber(totals[key])) as never;
    }

    result.taxRevenueCoverageComplete =
      result.taxRevenueCoverageComplete && totals.taxRevenueCoverageComplete;
    result.discountPointsCoverageComplete =
      result.discountPointsCoverageComplete && totals.discountPointsCoverageComplete;
    result.taxRevenueMissingDays = Array.from(
      new Set([...result.taxRevenueMissingDays, ...totals.taxRevenueMissingDays]),
    );
    result.discountPointsMissingDays = Array.from(
      new Set([
        ...result.discountPointsMissingDays,
        ...totals.discountPointsMissingDays,
      ]),
    );
  }

  result.taxRevenueSource = result.taxRevenueCoverageComplete
    ? "MERGED_COMPLETE"
    : "MERGED_INCOMPLETE";
  result.discountPointsSource = result.discountPointsCoverageComplete
    ? "MERGED_COMPLETE"
    : "MERGED_INCOMPLETE";
  result.taxCalculationMode = result.taxRevenueCoverageComplete
    ? "FINAL_TAXABLE_REVENUE"
    : "ESTIMATED_ECONOMIC_TURNOVER";
  result.taxesEstimated = !result.taxRevenueCoverageComplete;
  result.netProfitStatus = result.taxRevenueCoverageComplete
    ? "FINAL"
    : "PRELIMINARY";

  return finalizeOzonTotals(result);
}

function mergeOzonRows(rowsList: OzonProfitAnalyticsRow[][]) {
  const grouped = new Map<string, OzonProfitAnalyticsRow>();

  for (const rows of rowsList) {
    for (const row of rows) {
      const key = normalizeText(row.vendorCode) || normalizeText(row.nmId);
      if (!key) continue;

      const current = grouped.get(key);

      if (!current) {
        grouped.set(key, { ...row });
        continue;
      }

      current.salesQty += row.salesQty;
      current.returnsQty += row.returnsQty;
      current.netSalesQty += row.netSalesQty;
      current.revenue += row.revenue;
      current.sellerPayout += row.sellerPayout;
      current.wbCommission += row.wbCommission;
      current.logisticsCost += row.logisticsCost;
      current.deliveryCost += row.deliveryCost ?? 0;
      current.fboCost += row.fboCost ?? 0;
      current.storageCost += row.storageCost;
      current.acceptanceCost += row.acceptanceCost;
      current.penaltiesAmount += row.penaltiesAmount;
      current.deductions += row.deductions;
      current.paymentServiceCost += row.paymentServiceCost;
      current.adsCost += row.adsCost;
      current.totalCost += row.totalCost;
      current.marginProfit += row.marginProfit;
      current.taxesAmount += row.taxesAmount;
      current.netProfitAfterTax += row.netProfitAfterTax;

      if (!current.nmId && row.nmId) current.nmId = row.nmId;
      if (!current.subject && row.subject) current.subject = row.subject;
    }
  }

  const rows = Array.from(grouped.values());

  const totalRevenue = rows.reduce((sum, row) => sum + row.revenue, 0);

  for (const row of rows) {
    row.revenueSharePercent =
      totalRevenue > 0 ? (row.revenue / totalRevenue) * 100 : 0;
    row.costPrice = row.netSalesQty > 0 ? row.totalCost / row.netSalesQty : 0;
    row.drrPercent = row.revenue > 0 ? (row.adsCost / row.revenue) * 100 : 0;
    row.marginProfitPercent =
      row.revenue > 0 ? (row.marginProfit / row.revenue) * 100 : 0;
    row.marginAfterTaxPercent =
      row.revenue > 0 ? (row.netProfitAfterTax / row.revenue) * 100 : 0;
  }

  calculateAbcByProfit(rows);

  return rows.sort((a, b) => b.marginProfit - a.marginProfit);
}

function createOzonComparison(
  current: OzonProfitTotals,
  previous: OzonProfitTotals,
): OzonProfitAnalyticsComparison {
  return {
    revenue: createComparison(current.revenue, previous.revenue),

    economicTurnover: createComparison(
      current.economicTurnover,
      previous.economicTurnover,
    ),

    discountPointsAmount: createComparison(
      current.discountPointsAmount,
      previous.discountPointsAmount,
    ),

    clickAdsCost: createComparison(current.clickAdsCost, previous.clickAdsCost),

    orderAdsCost: createComparison(current.orderAdsCost, previous.orderAdsCost),

    sellerPayout: createComparison(current.sellerPayout, previous.sellerPayout),

    totalCost: createComparison(current.totalCost, previous.totalCost),

    wbCommission: createComparison(current.wbCommission, previous.wbCommission),

    logisticsCost: createComparison(
      current.logisticsCost,
      previous.logisticsCost,
    ),

    adsCost: createComparison(current.adsCost, previous.adsCost),

    grossOzonExpenses: createComparison(
      current.grossOzonExpenses,
      previous.grossOzonExpenses,
    ),

    netOzonExpenses: createComparison(
      current.netOzonExpenses,
      previous.netOzonExpenses,
    ),

    taxesAmount: createComparison(current.taxesAmount, previous.taxesAmount),

    marginProfit: createComparison(current.marginProfit, previous.marginProfit),

    netProfitAfterTax: createComparison(
      current.netProfitAfterTax,
      previous.netProfitAfterTax,
    ),
  };
}

function mergeOzonAnalyticsResults(
  results: OzonProfitAnalyticsResult[],
  usnRate: number,
  vatRate: number,
): OzonProfitAnalyticsResult {
  const rows = mergeOzonRows(results.map((result) => result.rows));
  const previousRows = mergeOzonRows(
    results.map((result) => result.previousRows),
  );

  const totals = mergeOzonTotals(
    results.map((result) => result.totals),
    usnRate,
    vatRate,
  );

  const previousTotals = mergeOzonTotals(
    results.map((result) => result.previousTotals),
    usnRate,
    vatRate,
  );

  return {
    rows,
    totals,
    previousRows,
    previousTotals,
    comparison: createOzonComparison(totals, previousTotals),
  };
}

function calculateAbcByProfit(rows: OzonProfitAnalyticsRow[]) {
  const totalPositiveProfit = rows.reduce(
    (sum, row) => sum + Math.max(0, row.marginProfit),
    0,
  );

  if (totalPositiveProfit <= 0) {
    for (const row of rows) {
      row.abcByProfit = "C";
    }
    return;
  }

  let cumulativeProfit = 0;

  for (const row of rows) {
    const positiveProfit = Math.max(0, row.marginProfit);

    if (positiveProfit <= 0) {
      row.abcByProfit = "C";
      continue;
    }

    const shareBefore = cumulativeProfit / totalPositiveProfit;
    cumulativeProfit += positiveProfit;

    if (shareBefore < 0.8) {
      row.abcByProfit = "A";
    } else if (shareBefore < 0.95) {
      row.abcByProfit = "B";
    } else {
      row.abcByProfit = "C";
    }
  }
}

function calculateRowsAndTotals({
  financeRows,
  adsRows,
  costs,
  ozonProducts,
  usnRate,
  vatRate,
}: {
  financeRows: OzonFinanceRecord[];
  adsRows: OzonAdsRecord[];
  costs: CostRecord[];
  ozonProducts: OzonProductRecord[];
  usnRate: number;
  vatRate: number;
}) {
  const costByVendorCode = buildCostByVendorCode(costs);
  const productLookup = buildOzonProductLookup(ozonProducts);

  const { adsCostByVendorCode, undistributedAdsCost } =
    buildAdsCostByVendorCode(adsRows, ozonProducts);

  const financeClickAdsCost = financeRows.reduce(
    (sum, row) =>
      isOzonFinanceClickAdOperation(row.operationType)
        ? sum + getOzonFinanceAdAmount(row)
        : sum,
    0,
  );

  const financeOrderAdsCost = financeRows.reduce(
    (sum, row) =>
      isOzonFinanceOrderAdOperation(row.operationType)
        ? sum + getOzonFinanceAdAmount(row)
        : sum,
    0,
  );

  const financeOtherAdsCost = financeRows.reduce(
    (sum, row) =>
      isOzonFinanceAdOperation(row.operationType) &&
      !isOzonFinanceClickAdOperation(row.operationType) &&
      !isOzonFinanceOrderAdOperation(row.operationType)
        ? sum + getOzonFinanceAdAmount(row)
        : sum,
    0,
  );

  const financeAdsCost =
    financeClickAdsCost + financeOrderAdsCost + financeOtherAdsCost;

  const marketplaceFinanceRows = financeRows.filter(
    (row) =>
      !isOzonFinanceAdOperation(row.operationType) &&
      !isOzonNonOperatingFinanceOperation(row.operationType),
  );

  const grouped = new Map<string, OzonProfitAnalyticsRow>();

  for (const financeRow of marketplaceFinanceRows) {
    const skuKey = normalizeText(financeRow.sku);
    const directVendorCodeKey = normalizeText(financeRow.vendorCode);
    const mappedVendorCodeKey = skuKey
      ? (productLookup.normalizedVendorCodeBySku.get(skuKey) ?? "")
      : "";

    const vendorCodeKey = directVendorCodeKey || mappedVendorCodeKey || skuKey;

    if (!vendorCodeKey) continue;

    const displayVendorCode =
      cleanText(financeRow.vendorCode) ||
      (skuKey ? productLookup.displayVendorCodeBySku.get(skuKey) : "") ||
      cleanText(financeRow.sku) ||
      vendorCodeKey;

    const current = grouped.get(vendorCodeKey) ?? {
      nmId: financeRow.sku ?? "",
      vendorCode: displayVendorCode,
      subject: "",

      salesQty: 0,
      returnsQty: 0,
      netSalesQty: 0,

      revenue: 0,
      revenueSharePercent: 0,

      sellerPayout: 0,

      wbCommission: 0,

      logisticsCost: 0,

      deliveryCost: 0,

      fboCost: 0,
      storageCost: 0,
      acceptanceCost: 0,

      penaltiesAmount: 0,
      deductions: 0,

      paymentServiceCost: 0,

      adsCost: adsCostByVendorCode.get(vendorCodeKey) ?? 0,
      drrPercent: 0,

      costPrice: costByVendorCode.get(vendorCodeKey) ?? 0,
      totalCost: 0,

      marginProfit: 0,
      marginProfitPercent: 0,

      taxesAmount: 0,

      netProfitAfterTax: 0,
      marginAfterTaxPercent: 0,

      abcByProfit: "C" as const,
    };

    if (!current.nmId && financeRow.sku) {
      current.nmId = financeRow.sku;
    }

    if (!current.vendorCode) {
      current.vendorCode = displayVendorCode;
    }

    if (current.costPrice === 0 && vendorCodeKey) {
      current.costPrice = costByVendorCode.get(vendorCodeKey) ?? 0;
    }

    const quantity = Math.abs(toNumber(financeRow.quantity));
    const salesAmount = toNumber(financeRow.salesAmount);
    const totalAmount = toNumber(financeRow.totalAmount);

    if (salesAmount > 0 || quantity > 0) {
      current.salesQty += quantity;
      current.netSalesQty += quantity;
      current.totalCost += current.costPrice * quantity;
    }

    if (salesAmount < 0 || totalAmount < 0) {
      current.returnsQty += quantity;
      current.netSalesQty -= quantity;
      current.totalCost -= current.costPrice * quantity;
    }

    current.revenue += salesAmount;
    current.sellerPayout += totalAmount;

    const commission = signedOzonExpenseAmount(financeRow.ozonCommission);
    const directLogistics = signedOzonExpenseAmount(financeRow.logisticsCost);
    const reverseLogistics = signedOzonExpenseAmount(
      financeRow.reverseLogisticsCost,
    );
    const logistics = directLogistics + reverseLogistics;

    current.wbCommission += commission;
    current.logisticsCost += logistics;
    current.deliveryCost += logistics;
    current.fboCost += 0;

    const knownMarketplaceExpenses = commission + logistics;
    const payoutGap = salesAmount - totalAmount;
    const otherDeductions = payoutGap - knownMarketplaceExpenses;

    current.deductions += otherDeductions;

    current.marginProfit =
      current.sellerPayout - current.totalCost - current.adsCost;

    current.marginProfitPercent =
      current.revenue > 0 ? (current.marginProfit / current.revenue) * 100 : 0;

    current.drrPercent =
      current.revenue > 0 ? (current.adsCost / current.revenue) * 100 : 0;

    const usnTax = current.revenue > 0 ? current.revenue * (usnRate / 100) : 0;
    const vatTax =
      current.revenue > 0 ? calculateVatTax(current.revenue, vatRate) : 0;

    current.taxesAmount = usnTax + vatTax;
    current.netProfitAfterTax = current.marginProfit - current.taxesAmount;

    current.marginAfterTaxPercent =
      current.revenue > 0
        ? (current.netProfitAfterTax / current.revenue) * 100
        : 0;

    grouped.set(vendorCodeKey, current);
  }

  for (const [vendorCodeKey, adsCost] of adsCostByVendorCode.entries()) {
    if (grouped.has(vendorCodeKey)) continue;
    if (adsCost === 0) continue;

    grouped.set(vendorCodeKey, {
      nmId: "",
      vendorCode: vendorCodeKey,
      subject: "",

      salesQty: 0,
      returnsQty: 0,
      netSalesQty: 0,

      revenue: 0,
      revenueSharePercent: 0,

      sellerPayout: 0,

      wbCommission: 0,

      logisticsCost: 0,

      deliveryCost: 0,

      fboCost: 0,
      storageCost: 0,
      acceptanceCost: 0,

      penaltiesAmount: 0,
      deductions: 0,

      paymentServiceCost: 0,

      adsCost,
      drrPercent: 0,

      costPrice: costByVendorCode.get(vendorCodeKey) ?? 0,
      totalCost: 0,

      marginProfit: -adsCost,
      marginProfitPercent: 0,

      taxesAmount: 0,

      netProfitAfterTax: -adsCost,
      marginAfterTaxPercent: 0,

      abcByProfit: "C",
    });
  }

  const rows = Array.from(grouped.values())
    .filter(
      (row) =>
        row.salesQty > 0 ||
        row.revenue !== 0 ||
        row.sellerPayout !== 0 ||
        row.adsCost !== 0,
    )
    .sort((a, b) => b.marginProfit - a.marginProfit);

  calculateAbcByProfit(rows);

  const totalRevenue = rows.reduce((sum, row) => sum + row.revenue, 0);

  rows.forEach((row) => {
    row.revenueSharePercent =
      totalRevenue > 0 ? (row.revenue / totalRevenue) * 100 : 0;
  });

  const totals = rows.reduce(
    (acc, row) => {
      acc.salesQty += row.salesQty;
      acc.returnsQty += row.returnsQty;
      acc.netSalesQty += row.netSalesQty;

      acc.revenue += row.revenue;
      acc.sellerPayout += row.sellerPayout;

      acc.wbCommission += row.wbCommission;
      acc.logisticsCost += row.logisticsCost;
      acc.deliveryCost += row.deliveryCost ?? 0;
      acc.fboCost += row.fboCost ?? 0;

      acc.penaltiesAmount += row.penaltiesAmount;
      acc.deductions += row.deductions;

      acc.paymentServiceCost += row.paymentServiceCost;

      acc.adsCost += row.adsCost;

      acc.totalCost += row.totalCost;

      acc.marginProfit += row.marginProfit;

      acc.taxesAmount += row.taxesAmount;

      acc.netProfitAfterTax += row.netProfitAfterTax;

      return acc;
    },
    createEmptyTotals(usnRate, vatRate, undistributedAdsCost + financeAdsCost),
  );

  if (totals.undistributedAdsCost > 0) {
    totals.adsCost += totals.undistributedAdsCost;
    totals.marginProfit -= totals.undistributedAdsCost;
    totals.netProfitAfterTax -= totals.undistributedAdsCost;
  }

  const adsRowsTotal =
    rows.reduce((sum, row) => sum + row.adsCost, 0) + undistributedAdsCost;

  totals.clickAdsCost =
    adsRowsTotal + financeClickAdsCost + financeOtherAdsCost;
  totals.orderAdsCost = financeOrderAdsCost;
  totals.adsCost = totals.clickAdsCost + totals.orderAdsCost;

  const financeAdsCostNotAppliedToProfit =
    financeClickAdsCost + financeOrderAdsCost + financeOtherAdsCost;

  if (financeAdsCostNotAppliedToProfit > 0) {
    totals.marginProfit -= financeAdsCostNotAppliedToProfit;
    totals.netProfitAfterTax -= financeAdsCostNotAppliedToProfit;
  }

  totals.marginProfitPercent =
    totals.revenue > 0 ? (totals.marginProfit / totals.revenue) * 100 : 0;

  totals.marginAfterTaxPercent =
    totals.revenue > 0 ? (totals.netProfitAfterTax / totals.revenue) * 100 : 0;

  totals.drrPercent =
    totals.revenue > 0 ? (totals.adsCost / totals.revenue) * 100 : 0;

  return {
    rows,
    totals,
  };
}

async function findOzonRealizationSummaryByPeriod(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
}): Promise<OzonRealizationSummaryRecord | null> {
  if (!params?.dateFrom || !params?.dateTo) return null;

  type IntervalRow = OzonRealizationSummaryRecord & {
    dateFrom: Date | string;
    dateTo: Date | string;
  };

  const rows = params.companyName
    ? await prisma.$queryRaw<IntervalRow[]>`
        SELECT
          "dateFrom"::date AS "dateFrom",
          "dateTo"::date AS "dateTo",
          COALESCE(SUM("realizedAmount"), 0) AS "realizedAmount",
          COALESCE(SUM("returnedAmount"), 0) AS "returnedAmount",
          COALESCE(SUM("taxableRevenue"), 0) AS "taxableRevenue",
          COALESCE(SUM("partnerProgramsAmount"), 0) AS "partnerProgramsAmount",
          COUNT(*)::int AS "rows"
        FROM "OzonRealizationSummary"
        WHERE "dateFrom"::date >= CAST(${params.dateFrom} AS date)
          AND "dateTo"::date <= CAST(${params.dateTo} AS date)
          AND "companyName" = ${params.companyName}
        GROUP BY "dateFrom"::date, "dateTo"::date
        ORDER BY "dateFrom"::date, "dateTo"::date
      `
    : await prisma.$queryRaw<IntervalRow[]>`
        SELECT
          "dateFrom"::date AS "dateFrom",
          "dateTo"::date AS "dateTo",
          COALESCE(SUM("realizedAmount"), 0) AS "realizedAmount",
          COALESCE(SUM("returnedAmount"), 0) AS "returnedAmount",
          COALESCE(SUM("taxableRevenue"), 0) AS "taxableRevenue",
          COALESCE(SUM("partnerProgramsAmount"), 0) AS "partnerProgramsAmount",
          COUNT(*)::int AS "rows"
        FROM "OzonRealizationSummary"
        WHERE "dateFrom"::date >= CAST(${params.dateFrom} AS date)
          AND "dateTo"::date <= CAST(${params.dateTo} AS date)
        GROUP BY "dateFrom"::date, "dateTo"::date
        ORDER BY "dateFrom"::date, "dateTo"::date
      `;

  const selectedRows = selectExactPeriodSummaryCoverage(
    rows,
    params.dateFrom,
    params.dateTo,
  );

  if (!selectedRows) {
    return {
      realizedAmount: 0,
      returnedAmount: 0,
      taxableRevenue: 0,
      partnerProgramsAmount: 0,
      source: "inside-period-incomplete",
      coverageComplete: false,
      missingDays: getMissingPeriodSummaryDays(
        rows,
        params.dateFrom,
        params.dateTo,
      ),
      rows: rows.length,
    };
  }

  const aggregateSummary = selectedRows.reduce(
    (acc, row) => {
      acc.realizedAmount += toNumber(row.realizedAmount);
      acc.returnedAmount += toNumber(row.returnedAmount);
      acc.taxableRevenue += toNumber(row.taxableRevenue);
      acc.partnerProgramsAmount += toNumber(row.partnerProgramsAmount);
      acc.rows += toNumber(row.rows);
      return acc;
    },
    {
      realizedAmount: 0,
      returnedAmount: 0,
      taxableRevenue: 0,
      partnerProgramsAmount: 0,
      rows: 0,
    },
  );

  const exactPeriod =
    selectedRows.length === 1 &&
    getPeriodSummaryDateKey(selectedRows[0].dateFrom) === params.dateFrom &&
    getPeriodSummaryDateKey(selectedRows[0].dateTo) === params.dateTo;

  return {
    ...aggregateSummary,
    source: exactPeriod
      ? "exact-period"
      : "inside-period-complete",
    coverageComplete: true,
    missingDays: [],
  };
}

async function findOzonRealizationSummaryByDatePeriod(params?: {
  dateFrom?: Date | null;
  dateTo?: Date | null;
  companyName?: string | null;
}) {
  if (!params?.dateFrom || !params?.dateTo) return null;

  return findOzonRealizationSummaryByPeriod({
    dateFrom: params.dateFrom.toISOString().slice(0, 10),
    dateTo: params.dateTo.toISOString().slice(0, 10),
    companyName: params.companyName,
  });
}

async function findOzonDiscountPointsSummaryByPeriod(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
}): Promise<OzonDiscountPointsSummaryRecord | null> {
  if (!params?.dateFrom || !params?.dateTo) return null;

  type IntervalRow = OzonDiscountPointsSummaryRecord & {
    dateFrom: Date | string;
    dateTo: Date | string;
  };

  const rows = params.companyName
    ? await prisma.$queryRaw<IntervalRow[]>`
        SELECT
          "dateFrom"::date AS "dateFrom",
          "dateTo"::date AS "dateTo",
          COALESCE(SUM("pointsAccrued"), 0) AS "pointsAccrued",
          COALESCE(SUM("pointsWrittenOff"), 0) AS "pointsWrittenOff",
          COALESCE(SUM("totalPaidByPoints"), 0) AS "totalPaidByPoints",
          COUNT(*)::int AS "rows"
        FROM "OzonDiscountPointsSummary"
        WHERE "dateFrom"::date >= CAST(${params.dateFrom} AS date)
          AND "dateTo"::date <= CAST(${params.dateTo} AS date)
          AND "companyName" = ${params.companyName}
        GROUP BY "dateFrom"::date, "dateTo"::date
        ORDER BY "dateFrom"::date, "dateTo"::date
      `
    : await prisma.$queryRaw<IntervalRow[]>`
        SELECT
          "dateFrom"::date AS "dateFrom",
          "dateTo"::date AS "dateTo",
          COALESCE(SUM("pointsAccrued"), 0) AS "pointsAccrued",
          COALESCE(SUM("pointsWrittenOff"), 0) AS "pointsWrittenOff",
          COALESCE(SUM("totalPaidByPoints"), 0) AS "totalPaidByPoints",
          COUNT(*)::int AS "rows"
        FROM "OzonDiscountPointsSummary"
        WHERE "dateFrom"::date >= CAST(${params.dateFrom} AS date)
          AND "dateTo"::date <= CAST(${params.dateTo} AS date)
        GROUP BY "dateFrom"::date, "dateTo"::date
        ORDER BY "dateFrom"::date, "dateTo"::date
      `;

  const selectedRows = selectExactPeriodSummaryCoverage(
    rows,
    params.dateFrom,
    params.dateTo,
  );

  if (!selectedRows) {
    return {
      pointsAccrued: 0,
      pointsWrittenOff: 0,
      totalPaidByPoints: 0,
      source: "inside-period-incomplete",
      coverageComplete: false,
      missingDays: getMissingPeriodSummaryDays(
        rows,
        params.dateFrom,
        params.dateTo,
      ),
      rows: rows.length,
    };
  }

  const aggregateSummary = selectedRows.reduce(
    (acc, row) => {
      acc.pointsAccrued += toNumber(row.pointsAccrued);
      acc.pointsWrittenOff += toNumber(row.pointsWrittenOff);
      acc.totalPaidByPoints += toNumber(row.totalPaidByPoints);
      acc.rows += toNumber(row.rows);
      return acc;
    },
    {
      pointsAccrued: 0,
      pointsWrittenOff: 0,
      totalPaidByPoints: 0,
      rows: 0,
    },
  );

  const exactPeriod =
    selectedRows.length === 1 &&
    getPeriodSummaryDateKey(selectedRows[0].dateFrom) === params.dateFrom &&
    getPeriodSummaryDateKey(selectedRows[0].dateTo) === params.dateTo;

  return {
    ...aggregateSummary,
    source: exactPeriod
      ? "exact-period"
      : "inside-period-complete",
    coverageComplete: true,
    missingDays: [],
  };
}

async function findOzonDiscountPointsSummaryByDatePeriod(params?: {
  dateFrom?: Date | null;
  dateTo?: Date | null;
  companyName?: string | null;
}) {
  if (!params?.dateFrom || !params?.dateTo) return null;

  return findOzonDiscountPointsSummaryByPeriod({
    dateFrom: params.dateFrom.toISOString().slice(0, 10),
    dateTo: params.dateTo.toISOString().slice(0, 10),
    companyName: params.companyName,
  });
}

async function findOzonFinancialCategoryFactsByPeriod(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
}): Promise<OzonFinancialCategoryFactRecord[]> {
  if (!params?.dateFrom || !params?.dateTo) return [];

  try {
    return params.companyName
      ? await prisma.$queryRaw<OzonFinancialCategoryFactRecord[]>`
          SELECT
            "category" AS "category",
            "sourceOperationType" AS "sourceOperationType",
            "sourceOperationCode" AS "sourceOperationCode",
            "sourceServiceName" AS "sourceServiceName",
            COALESCE(SUM("amount"), 0) AS "amount"
          FROM "OzonFinancialCategoryFact"
          WHERE "operationDate" >= CAST(${params.dateFrom} AS timestamp)
            AND "operationDate" < (CAST(${params.dateTo} AS timestamp) + INTERVAL '1 day')
            AND "companyName" = ${params.companyName}
          GROUP BY "category", "sourceOperationType", "sourceOperationCode", "sourceServiceName"
        `
      : await prisma.$queryRaw<OzonFinancialCategoryFactRecord[]>`
          SELECT
            "category" AS "category",
            "sourceOperationType" AS "sourceOperationType",
            "sourceOperationCode" AS "sourceOperationCode",
            "sourceServiceName" AS "sourceServiceName",
            COALESCE(SUM("amount"), 0) AS "amount"
          FROM "OzonFinancialCategoryFact"
          WHERE "operationDate" >= CAST(${params.dateFrom} AS timestamp)
            AND "operationDate" < (CAST(${params.dateTo} AS timestamp) + INTERVAL '1 day')
          GROUP BY "category", "sourceOperationType", "sourceOperationCode", "sourceServiceName"
        `;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (
      message.includes("OzonFinancialCategoryFact") ||
      message.includes("does not exist") ||
      message.includes("relation")
    ) {
      return [];
    }

    throw error;
  }
}

async function findOzonFinancialCategoryFactsByDatePeriod(params?: {
  dateFrom?: Date | null;
  dateTo?: Date | null;
  companyName?: string | null;
}) {
  if (!params?.dateFrom || !params?.dateTo) return [];

  return findOzonFinancialCategoryFactsByPeriod({
    dateFrom: params.dateFrom.toISOString().slice(0, 10),
    dateTo: params.dateTo.toISOString().slice(0, 10),
    companyName: params.companyName,
  });
}

async function findLatestOzonFinanceRowsByPeriod(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
}) {
  const accrualDateWhere = createDateWhere(params?.dateFrom, params?.dateTo);

  return prisma.ozonFinance.findMany({
    where: {
      ...(accrualDateWhere ? { accrualDate: accrualDateWhere } : {}),
      ...(params?.companyName ? { companyName: params.companyName } : {}),
    },
    orderBy: {
      accrualDate: "desc",
    },
  });
}

async function findLatestOzonFinanceRowsByDatePeriod(params?: {
  dateFrom?: Date | null;
  dateTo?: Date | null;
  companyName?: string | null;
}) {
  const accrualDateWhere = createDateWhereFromDates(
    params?.dateFrom,
    params?.dateTo,
  );

  return prisma.ozonFinance.findMany({
    where: {
      ...(accrualDateWhere ? { accrualDate: accrualDateWhere } : {}),
      ...(params?.companyName ? { companyName: params.companyName } : {}),
    },
    orderBy: {
      accrualDate: "desc",
    },
  });
}

async function findLatestOzonAdsRowsByPeriod(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
}) {
  const reportDateWhere = createDateWhere(params?.dateFrom, params?.dateTo);

  const datedRows = await prisma.ozonAds.findMany({
    where: {
      ...(reportDateWhere ? { reportDate: reportDateWhere } : {}),
      ...(params?.companyName ? { companyName: params.companyName } : {}),
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  const filteredDatedRows = keepOnlyLatestAdsImportPerReportDate(datedRows);

  if (filteredDatedRows.length > 0) {
    return filteredDatedRows;
  }

  const latestRow = await prisma.ozonAds.findFirst({
    where: {
      ...(params?.companyName ? { companyName: params.companyName } : {}),
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (!latestRow) return [];

  if (latestRow.importSessionId) {
    return prisma.ozonAds.findMany({
      where: {
        importSessionId: latestRow.importSessionId,
        ...(params?.companyName ? { companyName: params.companyName } : {}),
      },
    });
  }

  return prisma.ozonAds.findMany({
    where: {
      ...(params?.companyName ? { companyName: params.companyName } : {}),
      createdAt: {
        gte: new Date(latestRow.createdAt.getTime() - 10 * 60 * 1000),
        lte: new Date(latestRow.createdAt.getTime() + 10 * 60 * 1000),
      },
    },
  });
}

async function findLatestOzonAdsRowsByDatePeriod(params?: {
  dateFrom?: Date | null;
  dateTo?: Date | null;
  companyName?: string | null;
}) {
  const reportDateWhere = createDateWhereFromDates(
    params?.dateFrom,
    params?.dateTo,
  );

  const rows = await prisma.ozonAds.findMany({
    where: {
      ...(reportDateWhere ? { reportDate: reportDateWhere } : {}),
      ...(params?.companyName ? { companyName: params.companyName } : {}),
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return keepOnlyLatestAdsImportPerReportDate(rows);
}

function keepOnlyLatestAdsImportPerReportDate<
  T extends {
    reportDate: Date | null;
    importSessionId: string | null;
    createdAt: Date;
  },
>(rows: T[]) {
  const latestSessionByDate = new Map<string, string | null>();

  for (const row of rows) {
    const dateKey = row.reportDate
      ? row.reportDate.toISOString().slice(0, 10)
      : "NO_DATE";

    if (!latestSessionByDate.has(dateKey)) {
      latestSessionByDate.set(dateKey, row.importSessionId ?? null);
    }
  }

  return rows.filter((row) => {
    const dateKey = row.reportDate
      ? row.reportDate.toISOString().slice(0, 10)
      : "NO_DATE";

    return latestSessionByDate.get(dateKey) === (row.importSessionId ?? null);
  });
}

export async function getProfitAnalyticsOzon(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  usnRate?: string | number | null;
  vatRate?: string | number | null;
  companyName?: string | null;
  skipComparison?: boolean;
}): Promise<OzonProfitAnalyticsResult> {
  const requestedCompanyName =
    params?.companyName && params.companyName !== "ALL"
      ? params.companyName
      : null;

  // Единый источник налоговых ставок для всех потребителей аналитики.
  // Страница /profit-ozon передаёт ставки явно, а Dashboard/Telegram могут
  // вызывать аналитику только с companyName. В таком случае ставки должны
  // браться из настроек компании, а не превращаться в 0%.
  const companyTaxSettings =
    requestedCompanyName &&
    (params?.usnRate === null ||
      params?.usnRate === undefined ||
      params?.vatRate === null ||
      params?.vatRate === undefined)
      ? await prisma.company.findFirst({
          where: {
            name: requestedCompanyName,
          },
          select: {
            usnRate: true,
            vatRate: true,
          },
        })
      : null;

  const usnRate = clampRate(
    params?.usnRate ?? companyTaxSettings?.usnRate ?? 1,
    [0, 1, 2, 3, 4, 5, 6],
    1
  );
  const vatRate = clampRate(
    params?.vatRate ?? companyTaxSettings?.vatRate ?? 5,
    [0, 5, 7],
    5
  );

  if (!requestedCompanyName) {
    const companyResults: OzonProfitAnalyticsResult[] = [];

    for (const companyName of OZON_COMPANY_NAMES) {
      companyResults.push(
        await getProfitAnalyticsOzon({
          ...params,
          companyName,
        })
      );
    }

    return mergeOzonAnalyticsResults(companyResults, usnRate, vatRate);
  }

  const companyName = requestedCompanyName;

  const costs = await prisma.productCost.findMany({
    orderBy: {
      costDate: "desc",
    },
  });

  const [ozonProducts, ozonStockMappings] = await Promise.all([
    prisma.ozonProduct.findMany({
      where: {
        ...(companyName ? { companyName } : {}),
      },
      select: {
        vendorCode: true,
        sku: true,
      },
    }),
    // Fallback-маппинг: иногда Ozon Finance отдаёт SKU, которого нет в OzonProduct,
    // но он есть в остатках Ozon вместе с vendorCode. Используем это только как
    // справочник соответствия SKU -> артикул, не меняя сами финансовые формулы.
    prisma.ozonStock.findMany({
      where: {
        ...(companyName ? { companyName } : {}),
      },
      select: {
        vendorCode: true,
        sku: true,
      },
    }),
  ]);

  const ozonProductMappings = [...ozonProducts, ...ozonStockMappings];

  const currentFinanceRows = await findLatestOzonFinanceRowsByPeriod({
    dateFrom: params?.dateFrom,
    dateTo: params?.dateTo,
    companyName,
  });

  const currentRealizationSummary = await findOzonRealizationSummaryByPeriod({
    dateFrom: params?.dateFrom,
    dateTo: params?.dateTo,
    companyName,
  });

  const currentDiscountPointsSummary =
    await findOzonDiscountPointsSummaryByPeriod({
      dateFrom: params?.dateFrom,
      dateTo: params?.dateTo,
      companyName,
    });

  const currentFinancialCategoryFacts =
    await findOzonFinancialCategoryFactsByPeriod({
      dateFrom: params?.dateFrom,
      dateTo: params?.dateTo,
      companyName,
    });

  const currentHasFinanceClickAds =
    hasOzonFinanceClickAdRows(currentFinanceRows);

  const currentAdsRows = currentHasFinanceClickAds
    ? []
    : await findLatestOzonAdsRowsByPeriod({
        dateFrom: params?.dateFrom,
        dateTo: params?.dateTo,
        companyName,
      });

  const previousPeriod = params?.skipComparison
    ? null
    : calculatePreviousPeriod(params?.dateFrom, params?.dateTo);

  const previousFinanceRows = previousPeriod
    ? await findLatestOzonFinanceRowsByDatePeriod({
        dateFrom: previousPeriod.dateFrom,
        dateTo: previousPeriod.dateTo,
        companyName,
      })
    : [];

  const previousRealizationSummary = previousPeriod
    ? await findOzonRealizationSummaryByDatePeriod({
        dateFrom: previousPeriod.dateFrom,
        dateTo: previousPeriod.dateTo,
        companyName,
      })
    : null;

  const previousDiscountPointsSummary = previousPeriod
    ? await findOzonDiscountPointsSummaryByDatePeriod({
        dateFrom: previousPeriod.dateFrom,
        dateTo: previousPeriod.dateTo,
        companyName,
      })
    : null;

  const previousFinancialCategoryFacts = previousPeriod
    ? await findOzonFinancialCategoryFactsByDatePeriod({
        dateFrom: previousPeriod.dateFrom,
        dateTo: previousPeriod.dateTo,
        companyName,
      })
    : [];

  const previousHasFinanceClickAds =
    hasOzonFinanceClickAdRows(previousFinanceRows);

  const previousAdsRows =
    previousPeriod && !previousHasFinanceClickAds
      ? await findLatestOzonAdsRowsByDatePeriod({
          dateFrom: previousPeriod.dateFrom,
          dateTo: previousPeriod.dateTo,
          companyName,
        })
      : [];

  const current = applyOzonEconomicModel(
    calculateRowsAndTotals({
      financeRows: currentFinanceRows,
      adsRows: currentAdsRows,
      costs,
      ozonProducts: ozonProductMappings,
      usnRate,
      vatRate,
    }),
    currentRealizationSummary,
    currentDiscountPointsSummary,
    currentFinancialCategoryFacts,
    usnRate,
    vatRate,
  );

  const previous = applyOzonEconomicModel(
    calculateRowsAndTotals({
      financeRows: previousFinanceRows,
      adsRows: previousAdsRows,
      costs,
      ozonProducts: ozonProductMappings,
      usnRate,
      vatRate,
    }),
    previousRealizationSummary,
    previousDiscountPointsSummary,
    previousFinancialCategoryFacts,
    usnRate,
    vatRate,
  );

  const comparison = createOzonComparison(current.totals, previous.totals);

  return {
    rows: current.rows,
    totals: current.totals,

    previousRows: previous.rows,
    previousTotals: previous.totals,

    comparison,
  };
}
