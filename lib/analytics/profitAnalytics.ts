import { prisma } from "@/lib/prisma";
import {
  buildWbClosedWeekSettlement,
  buildWbDeductionReconciliation,
  buildWbRevenueCompatibilityFields,
  calculateClosedWeekWbProfit,
  calculateWbV6RevenueComponents,
} from "@/lib/analytics/wbFinancialCoreV6";
import {
  buildCanonicalPositiveCostLookups,
  normalizeProductCostKey,
} from "@/lib/analytics/productCostResolver";
import {
  aggregateRoundedWbTaxLiabilities,
  buildWbFinanceTaxReportKindByKeyForRelevantSales,
  calculateWbAccountantTaxContribution,
  resolveWbSaleTaxReportKind,
  WbTaxReportKindError,
  type WbFinanceTaxReportKind,
} from "@/lib/finance/wbAccountantTaxBase";
import {
  classifyCanonicalWbProductOperation,
  evaluateWbProductCoverage,
  requestedAllowsPreliminaryWbFallback,
  selectCanonicalWbSaleSource,
} from "@/lib/wb/sourceOwnership";

export const WB_PNL_UNAVAILABLE_REASON = "D6_UNSAFE_WB_OWNERSHIP_MODE" as const;

export type WbPnlAvailability =
  | {
      status: "AVAILABLE";
      kind: "FINAL" | "PRELIMINARY" | "LEGACY_NO_DATE_RANGE";
    }
  | {
      status: "UNAVAILABLE";
      reason: typeof WB_PNL_UNAVAILABLE_REASON;
      sourceOwnershipReasons: string[];
    };

type WbCanonicalOwnershipSignals = {
  isFinanciallyFinal: boolean;
  intervals: Array<{ preliminaryReasons?: string[] }>;
} | null;

export function resolveWbPnlAvailability(params: {
  dateFrom?: string | null;
  dateTo?: string | null;
  source: WbCanonicalOwnershipSignals;
}): WbPnlAvailability {
  const dateFrom = params.dateFrom?.slice(0, 10) || null;
  const dateTo = params.dateTo?.slice(0, 10) || null;
  if (!dateFrom || !dateTo || !params.source) {
    return { status: "AVAILABLE", kind: "LEGACY_NO_DATE_RANGE" };
  }
  if (params.source.isFinanciallyFinal) {
    return { status: "AVAILABLE", kind: "FINAL" };
  }
  if (requestedAllowsPreliminaryWbFallback(dateFrom, dateTo)) {
    return { status: "AVAILABLE", kind: "PRELIMINARY" };
  }
  return {
    status: "UNAVAILABLE",
    reason: WB_PNL_UNAVAILABLE_REASON,
    sourceOwnershipReasons: params.source.intervals.flatMap(
      (interval) => interval.preliminaryReasons ?? []
    ),
  };
}

export function isWbPnlUnavailable(
  availability: WbPnlAvailability
): availability is Extract<WbPnlAvailability, { status: "UNAVAILABLE" }> {
  return availability.status === "UNAVAILABLE";
}

export type ProfitAnalyticsIndependentAds = {
  adsCost: number;
  separatedFromPnl: boolean;
};

export type ProfitAnalyticsUnavailableResult = {
  rows: [];
  totals: null;
  previousRows: [];
  previousTotals: null;
  comparison: null;
  wbPnlAvailability: Extract<WbPnlAvailability, { status: "UNAVAILABLE" }>;
  independentAds: ProfitAnalyticsIndependentAds & { separatedFromPnl: true };
};

export type ProfitAnalyticsAvailableResult = {
  rows: ProfitAnalyticsRow[];
  totals: ProfitTotals;
  previousRows: ProfitAnalyticsRow[];
  previousTotals: ProfitTotals;
  comparison: {
    revenue: { current: number; previous: number; diff: number; diffPercent: number };
    taxableRevenue: { current: number; previous: number; diff: number; diffPercent: number };
    sellerRetailAmount: { current: number; previous: number; diff: number; diffPercent: number };
    sellerPayout: { current: number; previous: number; diff: number; diffPercent: number };
    totalCost: { current: number; previous: number; diff: number; diffPercent: number };
    wbCommission: { current: number; previous: number; diff: number; diffPercent: number };
    logisticsCost: { current: number; previous: number; diff: number; diffPercent: number };
    adsCost: { current: number; previous: number; diff: number; diffPercent: number };
    taxesAmount: { current: number; previous: number; diff: number; diffPercent: number };
    marginProfit: { current: number; previous: number; diff: number; diffPercent: number };
    netProfitAfterTax: { current: number; previous: number; diff: number; diffPercent: number };
  };
  wbPnlAvailability: Extract<WbPnlAvailability, { status: "AVAILABLE" }>;
  independentAds: ProfitAnalyticsIndependentAds;
};

export type ProfitAnalyticsResult =
  | ProfitAnalyticsAvailableResult
  | ProfitAnalyticsUnavailableResult;

export function isProfitAnalyticsUnavailable(
  result: ProfitAnalyticsResult
): result is ProfitAnalyticsUnavailableResult {
  return result.totals === null;
}

export function makeUnavailableProfitAnalyticsResult(params: {
  wbPnlAvailability: Extract<WbPnlAvailability, { status: "UNAVAILABLE" }>;
  independentAdsCost: number;
}): ProfitAnalyticsUnavailableResult {
  return {
    rows: [],
    totals: null,
    previousRows: [],
    previousTotals: null,
    comparison: null,
    wbPnlAvailability: params.wbPnlAvailability,
    independentAds: {
      adsCost: params.independentAdsCost,
      separatedFromPnl: true,
    },
  };
}

export function wbDependentRatioPercent(
  availability: WbPnlAvailability,
  numerator: number,
  denominator: number
): number | null {
  if (availability.status === "UNAVAILABLE") return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator === 0) return numerator === 0 ? 0 : null;
  return (numerator / denominator) * 100;
}

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

function startOfDay(value: string | Date) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function nextDayStart(value: string | Date) {
  const date = startOfDay(value);
  date.setDate(date.getDate() + 1);
  return date;
}

function startOfMoscowDayUtc(value: string | Date) {
  const source =
    typeof value === "string"
      ? value
      : value.toISOString().slice(0, 10);
  const match = source.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);

  if (!match) {
    const date = new Date(value);

    return new Date(
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        -3,
        0,
        0,
        0
      )
    );
  }

  const [, year, month, day] = match;

  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      -3,
      0,
      0,
      0
    )
  );
}

function nextMoscowDayStartUtc(value: string | Date) {
  const date = startOfMoscowDayUtc(value);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function getMoscowDateKey(value: unknown) {
  if (!value) return "unknown";

  const date = value instanceof Date ? value : new Date(String(value));

  if (Number.isNaN(date.getTime())) return "unknown";

  return new Date(date.getTime() + 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}


function getDateKeyFromInput(value?: string | null) {
  if (!value) return null;

  const text = String(value).trim();
  const isoDate = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);

  if (isoDate) {
    const [, year, month, day] = isoDate;

    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const moscowKey = getMoscowDateKey(value);

  return moscowKey === "unknown" ? null : moscowKey;
}

function dateKeyToDayNumber(value: string) {
  const [year, month, day] = value.split("-").map(Number);

  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function buildDateKeyRange(dateFrom?: string | null, dateTo?: string | null) {
  const fromKey = getDateKeyFromInput(dateFrom);
  const toKey = getDateKeyFromInput(dateTo) ?? fromKey;

  if (!fromKey && !toKey) {
    return null;
  }

  const startKey = fromKey ?? toKey;
  const endKey = toKey ?? fromKey;

  if (!startKey || !endKey) {
    return null;
  }

  const start = Math.min(dateKeyToDayNumber(startKey), dateKeyToDayNumber(endKey));
  const end = Math.max(dateKeyToDayNumber(startKey), dateKeyToDayNumber(endKey));

  return {
    start,
    end,
    startKey,
    endKey,
  };
}

function getWbFinanceRowDateRange(row: {
  dateFrom: Date | null;
  dateTo: Date | null;
}) {
  const fromKey = getMoscowDateKey(row.dateFrom);
  const toKey = getMoscowDateKey(row.dateTo ?? row.dateFrom);

  if (fromKey === "unknown" && toKey === "unknown") {
    return null;
  }

  const startKey = fromKey === "unknown" ? toKey : fromKey;
  const endKey = toKey === "unknown" ? fromKey : toKey;

  const start = Math.min(dateKeyToDayNumber(startKey), dateKeyToDayNumber(endKey));
  const end = Math.max(dateKeyToDayNumber(startKey), dateKeyToDayNumber(endKey));

  return {
    start,
    end,
    startKey,
    endKey,
    isSingleDay: start === end,
  };
}

function isWbFinanceRowInSelectedPeriod(
  row: { dateFrom: Date | null; dateTo: Date | null },
  params?: { dateFrom?: string | null; dateTo?: string | null }
) {
  const selectedRange = buildDateKeyRange(params?.dateFrom, params?.dateTo);

  if (!selectedRange) {
    return true;
  }

  const rowRange = getWbFinanceRowDateRange(row);

  if (!rowRange) {
    return false;
  }

  return rowRange.start <= selectedRange.end && rowRange.end >= selectedRange.start;
}

type WbFinanceIntervalGroup<T> = {
  start: number;
  end: number;
  startKey: string;
  endKey: string;
  rows: T[];
};

function buildWbFinanceIntervalGroups<T extends {
  dateFrom: Date | null;
  dateTo: Date | null;
}>(rows: T[]) {
  const groupsByKey = new Map<string, WbFinanceIntervalGroup<T>>();

  for (const row of rows) {
    const rowRange = getWbFinanceRowDateRange(row);

    if (!rowRange) {
      continue;
    }

    const key = `${rowRange.start}:${rowRange.end}`;
    const current = groupsByKey.get(key);

    if (current) {
      current.rows.push(row);
      continue;
    }

    groupsByKey.set(key, {
      start: rowRange.start,
      end: rowRange.end,
      startKey: rowRange.startKey,
      endKey: rowRange.endKey,
      rows: [row],
    });
  }

  return Array.from(groupsByKey.values()).sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }

    return right.end - left.end;
  });
}

function selectPreferredWbFinanceGroups<T extends {
  dateFrom: Date | null;
  dateTo: Date | null;
}>(
  rows: T[],
  params?: { dateFrom?: string | null; dateTo?: string | null }
): WbFinanceIntervalGroup<T>[] {
  const selectedRange = buildDateKeyRange(params?.dateFrom, params?.dateTo);

  if (!selectedRange) {
    return buildWbFinanceIntervalGroups(rows);
  }

  const containedGroups = buildWbFinanceIntervalGroups(rows).filter(
    (group) =>
      group.start >= selectedRange.start &&
      group.end <= selectedRange.end
  );

  if (containedGroups.length === 0) {
    return [];
  }

  const groupsByStart = new Map<number, WbFinanceIntervalGroup<T>[]>();

  for (const group of containedGroups) {
    const current = groupsByStart.get(group.start) ?? [];
    current.push(group);
    groupsByStart.set(group.start, current);
  }

  for (const groups of groupsByStart.values()) {
    groups.sort((left, right) => right.end - left.end);
  }

  const bestByNextDay = new Map<number, WbFinanceIntervalGroup<T>[]>();
  bestByNextDay.set(selectedRange.start, []);

  for (
    let dayNumber = selectedRange.start;
    dayNumber <= selectedRange.end;
    dayNumber += 1
  ) {
    const currentPath = bestByNextDay.get(dayNumber);

    if (!currentPath) {
      continue;
    }

    for (const group of groupsByStart.get(dayNumber) ?? []) {
      const nextDay = group.end + 1;
      const candidatePath = [...currentPath, group];
      const existingPath = bestByNextDay.get(nextDay);

      // Приоритет — минимальное количество непересекающихся официальных
      // интервалов. Поэтому точный недельный отчёт выигрывает у семи daily,
      // а точный daily — у перекрывающего недельного отчёта.
      if (!existingPath || candidatePath.length < existingPath.length) {
        bestByNextDay.set(nextDay, candidatePath);
      }
    }
  }

  return bestByNextDay.get(selectedRange.end + 1) ?? [];
}

function selectPreferredWbFinanceRows<T extends {
  dateFrom: Date | null;
  dateTo: Date | null;
}>(
  rows: T[],
  params?: { dateFrom?: string | null; dateTo?: string | null }
) {
  return selectPreferredWbFinanceGroups(rows, params).flatMap(
    (group) => group.rows
  );
}

function createWideWbFinanceDateFilter(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
}) {
  if (!params?.dateFrom && !params?.dateTo) {
    return {};
  }

  const from = params.dateFrom ? startOfDay(params.dateFrom) : null;
  const toExclusive = params.dateTo ? nextDayStart(params.dateTo) : null;
  const anchorFrom = from ?? (toExclusive ? startOfDay(toExclusive) : null);
  const anchorTo = toExclusive ?? (from ? nextDayStart(from) : null);

  if (!anchorFrom || !anchorTo) {
    return {};
  }

  const widenedFrom = new Date(anchorFrom.getTime() - 36 * 60 * 60 * 1000);
  const widenedTo = new Date(anchorTo.getTime() + 36 * 60 * 60 * 1000);

  return {
    OR: [
      {
        dateFrom: {
          gte: widenedFrom,
          lt: widenedTo,
        },
      },
      {
        dateTo: {
          gte: widenedFrom,
          lt: widenedTo,
        },
      },
      {
        AND: [
          {
            dateFrom: {
              lte: widenedFrom,
            },
          },
          {
            dateTo: {
              gte: widenedTo,
            },
          },
        ],
      },
    ],
  };
}

function clampRate(value: unknown, allowedRates: number[], fallback: number) {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return fallback;
  }

  const rate = toNumber(value);
  return allowedRates.includes(rate) ? rate : fallback;
}

function getWbShareBase(sellerRetailAmount: number, revenue: number) {
  // База для управленческих долей WB — экономический оборот: цена продавца до СПП.
  // `revenue` сохранён как совместимый управленческий alias той же суммы.
  return sellerRetailAmount !== 0 ? sellerRetailAmount : revenue;
}

const WB_COMMISSION_VAT_RATE_FALLBACK = 0.22;

function calculateWbCommissionVatFallback(
  commissionBeforeVat: number,
  savedCommissionVat: unknown
) {
  const savedVat = toNumber(savedCommissionVat);

  if (savedVat !== 0) {
    return savedVat;
  }

  // Старые уже загруженные WB Sales строки были импортированы до появления
  // отдельной колонки «НДС с Вознаграждения WB». Чтобы Dashboard, Telegram
  // и /profit-wb считали одинаково, для таких строк восстанавливаем НДС
  // как 22% от вознаграждения WB без НДС. Новые загрузки берут НДС из отчёта.
  if (commissionBeforeVat !== 0) {
    return commissionBeforeVat * WB_COMMISSION_VAT_RATE_FALLBACK;
  }

  return 0;
}

function calculatePreviousPeriod(dateFrom?: string | null, dateTo?: string | null) {
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

function createDateFilterFromStrings(dateFrom?: string | null, dateTo?: string | null) {
  return dateFrom || dateTo
    ? {
        OR: [
          {
            dateFrom: {
              ...(dateFrom ? { gte: startOfDay(dateFrom) } : {}),
              ...(dateTo ? { lt: nextDayStart(dateTo) } : {}),
            },
          },
          {
            dateTo: {
              ...(dateFrom ? { gte: startOfDay(dateFrom) } : {}),
              ...(dateTo ? { lt: nextDayStart(dateTo) } : {}),
            },
          },
        ],
      }
    : {};
}

function createDateFilterFromDates(dateFrom?: Date | null, dateTo?: Date | null) {
  if (!dateFrom || !dateTo) return {};

  const toExclusive = new Date(dateTo);
  toExclusive.setDate(toExclusive.getDate() + 1);

  return {
    OR: [
      {
        dateFrom: {
          gte: dateFrom,
          lt: toExclusive,
        },
      },
      {
        dateTo: {
          gte: dateFrom,
          lt: toExclusive,
        },
      },
    ],
  };
}

function getInclusiveDateDiff(from: Date, to: Date) {
  const fromStart = startOfDay(from);
  const toStart = startOfDay(to);
  const diff = Math.round((toStart.getTime() - fromStart.getTime()) / 86_400_000) + 1;
  return Math.max(1, diff);
}

function getMaxDate(left: Date, right: Date) {
  return left.getTime() >= right.getTime() ? left : right;
}

function getMinDate(left: Date, right: Date) {
  return left.getTime() <= right.getTime() ? left : right;
}

function prorateSpendByPeriod(
  spend: unknown,
  rowDateFrom: Date | null,
  rowDateTo: Date | null,
  periodFrom: Date,
  periodTo: Date
) {
  const rowFrom = startOfDay(rowDateFrom ?? rowDateTo ?? periodFrom);
  const rowTo = startOfDay(rowDateTo ?? rowDateFrom ?? periodTo);
  const overlapFrom = getMaxDate(rowFrom, periodFrom);
  const overlapTo = getMinDate(rowTo, periodTo);

  if (overlapTo.getTime() < overlapFrom.getTime()) return 0;

  const fullDays = getInclusiveDateDiff(rowFrom, rowTo);
  const overlapDays = getInclusiveDateDiff(overlapFrom, overlapTo);

  return toNumber(spend) * (overlapDays / fullDays);
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

function isWbAdsDeductionReason(value: unknown) {
  const text = normalizeText(value);

  return (
    text.includes("wb продвиж") ||
    text.includes("продвиж") ||
    text.includes("реклам") ||
    text.includes("advert") ||
    text.includes("promotion")
  );
}

function isWbCreditDeductionReason(value: unknown) {
  const text = normalizeText(value);

  return (
    text.includes("кредит") ||
    text.includes("заем") ||
    text.includes("заём") ||
    text.includes("заемщик") ||
    text.includes("заёмщик") ||
    text.includes("счет требований") ||
    text.includes("счёт требований")
  );
}

function classifyWbDeductionReason(value: unknown): "ADS" | "CREDIT" | "OPERATING" | "UNKNOWN" {
  const text = normalizeText(value);

  if (!text) return "UNKNOWN";
  if (isWbAdsDeductionReason(text)) return "ADS";
  if (isWbCreditDeductionReason(text)) return "CREDIT";

  // No broad fallback is allowed here: an unrecognised WB deduction can be
  // financing or another cashflow-only item and therefore must fail closed.
  return "UNKNOWN";
}

export type ProfitAnalyticsRow = {
  nmId: string;
  vendorCode: string;
  subject: string;

  salesQty: number;
  returnsQty: number;
  netSalesQty: number;

  revenue: number;
  taxableRevenue: number;
  revenueSharePercent: number;

  sellerRetailAmount: number;
  sppDiscountAmount: number;
  buyerPaid: number;
  marketplaceTaxTopUp: number;

  sellerPayout: number;

  wbCommission: number;
  wbCommissionBeforeVat: number;
  wbCommissionVat: number;

  logisticsCost: number;
  storageCost: number;
  acceptanceCost: number;

  penaltiesAmount: number;
  deductions: number;
  wbAdsDeduction: number;
  wbCreditDeduction: number;
  wbUnknownDeduction: number;
  wbRawDeduction: number;

  paymentServiceCost: number;
  pvzCompensation: number;
  transportCompensation: number;
  loyaltyDiscountCompensation: number;
  loyaltyParticipationCost: number;
  loyaltyPointsAmount: number;

  adsCost: number;
  drrPercent: number;

  costPrice: number;
  costResolved?: boolean;
  costCoverageIncomplete?: boolean;
  totalCost: number;

  marginProfit: number;
  marginProfitPercent: number;

  taxesAmount: number;

  netProfitAfterTax: number;
  marginAfterTaxPercent: number;

  abcByProfit: "A" | "B" | "C";
};

export type ProfitTotals = {
  salesQty: number;
  returnsQty: number;
  netSalesQty: number;

  revenue: number;
  taxableRevenue: number;

  sellerRetailAmount: number;
  sppDiscountAmount: number;
  buyerPaid: number;
  marketplaceTaxTopUp: number;

  sellerPayout: number;
  officialCashSettlement: number;
  officialCashSettlementAvailable: boolean;
  canonicalPnlSettlement: number;
  cashVsPnlDelta: number;

  wbCommission: number;
  wbCommissionBeforeVat: number;
  wbCommissionVat: number;

  logisticsCost: number;
  storageCost: number;
  acceptanceCost: number;

  penaltiesAmount: number;
  deductions: number;
  wbAdsDeduction: number;
  wbCreditDeduction: number;
  wbUnknownDeduction: number;
  wbRawDeduction: number;
  officialOtherDeductionsTotal: number;
  classifiedAdsDeduction: number;
  classifiedCreditDeduction: number;
  classifiedOperatingDeduction: number;
  classifiedUnknownDeduction: number;
  classifiedDeductionTotal: number;
  unreconciledOfficialDeduction: number;
  deductionCoverageComplete: boolean;

  paymentServiceCost: number;
  pvzCompensation: number;
  transportCompensation: number;
  loyaltyDiscountCompensation: number;
  loyaltyParticipationCost: number;
  loyaltyPointsAmount: number;

  adsCost: number;
  drrPercent: number;
  undistributedAdsCost: number;
  adsReconciliationAmount: number;

  unallocatedLogisticsCost: number;
  unallocatedStorageCost: number;
  unallocatedAcceptanceCost: number;
  unallocatedPenaltiesAmount: number;
  unallocatedOperatingDeductions: number;

  totalCost: number;
  costCoverageIncomplete?: boolean;
  missingCostQty?: number;
  missingCostItemsCount?: number;

  marginProfit: number;
  marginProfitPercent: number;

  taxesAmount: number;
  accountantOrdinarySalesVatInclusive?: number;
  accountantSeparateVatTaxableAmount?: number;
  taxesUnavailable?: boolean;
  taxesUnavailableReason?: string | null;
  netProfitUnavailable?: boolean;
  netProfitUnavailableReason?: string | null;

  netProfitAfterTax: number;
  marginAfterTaxPercent: number;

  usnRate: number;
  vatRate: number;

  dataMode?: "FINAL" | "PRELIMINARY";
  sourceOwnershipMode?: string;
  sourceOwnershipFinal?: boolean;
  sourceOwnershipReasons?: string[];
  missingVendorFinancialImpactRows?: number;
  missingCostFinancialRows?: number;
  missingCanonicalRevenueInputRows?: number;
  estimatedLogisticsCost?: number;
  estimatedStorageCost?: number;
  estimatedAcceptanceCost?: number;
  estimatedPenaltiesAmount?: number;
};

type CostRecord = {
  id?: string | null;
  vendorCode: string;
  nmId?: string | null;
  costPrice: unknown;
  costDate?: Date | null;
  createdAt?: Date | null;
};

type AdMapRecord = {
  campaignName: string;
  vendorCode: string;
};

type WbSaleRecord = {
  id?: string;
  importSessionId?: string | null;
  companyName?: string | null;
  reportNumber?: string | null;
  saleDate?: Date | null;

  nmId: string | null;
  vendorCode: string | null;
  subject: string | null;
  paymentReason: string | null;
  documentType?: string | null;
  quantity: number | null;

  retailPrice: unknown;
  retailPriceWithDiscount: unknown;
  wbRealizedAmount: unknown;
  sellerPayout: unknown;
  sppDiscountAmount: unknown;

  wbReward: unknown;
  wbRewardVat: unknown;
  wbRewardTotal: unknown;

  logisticsCost: unknown;
  storageCost: unknown;
  acceptanceCost: unknown;

  penaltiesAmount: unknown;
  deductions: unknown;
  deductionReason: string | null;

  paymentServiceCost: unknown;
  pvzCompensation: unknown;
  transportCompensation: unknown;
  loyaltyDiscountCompensation: unknown;
  loyaltyParticipationCost: unknown;
  loyaltyPointsAmount: unknown;
};

type WbAdsRecord = {
  campaignName: string | null;
  spend: unknown;
};

type WbFinanceExpenseTotals = {
  hasRows: boolean;
  revenue: number;
  sellerPayout: number;
  storageCost: number;
  acceptanceCost: number;
  penaltiesAmount: number;
  logisticsCost: number;
  deductions: number;
  settlement: number;
  settlementAvailable: boolean;
  logisticsCostByCompanyName: Map<string, number>;
  taxKindFinanceRows: Array<{
    companyName: string | null;
    reportNumber: string | null;
    reportTypeName: string | null;
  }>;
  taxReportKindByKey: Map<string, WbFinanceTaxReportKind | "ambiguous">;
};


function reconcileWbSaleRowsLogisticsToOfficialFinance(
  rows: WbSaleRecord[],
  financeExpenses: WbFinanceExpenseTotals
) {
  if (
    !financeExpenses.hasRows ||
    financeExpenses.logisticsCostByCompanyName.size === 0
  ) {
    return rows;
  }

  const detailedLogisticsByCompanyName = new Map<string, number>();

  for (const row of rows) {
    const companyKey = normalizeText(row.companyName);
    detailedLogisticsByCompanyName.set(
      companyKey,
      (detailedLogisticsByCompanyName.get(companyKey) ?? 0) +
        Math.abs(toNumber(row.logisticsCost))
    );
  }

  return rows.map((row) => {
    const companyKey = normalizeText(row.companyName);
    const officialLogistics =
      financeExpenses.logisticsCostByCompanyName.get(companyKey) ??
      (financeExpenses.logisticsCostByCompanyName.size === 1
        ? financeExpenses.logisticsCostByCompanyName.values().next().value
        : undefined);
    const detailedLogistics =
      detailedLogisticsByCompanyName.get(companyKey) ?? 0;

    if (
      officialLogistics === undefined ||
      detailedLogistics <= 0.000001
    ) {
      return row;
    }

    const scale = officialLogistics / detailedLogistics;

    return {
      ...row,
      logisticsCost: Math.abs(toNumber(row.logisticsCost)) * scale,
    };
  });
}

function buildCostByVendorCode(costs: CostRecord[]) {
  return buildCanonicalPositiveCostLookups(costs).costByVendorCode;
}

function resolveUnitCost(
  costByVendorCode: Map<string, number>,
  vendorCodeKey: string
): number | null {
  if (!vendorCodeKey) return null;
  if (!costByVendorCode.has(vendorCodeKey)) return null;
  return costByVendorCode.get(vendorCodeKey)!;
}

function buildVendorCodesByCampaign(adMaps: AdMapRecord[]) {
  const vendorCodesByCampaign = new Map<string, Set<string>>();

  for (const map of adMaps) {
    const campaignName = normalizeText(map.campaignName);
    const vendorCode = normalizeText(map.vendorCode);

    if (!campaignName || !vendorCode) continue;

    const current = vendorCodesByCampaign.get(campaignName) ?? new Set<string>();
    current.add(vendorCode);
    vendorCodesByCampaign.set(campaignName, current);
  }

  return vendorCodesByCampaign;
}

function buildAdsCostByVendorCode(
  adsRows: WbAdsRecord[],
  vendorCodesByCampaign: Map<string, Set<string>>
) {
  const adsCostByVendorCode = new Map<string, number>();
  let undistributedAdsCost = 0;
  let totalAdsCost = 0;

  for (const ad of adsRows) {
    const campaignName = normalizeText(ad.campaignName);
    const spend = toNumber(ad.spend);

    if (!campaignName || spend === 0) continue;

    totalAdsCost += spend;

    const vendorCodes = Array.from(vendorCodesByCampaign.get(campaignName) ?? []);

    if (vendorCodes.length === 0) {
      undistributedAdsCost += spend;
      continue;
    }

    const spendPerVendorCode = spend / vendorCodes.length;

    for (const vendorCode of vendorCodes) {
      adsCostByVendorCode.set(
        vendorCode,
        (adsCostByVendorCode.get(vendorCode) ?? 0) + spendPerVendorCode
      );
    }
  }

  return {
    adsCostByVendorCode,
    undistributedAdsCost,
    totalAdsCost,
  };
}

function createEmptyTotals(
  usnRate: number,
  vatRate: number,
  undistributedAdsCost = 0
): ProfitTotals {
  return {
    salesQty: 0,
    returnsQty: 0,
    netSalesQty: 0,

    revenue: 0,
    taxableRevenue: 0,
    sellerRetailAmount: 0,
    sppDiscountAmount: 0,
    buyerPaid: 0,
    marketplaceTaxTopUp: 0,
    sellerPayout: 0,
    officialCashSettlement: 0,
    officialCashSettlementAvailable: false,
    canonicalPnlSettlement: 0,
    cashVsPnlDelta: 0,
    wbCommission: 0,
    wbCommissionBeforeVat: 0,
    wbCommissionVat: 0,

    logisticsCost: 0,
    storageCost: 0,
    acceptanceCost: 0,

    penaltiesAmount: 0,
    deductions: 0,
    wbAdsDeduction: 0,
    wbCreditDeduction: 0,
    wbUnknownDeduction: 0,
    wbRawDeduction: 0,
    officialOtherDeductionsTotal: 0,
    classifiedAdsDeduction: 0,
    classifiedCreditDeduction: 0,
    classifiedOperatingDeduction: 0,
    classifiedUnknownDeduction: 0,
    classifiedDeductionTotal: 0,
    unreconciledOfficialDeduction: 0,
    deductionCoverageComplete: true,
    paymentServiceCost: 0,
    pvzCompensation: 0,
    transportCompensation: 0,
    loyaltyDiscountCompensation: 0,
    loyaltyParticipationCost: 0,
    loyaltyPointsAmount: 0,

    adsCost: 0,
    drrPercent: 0,
    undistributedAdsCost,
    adsReconciliationAmount: 0,

    unallocatedLogisticsCost: 0,
    unallocatedStorageCost: 0,
    unallocatedAcceptanceCost: 0,
    unallocatedPenaltiesAmount: 0,
    unallocatedOperatingDeductions: 0,

    totalCost: 0,
    costCoverageIncomplete: false,
    missingCostQty: 0,
    missingCostItemsCount: 0,

    marginProfit: 0,
    marginProfitPercent: 0,

    taxesAmount: 0,
    accountantOrdinarySalesVatInclusive: 0,
    accountantSeparateVatTaxableAmount: 0,
    taxesUnavailable: false,
    taxesUnavailableReason: null,
    netProfitUnavailable: false,
    netProfitUnavailableReason: null,

    netProfitAfterTax: 0,
    marginAfterTaxPercent: 0,

    usnRate,
    vatRate,

    dataMode: "FINAL",
    sourceOwnershipMode: "UNSPECIFIED",
    sourceOwnershipFinal: false,
    sourceOwnershipReasons: [],
    missingVendorFinancialImpactRows: 0,
    missingCostFinancialRows: 0,
    missingCanonicalRevenueInputRows: 0,
    estimatedLogisticsCost: 0,
    estimatedStorageCost: 0,
    estimatedAcceptanceCost: 0,
    estimatedPenaltiesAmount: 0,
  };
}

function calculateAbcByProfit(rows: ProfitAnalyticsRow[]) {
  const totalPositiveProfit = rows.reduce(
    (sum, row) => sum + Math.max(0, row.marginProfit),
    0
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
  wbRows,
  costs,
  adsRows,
  adMaps,
  usnRate,
  vatRate,
  taxRatesByCompanyName,
  wbFinanceTaxReportKindByKey,
}: {
  wbRows: WbSaleRecord[];
  costs: CostRecord[];
  adsRows: WbAdsRecord[];
  adMaps: AdMapRecord[];
  usnRate: number;
  vatRate: number;
  taxRatesByCompanyName: Map<
    string,
    {
      usnRate: number;
      vatRate: number;
    }
  >;
  wbFinanceTaxReportKindByKey?: Map<string, WbFinanceTaxReportKind | "ambiguous">;
}) {
  const reportKindByKey =
    wbFinanceTaxReportKindByKey ?? new Map<string, WbFinanceTaxReportKind | "ambiguous">();
  const taxesByCompanyName = new Map<string, number>();
  const accountantBasesByCompany = new Map<
    string,
    { ordinary: number; separate: number }
  >();
  let taxBlockedReason: string | null = null;
  const costByVendorCode = buildCostByVendorCode(costs);
  const vendorCodesByCampaign = buildVendorCodesByCampaign(adMaps);

  const { adsCostByVendorCode, undistributedAdsCost, totalAdsCost } =
    buildAdsCostByVendorCode(adsRows, vendorCodesByCampaign);

  const grouped = new Map<string, ProfitAnalyticsRow>();

  let unallocatedLogisticsCost = 0;
  let unallocatedStorageCost = 0;
  let unallocatedAcceptanceCost = 0;
  let unallocatedPenaltiesAmount = 0;
  let unallocatedAdsDeduction = 0;
  let unallocatedCreditDeduction = 0;
  let unallocatedOperatingDeductions = 0;
  let unallocatedUnknownDeduction = 0;
  let unallocatedRawDeduction = 0;

  for (const wbRow of wbRows) {
    const vendorCodeKey = normalizeProductCostKey(wbRow.vendorCode);

    if (!vendorCodeKey) {
      unallocatedLogisticsCost += Math.abs(toNumber(wbRow.logisticsCost));
      unallocatedStorageCost += Math.abs(toNumber(wbRow.storageCost));
      unallocatedAcceptanceCost += Math.abs(toNumber(wbRow.acceptanceCost));
      unallocatedPenaltiesAmount += toNumber(wbRow.penaltiesAmount);

      const rawDeduction = Math.abs(toNumber(wbRow.deductions));
      const deductionClass = classifyWbDeductionReason(wbRow.deductionReason);

      unallocatedRawDeduction += rawDeduction;

      if (deductionClass === "ADS") {
        unallocatedAdsDeduction += rawDeduction;
      } else if (deductionClass === "CREDIT") {
        unallocatedCreditDeduction += rawDeduction;
      } else if (deductionClass === "OPERATING") {
        unallocatedOperatingDeductions += rawDeduction;
      } else {
        unallocatedUnknownDeduction += rawDeduction;
      }

      continue;
    }

    const unitCost = resolveUnitCost(costByVendorCode, vendorCodeKey);
    const current =
      grouped.get(vendorCodeKey) ??
      {
        nmId: wbRow.nmId ?? "",
        vendorCode: wbRow.vendorCode ?? "",
        subject: wbRow.subject ?? "",

        salesQty: 0,
        returnsQty: 0,
        netSalesQty: 0,

        revenue: 0,
        taxableRevenue: 0,
        revenueSharePercent: 0,

        sellerRetailAmount: 0,
        sppDiscountAmount: 0,
        buyerPaid: 0,
        marketplaceTaxTopUp: 0,

        sellerPayout: 0,
        wbCommission: 0,
        wbCommissionBeforeVat: 0,
        wbCommissionVat: 0,

        logisticsCost: 0,
        storageCost: 0,
        acceptanceCost: 0,

        penaltiesAmount: 0,
        deductions: 0,
        wbAdsDeduction: 0,
        wbCreditDeduction: 0,
        wbUnknownDeduction: 0,
        wbRawDeduction: 0,
        paymentServiceCost: 0,
        pvzCompensation: 0,
        transportCompensation: 0,
        loyaltyDiscountCompensation: 0,
        loyaltyParticipationCost: 0,
        loyaltyPointsAmount: 0,

        adsCost: adsCostByVendorCode.get(vendorCodeKey) ?? 0,
        drrPercent: 0,

        costPrice: unitCost ?? 0,
        costResolved: unitCost != null,
        costCoverageIncomplete: false,
        totalCost: 0,

        marginProfit: 0,
        marginProfitPercent: 0,

        taxesAmount: 0,

        netProfitAfterTax: 0,
        marginAfterTaxPercent: 0,

        abcByProfit: "C" as const,
      };

    const rowTaxRates =
      taxRatesByCompanyName.get(normalizeText(wbRow.companyName)) ?? {
        usnRate,
        vatRate,
      };

    const productOperation = classifyCanonicalWbProductOperation(wbRow);
    const isWbSaleOperation = productOperation === "SALE";
    const isWbReturnOperation = productOperation === "RETURN";

    const quantity = Math.abs(toNumber(wbRow.quantity));

    if (!current.costResolved) {
      const upgradedUnitCost = resolveUnitCost(
        costByVendorCode,
        vendorCodeKey
      );
      if (upgradedUnitCost != null) {
        current.costPrice = upgradedUnitCost;
        current.costResolved = true;
      }
    }

    const revenueComponents = calculateWbV6RevenueComponents(wbRow);
    const revenueFields =
      buildWbRevenueCompatibilityFields(revenueComponents);
    const sellerRetailAmount = revenueFields.economicTurnover;
    const buyerPaidAmount = revenueComponents.buyerPaid;
    const sellerPayout = revenueComponents.sellerPayout;
    const marketplaceTaxTopUp = revenueComponents.marketplaceTaxTopUp;
    const taxableRevenueAmount = revenueFields.taxableRevenue;
    const sppDiscountAmount = revenueComponents.platformDiscount;

    let wbCommissionBeforeVat = toNumber(wbRow.wbReward);
    let wbCommissionVat = calculateWbCommissionVatFallback(
      wbCommissionBeforeVat,
      wbRow.wbRewardVat
    );
    const wbCommissionTotalRaw = toNumber(wbRow.wbRewardTotal);
    let wbCommissionTotal =
      wbCommissionTotalRaw !== 0
        ? wbCommissionTotalRaw
        : wbCommissionBeforeVat + wbCommissionVat;

    // Управленческий мост V6: экономический оборот − «к перечислению продавцу».
    //
    // В детализированных ежедневных/еженедельных отчетах WB есть отдельные поля
    // «Вознаграждение Вайлдберриз», «НДС с вознаграждения», «комиссия за
    // платежные сервисы» и компенсации. Но они не являются готовым управленческим
    // показателем «Комиссия» из P&L. Например, по отчету 07.07 поле
    // «Вознаграждение WB» может быть отрицательным/компенсационным, тогда как
    // управленческая комиссия равна мосту от выручки к выплате продавцу.
    //
    // Поэтому для P&L и SKU-аналитики берем комиссию из официальных строк отчета
    // как точную разницу официальных полей, а не как оценку:
    //   economic turnover − seller payout.
    // Если явная комиссия уже была положительной и мост недоступен — оставляем ее.
    if (sellerRetailAmount !== 0 && sellerPayout !== 0) {
      const wbCommissionByOfficialFields =
        revenueComponents.prePayoutBridge;

      if (wbCommissionByOfficialFields > 0) {
        wbCommissionTotal = wbCommissionByOfficialFields;
        wbCommissionBeforeVat = wbCommissionByOfficialFields;
        wbCommissionVat = 0;
      }
    }

    if (isWbSaleOperation) {
      current.salesQty += quantity;
      current.netSalesQty += quantity;

      current.sellerRetailAmount += sellerRetailAmount;
      current.revenue += sellerRetailAmount;
      current.taxableRevenue += taxableRevenueAmount;
      current.sppDiscountAmount += sppDiscountAmount;
      current.buyerPaid += buyerPaidAmount;
      current.marketplaceTaxTopUp += marketplaceTaxTopUp;
      current.sellerPayout += sellerPayout;
      current.wbCommissionBeforeVat += wbCommissionBeforeVat;
      current.wbCommissionVat += wbCommissionVat;
      current.wbCommission += wbCommissionTotal;
      if (quantity > 0 && current.costResolved === false) {
        current.costCoverageIncomplete = true;
      } else {
        current.totalCost += current.costPrice * quantity;
      }
      // Tax Formula Parity V1.1: accountant tax inputs use buyerPaid only,
      // routed by durable WbFinance.reportTypeName (ordinary vs buyout).
      // Do not feed V6 taxableRevenue (buyerPaid + marketplaceTaxTopUp).
      try {
        const saleReportKind = resolveWbSaleTaxReportKind({
          companyName: wbRow.companyName,
          reportNumber: wbRow.reportNumber,
          kindByKey: reportKindByKey,
          requireResolved: Math.abs(buyerPaidAmount) > 0,
        });
        const saleTax = calculateWbAccountantTaxContribution({
          buyerPaid: Math.abs(buyerPaidAmount),
          operation: "SALE",
          reportKind: saleReportKind,
          usnRate: rowTaxRates.usnRate,
          vatRate: rowTaxRates.vatRate,
        });
        current.taxesAmount += saleTax.taxAmountDelta;
        const saleCompanyKey = normalizeText(wbRow.companyName) || "__unknown__";
        taxesByCompanyName.set(
          saleCompanyKey,
          (taxesByCompanyName.get(saleCompanyKey) ?? 0) + saleTax.taxAmountDelta
        );
        const saleBases = accountantBasesByCompany.get(saleCompanyKey) ?? {
          ordinary: 0,
          separate: 0,
        };
        saleBases.ordinary += saleTax.ordinarySalesVatInclusiveDelta;
        saleBases.separate += saleTax.separateVatTaxableAmountDelta;
        accountantBasesByCompany.set(saleCompanyKey, saleBases);
      } catch (error) {
        if (error instanceof WbTaxReportKindError) {
          taxBlockedReason = error.code;
        } else {
          throw error;
        }
      }
    }

    if (isWbReturnOperation) {
      const returnSellerRetailAmount = Math.abs(sellerRetailAmount);
      const returnBuyerPaidAmount = Math.abs(buyerPaidAmount);
      const returnMarketplaceTaxTopUp = Math.abs(marketplaceTaxTopUp);
      const returnTaxableRevenueAmount = Math.abs(taxableRevenueAmount);
      const returnSppDiscountAmount = Math.abs(sppDiscountAmount);
      const returnSellerPayout = Math.abs(sellerPayout);
      const returnWbCommissionBeforeVat = Math.abs(wbCommissionBeforeVat);
      const returnWbCommissionVat = Math.abs(wbCommissionVat);
      const returnWbCommissionTotal = Math.abs(wbCommissionTotal);

      current.returnsQty += quantity;
      current.netSalesQty -= quantity;

      current.sellerRetailAmount -= returnSellerRetailAmount;
      current.revenue -= returnSellerRetailAmount;
      current.taxableRevenue -= returnTaxableRevenueAmount;
      current.sppDiscountAmount -= returnSppDiscountAmount;
      current.buyerPaid -= returnBuyerPaidAmount;
      current.marketplaceTaxTopUp -= returnMarketplaceTaxTopUp;
      current.sellerPayout -= returnSellerPayout;
      current.wbCommissionBeforeVat -= returnWbCommissionBeforeVat;
      current.wbCommissionVat -= returnWbCommissionVat;
      current.wbCommission -= returnWbCommissionTotal;
      if (quantity > 0 && current.costResolved === false) {
        current.costCoverageIncomplete = true;
      } else {
        current.totalCost -= current.costPrice * quantity;
      }
      try {
        const returnReportKind = resolveWbSaleTaxReportKind({
          companyName: wbRow.companyName,
          reportNumber: wbRow.reportNumber,
          kindByKey: reportKindByKey,
          requireResolved: Math.abs(returnBuyerPaidAmount) > 0,
        });
        const returnTax = calculateWbAccountantTaxContribution({
          buyerPaid: returnBuyerPaidAmount,
          operation: "RETURN",
          reportKind: returnReportKind,
          usnRate: rowTaxRates.usnRate,
          vatRate: rowTaxRates.vatRate,
        });
        current.taxesAmount += returnTax.taxAmountDelta;
        const returnCompanyKey =
          normalizeText(wbRow.companyName) || "__unknown__";
        taxesByCompanyName.set(
          returnCompanyKey,
          (taxesByCompanyName.get(returnCompanyKey) ?? 0) +
            returnTax.taxAmountDelta
        );
        const returnBases = accountantBasesByCompany.get(returnCompanyKey) ?? {
          ordinary: 0,
          separate: 0,
        };
        returnBases.ordinary += returnTax.ordinarySalesVatInclusiveDelta;
        returnBases.separate += returnTax.separateVatTaxableAmountDelta;
        accountantBasesByCompany.set(returnCompanyKey, returnBases);
      } catch (error) {
        if (error instanceof WbTaxReportKindError) {
          taxBlockedReason = error.code;
        } else {
          throw error;
        }
      }
    }

    current.logisticsCost += Math.abs(toNumber(wbRow.logisticsCost));
    current.storageCost += Math.abs(toNumber(wbRow.storageCost));
    current.acceptanceCost += Math.abs(toNumber(wbRow.acceptanceCost));

    current.penaltiesAmount += toNumber(wbRow.penaltiesAmount);

    const rawDeduction = Math.abs(toNumber(wbRow.deductions));
    const deductionClass = classifyWbDeductionReason(wbRow.deductionReason);

    current.wbRawDeduction += rawDeduction;

    if (deductionClass === "ADS") {
      current.wbAdsDeduction += rawDeduction;
    } else if (deductionClass === "CREDIT") {
      current.wbCreditDeduction += rawDeduction;
    } else if (deductionClass === "OPERATING") {
      current.deductions += rawDeduction;
    } else {
      // Если вид удержания не сохранён, не вычитаем его в unit-экономике автоматически.
      // Иначе можно задвоить WB Продвижение или кредит.
      current.wbUnknownDeduction += rawDeduction;
    }

    current.paymentServiceCost += Math.abs(toNumber(wbRow.paymentServiceCost));
    current.pvzCompensation += Math.abs(toNumber(wbRow.pvzCompensation));
    current.transportCompensation += Math.abs(toNumber(wbRow.transportCompensation));
    current.loyaltyDiscountCompensation += toNumber(
      wbRow.loyaltyDiscountCompensation
    );
    current.loyaltyParticipationCost += Math.abs(
      toNumber(wbRow.loyaltyParticipationCost)
    );
    current.loyaltyPointsAmount += Math.abs(toNumber(wbRow.loyaltyPointsAmount));

    // Для управленческой прибыли берём официальное «к перечислению продавцу»
    // и уже от него вычитаем себестоимость, логистику, хранение, удержания, рекламу и налоги.
    // Комиссия/компенсация WB, СПП, платёжные услуги и ПВЗ показываются отдельно как расшифровка
    // перехода от цены продавца к выплате, но не вычитаются второй раз.
    current.marginProfit =
      current.sellerPayout -
      current.totalCost -
      current.logisticsCost -
      current.storageCost -
      current.acceptanceCost -
      current.penaltiesAmount -
      current.deductions -
      current.adsCost;

    const currentShareBase = getWbShareBase(
      current.sellerRetailAmount,
      current.revenue
    );

    current.marginProfitPercent =
      currentShareBase > 0 ? (current.marginProfit / currentShareBase) * 100 : 0;

    current.drrPercent =
      currentShareBase > 0 ? (current.adsCost / currentShareBase) * 100 : 0;

    current.netProfitAfterTax = current.marginProfit - current.taxesAmount;

    current.marginAfterTaxPercent =
      currentShareBase > 0
        ? (current.netProfitAfterTax / currentShareBase) * 100
        : 0;

    grouped.set(vendorCodeKey, current);
  }

  const rows = Array.from(grouped.values())
    .filter(
      (row) =>
        row.salesQty !== 0 ||
        row.returnsQty !== 0 ||
        row.netSalesQty !== 0 ||
        row.revenue !== 0 ||
        row.sellerRetailAmount !== 0 ||
        row.sellerPayout !== 0 ||
        row.logisticsCost !== 0 ||
        row.storageCost !== 0 ||
        row.acceptanceCost !== 0 ||
        row.penaltiesAmount !== 0 ||
        row.deductions !== 0 ||
        row.wbAdsDeduction !== 0 ||
        row.wbCreditDeduction !== 0 ||
        row.wbUnknownDeduction !== 0 ||
        row.wbRawDeduction !== 0 ||
        row.adsCost !== 0 ||
        row.totalCost !== 0 ||
        row.taxesAmount !== 0
    )
    .sort((a, b) => b.marginProfit - a.marginProfit);

  calculateAbcByProfit(rows);

  const totalShareBase = rows.reduce(
    (sum, row) =>
      sum + getWbShareBase(row.sellerRetailAmount, row.revenue),
    0
  );

  rows.forEach((row) => {
    const rowShareBase = getWbShareBase(
      row.sellerRetailAmount,
      row.revenue
    );
    row.revenueSharePercent =
      totalShareBase > 0 ? (rowShareBase / totalShareBase) * 100 : 0;
  });

  const totals = rows.reduce(
    (acc, row) => {
      acc.salesQty += row.salesQty;
      acc.returnsQty += row.returnsQty;
      acc.netSalesQty += row.netSalesQty;

      acc.revenue += row.revenue;
      acc.taxableRevenue += row.taxableRevenue;
      acc.sellerRetailAmount += row.sellerRetailAmount;
      acc.sppDiscountAmount += row.sppDiscountAmount;
      acc.buyerPaid += row.buyerPaid;
      acc.marketplaceTaxTopUp += row.marketplaceTaxTopUp;
      acc.sellerPayout += row.sellerPayout;
      acc.wbCommission += row.wbCommission;
      acc.wbCommissionBeforeVat += row.wbCommissionBeforeVat;
      acc.wbCommissionVat += row.wbCommissionVat;

      acc.logisticsCost += row.logisticsCost;
      acc.storageCost += row.storageCost;
      acc.acceptanceCost += row.acceptanceCost;

      acc.penaltiesAmount += row.penaltiesAmount;
      acc.deductions += row.deductions;
      acc.wbAdsDeduction += row.wbAdsDeduction;
      acc.wbCreditDeduction += row.wbCreditDeduction;
      acc.wbUnknownDeduction += row.wbUnknownDeduction;
      acc.wbRawDeduction += row.wbRawDeduction;
      acc.paymentServiceCost += row.paymentServiceCost;
      acc.pvzCompensation += row.pvzCompensation;
      acc.transportCompensation += row.transportCompensation;
      acc.loyaltyDiscountCompensation += row.loyaltyDiscountCompensation;
      acc.loyaltyParticipationCost += row.loyaltyParticipationCost;
      acc.loyaltyPointsAmount += row.loyaltyPointsAmount;

      acc.adsCost += row.adsCost;
      acc.totalCost += row.totalCost;
      if (row.costCoverageIncomplete) {
        acc.costCoverageIncomplete = true;
        acc.missingCostQty =
          (acc.missingCostQty ?? 0) + row.salesQty + row.returnsQty;
        acc.missingCostItemsCount =
          (acc.missingCostItemsCount ?? 0) + 1;
      }
      acc.marginProfit += row.marginProfit;
      acc.taxesAmount += row.taxesAmount;
      acc.netProfitAfterTax += row.netProfitAfterTax;

      return acc;
    },
    createEmptyTotals(usnRate, vatRate, undistributedAdsCost)
  );

  const distributedAdsCost = totals.adsCost;
  const apiAdsCost = totalAdsCost;

  totals.unallocatedLogisticsCost = unallocatedLogisticsCost;
  totals.unallocatedStorageCost = unallocatedStorageCost;
  totals.unallocatedAcceptanceCost = unallocatedAcceptanceCost;
  totals.unallocatedPenaltiesAmount = unallocatedPenaltiesAmount;
  totals.unallocatedOperatingDeductions = unallocatedOperatingDeductions;

  totals.logisticsCost += unallocatedLogisticsCost;
  totals.storageCost += unallocatedStorageCost;
  totals.acceptanceCost += unallocatedAcceptanceCost;
  totals.penaltiesAmount += unallocatedPenaltiesAmount;
  totals.deductions += unallocatedOperatingDeductions;
  totals.wbAdsDeduction += unallocatedAdsDeduction;
  totals.wbCreditDeduction += unallocatedCreditDeduction;
  totals.wbUnknownDeduction += unallocatedUnknownDeduction;
  totals.wbRawDeduction += unallocatedRawDeduction;

  // V4 HYBRID: полный дедуплицированный WB Ads API — расход периода.
  // Удержание «WB Продвижение» остаётся официальной сверкой периода и не
  // заменяет расход API датой проводки одного финансового документа.
  const canonicalAdsCost = apiAdsCost;

  totals.adsReconciliationAmount = totals.wbAdsDeduction - canonicalAdsCost;
  totals.undistributedAdsCost = Math.max(0, canonicalAdsCost - distributedAdsCost);
  totals.adsCost = canonicalAdsCost;

  const nonRowExpenseAdjustment =
    unallocatedLogisticsCost +
    unallocatedStorageCost +
    unallocatedAcceptanceCost +
    unallocatedPenaltiesAmount +
    unallocatedOperatingDeductions +
    totals.undistributedAdsCost;

  totals.marginProfit -= nonRowExpenseAdjustment;

  let accountantOrdinarySalesVatInclusive = 0;
  let accountantSeparateVatTaxableAmount = 0;
  for (const bases of accountantBasesByCompany.values()) {
    accountantOrdinarySalesVatInclusive += bases.ordinary;
    accountantSeparateVatTaxableAmount += bases.separate;
  }
  totals.accountantOrdinarySalesVatInclusive = accountantOrdinarySalesVatInclusive;
  totals.accountantSeparateVatTaxableAmount = accountantSeparateVatTaxableAmount;

  if (taxBlockedReason) {
    // Fail-closed for unresolved/ambiguous taxable report kinds: never emit a
    // silent FINAL numeric tax. UI remains renderable as PRELIMINARY/unavailable.
    for (const row of rows) {
      row.taxesAmount = 0;
      row.netProfitAfterTax = row.marginProfit;
    }
    taxesByCompanyName.clear();
    totals.taxesAmount = 0;
    totals.accountantOrdinarySalesVatInclusive = 0;
    totals.accountantSeparateVatTaxableAmount = 0;
    totals.taxesUnavailable = true;
    totals.taxesUnavailableReason = taxBlockedReason;
    totals.netProfitUnavailable = true;
    totals.netProfitUnavailableReason = taxBlockedReason;
    totals.netProfitAfterTax = totals.marginProfit;
    totals.dataMode = "PRELIMINARY";
    totals.sourceOwnershipFinal = false;
    if (!totals.sourceOwnershipReasons?.includes(taxBlockedReason)) {
      totals.sourceOwnershipReasons = [
        ...(totals.sourceOwnershipReasons ?? []),
        taxBlockedReason,
      ];
    }
  } else {
    // V1.2: round payable tax once per legal entity, then sum for ALL.
    totals.taxesAmount = aggregateRoundedWbTaxLiabilities([
      ...taxesByCompanyName.values(),
    ]);
    totals.netProfitAfterTax = totals.marginProfit - totals.taxesAmount;
  }

  const totalsShareBase = getWbShareBase(
    totals.sellerRetailAmount,
    totals.revenue
  );

  totals.marginProfitPercent =
    totalsShareBase > 0 ? (totals.marginProfit / totalsShareBase) * 100 : 0;

  totals.marginAfterTaxPercent =
    totalsShareBase > 0
      ? (totals.netProfitAfterTax / totalsShareBase) * 100
      : 0;

  totals.drrPercent =
    totalsShareBase > 0 ? (totals.adsCost / totalsShareBase) * 100 : 0;

  if (totals.costCoverageIncomplete) {
    totals.dataMode = "PRELIMINARY";
  }

  return {
    rows,
    totals,
  };
}

const WB_SALE_ANALYTICS_SELECT = {
  id: true,
  importSessionId: true,
  companyName: true,
  reportNumber: true,
  saleDate: true,
  nmId: true,
  vendorCode: true,
  subject: true,
  paymentReason: true,
  documentType: true,
  quantity: true,
  retailPrice: true,
  retailPriceWithDiscount: true,
  wbRealizedAmount: true,
  sellerPayout: true,
  sppDiscountAmount: true,
  wbReward: true,
  wbRewardVat: true,
  wbRewardTotal: true,
  logisticsCost: true,
  storageCost: true,
  acceptanceCost: true,
  penaltiesAmount: true,
  deductions: true,
  deductionReason: true,
  paymentServiceCost: true,
  pvzCompensation: true,
  transportCompensation: true,
  loyaltyDiscountCompensation: true,
  loyaltyParticipationCost: true,
  loyaltyPointsAmount: true,
} as const;

async function findLatestWbSaleRowsBySaleDate(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
  reportTypes?: string[];
}) {
  const saleDateWhere =
    params?.dateFrom || params?.dateTo
      ? {
          ...(params?.dateFrom
            ? { gte: startOfMoscowDayUtc(params.dateFrom) }
            : {}),
          ...(params?.dateTo
            ? { lt: nextMoscowDayStartUtc(params.dateTo) }
            : {}),
        }
      : undefined;

  const importSessions = await prisma.importSession.findMany({
    where: {
      ...(params?.companyName ? { companyName: params.companyName } : {}),
      reportType: {
        in: params?.reportTypes ?? ["WB_SALES_DAILY"],
      },
      status: "SUCCESS",
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      id: true,
      fileName: true,
      companyName: true,
    },
  });

  const latestSessionByFileName = new Map<string, string>();

  for (const session of importSessions) {
    const sessionKey = [session.companyName ?? "", session.fileName].join("__");

    if (!latestSessionByFileName.has(sessionKey)) {
      latestSessionByFileName.set(sessionKey, session.id);
    }
  }

  const latestImportSessionIds = Array.from(latestSessionByFileName.values());

  if (latestImportSessionIds.length === 0) {
    return [];
  }

  return prisma.wbSale.findMany({
    where: {
      ...(params?.companyName ? { companyName: params.companyName } : {}),
      ...(saleDateWhere ? { saleDate: saleDateWhere } : {}),
      importSessionId: {
        in: latestImportSessionIds,
      },
    },
    select: WB_SALE_ANALYTICS_SELECT,
    orderBy: {
      saleDate: "desc",
    },
  });
}

async function findPreferredWbSaleRowsBySaleDate(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
}) {
  const wbSalesRows = await findLatestWbSaleRowsBySaleDate({
    ...params,
    reportTypes: ["WB_SALES"],
  });

  const operationalRows = await findLatestWbSaleRowsBySaleDate({
    ...params,
    reportTypes: ["WB_SALES_OPERATIONAL"],
  });

  const dailyRows = await findLatestWbSaleRowsBySaleDate({
    ...params,
    reportTypes: ["WB_SALES_DAILY"],
  });

  const wbSalesDayKeys = new Set(
    wbSalesRows.map((row) =>
      [
        row.companyName ?? params?.companyName ?? "",
        getMoscowDateKey(row.saleDate),
      ].join("__")
    )
  );

  const operationalFallbackRows = operationalRows.filter((row) => {
    const key = [
      row.companyName ?? params?.companyName ?? "",
      getMoscowDateKey(row.saleDate),
    ].join("__");

    return !wbSalesDayKeys.has(key);
  });

  const detailedDayKeys = new Set([
    ...wbSalesDayKeys,
    ...operationalFallbackRows.map((row) =>
      [
        row.companyName ?? params?.companyName ?? "",
        getMoscowDateKey(row.saleDate),
      ].join("__")
    ),
  ]);

  const dailyFallbackRows = dailyRows.filter((row) => {
    const key = [
      row.companyName ?? params?.companyName ?? "",
      getMoscowDateKey(row.saleDate),
    ].join("__");

    return !detailedDayKeys.has(key);
  });

  return [
    ...wbSalesRows,
    ...operationalFallbackRows,
    ...dailyFallbackRows,
  ].sort(
    (left, right) =>
      (right.saleDate?.getTime() ?? 0) -
      (left.saleDate?.getTime() ?? 0)
  );
}

async function findWbSaleRowsByPeriod(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
}) {
  // Канонический приоритет по компании и московскому дню:
  // WB_SALES -> WB_SALES_OPERATIONAL fallback -> WB_SALES_DAILY fallback.
  //
  // WbFinance остаётся источником официальных общих расходов, но больше не
  // управляет выбором строк продаж и удержаний. Иначе документы
  // «WB Продвижение» без продаж могут выпадать из общего P&L.
  return findPreferredWbSaleRowsBySaleDate(params);
}

async function findAdsRowsByPeriod(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
}) {
  const selectedRange = buildDateKeyRange(params?.dateFrom, params?.dateTo);
  const fromUtc = params?.dateFrom
    ? startOfMoscowDayUtc(params.dateFrom)
    : null;
  const toExclusiveUtc = params?.dateTo
    ? nextMoscowDayStartUtc(params.dateTo)
    : null;

  const dateOverlapFilter =
    fromUtc && toExclusiveUtc
      ? {
          AND: [
            { dateFrom: { lt: toExclusiveUtc } },
            { dateTo: { gte: fromUtc } },
          ],
        }
      : fromUtc
        ? { dateTo: { gte: fromUtc } }
        : toExclusiveUtc
          ? { dateFrom: { lt: toExclusiveUtc } }
          : {};

  const rows = await prisma.wbAds.findMany({
    where: {
      ...dateOverlapFilter,
      ...(params?.companyName ? { companyName: params.companyName } : {}),
    },
  });

  // V4 HYBRID: удаляем только полностью идентичные рекламные строки.
  // Технические id/importSessionId/createdAt намеренно не входят в ключ.
  const uniqueRows = Array.from(
    new Map(
      rows.map((row) => {
        const key = JSON.stringify([
          normalizeText(row.companyName),
          String(row.campaignId ?? ""),
          normalizeText(row.campaignName),
          getMoscowDateKey(row.dateFrom),
          getMoscowDateKey(row.dateTo ?? row.dateFrom),
          toNumber(row.spend),
          toNumber(row.impressions),
          toNumber(row.clicks),
          toNumber(row.ctr),
          toNumber(row.cpc),
        ]);

        return [key, row] as const;
      })
    ).values()
  );

  if (!selectedRange) return uniqueRows;

  return uniqueRows
    .map((row) => {
      const rowFromKey = getMoscowDateKey(row.dateFrom);
      const rowToKey = getMoscowDateKey(row.dateTo ?? row.dateFrom);

      if (rowFromKey === "unknown" || rowToKey === "unknown") {
        return { ...row, spend: 0 };
      }

      const rowStart = Math.min(
        dateKeyToDayNumber(rowFromKey),
        dateKeyToDayNumber(rowToKey)
      );
      const rowEnd = Math.max(
        dateKeyToDayNumber(rowFromKey),
        dateKeyToDayNumber(rowToKey)
      );
      const overlapStart = Math.max(rowStart, selectedRange.start);
      const overlapEnd = Math.min(rowEnd, selectedRange.end);

      if (overlapEnd < overlapStart) {
        return { ...row, spend: 0 };
      }

      const fullDays = Math.max(1, rowEnd - rowStart + 1);
      const overlapDays = overlapEnd - overlapStart + 1;

      return {
        ...row,
        spend: toNumber(row.spend) * (overlapDays / fullDays),
      };
    })
    .filter((row) => toNumber(row.spend) !== 0);
}

async function findWbFinanceExpenseTotalsByPeriod(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
}): Promise<WbFinanceExpenseTotals> {
  const rawRows = await prisma.wbFinance.findMany({
    where: {
      ...createWideWbFinanceDateFilter(params),
      ...(params?.companyName ? { companyName: params.companyName } : {}),
    },
    select: {
      companyName: true,
      reportNumber: true,
      reportTypeName: true,
      dateFrom: true,
      dateTo: true,
      salesAmount: true,
      payoutAmount: true,
      logisticsCost: true,
      storageCost: true,
      acceptanceCost: true,
      penaltiesAmount: true,
      otherDeductions: true,
      totalToPay: true,
    },
  });

  const taxKindFinanceRows = rawRows.map((row) => ({
    companyName: row.companyName,
    reportNumber: row.reportNumber,
    reportTypeName: row.reportTypeName,
  }));

  const rows = params?.companyName
    ? selectPreferredWbFinanceRows(rawRows, params)
    : Array.from(
        rawRows.reduce((byCompany, row) => {
          const key = normalizeText(row.companyName);
          const current = byCompany.get(key) ?? [];
          current.push(row);
          byCompany.set(key, current);
          return byCompany;
        }, new Map<string, typeof rawRows>())
      ).flatMap(([, companyRows]) =>
        selectPreferredWbFinanceRows(companyRows, params)
      );
  const logisticsCostByCompanyName = new Map<string, number>();

  const totals = rows.reduce(
    (acc, row) => {
      acc.revenue += toNumber(row.salesAmount);
      acc.sellerPayout += toNumber(row.payoutAmount);
      acc.logisticsCost += toNumber(row.logisticsCost);
      acc.storageCost += toNumber(row.storageCost);
      acc.acceptanceCost += toNumber(row.acceptanceCost);
      acc.penaltiesAmount += toNumber(row.penaltiesAmount);
      acc.deductions += toNumber(row.otherDeductions);
      acc.settlement += toNumber(row.totalToPay);
      acc.settlementAvailable ||= row.totalToPay !== null;

      const companyKey = normalizeText(row.companyName);
      logisticsCostByCompanyName.set(
        companyKey,
        (logisticsCostByCompanyName.get(companyKey) ?? 0) +
          toNumber(row.logisticsCost)
      );

      return acc;
    },
    {
      hasRows: rows.length > 0,
      revenue: 0,
      sellerPayout: 0,
      logisticsCost: 0,
      storageCost: 0,
      acceptanceCost: 0,
      penaltiesAmount: 0,
      deductions: 0,
      settlement: 0,
      settlementAvailable: false,
      logisticsCostByCompanyName,
      taxKindFinanceRows,
      taxReportKindByKey: new Map<string, WbFinanceTaxReportKind | "ambiguous">(),
    }
  );

  return totals;
}

function applyWbFinanceExpenseTotals(
  result: {
    rows: ProfitAnalyticsRow[];
    totals: ProfitTotals;
  },
  financeExpenses: WbFinanceExpenseTotals
) {
  // V6: продажи задают три разные суммы: экономический оборот, оплату
  // покупателями и налоговую выручку. WbFinance не заменяет ни одну из них.
  const economicTurnover = result.totals.sellerRetailAmount;
  const officialOtherDeductions = Math.abs(financeExpenses.deductions);
  const campaignAdsCost = result.totals.adsCost;
  const deductionReconciliation = buildWbDeductionReconciliation({
    officialOtherDeductionsTotal: officialOtherDeductions,
    classifiedAdsDeduction: result.totals.wbAdsDeduction,
    classifiedCreditDeduction: result.totals.wbCreditDeduction,
    classifiedOperatingDeduction: result.totals.deductions,
    classifiedUnknownDeduction: result.totals.wbUnknownDeduction,
  });
  const externalAdsCost =
    deductionReconciliation.classifiedAdsDeduction > 0
      ? 0
      : campaignAdsCost;

  result.totals.sellerPayout = financeExpenses.sellerPayout;
  result.totals.logisticsCost = financeExpenses.logisticsCost;
  result.totals.storageCost = financeExpenses.storageCost;
  result.totals.acceptanceCost = financeExpenses.acceptanceCost;
  result.totals.penaltiesAmount = financeExpenses.penaltiesAmount;
  result.totals.deductions =
    deductionReconciliation.classifiedOperatingDeduction;
  result.totals.adsCost =
    deductionReconciliation.classifiedAdsDeduction > 0
      ? deductionReconciliation.classifiedAdsDeduction
      : campaignAdsCost;
  result.totals.adsReconciliationAmount =
    deductionReconciliation.classifiedAdsDeduction - campaignAdsCost;
  result.totals.officialOtherDeductionsTotal =
    deductionReconciliation.officialOtherDeductionsTotal;
  result.totals.classifiedAdsDeduction =
    deductionReconciliation.classifiedAdsDeduction;
  result.totals.classifiedCreditDeduction =
    deductionReconciliation.classifiedCreditDeduction;
  result.totals.classifiedOperatingDeduction =
    deductionReconciliation.classifiedOperatingDeduction;
  result.totals.classifiedUnknownDeduction =
    deductionReconciliation.classifiedUnknownDeduction;
  result.totals.classifiedDeductionTotal =
    deductionReconciliation.classifiedTotal;
  result.totals.unreconciledOfficialDeduction =
    deductionReconciliation.unreconciledOfficialDeduction;
  result.totals.deductionCoverageComplete =
    deductionReconciliation.isFullyReconciled;

  // Точный мост V6: цена продавца до платформенной скидки − выплата продавцу.
  // Эту сумму не вычитаем второй раз из прибыли.
  if (economicTurnover !== 0 || result.totals.sellerPayout !== 0) {
    const wbCommissionBridge =
      economicTurnover - result.totals.sellerPayout;
    result.totals.wbCommission = wbCommissionBridge;
    result.totals.wbCommissionBeforeVat = wbCommissionBridge;
    result.totals.wbCommissionVat = 0;
  }

  const settlements = buildWbClosedWeekSettlement({
    officialCashSettlement: financeExpenses.settlement,
    canonical: {
      sellerPayout: result.totals.sellerPayout,
      officialLogistics: result.totals.logisticsCost,
      officialStorage: result.totals.storageCost,
      officialAcceptance: result.totals.acceptanceCost,
      officialPenalties: result.totals.penaltiesAmount,
      classifiedPnlAds: deductionReconciliation.classifiedAdsDeduction,
      classifiedPnlOperating:
        deductionReconciliation.classifiedOperatingDeduction,
    },
  });
  result.totals.officialCashSettlement =
    settlements.officialCashSettlement;
  result.totals.officialCashSettlementAvailable =
    financeExpenses.settlementAvailable;
  result.totals.canonicalPnlSettlement =
    settlements.canonicalPnlSettlement;
  result.totals.cashVsPnlDelta = settlements.cashVsPnlDelta;

  result.totals.marginProfit =
    result.totals.canonicalPnlSettlement -
    result.totals.totalCost -
    externalAdsCost;
  result.totals.netProfitAfterTax = calculateClosedWeekWbProfit({
    canonicalPnlSettlement: result.totals.canonicalPnlSettlement,
    canonicalCogs: result.totals.totalCost,
    taxes: result.totals.taxesAmount,
    externalPnlCosts: externalAdsCost,
  });
  if (!deductionReconciliation.isFullyReconciled) {
    result.totals.dataMode = "PRELIMINARY";
  }

  const shareBase = getWbShareBase(
    result.totals.sellerRetailAmount,
    result.totals.revenue
  );

  result.totals.marginProfitPercent =
    shareBase > 0
      ? (result.totals.marginProfit / shareBase) * 100
      : 0;

  result.totals.marginAfterTaxPercent =
    shareBase > 0
      ? (result.totals.netProfitAfterTax / shareBase) * 100
      : 0;

  // DRR_SOURCE_ECONOMIC_TURNOVER:
  // главный ДРР WB считаем от экономического оборота / цены продавца, а не от налоговой выручки.
  result.totals.drrPercent =
    shareBase > 0
      ? (result.totals.adsCost / shareBase) * 100
      : 0;

  return result;
}

type WbOperationalExpenseRates = {
  hasRates: boolean;
  logisticsPerSaleQty: number;
  storagePerSaleQty: number;
  acceptancePerSaleQty: number;
  penaltiesPerSaleQty: number;
};

function recalculateProfitRow(row: ProfitAnalyticsRow) {
  row.marginProfit =
    row.sellerPayout -
    row.totalCost -
    row.logisticsCost -
    row.storageCost -
    row.acceptanceCost -
    row.penaltiesAmount -
    row.deductions -
    row.adsCost;

  const rowShareBase = getWbShareBase(row.sellerRetailAmount, row.revenue);

  row.marginProfitPercent =
    rowShareBase > 0 ? (row.marginProfit / rowShareBase) * 100 : 0;
  row.drrPercent =
    rowShareBase > 0 ? (row.adsCost / rowShareBase) * 100 : 0;
  row.netProfitAfterTax = row.marginProfit - row.taxesAmount;
  row.marginAfterTaxPercent =
    rowShareBase > 0 ? (row.netProfitAfterTax / rowShareBase) * 100 : 0;
}

function recalculateTotalsFromRows(
  rows: ProfitAnalyticsRow[],
  previousTotals: ProfitTotals,
  usnRate: number,
  vatRate: number
): ProfitTotals {
  const totals = rows.reduce((acc, row) => {
    acc.salesQty += row.salesQty;
    acc.returnsQty += row.returnsQty;
    acc.netSalesQty += row.netSalesQty;
    acc.revenue += row.revenue;
    acc.taxableRevenue += row.taxableRevenue;
    acc.sellerRetailAmount += row.sellerRetailAmount;
    acc.sppDiscountAmount += row.sppDiscountAmount;
    acc.buyerPaid += row.buyerPaid;
    acc.marketplaceTaxTopUp += row.marketplaceTaxTopUp;
    acc.sellerPayout += row.sellerPayout;
    acc.wbCommission += row.wbCommission;
    acc.wbCommissionBeforeVat += row.wbCommissionBeforeVat;
    acc.wbCommissionVat += row.wbCommissionVat;
    acc.logisticsCost += row.logisticsCost;
    acc.storageCost += row.storageCost;
    acc.acceptanceCost += row.acceptanceCost;
    acc.penaltiesAmount += row.penaltiesAmount;
    acc.deductions += row.deductions;
    acc.wbAdsDeduction += row.wbAdsDeduction;
    acc.wbCreditDeduction += row.wbCreditDeduction;
    acc.wbUnknownDeduction += row.wbUnknownDeduction;
    acc.wbRawDeduction += row.wbRawDeduction;
    acc.paymentServiceCost += row.paymentServiceCost;
    acc.pvzCompensation += row.pvzCompensation;
    acc.transportCompensation += row.transportCompensation;
    acc.loyaltyDiscountCompensation += row.loyaltyDiscountCompensation;
    acc.loyaltyParticipationCost += row.loyaltyParticipationCost;
    acc.loyaltyPointsAmount += row.loyaltyPointsAmount;
    acc.adsCost += row.adsCost;
    acc.totalCost += row.totalCost;
    if (row.costCoverageIncomplete) {
      acc.costCoverageIncomplete = true;
      acc.missingCostQty =
        (acc.missingCostQty ?? 0) + row.salesQty + row.returnsQty;
      acc.missingCostItemsCount =
        (acc.missingCostItemsCount ?? 0) + 1;
    }
    acc.marginProfit += row.marginProfit;
    acc.taxesAmount += row.taxesAmount;
    acc.netProfitAfterTax += row.netProfitAfterTax;

    return acc;
  }, createEmptyTotals(usnRate, vatRate, previousTotals.undistributedAdsCost));

  const distributedAdsCost = totals.adsCost;

  totals.dataMode = previousTotals.dataMode;
  totals.estimatedLogisticsCost = previousTotals.estimatedLogisticsCost ?? 0;
  totals.estimatedStorageCost = previousTotals.estimatedStorageCost ?? 0;
  totals.estimatedAcceptanceCost = previousTotals.estimatedAcceptanceCost ?? 0;
  totals.estimatedPenaltiesAmount = previousTotals.estimatedPenaltiesAmount ?? 0;

  totals.unallocatedLogisticsCost =
    previousTotals.unallocatedLogisticsCost ?? 0;
  totals.unallocatedStorageCost = previousTotals.unallocatedStorageCost ?? 0;
  totals.unallocatedAcceptanceCost = previousTotals.unallocatedAcceptanceCost ?? 0;
  totals.unallocatedPenaltiesAmount = previousTotals.unallocatedPenaltiesAmount ?? 0;
  totals.unallocatedOperatingDeductions =
    previousTotals.unallocatedOperatingDeductions ?? 0;
  totals.adsReconciliationAmount = previousTotals.adsReconciliationAmount ?? 0;
  totals.undistributedAdsCost = previousTotals.undistributedAdsCost ?? 0;

  totals.logisticsCost += totals.unallocatedLogisticsCost;
  totals.storageCost += totals.unallocatedStorageCost;
  totals.acceptanceCost += totals.unallocatedAcceptanceCost;
  totals.penaltiesAmount += totals.unallocatedPenaltiesAmount;
  totals.deductions += totals.unallocatedOperatingDeductions;

  totals.wbAdsDeduction = previousTotals.wbAdsDeduction;
  totals.wbCreditDeduction = previousTotals.wbCreditDeduction;
  totals.wbUnknownDeduction = previousTotals.wbUnknownDeduction;
  totals.wbRawDeduction = previousTotals.wbRawDeduction;
  totals.adsCost = previousTotals.adsCost;

  const nonRowExpenseAdjustment =
    totals.unallocatedLogisticsCost +
    totals.unallocatedStorageCost +
    totals.unallocatedAcceptanceCost +
    totals.unallocatedPenaltiesAmount +
    totals.unallocatedOperatingDeductions +
    (totals.adsCost - distributedAdsCost);

  totals.marginProfit -= nonRowExpenseAdjustment;
  totals.netProfitAfterTax = totals.marginProfit - totals.taxesAmount;

  const totalsShareBase = getWbShareBase(totals.sellerRetailAmount, totals.revenue);

  totals.marginProfitPercent = totalsShareBase > 0 ? (totals.marginProfit / totalsShareBase) * 100 : 0;
  totals.marginAfterTaxPercent =
    totalsShareBase > 0 ? (totals.netProfitAfterTax / totalsShareBase) * 100 : 0;
  totals.drrPercent = totalsShareBase > 0 ? (totals.adsCost / totalsShareBase) * 100 : 0;

  return totals;
}

async function findLatestWbOperationalExpenseRates(params?: {
  companyName?: string | null;
  anchorDate?: string | null;
}): Promise<WbOperationalExpenseRates> {
  const anchor = params?.anchorDate
    ? startOfDay(params.anchorDate)
    : startOfDay(new Date());
  const from = new Date(anchor);
  from.setDate(from.getDate() - 34);

  const rows = await findLatestWbSaleRowsBySaleDate({
    companyName: params?.companyName,
    dateFrom: from.toISOString().slice(0, 10),
    dateTo: anchor.toISOString().slice(0, 10),
    reportTypes: ["WB_SALES"],
  });

  let saleQty = 0;
  let logisticsCost = 0;
  let storageCost = 0;
  let acceptanceCost = 0;
  let penaltiesAmount = 0;

  for (const row of rows) {
    if (
      classifyCanonicalWbProductOperation(row) === "SALE"
    ) {
      saleQty += Math.abs(toNumber(row.quantity)) || 1;
    }

    logisticsCost += Math.abs(toNumber(row.logisticsCost));
    storageCost += Math.abs(toNumber(row.storageCost));
    acceptanceCost += Math.abs(toNumber(row.acceptanceCost));
    penaltiesAmount += Math.abs(toNumber(row.penaltiesAmount));
  }

  if (saleQty <= 0) {
    return {
      hasRates: false,
      logisticsPerSaleQty: 0,
      storagePerSaleQty: 0,
      acceptancePerSaleQty: 0,
      penaltiesPerSaleQty: 0,
    };
  }

  return {
    hasRates: true,
    logisticsPerSaleQty: logisticsCost / saleQty,
    storagePerSaleQty: storageCost / saleQty,
    acceptancePerSaleQty: acceptanceCost / saleQty,
    penaltiesPerSaleQty: penaltiesAmount / saleQty,
  };
}

function applyEstimatedOperationalExpenses(
  result: { rows: ProfitAnalyticsRow[]; totals: ProfitTotals },
  rates: WbOperationalExpenseRates,
  usnRate: number,
  vatRate: number
) {
  if (!rates.hasRates) return result;

  const shouldEstimateLogistics = result.totals.logisticsCost === 0;
  const shouldEstimateStorage = result.totals.storageCost === 0;
  const shouldEstimateAcceptance = result.totals.acceptanceCost === 0;
  const shouldEstimatePenalties = result.totals.penaltiesAmount === 0;

  if (
    !shouldEstimateLogistics &&
    !shouldEstimateStorage &&
    !shouldEstimateAcceptance &&
    !shouldEstimatePenalties
  ) {
    return result;
  }

  let estimatedLogisticsCost = 0;
  let estimatedStorageCost = 0;
  let estimatedAcceptanceCost = 0;
  let estimatedPenaltiesAmount = 0;

  for (const row of result.rows) {
    const saleQtyBase = Math.max(0, row.salesQty);

    if (shouldEstimateLogistics) {
      row.logisticsCost = saleQtyBase * rates.logisticsPerSaleQty;
      estimatedLogisticsCost += row.logisticsCost;
    }

    if (shouldEstimateStorage) {
      row.storageCost = saleQtyBase * rates.storagePerSaleQty;
      estimatedStorageCost += row.storageCost;
    }

    if (shouldEstimateAcceptance) {
      row.acceptanceCost = saleQtyBase * rates.acceptancePerSaleQty;
      estimatedAcceptanceCost += row.acceptanceCost;
    }

    if (shouldEstimatePenalties) {
      row.penaltiesAmount = saleQtyBase * rates.penaltiesPerSaleQty;
      estimatedPenaltiesAmount += row.penaltiesAmount;
    }

    recalculateProfitRow(row);
  }

  result.totals.dataMode = "PRELIMINARY";
  result.totals.estimatedLogisticsCost = estimatedLogisticsCost;
  result.totals.estimatedStorageCost = estimatedStorageCost;
  result.totals.estimatedAcceptanceCost = estimatedAcceptanceCost;
  result.totals.estimatedPenaltiesAmount = estimatedPenaltiesAmount;
  result.totals = recalculateTotalsFromRows(result.rows, result.totals, usnRate, vatRate);

  return result;
}

export async function getProfitAnalytics(params?: {
  dateFrom?: string | null;
  dateTo?: string | null;
  companyName?: string | null;
  skipComparison?: boolean;
}): Promise<ProfitAnalyticsResult> {
  const companyName =
    params?.companyName && params.companyName !== "ALL"
      ? params.companyName
      : null;

  const companySettingsRows = await prisma.company.findMany({
    where: companyName
      ? {
          name: companyName,
        }
      : undefined,
    select: {
      name: true,
      usnRate: true,
      vatRate: true,
    },
  });

  const taxRatesByCompanyName = new Map(
    companySettingsRows.map((settings) => [
      normalizeText(settings.name),
      {
        usnRate: clampRate(
          settings.usnRate,
          [0, 1, 2, 3, 4, 5, 6],
          1
        ),
        vatRate: clampRate(settings.vatRate, [0, 5, 7], 5),
      },
    ])
  );

  const selectedCompanyRates = companyName
    ? taxRatesByCompanyName.get(normalizeText(companyName))
    : null;

  const allUsnRates = Array.from(
    new Set(
      Array.from(taxRatesByCompanyName.values()).map(
        (rates) => rates.usnRate
      )
    )
  );
  const allVatRates = Array.from(
    new Set(
      Array.from(taxRatesByCompanyName.values()).map(
        (rates) => rates.vatRate
      )
    )
  );

  const usnRate =
    selectedCompanyRates?.usnRate ??
    (allUsnRates.length === 1 ? allUsnRates[0] : 1);
  const vatRate =
    selectedCompanyRates?.vatRate ??
    (allVatRates.length === 1 ? allVatRates[0] : 5);

  const costs = await prisma.productCost.findMany({
    orderBy: [
      { costDate: "desc" },
      { createdAt: "desc" },
      { id: "desc" },
    ],
  });

  const adMaps = await prisma.adCampaignMap.findMany({
    where: {
      marketplace: "WB",
      ...(companyName ? { companyName } : {}),
    },
  });

  const currentSource =
    params?.dateFrom && params?.dateTo
      ? await selectCanonicalWbSaleSource({
          dateFrom: params.dateFrom,
          dateTo: params.dateTo,
          companyName,
        })
      : null;
  const currentSalesRows = currentSource
    ? currentSource.rows
    : await findWbSaleRowsByPeriod({
        dateFrom: params?.dateFrom,
        dateTo: params?.dateTo,
        companyName,
      });

  const previousPeriod = params?.skipComparison
    ? null
    : calculatePreviousPeriod(params?.dateFrom, params?.dateTo);

  const currentAdsRows = await findAdsRowsByPeriod({
    dateFrom: params?.dateFrom,
    dateTo: params?.dateTo,
    companyName,
  });

  const wbPnlAvailability = resolveWbPnlAvailability({
    dateFrom: params?.dateFrom,
    dateTo: params?.dateTo,
    source: currentSource,
  });

  if (isWbPnlUnavailable(wbPnlAvailability)) {
    const independentAdsCost = currentAdsRows.reduce(
      (sum, row) => sum + toNumber(row.spend),
      0
    );
    return makeUnavailableProfitAnalyticsResult({
      wbPnlAvailability,
      independentAdsCost,
    });
  }

  const currentFinanceExpenses = await findWbFinanceExpenseTotalsByPeriod({
    dateFrom: params?.dateFrom,
    dateTo: params?.dateTo,
    companyName,
  });

  const previousAdsRows = previousPeriod
    ? await findAdsRowsByPeriod({
        dateFrom: previousPeriod.dateFrom.toISOString().slice(0, 10),
        dateTo: previousPeriod.dateTo.toISOString().slice(0, 10),
        companyName,
      })
    : [];

  const previousFinanceExpenses = previousPeriod
    ? await findWbFinanceExpenseTotalsByPeriod({
        dateFrom: previousPeriod.dateFrom.toISOString().slice(0, 10),
        dateTo: previousPeriod.dateTo.toISOString().slice(0, 10),
        companyName,
      })
    : {
        hasRows: false,
        revenue: 0,
        sellerPayout: 0,
        logisticsCost: 0,
        storageCost: 0,
        acceptanceCost: 0,
        penaltiesAmount: 0,
        deductions: 0,
        settlement: 0,
        settlementAvailable: false,
        logisticsCostByCompanyName: new Map<string, number>(),
        taxKindFinanceRows: [],
        taxReportKindByKey: new Map<string, WbFinanceTaxReportKind | "ambiguous">(),
      };

  const reconciledCurrentSalesRows =
    currentFinanceExpenses.hasRows
      ? reconcileWbSaleRowsLogisticsToOfficialFinance(
          currentSalesRows,
          currentFinanceExpenses
        )
      : currentSalesRows;

  const currentBase = calculateRowsAndTotals({
    wbRows: reconciledCurrentSalesRows,
    costs,
    adsRows: currentAdsRows,
    adMaps,
    usnRate,
    vatRate,
    taxRatesByCompanyName,
    wbFinanceTaxReportKindByKey: buildWbFinanceTaxReportKindByKeyForRelevantSales(
      currentFinanceExpenses.taxKindFinanceRows,
      reconciledCurrentSalesRows
    ),
  });

  const currentOperationalRates = currentFinanceExpenses.hasRows
    ? null
    : await findLatestWbOperationalExpenseRates({
        companyName,
        anchorDate: params?.dateTo ?? params?.dateFrom,
      });

  const current = currentFinanceExpenses.hasRows
    ? applyWbFinanceExpenseTotals(currentBase, currentFinanceExpenses)
    : currentOperationalRates
      ? applyEstimatedOperationalExpenses(
          currentBase,
          currentOperationalRates,
          usnRate,
          vatRate
        )
      : currentBase;
  const currentProductCoverage = evaluateWbProductCoverage(
    currentSalesRows,
    costs
  );
  current.totals.sourceOwnershipMode = currentSource
    ? Array.from(
        new Set(currentSource.intervals.map((interval) => interval.mode))
      ).join("+")
    : "LEGACY_NO_DATE_RANGE";
  current.totals.sourceOwnershipFinal = Boolean(
    currentSource?.isFinanciallyFinal &&
      !currentProductCoverage.blocksFinal
  );
  current.totals.sourceOwnershipReasons = [
    ...(currentSource?.intervals.flatMap(
      (interval) => interval.preliminaryReasons
    ) ?? ["DATE_RANGE_REQUIRED_FOR_CANONICAL_SOURCE"]),
    ...(currentProductCoverage.missingVendorFinancialImpactRows > 0
      ? ["MISSING_VENDOR_FINANCIAL_IMPACT"]
      : []),
    ...(currentProductCoverage.missingCostFinancialRows > 0
      ? ["MISSING_COST_FINANCIAL_ROW"]
      : []),
    ...(currentProductCoverage.missingCanonicalRevenueInputRows > 0
      ? ["MISSING_CANONICAL_V6_REVENUE_INPUT"]
      : []),
  ];
  current.totals.missingVendorFinancialImpactRows =
    currentProductCoverage.missingVendorFinancialImpactRows;
  current.totals.missingCostFinancialRows =
    currentProductCoverage.missingCostFinancialRows;
  current.totals.missingCanonicalRevenueInputRows =
    currentProductCoverage.missingCanonicalRevenueInputRows;
  if (!current.totals.sourceOwnershipFinal) {
    current.totals.dataMode = "PRELIMINARY";
  }
  if (current.totals.taxesUnavailable) {
    current.totals.sourceOwnershipFinal = false;
    current.totals.dataMode = "PRELIMINARY";
  }

  const previousSource = previousPeriod
    ? await selectCanonicalWbSaleSource({
        dateFrom: previousPeriod.dateFrom.toISOString().slice(0, 10),
        dateTo: previousPeriod.dateTo.toISOString().slice(0, 10),
        companyName,
      })
    : null;
  const previousSalesRows = previousSource?.rows ?? [];

  const reconciledPreviousSalesRows =
    previousFinanceExpenses.hasRows
      ? reconcileWbSaleRowsLogisticsToOfficialFinance(
          previousSalesRows,
          previousFinanceExpenses
        )
      : previousSalesRows;

  const previousBase = calculateRowsAndTotals({
    wbRows: reconciledPreviousSalesRows,
    costs,
    adsRows: previousAdsRows,
    adMaps,
    usnRate,
    vatRate,
    taxRatesByCompanyName,
    wbFinanceTaxReportKindByKey: buildWbFinanceTaxReportKindByKeyForRelevantSales(
      previousFinanceExpenses.taxKindFinanceRows,
      reconciledPreviousSalesRows
    ),
  });

  const previousOperationalRates =
    previousPeriod && !previousFinanceExpenses.hasRows
      ? await findLatestWbOperationalExpenseRates({
          companyName,
          anchorDate: previousPeriod.dateTo.toISOString().slice(0, 10),
        })
      : null;

  const previous = previousFinanceExpenses.hasRows
    ? applyWbFinanceExpenseTotals(previousBase, previousFinanceExpenses)
    : previousOperationalRates
      ? applyEstimatedOperationalExpenses(
          previousBase,
          previousOperationalRates,
          usnRate,
          vatRate
        )
      : previousBase;
  const previousProductCoverage = evaluateWbProductCoverage(
    previousSalesRows,
    costs
  );
  previous.totals.sourceOwnershipMode = previousSource
    ? Array.from(
        new Set(previousSource.intervals.map((interval) => interval.mode))
      ).join("+")
    : "NO_COMPARISON";
  previous.totals.sourceOwnershipFinal = Boolean(
    previousSource?.isFinanciallyFinal &&
      !previousProductCoverage.blocksFinal
  );
  previous.totals.sourceOwnershipReasons = [
    ...(previousSource?.intervals.flatMap(
      (interval) => interval.preliminaryReasons
    ) ?? []),
    ...(previousProductCoverage.missingVendorFinancialImpactRows > 0
      ? ["MISSING_VENDOR_FINANCIAL_IMPACT"]
      : []),
    ...(previousProductCoverage.missingCostFinancialRows > 0
      ? ["MISSING_COST_FINANCIAL_ROW"]
      : []),
    ...(previousProductCoverage.missingCanonicalRevenueInputRows > 0
      ? ["MISSING_CANONICAL_V6_REVENUE_INPUT"]
      : []),
  ];
  previous.totals.missingVendorFinancialImpactRows =
    previousProductCoverage.missingVendorFinancialImpactRows;
  previous.totals.missingCostFinancialRows =
    previousProductCoverage.missingCostFinancialRows;
  previous.totals.missingCanonicalRevenueInputRows =
    previousProductCoverage.missingCanonicalRevenueInputRows;
  if (previousSource && !previous.totals.sourceOwnershipFinal) {
    previous.totals.dataMode = "PRELIMINARY";
  }
  if (previous.totals.taxesUnavailable) {
    previous.totals.sourceOwnershipFinal = false;
    previous.totals.dataMode = "PRELIMINARY";
  }

  const comparison = {
    revenue: createComparison(current.totals.revenue, previous.totals.revenue),
    taxableRevenue: createComparison(
      current.totals.taxableRevenue,
      previous.totals.taxableRevenue
    ),
    sellerRetailAmount: createComparison(
      current.totals.sellerRetailAmount,
      previous.totals.sellerRetailAmount
    ),

    sellerPayout: createComparison(
      current.totals.sellerPayout,
      previous.totals.sellerPayout
    ),

    totalCost: createComparison(
      current.totals.totalCost,
      previous.totals.totalCost
    ),

    wbCommission: createComparison(
      current.totals.wbCommission,
      previous.totals.wbCommission
    ),

    logisticsCost: createComparison(
      current.totals.logisticsCost,
      previous.totals.logisticsCost
    ),

    adsCost: createComparison(current.totals.adsCost, previous.totals.adsCost),

    taxesAmount: createComparison(
      current.totals.taxesAmount,
      previous.totals.taxesAmount
    ),

    marginProfit: createComparison(
      current.totals.marginProfit,
      previous.totals.marginProfit
    ),

    netProfitAfterTax: createComparison(
      current.totals.netProfitAfterTax,
      previous.totals.netProfitAfterTax
    ),
  };

  return {
    rows: current.rows,
    totals: current.totals,

    previousRows: previous.rows,
    previousTotals: previous.totals,

    comparison,
    wbPnlAvailability,
    independentAds: {
      adsCost: current.totals.adsCost,
      separatedFromPnl: false as const,
    },
  };
}