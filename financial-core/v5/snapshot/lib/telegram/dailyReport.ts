import { prisma } from "@/lib/prisma";
import { aliasWbDailyReportSalesAmount } from "@/lib/dashboard/managementRevenue";
import { calculateFinanceMetricsForRows } from "@/lib/finance/financeMetrics";
import {
  buildWbFinanceTaxReportKindByKeyForRelevantSales,
  calculateWbFallbackAccountantTaxLiability,
  WbTaxReportKindError,
} from "@/lib/finance/wbAccountantTaxBase";
import { calculateMarketplaceTotalTax } from "@/lib/finance/marketplaceTax";
import { getProfitAnalytics, isProfitAnalyticsUnavailable } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import {
  getDataReadinessSummary,
  type DataReadinessSummary,
} from "@/lib/analytics/dataReadiness";
import { evaluateCombinedMarketplaceFinality } from "@/lib/finance/combinedMarketplaceFinality";
import {
  applyOzonCanonicalIngestFinality,
  resolveOzonPeriodFinality,
  resolveWbPeriodFinality,
} from "@/lib/finance/canonicalPeriodFinality";
import { loadOzonAccrualDayStatuses } from "@/lib/ozon/accrualDayStatusStore";

export type DailyReportPeriodPreset =
  | "today"
  | "yesterday"
  | "current_week"
  | "previous_week"
  | "current_month"
  | "previous_month"
  | "last_30_days"
  | "current_quarter"
  | "ytd"
  // РЎС‚Р°СЂС‹Рµ Р·РЅР°С‡РµРЅРёСЏ РѕСЃС‚Р°РІР»СЏРµРј РґР»СЏ РѕР±СЂР°С‚РЅРѕР№ СЃРѕРІРјРµСЃС‚РёРјРѕСЃС‚Рё РєРѕРјР°РЅРґ Рё СЃСЃС‹Р»РѕРє.
  | "day_before_yesterday"
  | "3d"
  | "7d"
  | "15d"
  | "month"
  | "3m"
  | "6m"
  | "year"
  | "30d"
  | "90d"
  | "365d";

type DateRange = {
  dateLabel: string;
  periodLabel: string;
  dateFrom: Date;
  dateToExclusive: Date;
};

type MarketplaceDailyMetrics = {
  marketplace: "WB" | "OZON";
  ordersQty: number;
  ordersAmount: number;
  orderDataLoadedDays: number;
  orderDataExpectedDays: number;
  ordersDataMissing: boolean;
  ordersDataIncomplete: boolean;
  ordersDataMissingReason: string | null;
  salesQty: number;
  salesAmount: number;
  salesLabel: string;
  salesQtyIsReliable: boolean;
  salesDataMissing: boolean;
  salesDataMissingReason: string | null;
  adSpend: number;
  adSpendSource: string;
  adDataMissing: boolean;
  adDataMissingReason: string | null;
  drrByOrders: number;
  drrBySales: number;
  drrByEconomicTurnover: number;
  drrByTaxableRevenue: number;
  stockQty: number;
  netProfitAfterTax: number;
  netProfitUnavailable?: boolean;
  netProfitUnavailableReason?: string | null;
  taxableRevenue?: number;
  economicTurnover?: number;
  discountPointsAmount?: number;
  partnerProgramsAmount?: number;
  grossOzonExpenses?: number;
  netOzonExpenses?: number;
  excludedLoansFactoringAmount?: number;
  taxRevenueCoverageComplete?: boolean;
  discountPointsCoverageComplete?: boolean;
  taxRevenueMissingDays?: string[];
  discountPointsMissingDays?: string[];
  ozonEconomicsWarning?: string | null;
  marginProfit?: number;
  taxesAmount?: number;
  taxCalculationBase?: number;
  taxCalculationMode?:
    | "FINAL_TAXABLE_REVENUE"
    | "ESTIMATED_ECONOMIC_TURNOVER";
  taxesEstimated?: boolean;
  netProfitStatus?: "FINAL" | "PRELIMINARY";
  financialUnavailable?: boolean;
  financialUnavailableReason?: string | null;
  sourceOwnershipMode?: string;
  sourceOwnershipFinal?: boolean;
  ozonQuarantineCount?: number;
  ozonCanonicalImportSession?: string | null;
  ozonMissingEvidence?: string[];
};

type CompanyDailyReport = {
  companyName: string;
  wb: MarketplaceDailyMetrics;
  ozon: MarketplaceDailyMetrics;
  combinedDataMode: "FINAL" | "PRELIMINARY";
  finance: {
    cashIncome: number;
    cashOutflow: number;
    netCashFlow: number;
    netProfitImpact: number;
    ownerWithdrawals: number;
  };
};

type DailyReportComparison = {
  periodLabel: string;
  dateLabel: string;
  totals: {
    ordersAmountPercent: number | null;
    salesAmountPercent: number | null;
    economicTurnoverPercent: number | null;
    taxableRevenuePercent: number | null;
    adSpendPercent: number | null;
    netCashFlowPercent: number | null;
    netCashFlowCurrent: number;
    netCashFlowPrevious: number;
    netProfitImpactPercent: number | null;
    drrBySalesPointDiff: number | null;
    drrByEconomicTurnoverPointDiff: number | null;
  };
};

export type DailyReport = {
  dateLabel: string;
  periodLabel: string;
  companies: CompanyDailyReport[];
  totals: {
    ordersQty: number;
    ordersAmount: number;
    orderDataLoadedDays: number;
    orderDataExpectedDays: number;
    salesQty: number;
    salesAmount: number;
    economicTurnover: number;
    taxableRevenue: number;
    adSpend: number;
    drrByOrders: number;
    drrBySales: number;
    drrByEconomicTurnover: number;
    drrByTaxableRevenue: number;
    stockQty: number;
    cashIncome: number;
    cashOutflow: number;
    netCashFlow: number;
    netProfitImpact: number;
    ownerWithdrawals: number;
  };
  warnings: string[];
  dataReadiness: DataReadinessSummary | null;
  comparison?: DailyReportComparison | null;
  wbFinancialUnavailable?: boolean;
  combinedFinancialUnavailable?: boolean;
};

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  if (typeof value === "object" && "toNumber" in value) {
    const number = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(number) ? number : 0;
  }

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

function normalizeText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("С‘", "Рµ")
    .replace(/[вЂ“вЂ”в€’]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function formatDateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getInclusiveDateTo(dateToExclusive: Date) {
  const date = new Date(dateToExclusive);
  date.setDate(date.getDate() - 1);
  return date;
}

function makeMoscowRange(params: {
  days: number;
  label: string;
  now?: Date;
}): DateRange {
  const now = params.now ?? new Date();
  const moscowNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);

  const year = moscowNow.getUTCFullYear();
  const month = moscowNow.getUTCMonth();
  const day = moscowNow.getUTCDate();

  const dateToExclusive = new Date(Date.UTC(year, month, day, -3, 0, 0));
  const dateFrom = new Date(
    Date.UTC(year, month, day - params.days, -3, 0, 0)
  );

  const dateFromLabel = formatDateInput(
    new Date(Date.UTC(year, month, day - params.days, 12))
  );
  const dateToLabel = formatDateInput(
    new Date(Date.UTC(year, month, day - 1, 12))
  );

  return {
    dateLabel:
      params.days === 1 ? dateToLabel : `${dateFromLabel} вЂ” ${dateToLabel}`,
    periodLabel: params.label,
    dateFrom,
    dateToExclusive,
  };
}


function makeMoscowDayRange(params: {
  offsetDays: number;
  label: string;
  now?: Date;
}): DateRange {
  const now = params.now ?? new Date();
  const moscowNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);

  const year = moscowNow.getUTCFullYear();
  const month = moscowNow.getUTCMonth();
  const day = moscowNow.getUTCDate() - params.offsetDays;

  const dateFrom = new Date(Date.UTC(year, month, day, -3, 0, 0));
  const dateToExclusive = new Date(Date.UTC(year, month, day + 1, -3, 0, 0));
  const dateLabel = formatDateInput(new Date(Date.UTC(year, month, day, 12)));

  return {
    dateLabel,
    periodLabel: params.label,
    dateFrom,
    dateToExclusive,
  };
}

function makeCurrentMoscowWeekRange(now?: Date): DateRange {
  const currentNow = now ?? new Date();
  const moscowNow = new Date(currentNow.getTime() + 3 * 60 * 60 * 1000);

  const year = moscowNow.getUTCFullYear();
  const month = moscowNow.getUTCMonth();
  const day = moscowNow.getUTCDate();
  const dayOfWeek = moscowNow.getUTCDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const mondayNoon = new Date(Date.UTC(year, month, day - daysFromMonday, 12));
  const yesterdayNoon = new Date(Date.UTC(year, month, day - 1, 12));

  const dateFrom = new Date(
    Date.UTC(year, month, day - daysFromMonday, -3, 0, 0)
  );
  const dateToExclusive = new Date(Date.UTC(year, month, day, -3, 0, 0));

  return {
    dateLabel:
      dateFrom.getTime() >= dateToExclusive.getTime()
        ? formatDateInput(mondayNoon)
        : `${formatDateInput(mondayNoon)} вЂ” ${formatDateInput(yesterdayNoon)}`,
    periodLabel: "РўРµРєСѓС‰Р°СЏ РЅРµРґРµР»СЏ",
    dateFrom,
    dateToExclusive,
  };
}


function makeTodayMoscowRange(now?: Date): DateRange {
  const currentNow = now ?? new Date();
  const moscowNow = new Date(currentNow.getTime() + 3 * 60 * 60 * 1000);

  const year = moscowNow.getUTCFullYear();
  const month = moscowNow.getUTCMonth();
  const day = moscowNow.getUTCDate();

  const dateFrom = new Date(Date.UTC(year, month, day, -3, 0, 0));
  const dateToExclusive = new Date(Date.UTC(year, month, day + 1, -3, 0, 0));
  const dateLabel = formatDateInput(new Date(Date.UTC(year, month, day, 12)));

  return {
    dateLabel,
    periodLabel: "РЎРµРіРѕРґРЅСЏ",
    dateFrom,
    dateToExclusive,
  };
}

function makePreviousClosedMoscowWeekRange(now?: Date): DateRange {
  const currentNow = now ?? new Date();
  const moscowNow = new Date(currentNow.getTime() + 3 * 60 * 60 * 1000);

  const year = moscowNow.getUTCFullYear();
  const month = moscowNow.getUTCMonth();
  const day = moscowNow.getUTCDate();
  const dayOfWeek = moscowNow.getUTCDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const previousMondayNoon = new Date(
    Date.UTC(year, month, day - daysFromMonday - 7, 12)
  );
  const previousSundayNoon = new Date(
    Date.UTC(year, month, day - daysFromMonday - 1, 12)
  );

  const dateFrom = new Date(
    Date.UTC(year, month, day - daysFromMonday - 7, -3, 0, 0)
  );
  const dateToExclusive = new Date(
    Date.UTC(year, month, day - daysFromMonday, -3, 0, 0)
  );

  return {
    dateLabel: `${formatDateInput(previousMondayNoon)} вЂ” ${formatDateInput(previousSundayNoon)}`,
    periodLabel: "РџСЂРѕС€Р»Р°СЏ Р·Р°РєСЂС‹С‚Р°СЏ РЅРµРґРµР»СЏ",
    dateFrom,
    dateToExclusive,
  };
}

function makeMoscowMonthRange(params: {
  offsetMonths: number;
  label: string;
  now?: Date;
}): DateRange {
  const currentNow = params.now ?? new Date();
  const moscowNow = new Date(currentNow.getTime() + 3 * 60 * 60 * 1000);

  const year = moscowNow.getUTCFullYear();
  const month = moscowNow.getUTCMonth() + params.offsetMonths;
  const day = moscowNow.getUTCDate();

  const monthStartNoon = new Date(Date.UTC(year, month, 1, 12));
  const monthEndNoon =
    params.offsetMonths === 0
      ? new Date(Date.UTC(year, month, day, 12))
      : new Date(Date.UTC(year, month + 1, 0, 12));

  const dateFrom = new Date(Date.UTC(year, month, 1, -3, 0, 0));
  const dateToExclusive =
    params.offsetMonths === 0
      ? new Date(Date.UTC(year, month, day + 1, -3, 0, 0))
      : new Date(Date.UTC(year, month + 1, 1, -3, 0, 0));

  return {
    dateLabel: `${formatDateInput(monthStartNoon)} вЂ” ${formatDateInput(monthEndNoon)}`,
    periodLabel: params.label,
    dateFrom,
    dateToExclusive,
  };
}

function makeCurrentMoscowQuarterRange(now?: Date): DateRange {
  const currentNow = now ?? new Date();
  const moscowNow = new Date(currentNow.getTime() + 3 * 60 * 60 * 1000);

  const year = moscowNow.getUTCFullYear();
  const month = moscowNow.getUTCMonth();
  const day = moscowNow.getUTCDate();
  const quarterStartMonth = Math.floor(month / 3) * 3;

  const dateFrom = new Date(Date.UTC(year, quarterStartMonth, 1, -3, 0, 0));
  const dateToExclusive = new Date(Date.UTC(year, month, day + 1, -3, 0, 0));

  const dateFromLabel = formatDateInput(new Date(Date.UTC(year, quarterStartMonth, 1, 12)));
  const dateToLabel = formatDateInput(new Date(Date.UTC(year, month, day, 12)));

  return {
    dateLabel: `${dateFromLabel} вЂ” ${dateToLabel}`,
    periodLabel: "РўРµРєСѓС‰РёР№ РєРІР°СЂС‚Р°Р»",
    dateFrom,
    dateToExclusive,
  };
}

function makeYearToDateMoscowRange(now?: Date): DateRange {
  const currentNow = now ?? new Date();
  const moscowNow = new Date(currentNow.getTime() + 3 * 60 * 60 * 1000);

  const year = moscowNow.getUTCFullYear();
  const month = moscowNow.getUTCMonth();
  const day = moscowNow.getUTCDate();

  const dateFrom = new Date(Date.UTC(year, 0, 1, -3, 0, 0));
  const dateToExclusive = new Date(Date.UTC(year, month, day + 1, -3, 0, 0));

  return {
    dateLabel: `${formatDateInput(new Date(Date.UTC(year, 0, 1, 12)))} вЂ” ${formatDateInput(new Date(Date.UTC(year, month, day, 12)))}`,
    periodLabel: "РЎ РЅР°С‡Р°Р»Р° РіРѕРґР°",
    dateFrom,
    dateToExclusive,
  };
}

function normalizeReportPreset(
  preset: DailyReportPeriodPreset | undefined
): DailyReportPeriodPreset {
  if (preset === "30d") return "last_30_days";
  if (preset === "90d") return "current_quarter";
  if (preset === "365d") return "ytd";
  if (preset === "month") return "current_month";
  if (preset === "3m") return "current_quarter";
  if (preset === "year") return "ytd";

  return preset ?? "yesterday";
}
export function getDailyReportRange(params?: {
  preset?: DailyReportPeriodPreset;
  date?: string;
  from?: string;
  to?: string;
  now?: Date;
}): DateRange {
  if (params?.from && params?.to) {
    const [fromYear, fromMonth, fromDay] = params.from.split("-").map(Number);
    const [toYear, toMonth, toDay] = params.to.split("-").map(Number);

    if (fromYear && fromMonth && fromDay && toYear && toMonth && toDay) {
      return {
        dateLabel: `${params.from} вЂ” ${params.to}`,
        periodLabel: "Р’С‹Р±СЂР°РЅРЅС‹Р№ РїРµСЂРёРѕРґ",
        dateFrom: new Date(Date.UTC(fromYear, fromMonth - 1, fromDay, -3, 0, 0)),
        dateToExclusive: new Date(
          Date.UTC(toYear, toMonth - 1, toDay + 1, -3, 0, 0)
        ),
      };
    }
  }

  if (params?.date) {
    const [year, month, day] = params.date.split("-").map(Number);

    if (year && month && day) {
      return {
        dateLabel: params.date,
        periodLabel: "Р’С‹Р±СЂР°РЅРЅС‹Р№ РґРµРЅСЊ",
        dateFrom: new Date(Date.UTC(year, month - 1, day, -3, 0, 0)),
        dateToExclusive: new Date(Date.UTC(year, month - 1, day + 1, -3, 0, 0)),
      };
    }
  }

  const preset = normalizeReportPreset(params?.preset);

  if (preset === "today") {
    return makeTodayMoscowRange(params?.now);
  }

  if (preset === "yesterday") {
    return makeMoscowDayRange({
      offsetDays: 1,
      label: "Р’С‡РµСЂР°",
      now: params?.now,
    });
  }

  if (preset === "day_before_yesterday") {
    return makeMoscowDayRange({
      offsetDays: 2,
      label: "РџРѕР·Р°РІС‡РµСЂР°",
      now: params?.now,
    });
  }

  if (preset === "current_week") {
    return makeCurrentMoscowWeekRange(params?.now);
  }

  if (preset === "previous_week") {
    return makePreviousClosedMoscowWeekRange(params?.now);
  }

  if (preset === "current_month") {
    return makeMoscowMonthRange({
      offsetMonths: 0,
      label: "РўРµРєСѓС‰РёР№ РјРµСЃСЏС†",
      now: params?.now,
    });
  }

  if (preset === "previous_month") {
    return makeMoscowMonthRange({
      offsetMonths: -1,
      label: "РџСЂРѕС€Р»С‹Р№ РјРµСЃСЏС†",
      now: params?.now,
    });
  }

  if (preset === "last_30_days") {
    return makeMoscowRange({
      days: 30,
      label: "РџРѕСЃР»РµРґРЅРёРµ 30 РґРЅРµР№",
      now: params?.now,
    });
  }

  if (preset === "current_quarter") {
    return makeCurrentMoscowQuarterRange(params?.now);
  }

  if (preset === "ytd") {
    return makeYearToDateMoscowRange(params?.now);
  }

  if (preset === "3d") {
    return makeMoscowRange({
      days: 3,
      label: "РџРѕСЃР»РµРґРЅРёРµ 3 РґРЅСЏ",
      now: params?.now,
    });
  }

  if (preset === "7d") {
    return makeMoscowRange({
      days: 7,
      label: "РџРѕСЃР»РµРґРЅРёРµ 7 РґРЅРµР№",
      now: params?.now,
    });
  }

  if (preset === "15d") {
    return makeMoscowRange({
      days: 15,
      label: "РџРѕСЃР»РµРґРЅРёРµ 15 РґРЅРµР№",
      now: params?.now,
    });
  }

  if (preset === "6m") {
    return makeMoscowRange({
      days: 183,
      label: "РџРѕСЃР»РµРґРЅРёРµ 6 РјРµСЃСЏС†РµРІ",
      now: params?.now,
    });
  }

  return makeMoscowDayRange({
    offsetDays: 1,
    label: "Р’С‡РµСЂР°",
    now: params?.now,
  });
}

function getExpectedOrderDays(range: DateRange) {
  const diff = range.dateToExclusive.getTime() - range.dateFrom.getTime();
  return Math.max(1, Math.round(diff / 86_400_000));
}

function getOrderDateKey(date: Date) {
  return new Date(date.getTime() + 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function hasIncompleteOrderData(report: DailyReport) {
  return (
    report.totals.orderDataExpectedDays > 0 &&
    report.totals.orderDataLoadedDays < report.totals.orderDataExpectedDays
  );
}

function isWbSaleOperation(reason: string | null | undefined) {
  const value = normalizeText(reason);
  return value === "РїСЂРѕРґР°Р¶Р°" || value === "СЃС‚РѕСЂРЅРѕ РІРѕР·РІСЂР°С‚РѕРІ";
}

function isWbReturnOperation(reason: string | null | undefined) {
  const value = normalizeText(reason);

  // Р’ РµР¶РµРґРЅРµРІРЅС‹С… Рё РґРµС‚Р°Р»РёР·РёСЂРѕРІР°РЅРЅС‹С… WB-РѕС‚С‡С‘С‚Р°С… РІРѕР·РІСЂР°С‚ РјРѕР¶РµС‚ РїСЂРёС…РѕРґРёС‚СЊ
  // РЅРµ С‚РѕР»СЊРєРѕ С‚РѕС‡РЅС‹Рј Р·РЅР°С‡РµРЅРёРµРј "Р’РѕР·РІСЂР°С‚", РЅРѕ Рё СЂР°СЃС€РёСЂРµРЅРЅС‹Рј С‚РµРєСЃС‚РѕРј РѕРїРµСЂР°С†РёРё.
  // "РЎС‚РѕСЂРЅРѕ РІРѕР·РІСЂР°С‚РѕРІ" РїСЂРё СЌС‚РѕРј РѕСЃС‚Р°РІР»СЏРµРј РїРѕР»РѕР¶РёС‚РµР»СЊРЅРѕР№ РѕРїРµСЂР°С†РёРµР№.
  return value.includes("РІРѕР·РІСЂР°С‚") && value !== "СЃС‚РѕСЂРЅРѕ РІРѕР·РІСЂР°С‚РѕРІ";
}

function getDateSpan(dateFrom: Date | null, dateTo: Date | null) {
  if (!dateFrom && !dateTo) return [];

  const from = new Date(dateFrom ?? dateTo ?? new Date());
  const to = new Date(dateTo ?? dateFrom ?? new Date());

  from.setHours(0, 0, 0, 0);
  to.setHours(0, 0, 0, 0);

  const dates: string[] = [];

  for (const cursor = new Date(from); cursor.getTime() <= to.getTime(); cursor.setDate(cursor.getDate() + 1)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }

  return dates;
}

function keepLatestWbAdsRowsPerDate<
  T extends {
    dateFrom: Date | null;
    dateTo: Date | null;
    importSessionId: string | null;
    createdAt: Date;
  },
>(rows: T[]) {
  const latestSessionByDate = new Map<string, string | null>();

  for (const row of rows) {
    const dates = getDateSpan(row.dateFrom, row.dateTo);

    for (const date of dates) {
      if (!latestSessionByDate.has(date)) {
        latestSessionByDate.set(date, row.importSessionId ?? null);
      }
    }
  }

  return rows.filter((row) => {
    const dates = getDateSpan(row.dateFrom, row.dateTo);
    if (dates.length === 0) return false;

    return dates.some(
      (date) => latestSessionByDate.get(date) === (row.importSessionId ?? null)
    );
  });
}

function keepLatestOzonAdsRowsPerDate<
  T extends {
    reportDate: Date | null;
    importSessionId: string | null;
    createdAt: Date;
  },
>(rows: T[]) {
  const latestSessionByDate = new Map<string, string | null>();

  for (const row of rows) {
    if (!row.reportDate) continue;

    const date = row.reportDate.toISOString().slice(0, 10);

    if (!latestSessionByDate.has(date)) {
      latestSessionByDate.set(date, row.importSessionId ?? null);
    }
  }

  return rows.filter((row) => {
    if (!row.reportDate) return false;

    const date = row.reportDate.toISOString().slice(0, 10);

    return latestSessionByDate.get(date) === (row.importSessionId ?? null);
  });
}

type WbStockRowForReport = {
  warehouseName: string | null;
  vendorCode: string | null;
  barcode: string | null;
  nmId: string | null;
  chrtId: string | null;
  size: string | null;
  inTransitToCustomer: number | null;
  inTransitReturns: number | null;
  totalStock: number | null;
  warehouseQty: number | null;
};

function getWbStockProductKey(row: WbStockRowForReport) {
  return [
    row.nmId ?? "",
    row.chrtId ?? "",
    row.barcode ?? "",
    row.vendorCode ?? "",
    row.size ?? "",
  ].join("|");
}

function calculateWbStockQty(rows: WbStockRowForReport[]) {
  if (rows.length === 0) return 0;

  const totalRows = rows.filter((row) => row.warehouseName === "__TOTAL__");

  if (totalRows.length > 0) {
    return totalRows.reduce(
      (sum, row) =>
        sum +
        toNumber(row.inTransitToCustomer) +
        toNumber(row.inTransitReturns) +
        toNumber(row.totalStock),
      0
    );
  }

  const hasWarehouseQty = rows.some((row) => toNumber(row.warehouseQty) > 0);

  if (hasWarehouseQty) {
    return rows.reduce((sum, row) => sum + toNumber(row.warehouseQty), 0);
  }

  const latestByProduct = new Map<string, WbStockRowForReport>();

  for (const row of rows) {
    const key = getWbStockProductKey(row);

    if (!latestByProduct.has(key)) {
      latestByProduct.set(key, row);
    }
  }

  return Array.from(latestByProduct.values()).reduce(
    (sum, row) =>
      sum +
      toNumber(row.inTransitToCustomer) +
      toNumber(row.inTransitReturns) +
      toNumber(row.totalStock),
    0
  );
}

async function getLatestWbStockQty(companyName: string) {
  const latestStockImport = await prisma.importSession.findFirst({
    where: {
      companyName,
      reportType: "WB_STOCK",
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      id: true,
    },
  });

  let rows = latestStockImport
    ? await prisma.wbStock.findMany({
        where: {
          companyName,
          importSessionId: latestStockImport.id,
        },
        select: {
          warehouseName: true,
          vendorCode: true,
          barcode: true,
          nmId: true,
          chrtId: true,
          size: true,
          inTransitToCustomer: true,
          inTransitReturns: true,
          totalStock: true,
          warehouseQty: true,
        },
      })
    : [];

  // Р§Р°СЃС‚СЊ API-СЃРёРЅС…СЂРѕРЅРёР·Р°С†РёР№ С…СЂР°РЅРёС‚ Р°РєС‚СѓР°Р»СЊРЅС‹Рµ РѕСЃС‚Р°С‚РєРё Р±РµР· ImportSession.
  // РџРѕСЌС‚РѕРјСѓ РµСЃР»Рё РїРѕ РїРѕСЃР»РµРґРЅРµР№ СЃРµСЃСЃРёРё СЃС‚СЂРѕРє РЅРµС‚, Р±РµСЂС‘Рј С‚РµРєСѓС‰РёРµ СЃС‚СЂРѕРєРё РєРѕРјРїР°РЅРёРё.
  if (rows.length === 0) {
    rows = await prisma.wbStock.findMany({
      where: {
        companyName,
      },
      select: {
        warehouseName: true,
        vendorCode: true,
        barcode: true,
        nmId: true,
        chrtId: true,
        size: true,
        inTransitToCustomer: true,
        inTransitReturns: true,
        totalStock: true,
        warehouseQty: true,
      },
    });
  }

  return calculateWbStockQty(rows);
}

async function getLatestOzonStockQty(companyName: string) {
  // Ozon stock sync РїРµСЂРµР·Р°РїРёСЃС‹РІР°РµС‚ С‚РµРєСѓС‰РёРµ СЃС‚СЂРѕРєРё РїРѕ РєРѕРјРїР°РЅРёРё Рё С‡Р°СЃС‚Рѕ С…СЂР°РЅРёС‚
  // importSessionId = null. РџРѕСЌС‚РѕРјСѓ РЅРµР»СЊР·СЏ РёСЃРєР°С‚СЊ С‚РѕР»СЊРєРѕ РїРѕСЃР»РµРґРЅСЋСЋ ImportSession.
  const rows = await prisma.ozonStock.findMany({
    where: {
      companyName,
    },
    select: {
      availableQty: true,
      preparingQty: true,
      supplyQty: true,
      inTransitQty: true,
      returnQty: true,
    },
  });

  return rows.reduce(
    (sum, row) =>
      sum +
      toNumber(row.availableQty) +
      toNumber(row.preparingQty) +
      toNumber(row.supplyQty) +
      toNumber(row.inTransitQty) +
      toNumber(row.returnQty),
    0
  );
}

function isOzonFinanceAdOperation(operationType: string | null | undefined) {
  const value = normalizeText(operationType);

  return (
    value.includes("РѕРїР»Р°С‚Р° Р·Р° РєР»РёРє") ||
    value.includes("РїСЂРѕРґРІРёР¶РµРЅРёРµ СЃ РѕРїР»Р°С‚РѕР№ Р·Р° Р·Р°РєР°Р·") ||
    value.includes("РїСЂРѕРґРІРёР¶РµРЅРёРµ") ||
    value.includes("СЂРµРєР»Р°РјР°") ||
    value.includes("СЂРµРєР»Р°Рј") ||
    value.includes("С‚СЂР°С„Р°СЂРµС‚") ||
    value.includes("cpc") ||
    value.includes("cpo")
  );
}

function calculateOzonFinanceAdSpend(
  rows: Array<{ operationType: string | null; totalAmount: unknown }>
) {
  return rows
    .filter((row) => isOzonFinanceAdOperation(row.operationType))
    .reduce((sum, row) => sum + Math.abs(toNumber(row.totalAmount)), 0);
}

function clampRate(value: unknown, allowedRates: number[], fallback: number) {
  const rate = toNumber(value);
  return allowedRates.includes(rate) ? rate : fallback;
}

function calculateTaxesAmount(params: {
  revenue: number;
  usnRate: number;
  vatRate: number;
  separateVatTaxableAmount?: number;
}) {
  return calculateMarketplaceTotalTax({
    ordinarySalesVatInclusive: params.revenue,
    separateVatTaxableAmount: params.separateVatTaxableAmount ?? 0,
    usnRate: params.usnRate,
    vatRate: params.vatRate,
  });
}

function getCompanyTaxRates(company: {
  usnRate: unknown;
  vatRate: unknown;
} | null) {
  return {
    usnRate: clampRate(company?.usnRate, [0, 1, 2, 3, 4, 5, 6], 1),
    vatRate: clampRate(company?.vatRate, [0, 5, 7], 5),
  };
}

type ProductCostForDailyProfit = {
  vendorCode: string;
  nmId: string | null;
  costPrice: unknown;
};

type WbProductCardForDailyProfit = {
  nmId: string;
  vendorCode: string | null;
};

type OzonProductForDailyProfit = {
  sku: string;
  vendorCode: string;
};

function buildCostLookups(costs: ProductCostForDailyProfit[]) {
  const costByVendorCode = new Map<string, number>();
  const costByNmId = new Map<string, number>();

  for (const cost of costs) {
    const vendorCode = normalizeText(cost.vendorCode);
    const nmId = normalizeText(cost.nmId);
    const costPrice = toNumber(cost.costPrice);

    if (vendorCode && !costByVendorCode.has(vendorCode)) {
      costByVendorCode.set(vendorCode, costPrice);
    }

    if (nmId && !costByNmId.has(nmId)) {
      costByNmId.set(nmId, costPrice);
    }
  }

  return {
    costByVendorCode,
    costByNmId,
  };
}

function buildWbSupplierArticleByNmId(cards: WbProductCardForDailyProfit[]) {
  const supplierArticleByNmId = new Map<string, string>();

  for (const card of cards) {
    const nmId = normalizeText(card.nmId);
    const vendorCode = normalizeText(card.vendorCode);

    if (!nmId || !vendorCode || supplierArticleByNmId.has(nmId)) continue;

    supplierArticleByNmId.set(nmId, vendorCode);
  }

  return supplierArticleByNmId;
}

function buildOzonVendorCodeBySku(products: OzonProductForDailyProfit[]) {
  const vendorCodeBySku = new Map<string, string>();

  for (const product of products) {
    const sku = normalizeText(product.sku);
    const vendorCode = normalizeText(product.vendorCode);

    if (!sku || !vendorCode || vendorCodeBySku.has(sku)) continue;

    vendorCodeBySku.set(sku, vendorCode);
  }

  return vendorCodeBySku;
}

function getOzonBaseArticle(value: unknown) {
  const vendorCode = cleanText(value);
  if (!vendorCode) return "";

  return cleanText(vendorCode.split("-")[0]);
}

function getWbCostPrice(params: {
  vendorCode: unknown;
  costs: ProductCostForDailyProfit[];
}) {
  const { costByVendorCode } = buildCostLookups(params.costs);
  const vendorCode = normalizeText(params.vendorCode);

  return vendorCode ? costByVendorCode.get(vendorCode) ?? 0 : 0;
}

function createOzonCostResolver(params: {
  costs: ProductCostForDailyProfit[];
  wbProductCards: WbProductCardForDailyProfit[];
  ozonProducts: OzonProductForDailyProfit[];
}) {
  const { costByVendorCode, costByNmId } = buildCostLookups(params.costs);
  const wbSupplierArticleByNmId = buildWbSupplierArticleByNmId(
    params.wbProductCards
  );
  const ozonVendorCodeBySku = buildOzonVendorCodeBySku(params.ozonProducts);

  return function resolveOzonCostPrice(row: {
    sku: string | null;
    vendorCode: string | null;
  }) {
    const sku = normalizeText(row.sku);
    const directVendorCode = normalizeText(row.vendorCode);
    const mappedVendorCode = sku ? ozonVendorCodeBySku.get(sku) ?? "" : "";
    const vendorCode = directVendorCode || mappedVendorCode || sku;

    if (!vendorCode) return 0;

    const directCost = costByVendorCode.get(vendorCode);
    if (directCost !== undefined) return directCost;

    const baseArticle = normalizeText(getOzonBaseArticle(vendorCode));
    if (!baseArticle) return 0;

    const costByBaseNmId = costByNmId.get(baseArticle);
    if (costByBaseNmId !== undefined) return costByBaseNmId;

    const directBaseCost = costByVendorCode.get(baseArticle);
    if (directBaseCost !== undefined) return directBaseCost;

    const wbSupplierArticle = wbSupplierArticleByNmId.get(baseArticle);
    if (!wbSupplierArticle) return 0;

    return costByVendorCode.get(wbSupplierArticle) ?? 0;
  };
}

function calculateWbNetProfitAfterTax(params: {
  rows: Array<{
    paymentReason: string | null;
    quantity: number | null;
    wbRealizedAmount: unknown;
    sellerPayout: unknown;
    vendorCode: string | null;
  }>;
  costs: ProductCostForDailyProfit[];
  adSpend: number;
  usnRate: number;
  vatRate: number;
}) {
  let revenue = 0;
  let sellerPayout = 0;
  let totalCost = 0;

  for (const row of params.rows) {
    const paymentReason = normalizeText(row.paymentReason);
    const quantity = Math.abs(toNumber(row.quantity)) || 1;
    const realizedAmount = Math.abs(toNumber(row.wbRealizedAmount));
    const payout = Math.abs(toNumber(row.sellerPayout));
    const costPrice = getWbCostPrice({
      vendorCode: row.vendorCode,
      costs: params.costs,
    });

    if (isWbSaleOperation(paymentReason)) {
      revenue += realizedAmount;
      sellerPayout += payout;
      totalCost += costPrice * quantity;
      continue;
    }

    if (isWbReturnOperation(paymentReason)) {
      revenue -= realizedAmount;
      sellerPayout -= payout;
      totalCost -= costPrice * quantity;
    }
  }

  const taxesAmount = calculateTaxesAmount({
    revenue,
    usnRate: params.usnRate,
    vatRate: params.vatRate,
  });

  return sellerPayout - totalCost - params.adSpend - taxesAmount;
}

function calculateWbCostOfGoodsForRows(params: {
  rows: Array<{
    paymentReason: string | null;
    quantity: number | null;
    vendorCode: string | null;
  }>;
  costs: ProductCostForDailyProfit[];
}) {
  let totalCost = 0;

  for (const row of params.rows) {
    const quantity = Math.abs(toNumber(row.quantity)) || 1;
    const costPrice = getWbCostPrice({
      vendorCode: row.vendorCode,
      costs: params.costs,
    });

    if (isWbSaleOperation(row.paymentReason)) {
      totalCost += costPrice * quantity;
      continue;
    }

    if (isWbReturnOperation(row.paymentReason)) {
      totalCost -= costPrice * quantity;
    }
  }

  return totalCost;
}

function sumWbFinanceRows(rows: Array<{
  payoutAmount: unknown;
  totalToPay: unknown;
  logisticsCost: unknown;
  storageCost: unknown;
  acceptanceCost: unknown;
  penaltiesAmount: unknown;
  otherDeductions: unknown;
}>) {
  return rows.reduce(
    (acc, row) => {
      acc.sellerPayout += toNumber(row.payoutAmount);
      acc.totalToPay += toNumber(row.totalToPay);
      acc.logisticsCost += toNumber(row.logisticsCost);
      acc.storageCost += toNumber(row.storageCost);
      acc.acceptanceCost += toNumber(row.acceptanceCost);
      acc.penaltiesAmount += toNumber(row.penaltiesAmount);
      acc.otherDeductions += toNumber(row.otherDeductions);
      return acc;
    },
    {
      sellerPayout: 0,
      totalToPay: 0,
      logisticsCost: 0,
      storageCost: 0,
      acceptanceCost: 0,
      penaltiesAmount: 0,
      otherDeductions: 0,
    }
  );
}

function calculateOzonNetProfitAfterTax(params: {
  rows: Array<{
    operationType: string | null;
    sku: string | null;
    vendorCode: string | null;
    quantity: number | null;
    salesAmount: unknown;
    totalAmount: unknown;
  }>;
  costs: ProductCostForDailyProfit[];
  wbProductCards: WbProductCardForDailyProfit[];
  ozonProducts: OzonProductForDailyProfit[];
  adSpend: number;
  usnRate: number;
  vatRate: number;
}) {
  const resolveCostPrice = createOzonCostResolver({
    costs: params.costs,
    wbProductCards: params.wbProductCards,
    ozonProducts: params.ozonProducts,
  });

  let revenue = 0;
  let sellerPayoutBeforeAds = 0;
  let totalCost = 0;

  for (const row of params.rows) {
    if (isOzonFinanceAdOperation(row.operationType)) {
      continue;
    }

    const salesAmount = toNumber(row.salesAmount);
    const totalAmount = toNumber(row.totalAmount);
    const quantity = Math.abs(toNumber(row.quantity));
    const costPrice = resolveCostPrice(row);

    revenue += salesAmount;
    sellerPayoutBeforeAds += totalAmount;

    if (salesAmount > 0 || quantity > 0) {
      totalCost += costPrice * quantity;
    }

    if (salesAmount < 0 || totalAmount < 0) {
      totalCost -= costPrice * quantity;
    }
  }

  const taxesAmount = calculateTaxesAmount({
    revenue,
    usnRate: params.usnRate,
    vatRate: params.vatRate,
  });

  return sellerPayoutBeforeAds - totalCost - params.adSpend - taxesAmount;
}


async function getFinanceMetricsForCompany(params: {
  companyName: string;
  range: DateRange;
}) {
  const [transactions, categories] = await Promise.all([
    prisma.financeTransaction.findMany({
      where: {
        companyName: params.companyName,
        transactionStatus: "FACT",
        operationDate: {
          gte: params.range.dateFrom,
          lt: params.range.dateToExclusive,
        },
      },
      select: {
        operationType: true,
        category: true,
        subcategory: true,
        amount: true,
        isInternalTransfer: true,
        transferDirection: true,
        transactionStatus: true,
      },
    }),
    prisma.financeCategory.findMany({
      select: {
        name: true,
        categoryType: true,
        parentName: true,
        profitTreatment: true,
      },
    }),
  ]);

  const metrics = calculateFinanceMetricsForRows({
    transactions,
    categories,
  });

  return {
    cashIncome: metrics.cashIncome,
    cashOutflow: metrics.cashOutflow,
    netCashFlow: metrics.netCashFlow,
    netProfitImpact: metrics.netProfitImpact,
    ownerWithdrawals: metrics.ownerWithdrawals,
  };
}

async function getOrderStats(params: {
  companyName: string;
  marketplace: "WB" | "OZON";
  range: DateRange;
}) {
  const rows = await prisma.marketplaceDailyOrderStat.findMany({
    where: {
      companyName: params.companyName,
      marketplace: params.marketplace,
      orderDate: {
        gte: params.range.dateFrom,
        lt: params.range.dateToExclusive,
      },
    },
    select: {
      orderDate: true,
      ordersQty: true,
      ordersAmount: true,
    },
  });

  const loadedDateKeys = new Set<string>();

  return rows.reduce(
    (acc, row) => {
      acc.ordersQty += Number(row.ordersQty ?? 0);
      acc.ordersAmount += toNumber(row.ordersAmount);
      loadedDateKeys.add(getOrderDateKey(row.orderDate));
      acc.loadedDays = loadedDateKeys.size;
      return acc;
    },
    {
      ordersQty: 0,
      ordersAmount: 0,
      rowsCount: rows.length,
      loadedDays: 0,
      expectedDays: getExpectedOrderDays(params.range),
    }
  );
}

function calculateDrr(adSpend: number, salesAmount: number) {
  if (salesAmount <= 0) return 0;
  return (adSpend / salesAmount) * 100;
}

function getDrrEconomicBase(metrics: MarketplaceDailyMetrics) {
  return metrics.economicTurnover && metrics.economicTurnover > 0
    ? metrics.economicTurnover
    : metrics.salesAmount;
}


function getMoscowDateKey(date: Date | null | undefined) {
  if (!date) return "unknown";

  return new Date(date.getTime() + 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

function isWbDailyStatisticsSaleRow(row: {
  reportNumber: string | null;
}) {
  return String(row.reportNumber ?? "").startsWith("WB_DAILY_STATISTICS_");
}

function selectPreferredWbSaleRows<
  T extends {
    reportNumber: string | null;
    saleDate: Date | null;
  },
>(rows: T[]) {
  const rowsByDay = new Map<string, T[]>();

  for (const row of rows) {
    const key = getMoscowDateKey(row.saleDate);
    const current = rowsByDay.get(key) ?? [];

    current.push(row);
    rowsByDay.set(key, current);
  }

  const preferredRows: T[] = [];

  for (const dayRows of rowsByDay.values()) {
    const finalRows = dayRows.filter((row) => !isWbDailyStatisticsSaleRow(row));
    const dailyRows = dayRows.filter((row) => isWbDailyStatisticsSaleRow(row));

    // Р•СЃР»Рё Р·Р° РґРµРЅСЊ СѓР¶Рµ РµСЃС‚СЊ С„РёРЅР°Р»СЊРЅС‹Р№ РЅРµРґРµР»СЊРЅС‹Р№ WB Sales вЂ” РёСЃРїРѕР»СЊР·СѓРµРј РµРіРѕ.
    // РРЅР°С‡Рµ РёСЃРїРѕР»СЊР·СѓРµРј РѕРїРµСЂР°С‚РёРІРЅС‹Р№ daily sales, С‡С‚РѕР±С‹ РЅРµ Р±С‹Р»Рѕ РїСѓСЃС‚РѕС‚С‹ РІ СѓС‚СЂРµРЅРЅРµРј РѕС‚С‡С‘С‚Рµ.
    preferredRows.push(...(finalRows.length > 0 ? finalRows : dailyRows));
  }

  return preferredRows;
}

async function getWbMetrics(companyName: string, range: DateRange) {
  const [
    orderStats,
    salesRows,
    financeRows,
    adsRowsRaw,
    stockQty,
    costs,
    companySettings,
    wbProfitAnalytics,
  ] = await Promise.all([
      getOrderStats({
        companyName,
        marketplace: "WB",
        range,
      }),
      prisma.wbSale.findMany({
        where: {
          companyName,
          saleDate: {
            gte: range.dateFrom,
            lt: range.dateToExclusive,
          },
        },
        select: {
          reportNumber: true,
          saleDate: true,
          paymentReason: true,
          documentType: true,
          quantity: true,
          wbRealizedAmount: true,
          sellerPayout: true,
          vendorCode: true,
        },
      }),
      prisma.wbFinance.findMany({
        where: {
          companyName,
          OR: [
            {
              dateFrom: {
                gte: range.dateFrom,
                lt: range.dateToExclusive,
              },
            },
            {
              dateTo: {
                gte: range.dateFrom,
                lt: range.dateToExclusive,
              },
            },
            {
              AND: [
                {
                  dateFrom: {
                    lte: range.dateFrom,
                  },
                },
                {
                  dateTo: {
                    gte: range.dateToExclusive,
                  },
                },
              ],
            },
          ],
        },
        select: {
          companyName: true,
          reportNumber: true,
          reportTypeName: true,
          payoutAmount: true,
          totalToPay: true,
          logisticsCost: true,
          storageCost: true,
          acceptanceCost: true,
          penaltiesAmount: true,
          otherDeductions: true,
        },
      }),
      prisma.wbAds.findMany({
        where: {
          companyName,
          OR: [
            {
              dateFrom: {
                gte: range.dateFrom,
                lt: range.dateToExclusive,
              },
            },
            {
              dateTo: {
                gte: range.dateFrom,
                lt: range.dateToExclusive,
              },
            },
            {
              AND: [
                {
                  dateFrom: {
                    lte: range.dateFrom,
                  },
                },
                {
                  dateTo: {
                    gte: range.dateToExclusive,
                  },
                },
              ],
            },
          ],
        },
        select: {
          dateFrom: true,
          dateTo: true,
          spend: true,
          importSessionId: true,
          createdAt: true,
        },
        orderBy: {
          createdAt: "desc",
        },
      }),
      getLatestWbStockQty(companyName),
      prisma.productCost.findMany({
        select: {
          vendorCode: true,
          nmId: true,
          costPrice: true,
        },
        orderBy: {
          costDate: "desc",
        },
      }),
      prisma.company.findFirst({
        where: {
          name: companyName,
        },
        select: {
          usnRate: true,
          vatRate: true,
        },
      }),
      getProfitAnalytics({
        dateFrom: getMoscowDateInput(range.dateFrom),
        dateTo: getMoscowDateInput(getInclusiveDateTo(range.dateToExclusive)),
        companyName,
      }),
    ]);

  const effectiveSalesRows = selectPreferredWbSaleRows(salesRows);

  let salesQty = 0;
  let salesAmount = 0;

  for (const row of effectiveSalesRows) {
    const qty = Math.abs(Number(row.quantity ?? 0)) || 1;
    const amount = Math.abs(toNumber(row.wbRealizedAmount));

    if (isWbSaleOperation(row.paymentReason)) {
      salesQty += qty;
      salesAmount += amount;
      continue;
    }

    if (isWbReturnOperation(row.paymentReason)) {
      salesQty -= qty;
      salesAmount -= amount;
    }
  }

  const ordersDataMissing = orderStats.rowsCount === 0;
  const ordersDataIncomplete =
    !ordersDataMissing && orderStats.loadedDays < orderStats.expectedDays;
  const ordersDataMissingReason = ordersDataMissing
    ? "WB Р·Р°РєР°Р·С‹ Р·Р° СЌС‚РѕС‚ РїРµСЂРёРѕРґ РµС‰С‘ РЅРµ Р·Р°РіСЂСѓР¶РµРЅС‹ РІ MarketplaceDailyOrderStat"
    : ordersDataIncomplete
      ? `WB Р·Р°РєР°Р·С‹ Р·Р°РіСЂСѓР¶РµРЅС‹ С‡Р°СЃС‚РёС‡РЅРѕ: ${orderStats.loadedDays} РёР· ${orderStats.expectedDays} РґРЅРµР№`
      : null;

  const salesDataMissing =
    effectiveSalesRows.length === 0 && orderStats.ordersQty > 0;
  const salesDataMissingReason = salesDataMissing
    ? "WB Sales/РІС‹РєСѓРїС‹ Р·Р° СЌС‚РѕС‚ РїРµСЂРёРѕРґ РµС‰С‘ РЅРµ Р·Р°РіСЂСѓР¶РµРЅС‹ РІ WbSale"
    : null;

  const adsRows = keepLatestWbAdsRowsPerDate(adsRowsRaw);
  const adSpend = adsRows.reduce((sum, row) => sum + toNumber(row.spend), 0);
  const taxRates = getCompanyTaxRates(companySettings);

  if (isProfitAnalyticsUnavailable(wbProfitAnalytics)) {
    return {
      marketplace: "WB" as const,
      ordersQty: orderStats.ordersQty,
      ordersAmount: orderStats.ordersAmount,
      orderDataLoadedDays: orderStats.loadedDays,
      orderDataExpectedDays: orderStats.expectedDays,
      ordersDataMissing,
      ordersDataIncomplete,
      ordersDataMissingReason,
      salesQty: 0,
      salesAmount: 0,
      salesLabel: "Экономический оборот",
      salesQtyIsReliable: false,
      salesDataMissing: true,
      salesDataMissingReason: "WB финансовые данные неполны",
      adSpend: wbProfitAnalytics.independentAds.adsCost,
      adSpendSource: "WB Ads (не полный P&L)",
      adDataMissing: false,
      adDataMissingReason: null,
      drrByOrders: 0,
      drrBySales: 0,
      drrByEconomicTurnover: 0,
      drrByTaxableRevenue: 0,
      stockQty,
      netProfitAfterTax: 0,
      netProfitUnavailable: true,
      netProfitUnavailableReason: "D6_UNSAFE_WB_OWNERSHIP_MODE",
      financialUnavailable: true,
      financialUnavailableReason: "D6_UNSAFE_WB_OWNERSHIP_MODE",
      taxableRevenue: 0,
      economicTurnover: 0,
      netProfitStatus: "PRELIMINARY" as const,
      sourceOwnershipFinal: false,
    };
  }

  const fallbackNetProfitAfterTax = calculateWbNetProfitAfterTax({
    rows: effectiveSalesRows,
    costs,
    adSpend,
    usnRate: taxRates.usnRate,
    vatRate: taxRates.vatRate,
  });

  const profitTotals = wbProfitAnalytics.totals;
  const financeTotals = sumWbFinanceRows(financeRows);
  const hasDailyFinance = financeRows.length > 0 && Math.abs(financeTotals.totalToPay) > 0.5;
  const profitAnalyticsHasWbData =
    wbProfitAnalytics.rows.length > 0 ||
    profitTotals.revenue !== 0 ||
    profitTotals.sellerRetailAmount !== 0 ||
    profitTotals.taxableRevenue !== 0 ||
    profitTotals.sellerPayout !== 0 ||
    profitTotals.adsCost !== 0 ||
    profitTotals.netProfitAfterTax !== 0;

  const finalSalesQty = profitAnalyticsHasWbData
    ? profitTotals.netSalesQty
    : salesQty;

  // DTO-only mapping onto canonical V6 totals. Do not recompute formulas here.
  // V6: revenue alias = economicTurnover = sellerRetailAmount.
  // Taxable revenue is a separate field (buyerPaid + marketplaceTaxTopUp).
  const finalEconomicTurnover = profitAnalyticsHasWbData
    ? profitTotals.sellerRetailAmount !== 0
      ? profitTotals.sellerRetailAmount
      : profitTotals.revenue
    : salesAmount;

  const finalTaxableRevenue = profitAnalyticsHasWbData
    ? profitTotals.taxableRevenue
    : salesAmount;

  const aliasedSales = aliasWbDailyReportSalesAmount({
    economicTurnover: finalEconomicTurnover,
    taxableRevenue: finalTaxableRevenue,
  });
  const finalSalesAmount = aliasedSales.salesAmount;

  const finalAdSpend = profitAnalyticsHasWbData
    ? profitTotals.adsCost
    : adSpend;

  const canonicalCostOfGoods = calculateWbCostOfGoodsForRows({
    rows: effectiveSalesRows,
    costs,
  });
  let canonicalTaxesAmount = 0;
  let wbFallbackTaxBlockedReason: string | null = null;
  try {
    canonicalTaxesAmount = calculateWbFallbackAccountantTaxLiability({
      rows: effectiveSalesRows.map((row) => ({
        companyName,
        reportNumber: row.reportNumber,
        paymentReason: row.paymentReason,
        documentType: row.documentType,
        wbRealizedAmount: row.wbRealizedAmount,
      })),
      kindByKey: buildWbFinanceTaxReportKindByKeyForRelevantSales(
        financeRows,
        effectiveSalesRows
      ),
      usnRate: taxRates.usnRate,
      vatRate: taxRates.vatRate,
    });
  } catch (error) {
    if (error instanceof WbTaxReportKindError) {
      wbFallbackTaxBlockedReason = error.code;
    } else {
      throw error;
    }
  }

  const wbFallbackNetProfitUnavailable =
    !profitAnalyticsHasWbData && wbFallbackTaxBlockedReason != null;

  // Р•СЃР»Рё РµР¶РµРґРЅРµРІРЅС‹Р№ С„РёРЅР°РЅСЃРѕРІС‹Р№ РѕС‚С‡С‘С‚ WB Р·Р°РіСЂСѓР¶РµРЅ, Telegram СЃС‡РёС‚Р°РµС‚ РїСЂРёР±С‹Р»СЊ
  // РѕС‚ "РС‚РѕРіРѕ Рє РѕРїР»Р°С‚Рµ WB", РєР°Рє /profit-wb Рё СѓРїСЂР°РІР»РµРЅС‡РµСЃРєР°СЏ СЌРєРѕРЅРѕРјРёРєР°:
  // РС‚РѕРіРѕ Рє РѕРїР»Р°С‚Рµ WB в€’ СЃРµР±РµСЃС‚РѕРёРјРѕСЃС‚СЊ в€’ СЂРµРєР»Р°РјР° в€’ РЅР°Р»РѕРі.
  const canonicalNetProfitAfterTax =
    financeTotals.totalToPay -
    canonicalCostOfGoods -
    finalAdSpend -
    canonicalTaxesAmount;

  // Р•РґРёРЅС‹Р№ РёСЃС‚РѕС‡РЅРёРє РёСЃС‚РёРЅС‹: РїСЂРёР±С‹Р»СЊ WB РґРѕР»Р¶РЅР° СЃРѕРІРїР°РґР°С‚СЊ СЃ /profit-wb.
  // РЎР°РјРѕСЃС‚РѕСЏС‚РµР»СЊРЅС‹Р№ СЂР°СЃС‡С‘С‚ DailyReport РѕСЃС‚Р°С‘С‚СЃСЏ С‚РѕР»СЊРєРѕ fallback, РєРѕРіРґР°
  // РєР°РЅРѕРЅРёС‡РµСЃРєР°СЏ Р°РЅР°Р»РёС‚РёРєР° РµС‰С‘ РЅРµ РІРµСЂРЅСѓР»Р° РґР°РЅРЅС‹Рµ.
  const finalNetProfitAfterTax = profitAnalyticsHasWbData
    ? profitTotals.netProfitAfterTax
    : wbFallbackNetProfitUnavailable
      ? 0
      : hasDailyFinance
        ? canonicalNetProfitAfterTax
        : fallbackNetProfitAfterTax;

  return {
    marketplace: "WB" as const,
    ordersQty: orderStats.ordersQty,
    ordersAmount: orderStats.ordersAmount,
    orderDataLoadedDays: orderStats.loadedDays,
    orderDataExpectedDays: orderStats.expectedDays,
    ordersDataMissing,
    ordersDataIncomplete,
    ordersDataMissingReason,
    salesQty: finalSalesQty,
    salesAmount: finalSalesAmount,
    salesLabel: "Р­РєРѕРЅРѕРјРёС‡РµСЃРєРёР№ РѕР±РѕСЂРѕС‚",
    salesQtyIsReliable: !salesDataMissing,
    salesDataMissing,
    salesDataMissingReason,
    adSpend: finalAdSpend,
    adSpendSource: "WB Ads",
    adDataMissing: false,
    adDataMissingReason: null,
    drrByOrders: ordersDataMissing
      ? 0
      : calculateDrr(finalAdSpend, orderStats.ordersAmount),
    drrBySales: salesDataMissing
      ? 0
      : calculateDrr(finalAdSpend, finalSalesAmount),
    drrByEconomicTurnover: salesDataMissing
      ? 0
      : calculateDrr(finalAdSpend, finalEconomicTurnover),
    drrByTaxableRevenue: salesDataMissing
      ? 0
      : calculateDrr(finalAdSpend, aliasedSales.drrTaxableBase),
    stockQty,
    netProfitAfterTax: wbFallbackNetProfitUnavailable ? 0 : finalNetProfitAfterTax,
    netProfitUnavailable: wbFallbackNetProfitUnavailable,
    netProfitUnavailableReason: wbFallbackNetProfitUnavailable
      ? wbFallbackTaxBlockedReason
      : null,
    taxableRevenue: finalTaxableRevenue,
    economicTurnover: finalEconomicTurnover,
    netProfitStatus: profitAnalyticsHasWbData
      ? profitTotals.dataMode === "PRELIMINARY"
        ? ("PRELIMINARY" as const)
        : ("FINAL" as const)
      : undefined,
    sourceOwnershipMode: profitTotals.sourceOwnershipMode,
    sourceOwnershipFinal: profitTotals.sourceOwnershipFinal,
  };
}

function profitAnalyticsHasOzonEconomicActivity(totals: {
  revenue: number;
  economicTurnover: number;
  discountPointsAmount: number;
  adsCost: number;
  netProfitAfterTax: number;
}) {
  return (
    Math.abs(totals.revenue) > 0.5 ||
    Math.abs(totals.economicTurnover) > 0.5 ||
    Math.abs(totals.discountPointsAmount) > 0.5 ||
    Math.abs(totals.adsCost) > 0.5 ||
    Math.abs(totals.netProfitAfterTax) > 0.5
  );
}

async function getOzonMetrics(companyName: string, range: DateRange) {
  const [
    orderStats,
    financeRows,
    adsRowsRaw,
    stockQty,
    costs,
    wbProductCards,
    ozonProducts,
    companySettings,
    ozonProfitAnalytics,
  ] = await Promise.all([
    getOrderStats({
      companyName,
      marketplace: "OZON",
      range,
    }),
    prisma.ozonFinance.findMany({
      where: {
        companyName,
        accrualDate: {
          gte: range.dateFrom,
          lt: range.dateToExclusive,
        },
      },
      select: {
        operationType: true,
        quantity: true,
        salesAmount: true,
        totalAmount: true,
        sku: true,
        vendorCode: true,
      },
    }),
    prisma.ozonAds.findMany({
      where: {
        companyName,
        reportDate: {
          gte: range.dateFrom,
          lt: range.dateToExclusive,
        },
      },
      select: {
        reportDate: true,
        orders: true,
        spend: true,
        importSessionId: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    }),
    getLatestOzonStockQty(companyName),
    prisma.productCost.findMany({
      select: {
        vendorCode: true,
        nmId: true,
        costPrice: true,
      },
      orderBy: {
        costDate: "desc",
      },
    }),
    prisma.wbProductCard.findMany({
      where: {
        companyName,
      },
      select: {
        nmId: true,
        vendorCode: true,
      },
      orderBy: {
        lastSyncedAt: "desc",
      },
    }),
    prisma.ozonProduct.findMany({
      where: {
        companyName,
      },
      select: {
        sku: true,
        vendorCode: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    }),
    prisma.company.findFirst({
      where: {
        name: companyName,
      },
      select: {
        usnRate: true,
        vatRate: true,
      },
    }),
    getProfitAnalyticsOzon({
      dateFrom: getMoscowDateInput(range.dateFrom),
      dateTo: getMoscowDateInput(getInclusiveDateTo(range.dateToExclusive)),
      companyName,
    }),
  ]);

  let salesQty = 0;
  let salesAmount = 0;

  for (const row of financeRows) {
    if (isOzonFinanceAdOperation(row.operationType)) {
      continue;
    }

    const amount = toNumber(row.salesAmount);
    const qty = Math.abs(Number(row.quantity ?? 0));

    if (amount === 0 && qty === 0) continue;

    salesAmount += amount;
    salesQty += qty;
  }

  const adsRows = keepLatestOzonAdsRowsPerDate(adsRowsRaw);
  const performanceAdSpend = adsRows.reduce(
    (sum, row) => sum + toNumber(row.spend),
    0
  );
  const financeAdSpend = calculateOzonFinanceAdSpend(financeRows);
  const financeAdRowsCount = financeRows.filter((row) =>
    isOzonFinanceAdOperation(row.operationType)
  ).length;
  const performanceAdRowsCount = adsRows.length;

  // Р”Р»СЏ СѓРїСЂР°РІР»РµРЅС‡РµСЃРєРѕРіРѕ РѕС‚С‡С‘С‚Р° Р±РµСЂС‘Рј С„Р°РєС‚РёС‡РµСЃРєРёРµ СЂРµРєР»Р°РјРЅС‹Рµ СЃРїРёСЃР°РЅРёСЏ РёР· Ozon Finance,
  // РµСЃР»Рё РѕРЅРё РµСЃС‚СЊ. Performance API РѕСЃС‚Р°РІР»СЏРµРј РєР°Рє fallback, С‡С‚РѕР±С‹ РЅРµ Р·Р°РґРІРѕРёС‚СЊ CPC/CPO.
  const adSpend =
    financeAdRowsCount > 0 ? financeAdSpend : performanceAdSpend;
  const adSpendSource =
    financeAdRowsCount > 0 ? "Ozon Finance Ads" : "Ozon Performance Ads";

  const taxRates = getCompanyTaxRates(companySettings);
  const fallbackNetProfitAfterTax = calculateOzonNetProfitAfterTax({
    rows: financeRows,
    costs,
    wbProductCards,
    ozonProducts,
    adSpend,
    usnRate: taxRates.usnRate,
    vatRate: taxRates.vatRate,
  });

  const profitTotals = ozonProfitAnalytics.totals;
  const ozonFinality = resolveOzonPeriodFinality({
    companyName,
    dateFrom: getMoscowDateInput(range.dateFrom),
    dateTo: getMoscowDateInput(getInclusiveDateTo(range.dateToExclusive)),
    days: await loadOzonAccrualDayStatuses({
      companyName,
      dateFrom: getMoscowDateInput(range.dateFrom),
      dateTo: getMoscowDateInput(getInclusiveDateTo(range.dateToExclusive)),
    }),
  });
  applyOzonCanonicalIngestFinality(profitTotals, ozonFinality);
  const taxRevenueCoverageComplete = profitTotals.taxRevenueCoverageComplete !== false;
  const discountPointsCoverageComplete = profitTotals.discountPointsCoverageComplete !== false;
  const ozonEconomicsIncomplete =
    profitAnalyticsHasOzonEconomicActivity(profitTotals) &&
    (!taxRevenueCoverageComplete || !discountPointsCoverageComplete);
  const ozonEconomicsWarning = ozonEconomicsIncomplete
    ? "РЅР°Р»РѕРіРѕРІР°СЏ РІС‹СЂСѓС‡РєР° / Р±Р°Р»Р»С‹ Ozon РµС‰С‘ РЅРµ Р·Р°РєСЂС‹С‚С‹ вЂ” РїСЂРёР±С‹Р»СЊ РґРѕ РЅР°Р»РѕРіРѕРІ СЂР°СЃСЃС‡РёС‚Р°РЅР° РѕС‚ СЌРєРѕРЅРѕРјРёС‡РµСЃРєРѕРіРѕ РѕР±РѕСЂРѕС‚Р°, РЅР°Р»РѕРі Рё С‡РёСЃС‚Р°СЏ РїСЂРёР±С‹Р»СЊ РїСЂРµРґРІР°СЂРёС‚РµР»СЊРЅС‹Рµ"
    : null;
  const profitAnalyticsHasOzonData =
    ozonProfitAnalytics.rows.length > 0 ||
    profitTotals.revenue !== 0 ||
    profitTotals.taxableRevenue !== 0 ||
    profitTotals.economicTurnover !== 0 ||
    profitTotals.discountPointsAmount !== 0 ||
    profitTotals.adsCost !== 0 ||
    profitTotals.netProfitAfterTax !== 0;

  const finalSalesAmount = profitAnalyticsHasOzonData
    ? profitTotals.economicTurnover > 0
      ? profitTotals.economicTurnover
      : profitTotals.revenue
    : salesAmount;
  // Р•РґРёРЅС‹Р№ РёСЃС‚РѕС‡РЅРёРє РёСЃС‚РёРЅС‹: СЂРµРєР»Р°РјР° Рё РїСЂРёР±С‹Р»СЊ Ozon РґРѕР»Р¶РЅС‹ СЃРѕРІРїР°РґР°С‚СЊ
  // СЃ /profit-ozon. Р’С‚РѕСЂРѕР№ РЅРµР·Р°РІРёСЃРёРјС‹Р№ РїРµСЂРµСЃС‡С‘С‚ РІРЅСѓС‚СЂРё DailyReport
  // СЃРѕР·РґР°РІР°Р» СЂР°СЃС…РѕР¶РґРµРЅРёСЏ РјРµР¶РґСѓ СЃС‚СЂР°РЅРёС†Р°РјРё Рё Telegram.
  const finalAdSpend = profitAnalyticsHasOzonData
    ? profitTotals.adsCost
    : adSpend;
  const finalNetProfitAfterTax = profitAnalyticsHasOzonData
    ? profitTotals.netProfitAfterTax
    : fallbackNetProfitAfterTax;

  const ordersDataMissing = orderStats.rowsCount === 0;
  const ordersDataIncomplete =
    !ordersDataMissing && orderStats.loadedDays < orderStats.expectedDays;
  const ordersDataMissingReason = ordersDataMissing
    ? "Ozon Р·Р°РєР°Р·С‹ Р·Р° СЌС‚РѕС‚ РїРµСЂРёРѕРґ РµС‰С‘ РЅРµ Р·Р°РіСЂСѓР¶РµРЅС‹ РІ MarketplaceDailyOrderStat"
    : ordersDataIncomplete
      ? `Ozon Р·Р°РєР°Р·С‹ Р·Р°РіСЂСѓР¶РµРЅС‹ С‡Р°СЃС‚РёС‡РЅРѕ: ${orderStats.loadedDays} РёР· ${orderStats.expectedDays} РґРЅРµР№`
      : null;

  const hasOzonActivity = orderStats.rowsCount > 0 || finalSalesAmount > 0;
  const adDataMissing =
    hasOzonActivity &&
    finalAdSpend === 0 &&
    financeAdRowsCount === 0 &&
    performanceAdRowsCount === 0;
  const adDataMissingReason = adDataMissing
    ? "Ozon СЂРµРєР»Р°РјРЅС‹Рµ СЂР°СЃС…РѕРґС‹ Р·Р° СЌС‚РѕС‚ РїРµСЂРёРѕРґ РµС‰С‘ РЅРµ Р·Р°РіСЂСѓР¶РµРЅС‹ РёР· Ozon Finance/Performance"
    : null;

  return {
    marketplace: "OZON" as const,
    ordersQty: orderStats.ordersQty,
    ordersAmount: orderStats.ordersAmount,
    orderDataLoadedDays: orderStats.loadedDays,
    orderDataExpectedDays: orderStats.expectedDays,
    ordersDataMissing,
    ordersDataIncomplete,
    ordersDataMissingReason,
    salesQty: 0,
    salesAmount: finalSalesAmount,
    salesLabel: profitAnalyticsHasOzonData ? "Р­РєРѕРЅРѕРјРёС‡РµСЃРєРёР№ РѕР±РѕСЂРѕС‚" : "РќР°С‡РёСЃР»РµРЅРёСЏ",
    salesQtyIsReliable: false,
    salesDataMissing: false,
    salesDataMissingReason: null,
    adSpend: finalAdSpend,
    adSpendSource: profitAnalyticsHasOzonData
      ? "Ozon Finance / СЂРµР°Р»РёР·Р°С†РёСЏ"
      : adSpendSource,
    adDataMissing,
    adDataMissingReason,
    drrByOrders: ordersDataMissing ? 0 : calculateDrr(finalAdSpend, orderStats.ordersAmount),
    drrBySales: calculateDrr(finalAdSpend, finalSalesAmount),
    drrByEconomicTurnover: calculateDrr(
      finalAdSpend,
      profitTotals.economicTurnover || finalSalesAmount
    ),
    drrByTaxableRevenue: calculateDrr(
      finalAdSpend,
      profitAnalyticsHasOzonData && taxRevenueCoverageComplete
        ? profitTotals.taxableRevenue
        : 0
    ),
    stockQty,
    netProfitAfterTax: finalNetProfitAfterTax,
    taxableRevenue: profitAnalyticsHasOzonData && taxRevenueCoverageComplete
      ? profitTotals.taxableRevenue
      : undefined,
    economicTurnover: profitAnalyticsHasOzonData
      ? profitTotals.economicTurnover || finalSalesAmount
      : undefined,
    discountPointsAmount: profitAnalyticsHasOzonData
      ? profitTotals.discountPointsAmount
      : undefined,
    partnerProgramsAmount: profitAnalyticsHasOzonData
      ? profitTotals.partnerProgramsAmount
      : undefined,
    grossOzonExpenses: profitAnalyticsHasOzonData
      ? profitTotals.grossOzonExpenses
      : undefined,
    netOzonExpenses: profitAnalyticsHasOzonData
      ? profitTotals.netOzonExpenses
      : undefined,
    excludedLoansFactoringAmount: profitAnalyticsHasOzonData
      ? profitTotals.excludedLoansFactoringAmount
      : undefined,
    taxRevenueCoverageComplete,
    discountPointsCoverageComplete,
    taxRevenueMissingDays: profitTotals.taxRevenueMissingDays ?? [],
    discountPointsMissingDays: profitTotals.discountPointsMissingDays ?? [],
    ozonEconomicsWarning,
    marginProfit: profitAnalyticsHasOzonData
      ? profitTotals.marginProfit
      : undefined,
    taxesAmount: profitAnalyticsHasOzonData
      ? profitTotals.taxesAmount
      : undefined,
    taxCalculationBase: profitAnalyticsHasOzonData
      ? profitTotals.taxCalculationBase
      : undefined,
    taxCalculationMode: profitAnalyticsHasOzonData
      ? profitTotals.taxCalculationMode
      : undefined,
    taxesEstimated: profitAnalyticsHasOzonData
      ? profitTotals.taxesEstimated
      : undefined,
    netProfitStatus: profitAnalyticsHasOzonData
      ? profitTotals.netProfitStatus
      : undefined,
    ozonQuarantineCount: ozonFinality.quarantineCount,
    ozonCanonicalImportSession: ozonFinality.canonicalImportSession ?? null,
    ozonMissingEvidence: ozonFinality.missingEvidence,
  };
}

function addMarketplaceTotals(
  target: DailyReport["totals"],
  source: MarketplaceDailyMetrics
) {
  target.ordersQty += source.ordersQty;
  target.ordersAmount += source.ordersAmount;
  target.orderDataLoadedDays += source.orderDataLoadedDays;
  target.orderDataExpectedDays += source.orderDataExpectedDays;
  target.stockQty += source.stockQty;
  if (source.financialUnavailable) {
    return;
  }
  target.salesQty += source.salesQty;
  target.salesAmount += source.salesAmount;
  target.economicTurnover += source.economicTurnover ?? source.salesAmount;
  target.taxableRevenue += source.taxableRevenue ?? 0;
  target.adSpend += source.adSpend;
}


function getMoscowDateInput(date: Date) {
  return new Date(date.getTime() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function getPreviousComparableRange(range: DateRange): DateRange {
  const durationMs = range.dateToExclusive.getTime() - range.dateFrom.getTime();
  const dateToExclusive = new Date(range.dateFrom);
  const dateFrom = new Date(range.dateFrom.getTime() - durationMs);
  const inclusiveTo = getInclusiveDateTo(dateToExclusive);

  return {
    dateLabel: `${getMoscowDateInput(dateFrom)} вЂ” ${getMoscowDateInput(inclusiveTo)}`,
    periodLabel: "РђРЅР°Р»РѕРіРёС‡РЅС‹Р№ РїСЂРµРґС‹РґСѓС‰РёР№ РїРµСЂРёРѕРґ",
    dateFrom,
    dateToExclusive,
  };
}

function percentChange(current: number, previous: number) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function createReportComparison(
  current: DailyReport,
  previous: DailyReport
): DailyReportComparison {
  return {
    periodLabel: previous.periodLabel,
    dateLabel: previous.dateLabel,
    totals: {
      ordersAmountPercent: percentChange(
        current.totals.ordersAmount,
        previous.totals.ordersAmount
      ),
      salesAmountPercent: percentChange(
        current.totals.salesAmount,
        previous.totals.salesAmount
      ),
      economicTurnoverPercent: percentChange(
        current.totals.economicTurnover,
        previous.totals.economicTurnover
      ),
      taxableRevenuePercent:
        !hasEstimatedOzonTaxes(current) &&
        !hasEstimatedOzonTaxes(previous)
          ? percentChange(
              current.totals.taxableRevenue,
              previous.totals.taxableRevenue
            )
          : null,
      adSpendPercent: percentChange(
        current.totals.adSpend,
        previous.totals.adSpend
      ),
      netCashFlowPercent: percentChange(
        current.totals.netCashFlow,
        previous.totals.netCashFlow
      ),
      netCashFlowCurrent: current.totals.netCashFlow,
      netCashFlowPrevious: previous.totals.netCashFlow,
      netProfitImpactPercent:
        !isPreliminaryFinancialResult(current) &&
        !isPreliminaryFinancialResult(previous)
          ? percentChange(
              current.totals.netProfitImpact,
              previous.totals.netProfitImpact
            )
          : null,
      drrBySalesPointDiff:
        Number.isFinite(current.totals.drrBySales) &&
        Number.isFinite(previous.totals.drrBySales)
          ? current.totals.drrBySales - previous.totals.drrBySales
          : null,
      drrByEconomicTurnoverPointDiff:
        Number.isFinite(current.totals.drrByEconomicTurnover) &&
        Number.isFinite(previous.totals.drrByEconomicTurnover)
          ? current.totals.drrByEconomicTurnover - previous.totals.drrByEconomicTurnover
          : null,
    },
  };
}

function hasEstimatedOzonTaxes(report: DailyReport) {
  return report.companies.some(
    (company) =>
      company.ozon.taxCalculationMode ===
        "ESTIMATED_ECONOMIC_TURNOVER" ||
      company.ozon.taxesEstimated === true
  );
}

function isPreliminaryFinancialResult(report: DailyReport) {
  return Boolean(
    (report.dataReadiness && !report.dataReadiness.isFinal) ||
      hasEstimatedOzonTaxes(report)
  );
}

function buildWarnings(report: DailyReport) {
  const warnings: string[] = [];
  const suppressReadinessWarnings = Boolean(
    report.dataReadiness && !report.dataReadiness.isFinal
  );

  if (!suppressReadinessWarnings) {
    if (report.totals.ordersQty <= 0 && report.totals.ordersAmount <= 0) {
      warnings.push("РЅРµС‚ Р·Р°РєР°Р·РѕРІ Р·Р° РїРµСЂРёРѕРґ");
    }

    if (hasIncompleteOrderData(report)) {
      warnings.push(
        `Р·Р°РєР°Р·С‹ Р·Р°РіСЂСѓР¶РµРЅС‹ РЅРµ Р·Р° РІРµСЃСЊ РІС‹Р±СЂР°РЅРЅС‹Р№ РїРµСЂРёРѕРґ: ${report.totals.orderDataLoadedDays} РёР· ${report.totals.orderDataExpectedDays} РґРЅРµРІРЅС‹С… СЃСЂРµР·РѕРІ. Р”Р Р  РѕС‚ Р·Р°РєР°Р·РѕРІ РјРѕР¶РµС‚ Р±С‹С‚СЊ Р·Р°РІС‹С€РµРЅ`
      );
    }

    if (report.totals.economicTurnover <= 0) {
      warnings.push("РЅРµС‚ СЌРєРѕРЅРѕРјРёС‡РµСЃРєРѕРіРѕ РѕР±РѕСЂРѕС‚Р° Р·Р° РїРµСЂРёРѕРґ");
    }

    if (report.totals.drrByEconomicTurnover > 20) {
      warnings.push(
        `Р”Р Р  РѕС‚ СЌРєРѕРЅРѕРјРёС‡РµСЃРєРѕРіРѕ РѕР±РѕСЂРѕС‚Р° РІС‹С€Рµ 20%: ${formatPercent(report.totals.drrByEconomicTurnover)}`
      );
    }
  }

  if (report.totals.netCashFlow < 0) {
    warnings.push(`РѕС‚СЂРёС†Р°С‚РµР»СЊРЅС‹Р№ Р”Р”РЎ: ${formatMoney(report.totals.netCashFlow)}`);
  }

  if (report.totals.netProfitImpact < 0) {
    warnings.push(
      `${isPreliminaryFinancialResult(report) ? "РѕС‚СЂРёС†Р°С‚РµР»СЊРЅР°СЏ РїСЂРµРґРІР°СЂРёС‚РµР»СЊРЅР°СЏ РїСЂРёР±С‹Р»СЊ" : "РѕС‚СЂРёС†Р°С‚РµР»СЊРЅР°СЏ С‡РёСЃС‚Р°СЏ РїСЂРёР±С‹Р»СЊ"}: ${formatMoney(
        report.totals.netProfitImpact
      )}`
    );
  }

  if (!suppressReadinessWarnings) {
    for (const company of report.companies) {
      if (company.wb.ordersDataMissing) {
        warnings.push(`${company.companyName} WB: Р·Р°РєР°Р·С‹ РµС‰С‘ РЅРµ Р·Р°РіСЂСѓР¶РµРЅС‹`);
      } else if (company.wb.ordersDataIncomplete) {
        warnings.push(
          `${company.companyName} WB: Р·Р°РєР°Р·С‹ Р·Р°РіСЂСѓР¶РµРЅС‹ С‡Р°СЃС‚РёС‡РЅРѕ (${company.wb.orderDataLoadedDays} РёР· ${company.wb.orderDataExpectedDays} РґРЅРµР№)`
        );
      }

      if (company.ozon.ordersDataMissing) {
        warnings.push(`${company.companyName} Ozon: Р·Р°РєР°Р·С‹ РµС‰С‘ РЅРµ Р·Р°РіСЂСѓР¶РµРЅС‹`);
      } else if (company.ozon.ordersDataIncomplete) {
        warnings.push(
          `${company.companyName} Ozon: Р·Р°РєР°Р·С‹ Р·Р°РіСЂСѓР¶РµРЅС‹ С‡Р°СЃС‚РёС‡РЅРѕ (${company.ozon.orderDataLoadedDays} РёР· ${company.ozon.orderDataExpectedDays} РґРЅРµР№)`
        );
      }

      if (company.wb.adDataMissing) {
        warnings.push(`${company.companyName} WB: СЂРµРєР»Р°РјР° РµС‰С‘ РЅРµ Р·Р°РіСЂСѓР¶РµРЅР°`);
      }

      if (company.ozon.adDataMissing) {
        warnings.push(`${company.companyName} Ozon: СЂРµРєР»Р°РјР° РµС‰С‘ РЅРµ Р·Р°РіСЂСѓР¶РµРЅР°`);
      }

      if (company.wb.salesDataMissing) {
        warnings.push(
          `${company.companyName} WB: продажи/выкупы ещё не загружены`
        );
      }

      if (company.wb.netProfitUnavailable) {
        warnings.push(
          `${company.companyName} WB: чистая прибыль недоступна — не определён тип отчёта для налога (${company.wb.netProfitUnavailableReason ?? "WB_TAX_REPORT_KIND_UNRESOLVED"})`
        );
      }

      if (company.ozon.salesDataMissing) {
        warnings.push(
          `${company.companyName} Ozon: РїСЂРѕРґР°Р¶Рё/РЅР°С‡РёСЃР»РµРЅРёСЏ РµС‰С‘ РЅРµ Р·Р°РіСЂСѓР¶РµРЅС‹`
        );
      }

      if (company.ozon.ozonEconomicsWarning) {
        const missingTaxDays = company.ozon.taxRevenueMissingDays?.length
          ? ` РќРµС‚ РЅР°Р»РѕРіРѕРІРѕР№ РІС‹СЂСѓС‡РєРё Р·Р° РґРЅРё: ${company.ozon.taxRevenueMissingDays.join(", ")}.`
          : "";
        const missingPointDays = company.ozon.discountPointsMissingDays?.length
          ? ` РќРµС‚ Р±Р°Р»Р»РѕРІ Р·Р° РґРЅРё: ${company.ozon.discountPointsMissingDays.join(", ")}.`
          : "";
        warnings.push(
          `${company.companyName} Ozon: ${company.ozon.ozonEconomicsWarning}.${missingTaxDays}${missingPointDays}`
        );
      }
    }
  }

  if (report.totals.stockQty <= 0) {
    warnings.push("РЅРµ РІРёР¶Сѓ РѕСЃС‚Р°С‚РєРѕРІ РїРѕ РїРѕСЃР»РµРґРЅРёРј Р·Р°РіСЂСѓР¶РµРЅРЅС‹Рј РѕС‚С‡С‘С‚Р°Рј");
  }

  return warnings;
}

export async function buildDailyReport(params?: {
  preset?: DailyReportPeriodPreset;
  date?: string;
  from?: string;
  to?: string;
  skipComparison?: boolean;
}): Promise<DailyReport> {
  const range = getDailyReportRange(params);

  const companies = await prisma.company.findMany({
    where: {
      isActive: true,
    },
    orderBy: {
      name: "asc",
    },
    select: {
      name: true,
    },
  });

  const report: DailyReport = {
    dateLabel: range.dateLabel,
    periodLabel: range.periodLabel,
    companies: [],
    totals: {
      ordersQty: 0,
      ordersAmount: 0,
      orderDataLoadedDays: 0,
      orderDataExpectedDays: 0,
      salesQty: 0,
      salesAmount: 0,
      economicTurnover: 0,
      taxableRevenue: 0,
      adSpend: 0,
      drrByOrders: 0,
      drrBySales: 0,
      drrByEconomicTurnover: 0,
      drrByTaxableRevenue: 0,
      stockQty: 0,
      cashIncome: 0,
      cashOutflow: 0,
      netCashFlow: 0,
      netProfitImpact: 0,
      ownerWithdrawals: 0,
    },
    warnings: [],
    dataReadiness: null,
    comparison: null,
  };

  for (const company of companies) {
    const [wb, ozon, finance] = await Promise.all([
      getWbMetrics(company.name, range),
      getOzonMetrics(company.name, range),
      getFinanceMetricsForCompany({
        companyName: company.name,
        range,
      }),
    ]);

    const realNetProfit = wb.financialUnavailable
      ? null
      : (wb.netProfitUnavailable ? 0 : wb.netProfitAfterTax) +
        ozon.netProfitAfterTax +
        finance.netProfitImpact;

    const financeForReport = {
      ...finance,
      netProfitImpact: finance.netProfitImpact,
    };

    const combined = evaluateCombinedMarketplaceFinality({
      wbSelected: true,
      ozonSelected: true,
      wb: resolveWbPeriodFinality({
        dataMode: wb.netProfitStatus === "FINAL" ? "FINAL" : "PRELIMINARY",
        sourceOwnershipMode: wb.sourceOwnershipMode,
        sourceOwnershipFinal: wb.sourceOwnershipFinal === true,
      }),
      ozon: {
        dataMode: ozon.netProfitStatus === "FINAL" ? "FINAL" : "PRELIMINARY",
        coverageComplete:
          ozon.taxRevenueCoverageComplete !== false &&
          ozon.discountPointsCoverageComplete !== false &&
          ozon.netProfitStatus === "FINAL",
        quarantineCount: ozon.ozonQuarantineCount ?? 0,
        missingEvidence: ozon.ozonMissingEvidence,
        canonicalImportSession: ozon.ozonCanonicalImportSession,
      },
    });

    report.companies.push({
      companyName: company.name,
      wb: {
        ...wb,
        netProfitStatus:
          combined.combined.dataMode === "FINAL" ? wb.netProfitStatus : "PRELIMINARY",
      },
      ozon: {
        ...ozon,
        netProfitStatus:
          combined.combined.dataMode === "FINAL" ? ozon.netProfitStatus : "PRELIMINARY",
      },
      combinedDataMode: combined.combined.dataMode,
      finance: financeForReport,
    });

    addMarketplaceTotals(report.totals, wb);
    addMarketplaceTotals(report.totals, ozon);

    report.totals.cashIncome += finance.cashIncome;
    report.totals.cashOutflow += finance.cashOutflow;
    report.totals.netCashFlow += finance.netCashFlow;
    if (wb.financialUnavailable) {
      report.wbFinancialUnavailable = true;
      report.combinedFinancialUnavailable = true;
    } else if (realNetProfit !== null) {
      report.totals.netProfitImpact += realNetProfit;
    }
    report.totals.ownerWithdrawals += finance.ownerWithdrawals;
  }

  report.totals.drrByOrders = calculateDrr(
    report.totals.adSpend,
    report.totals.ordersAmount
  );
  const drrEconomicBase = report.companies.reduce(
    (sum, company) =>
      sum + getDrrEconomicBase(company.wb) + getDrrEconomicBase(company.ozon),
    0
  );

  report.totals.drrBySales = calculateDrr(report.totals.adSpend, report.totals.salesAmount);
  report.totals.drrByEconomicTurnover = calculateDrr(
    report.totals.adSpend,
    report.totals.economicTurnover || drrEconomicBase
  );
  report.totals.drrByTaxableRevenue = calculateDrr(
    report.totals.adSpend,
    report.totals.taxableRevenue
  );

  const dataReadiness = await getDataReadinessSummary({
    dateFrom: getMoscowDateInput(range.dateFrom),
    dateTo: getMoscowDateInput(getInclusiveDateTo(range.dateToExclusive)),
    companyName: null,
  });

  report.dataReadiness = dataReadiness;
  report.warnings = buildWarnings(report);

  if (!params?.skipComparison) {
    const previousRange = getPreviousComparableRange(range);
    const previousReport = await buildDailyReport({
      from: getMoscowDateInput(previousRange.dateFrom),
      to: getMoscowDateInput(getInclusiveDateTo(previousRange.dateToExclusive)),
      skipComparison: true,
    });

    report.comparison = createReportComparison(report, previousReport);
  }

  return report;
}

export function formatMoney(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatPercent(value: number) {
  return `${new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 1,
  }).format(value)}%`;
}

export function formatRuDate(value: string | null | undefined) {
  const match = String(value ?? "").match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(value ?? "").trim();
  return `${match[3]}.${match[2]}.${match[1]}`;
}

export function formatRuDateShort(value: string | null | undefined) {
  const match = String(value ?? "").match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(value ?? "").trim();
  return `${match[3]}.${match[2]}`;
}

export function formatCompactMoney(value: number) {
  const abs = Math.abs(value);
  const sign = value < 0 ? "в€’" : "";

  if (abs >= 1_000_000) {
    const millions = abs / 1_000_000;
    const formatted = new Intl.NumberFormat("ru-RU", {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    }).format(millions);
    return `${sign}${formatted} РјР»РЅ в‚Ѕ`;
  }

  if (abs >= 1000) {
    const thousands = abs / 1000;
    const formatted = new Intl.NumberFormat("ru-RU", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(thousands);
    return `${sign}${formatted} С‚С‹СЃ. в‚Ѕ`;
  }

  return `${sign}${formatNumber(abs)} в‚Ѕ`;
}

export function formatSignedMoney(value: number) {
  if (value > 0) return `+${formatMoney(value)}`;
  if (value < 0) return formatMoney(value);
  return formatMoney(0);
}

export function shouldShowCashFlowPercent(params: {
  current: number;
  previous: number;
  percent: number | null;
}) {
  if (params.percent === null || !Number.isFinite(params.percent)) return false;
  if (Math.abs(params.previous) < 10_000) return false;
  if (params.current !== 0 && params.previous !== 0) {
    const currentSign = Math.sign(params.current);
    const previousSign = Math.sign(params.previous);
    if (currentSign !== previousSign) return false;
  }
  if (Math.abs(params.percent) > 250) return false;
  return true;
}

export type TelegramReadinessIssue = {
  companyName: string;
  marketplace: "WB" | "Ozon";
  source: string;
  dateLabel: string;
  reason: string;
};

function marketplaceHasIncompleteTaxableRevenueSource(
  metrics: MarketplaceDailyMetrics
) {
  if (metrics.marketplace === "OZON" && metrics.taxRevenueCoverageComplete === false) {
    return true;
  }
  if (metrics.marketplace === "WB" && metrics.salesDataMissing) {
    return true;
  }
  return false;
}

function marketplaceHasIncompleteProfitSource(metrics: MarketplaceDailyMetrics) {
  if (marketplaceHasIncompleteTaxableRevenueSource(metrics)) return true;
  if (metrics.marketplace === "OZON") {
    if (metrics.discountPointsCoverageComplete === false) return true;
    if (metrics.taxesEstimated === true) return true;
  }
  return false;
}

export function hasIncompleteTaxableRevenueSource(report: DailyReport) {
  return report.companies.some(
    (company) =>
      marketplaceHasIncompleteTaxableRevenueSource(company.wb) ||
      marketplaceHasIncompleteTaxableRevenueSource(company.ozon)
  );
}

export function hasIncompleteProfitSource(report: DailyReport) {
  return report.companies.some(
    (company) =>
      marketplaceHasIncompleteProfitSource(company.wb) ||
      marketplaceHasIncompleteProfitSource(company.ozon)
  );
}

function primaryReportDate(report: DailyReport) {
  const match = String(report.dateLabel ?? "").match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? report.dateLabel;
}

export function collectTelegramReadinessIssues(
  report: DailyReport
): TelegramReadinessIssue[] {
  const dateIso = primaryReportDate(report);
  const dateShort = formatRuDateShort(dateIso);
  const issues: TelegramReadinessIssue[] = [];

  const push = (
    companyName: string,
    marketplace: "WB" | "Ozon",
    source: string,
    reason: string
  ) => {
    issues.push({
      companyName,
      marketplace,
      source,
      dateLabel: dateShort || dateIso,
      reason,
    });
  };

  for (const company of report.companies) {
    if (company.wb.ordersDataMissing) {
      push(
        company.companyName,
        "WB",
        "Р·Р°РєР°Р·С‹",
        `РЅРµ Р·Р°РіСЂСѓР¶РµРЅС‹ Р·Р°РєР°Р·С‹ Р·Р° ${dateShort}`
      );
    } else if (company.wb.ordersDataIncomplete) {
      push(
        company.companyName,
        "WB",
        "Р·Р°РєР°Р·С‹",
        `Р·Р°РєР°Р·С‹ Р·Р°РіСЂСѓР¶РµРЅС‹ С‡Р°СЃС‚РёС‡РЅРѕ Р·Р° ${dateShort}: ${company.wb.orderDataLoadedDays} РёР· ${company.wb.orderDataExpectedDays} РґРЅ.`
      );
    }

    if (company.wb.salesDataMissing) {
      push(
        company.companyName,
        "WB",
        "РїСЂРѕРґР°Р¶Рё",
        `РЅРµ Р·Р°РіСЂСѓР¶РµРЅС‹ РїСЂРѕРґР°Р¶Рё/РІС‹РєСѓРїС‹ Р·Р° ${dateShort}`
      );
    }

    if (company.wb.adDataMissing) {
      push(
        company.companyName,
        "WB",
        "СЂРµРєР»Р°РјР°",
        `РЅРµ Р·Р°РіСЂСѓР¶РµРЅР° СЂРµРєР»Р°РјР° Р·Р° ${dateShort}`
      );
    }

    // WB_WEEKLY_NOT_CLOSED / dataMode=PRELIMINARY is the normal daily-summary
    // state while the official week is still open. Do not treat it as a missing
    // daily source. Warn only when a concrete WB daily source is absent.

    if (company.ozon.ordersDataMissing) {
      push(
        company.companyName,
        "Ozon",
        "Р·Р°РєР°Р·С‹",
        `РЅРµ Р·Р°РіСЂСѓР¶РµРЅС‹ Р·Р°РєР°Р·С‹ Р·Р° ${dateShort}`
      );
    } else if (company.ozon.ordersDataIncomplete) {
      push(
        company.companyName,
        "Ozon",
        "Р·Р°РєР°Р·С‹",
        `Р·Р°РєР°Р·С‹ Р·Р°РіСЂСѓР¶РµРЅС‹ С‡Р°СЃС‚РёС‡РЅРѕ Р·Р° ${dateShort}: ${company.ozon.orderDataLoadedDays} РёР· ${company.ozon.orderDataExpectedDays} РґРЅ.`
      );
    }

    if (company.ozon.adDataMissing) {
      push(
        company.companyName,
        "Ozon",
        "СЂРµРєР»Р°РјР°",
        `РЅРµ Р·Р°РіСЂСѓР¶РµРЅР° СЂРµРєР»Р°РјР° Р·Р° ${dateShort}`
      );
    }

    if (company.ozon.taxRevenueCoverageComplete === false) {
      const missing = company.ozon.taxRevenueMissingDays?.length
        ? company.ozon.taxRevenueMissingDays.map(formatRuDateShort).join(", ")
        : dateShort;
      push(
        company.companyName,
        "Ozon",
        "РѕС‚С‡С‘С‚ РЅР°С‡РёСЃР»РµРЅРёР№",
        `РЅРµС‚ РѕС‚С‡С‘С‚Р° РЅР°С‡РёСЃР»РµРЅРёР№ Р·Р° ${missing}`
      );
    }

    if (company.ozon.discountPointsCoverageComplete === false) {
      const missing = company.ozon.discountPointsMissingDays?.length
        ? company.ozon.discountPointsMissingDays.map(formatRuDateShort).join(", ")
        : dateShort;
      push(
        company.companyName,
        "Ozon",
        "РѕС‚С‡С‘С‚ Р±Р°Р»Р»РѕРІ",
        `РЅРµС‚ РѕС‚С‡С‘С‚Р° Р±Р°Р»Р»РѕРІ Р·Р° ${missing}`
      );
    }
  }

  return issues;
}

export function formatTelegramReadinessBlock(
  issues: TelegramReadinessIssue[]
) {
  if (issues.length === 0) return [];

  return [
    "вљ пёЏ РќРµРїРѕР»РЅС‹Рµ РґР°РЅРЅС‹Рµ:",
    ...issues.map(
      (issue) =>
        `вЂў ${issue.companyName} В· ${issue.marketplace}: ${issue.reason}`
    ),
  ];
}

function marketplaceSalesLine(metrics: MarketplaceDailyMetrics) {
  if (metrics.salesDataMissing) {
    return `${metrics.salesLabel}: РґР°РЅРЅС‹Рµ РµС‰С‘ РЅРµ Р·Р°РіСЂСѓР¶РµРЅС‹`;
  }

  if (metrics.economicTurnover !== undefined) {
    if (metrics.marketplace === "OZON" && metrics.ozonEconomicsWarning) {
      return `Р­РєРѕРЅРѕРјРёС‡РµСЃРєРёР№ РѕР±РѕСЂРѕС‚: ${formatMoney(metrics.economicTurnover)} (${metrics.ozonEconomicsWarning})`;
    }

    const details: string[] = [];
    const taxableRevenue = metrics.taxableRevenue ?? 0;
    const discountPointsAmount = metrics.discountPointsAmount ?? 0;
    const partnerProgramsAmount = metrics.partnerProgramsAmount ?? 0;

    if (metrics.taxableRevenue !== undefined) {
      details.push(`РЅР°Р»РѕРіРѕРІР°СЏ РІС‹СЂСѓС‡РєР° ${formatMoney(taxableRevenue)}`);
    }

    if (metrics.discountPointsAmount !== undefined && Math.abs(discountPointsAmount) > 0.5) {
      details.push(`Р±Р°Р»Р»С‹ ${formatMoney(discountPointsAmount)}`);
    }

    if (metrics.partnerProgramsAmount !== undefined && Math.abs(partnerProgramsAmount) > 0.5) {
      details.push(`РїСЂРѕРіСЂР°РјРјС‹ РїР°СЂС‚РЅС‘СЂРѕРІ ${formatMoney(partnerProgramsAmount)}`);
    }

    const knownEconomicParts =
      (metrics.taxableRevenue !== undefined ? taxableRevenue : 0) +
      (metrics.discountPointsAmount !== undefined ? discountPointsAmount : 0) +
      (metrics.partnerProgramsAmount !== undefined ? partnerProgramsAmount : 0);
    const unclassifiedEconomicPart = metrics.economicTurnover - knownEconomicParts;

    if (metrics.marketplace === "OZON" && details.length > 0 && Math.abs(unclassifiedEconomicPart) > 0.5) {
      details.push(`РЅРµСЂР°Р·РЅРµСЃС‘РЅРЅР°СЏ С‡Р°СЃС‚СЊ ${formatMoney(unclassifiedEconomicPart)}`);
    }

    return `Р­РєРѕРЅРѕРјРёС‡РµСЃРєРёР№ РѕР±РѕСЂРѕС‚: ${formatMoney(metrics.economicTurnover)}${
      details.length > 0 ? ` (${details.join(" + ")})` : ""
    }`;
  }

  if (metrics.salesQtyIsReliable) {
    return `${metrics.salesLabel}: ${formatNumber(metrics.salesQty)} С€С‚ / ${formatMoney(
      metrics.salesAmount
    )}`;
  }

  return `${metrics.salesLabel}: ${formatMoney(metrics.salesAmount)}`;
}

function marketplaceOrdersLine(metrics: MarketplaceDailyMetrics) {
  if (metrics.ordersDataMissing) {
    return "Р—Р°РєР°Р·С‹: РґР°РЅРЅС‹Рµ РµС‰С‘ РЅРµ Р·Р°РіСЂСѓР¶РµРЅС‹";
  }

  const coverageText = metrics.ordersDataIncomplete
    ? ` В· С‡Р°СЃС‚РёС‡РЅРѕ: ${formatNumber(metrics.orderDataLoadedDays)} РёР· ${formatNumber(
        metrics.orderDataExpectedDays
      )} РґРЅРµР№`
    : "";

  return `Р—Р°РєР°Р·С‹: ${formatNumber(metrics.ordersQty)} С€С‚ / ${formatMoney(
    metrics.ordersAmount
  )}${coverageText}`;
}

function marketplaceAdLine(metrics: MarketplaceDailyMetrics) {
  if (metrics.adDataMissing) {
    return "Р РµРєР»Р°РјР°: РґР°РЅРЅС‹Рµ РµС‰С‘ РЅРµ Р·Р°РіСЂСѓР¶РµРЅС‹";
  }

  return `Р РµРєР»Р°РјР°: ${formatMoney(metrics.adSpend)}`;
}

type MarketplaceConclusionItem = {
  label: string;
  drrByOrders: number;
  drrBySales: number;
  drrByEconomicTurnover: number;
  ordersAmount: number;
  salesAmount: number;
  economicTurnover: number;
  adSpend: number;
  ordersDataIncomplete: boolean;
};

function getMarketplaceConclusionItems(report: DailyReport) {
  const items: MarketplaceConclusionItem[] = [];

  for (const company of report.companies) {
    items.push({
      label: `${company.companyName} WB`,
      drrByOrders: company.wb.drrByOrders,
      drrBySales: company.wb.drrBySales,
      drrByEconomicTurnover: company.wb.drrByEconomicTurnover,
      ordersAmount: company.wb.ordersAmount,
      salesAmount: company.wb.salesAmount,
      economicTurnover: company.wb.economicTurnover ?? company.wb.salesAmount,
      adSpend: company.wb.adSpend,
      ordersDataIncomplete: company.wb.ordersDataIncomplete,
    });

    items.push({
      label: `${company.companyName} Ozon`,
      drrByOrders: company.ozon.drrByOrders,
      drrBySales: company.ozon.drrBySales,
      drrByEconomicTurnover: company.ozon.drrByEconomicTurnover,
      ordersAmount: company.ozon.ordersAmount,
      salesAmount: company.ozon.salesAmount,
      economicTurnover: company.ozon.economicTurnover ?? company.ozon.salesAmount,
      adSpend: company.ozon.adSpend,
      ordersDataIncomplete: company.ozon.ordersDataIncomplete,
    });
  }

  return items;
}

function getHighestDrrItem(report: DailyReport) {
  const items = getMarketplaceConclusionItems(report).filter(
    (item) => item.economicTurnover > 0 && item.adSpend > 0
  );

  if (items.length === 0) return null;

  return items.sort((a, b) => b.drrByEconomicTurnover - a.drrByEconomicTurnover)[0];
}

function getDrrConclusion(report: DailyReport) {
  const totalDrr = report.totals.drrByEconomicTurnover;

  if (report.totals.adSpend <= 0 || report.totals.economicTurnover <= 0) {
    return "Р РµРєР»Р°РјР°: РЅРµС‚ РґРѕСЃС‚Р°С‚РѕС‡РЅРѕ РґР°РЅРЅС‹С… РґР»СЏ РѕС†РµРЅРєРё Р”Р Р .";
  }

  if (totalDrr <= 7) {
    return `Р РµРєР»Р°РјР° РІ СЂР°Р±РѕС‡РµР№ Р·РѕРЅРµ: Р”Р Р  ${formatPercent(
      totalDrr
    )} РѕС‚ СЌРєРѕРЅРѕРјРёС‡РµСЃРєРѕРіРѕ РѕР±РѕСЂРѕС‚Р°.`;
  }

  if (totalDrr <= 10) {
    return `Р РµРєР»Р°РјР° С‚СЂРµР±СѓРµС‚ РєРѕРЅС‚СЂРѕР»СЏ: Р”Р Р  ${formatPercent(
      totalDrr
    )} РѕС‚ СЌРєРѕРЅРѕРјРёС‡РµСЃРєРѕРіРѕ РѕР±РѕСЂРѕС‚Р°.`;
  }

  return `Р РµРєР»Р°РјР° РїРµСЂРµРіСЂРµС‚Р°: Р”Р Р  ${formatPercent(
    totalDrr
  )} РѕС‚ СЌРєРѕРЅРѕРјРёС‡РµСЃРєРѕРіРѕ РѕР±РѕСЂРѕС‚Р°, РЅСѓР¶РЅРѕ РїСЂРѕРІРµСЂРёС‚СЊ РєР°РјРїР°РЅРёРё.`;
}

function getCashFlowConclusion(report: DailyReport) {
  if (report.totals.netCashFlow < 0) {
    return `Р”РµРЅРµР¶РЅС‹Р№ РїРѕС‚РѕРє РѕС‚СЂРёС†Р°С‚РµР»СЊРЅС‹Р№: ${formatMoney(
      report.totals.netCashFlow
    )}. Р”РµРЅСЊРіРё РёР· Р±РёР·РЅРµСЃР° СѓС…РѕРґСЏС‚ Р±С‹СЃС‚СЂРµРµ, С‡РµРј Р·Р°С…РѕРґСЏС‚.`;
  }

  if (report.totals.netCashFlow > 0) {
    return `Р”РµРЅРµР¶РЅС‹Р№ РїРѕС‚РѕРє РїРѕР»РѕР¶РёС‚РµР»СЊРЅС‹Р№: ${formatMoney(
      report.totals.netCashFlow
    )}. Р—Р° РїРµСЂРёРѕРґ РєР°СЃСЃР° РїСЂРѕС€Р»Р° СѓСЃС‚РѕР№С‡РёРІРѕ.`;
  }

  return "Р”РµРЅРµР¶РЅС‹Р№ РїРѕС‚РѕРє РѕРєРѕР»Рѕ РЅСѓР»СЏ: РєР°СЃСЃР° Р±РµР· Р·Р°РїР°СЃР° РїСЂРѕС‡РЅРѕСЃС‚Рё.";
}

function getProfitConclusion(report: DailyReport) {
  const preliminary = isPreliminaryFinancialResult(report);
  const label = preliminary
    ? "РџСЂРµРґРІР°СЂРёС‚РµР»СЊРЅР°СЏ РїСЂРёР±С‹Р»СЊ"
    : "Р§РёСЃС‚Р°СЏ РїСЂРёР±С‹Р»СЊ";

  if (report.totals.netProfitImpact < 0) {
    return `${label} РїРѕРґ РґР°РІР»РµРЅРёРµРј: ${formatMoney(
      report.totals.netProfitImpact
    )}. ${preliminary ? "РС‚РѕРі СѓС‚РѕС‡РЅРёС‚СЃСЏ РїРѕСЃР»Рµ Р·Р°РєСЂС‹С‚РёСЏ РЅР°Р»РѕРіРѕРІРѕР№ РІС‹СЂСѓС‡РєРё Ozon Рё С„РёРЅР°РЅСЃРѕРІРѕРіРѕ РїРµСЂРёРѕРґР° WB." : "РќСѓР¶РЅРѕ СЃРјРѕС‚СЂРµС‚СЊ СЂР°СЃС…РѕРґС‹ Рё РІС‹РІРѕРґС‹."}`;
  }

  if (report.totals.netProfitImpact > 0) {
    return `${label} Р·Р° РїРµСЂРёРѕРґ РїРѕР»РѕР¶РёС‚РµР»СЊРЅР°СЏ: ${formatMoney(
      report.totals.netProfitImpact
    )}.${preliminary ? " РС‚РѕРі СѓС‚РѕС‡РЅРёС‚СЃСЏ РїРѕСЃР»Рµ Р·Р°РєСЂС‹С‚РёСЏ РЅР°Р»РѕРіРѕРІРѕР№ РІС‹СЂСѓС‡РєРё Ozon Рё С„РёРЅР°РЅСЃРѕРІРѕРіРѕ РїРµСЂРёРѕРґР° WB." : ""}`;
  }

  return `${label} РѕРєРѕР»Рѕ РЅСѓР»СЏ.${preliminary ? " РС‚РѕРі РїРѕРєР° РїСЂРµРґРІР°СЂРёС‚РµР»СЊРЅС‹Р№." : ""}`;
}

function buildOwnerConclusion(report: DailyReport) {
  const lines: string[] = ["Р’С‹РІРѕРґ РїРѕ РїРµСЂРёРѕРґСѓ:"];

  lines.push(
    `РћР±РѕСЂРѕС‚ Р·Р°РєР°Р·РѕРІ: ${formatMoney(report.totals.ordersAmount)} РїСЂРё РѕСЃС‚Р°С‚РєР°С… ${formatNumber(
      report.totals.stockQty
    )} С€С‚.`
  );

  lines.push(getDrrConclusion(report));
  lines.push(getCashFlowConclusion(report));
  lines.push(getProfitConclusion(report));

  if (report.totals.ownerWithdrawals > 0 && report.totals.netCashFlow < 0) {
    lines.push(
      `Р’С‹РІРѕРґ СЃРѕР±СЃС‚РІРµРЅРЅРёРєР° ${formatMoney(
        report.totals.ownerWithdrawals
      )} СѓСЃРёР»РёР» РєР°СЃСЃРѕРІС‹Р№ СЂР°Р·СЂС‹РІ Р·Р° РїРµСЂРёРѕРґ.`
    );
  }

  const highestDrrItem = getHighestDrrItem(report);

  if (highestDrrItem && highestDrrItem.drrByEconomicTurnover >= 10) {
    lines.push(
      `РЎР°РјР°СЏ РґРѕСЂРѕРіР°СЏ СЃРІСЏР·РєР° РїРѕ СЂРµРєР»Р°РјРµ: ${
        highestDrrItem.label
      } вЂ” Р”Р Р  ${formatPercent(highestDrrItem.drrByEconomicTurnover)} РѕС‚ СЌРєРѕРЅРѕРјРёС‡РµСЃРєРѕРіРѕ РѕР±РѕСЂРѕС‚Р°.`
    );
  }

  return lines;
}

function getHighDrrAction(report: DailyReport) {
  const highestDrrItem = getHighestDrrItem(report);

  if (!highestDrrItem || highestDrrItem.drrByEconomicTurnover < 10) {
    return null;
  }

  if (highestDrrItem.economicTurnover < 50000) {
    return `РџСЂРѕРІРµСЂРёС‚СЊ ${highestDrrItem.label}: Р”Р Р  РІС‹СЃРѕРєРёР№, РЅРѕ РѕР±СЉС‘Рј СЌРєРѕРЅРѕРјРёС‡РµСЃРєРѕРіРѕ РѕР±РѕСЂРѕС‚Р° РјР°Р»РµРЅСЊРєРёР№ вЂ” РЅРµ РјР°СЃС€С‚Р°Р±РёСЂРѕРІР°С‚СЊ СЂРµРєР»Р°РјСѓ Р±РµР· РїСЂРѕРІРµСЂРєРё С‚РѕРІР°СЂРѕРІ Рё СЃС‚Р°РІРѕРє.`;
  }

  return `РџСЂРѕРІРµСЂРёС‚СЊ ${highestDrrItem.label}: Р”Р Р  ${formatPercent(
    highestDrrItem.drrByEconomicTurnover
  )} РѕС‚ СЌРєРѕРЅРѕРјРёС‡РµСЃРєРѕРіРѕ РѕР±РѕСЂРѕС‚Р° вЂ” РЅР°Р№С‚Рё РєР°РјРїР°РЅРёРё/С‚РѕРІР°СЂС‹, РєРѕС‚РѕСЂС‹Рµ СЃСЉРµРґР°СЋС‚ Р±СЋРґР¶РµС‚.`;
}

function getSalesGapAction(report: DailyReport) {
  if (report.totals.ordersAmount <= 0 || hasIncompleteOrderData(report)) return null;

  const salesToOrdersRatio =
    (report.totals.salesAmount / report.totals.ordersAmount) * 100;

  if (salesToOrdersRatio < 55) {
    return `РџСЂРѕРІРµСЂРёС‚СЊ СЂР°Р·СЂС‹РІ Р·Р°РєР°Р·РѕРІ Рё РїСЂРѕРґР°Р¶/РЅР°С‡РёСЃР»РµРЅРёР№: СЃРµР№С‡Р°СЃ РїСЂРѕРґР°Р¶Рё/РЅР°С‡РёСЃР»РµРЅРёСЏ в‰€ ${formatPercent(
      salesToOrdersRatio
    )} РѕС‚ СЃСѓРјРјС‹ Р·Р°РєР°Р·РѕРІ. Р”Р»СЏ РІС‹Р±СЂР°РЅРЅРѕРіРѕ РїРµСЂРёРѕРґР° СЌС‚Рѕ РјРѕР¶РµС‚ Р±С‹С‚СЊ РЅРѕСЂРјР°Р»СЊРЅРѕР№ Р·Р°РґРµСЂР¶РєРѕР№, РЅРѕ С‚СЂРµРЅРґ РЅСѓР¶РЅРѕ СЃРјРѕС‚СЂРµС‚СЊ РІ РґРёРЅР°РјРёРєРµ.`;
  }

  return null;
}

function buildOwnerActions(report: DailyReport) {
  const actions: string[] = [];

  if (hasIncompleteOrderData(report) && (!report.dataReadiness || report.dataReadiness.isFinal)) {
    actions.push(
      "РќРµ РґРµР»Р°С‚СЊ РѕРєРѕРЅС‡Р°С‚РµР»СЊРЅС‹Рµ РІС‹РІРѕРґС‹ РїРѕ Р”Р Р  РѕС‚ Р·Р°РєР°Р·РѕРІ, РїРѕРєР° Р·Р°РєР°Р·С‹ РЅРµ РЅР°РєРѕРїСЏС‚СЃСЏ Р·Р° РІРµСЃСЊ РїРµСЂРёРѕРґ. Р“Р»Р°РІРЅС‹Р№ РѕСЂРёРµРЅС‚РёСЂ вЂ” Р”Р Р  РѕС‚ СЌРєРѕРЅРѕРјРёС‡РµСЃРєРѕРіРѕ РѕР±РѕСЂРѕС‚Р°."
    );
  }

  if (report.totals.netCashFlow < 0) {
    actions.push(
      "РџСЂРѕРІРµСЂРёС‚СЊ РєСЂСѓРїРЅС‹Рµ СЂР°СЃС…РѕРґС‹ РїРµСЂРёРѕРґР° Рё РѕС‚РґРµР»РёС‚СЊ РѕР±СЏР·Р°С‚РµР»СЊРЅС‹Рµ РїР»Р°С‚РµР¶Рё РѕС‚ С‚РµС…, С‡С‚Рѕ РјРѕР¶РЅРѕ РїРµСЂРµРЅРµСЃС‚Рё."
    );
  }

  if (report.totals.ownerWithdrawals > 0 && report.totals.netCashFlow < 0) {
    actions.push(
      "Р’ РїРµСЂРёРѕРґС‹ СЃ РјРёРЅСѓСЃРѕРІС‹Рј Р”Р”РЎ РЅРµ СѓРІРµР»РёС‡РёРІР°С‚СЊ РІС‹РІРѕРґ СЃРѕР±СЃС‚РІРµРЅРЅРёРєР° Р±РµР· РїСЂРѕРІРµСЂРєРё Р±Р»РёР¶Р°Р№С€РёС… РїР»Р°С‚РµР¶РµР№."
    );
  }

  const highDrrAction = getHighDrrAction(report);

  if (highDrrAction) {
    actions.push(highDrrAction);
  }

  const salesGapAction = getSalesGapAction(report);

  if (salesGapAction) {
    actions.push(salesGapAction);
  }

  if (report.totals.stockQty > 0) {
    actions.push(
      `РћСЃС‚Р°С‚РєРё ${formatNumber(
        report.totals.stockQty
      )} С€С‚: СЃР»РµРґСѓСЋС‰РёРј С€Р°РіРѕРј СЃРјРѕС‚СЂРµС‚СЊ РЅРµ РѕР±С‰РёР№ РѕСЃС‚Р°С‚РѕРє, Р° SKU СЃ Р±РѕР»СЊС€РёРј Р·Р°РїР°СЃРѕРј Рё СЃР»Р°Р±С‹Рј СЃРїСЂРѕСЃРѕРј.`
    );
  }

  return ["Р§С‚Рѕ СЃРґРµР»Р°С‚СЊ РґР°Р»СЊС€Рµ:", ...actions.slice(0, 4).map((action, index) => `${index + 1}. ${action}`)];
}

function marketplaceLine(label: string, metrics: MarketplaceDailyMetrics) {
  const lines = [`${label}`, marketplaceOrdersLine(metrics), marketplaceSalesLine(metrics)];


  lines.push(marketplaceAdLine(metrics));

  if (metrics.marketplace === "OZON" && metrics.netOzonExpenses !== undefined) {
    lines.push(
      metrics.discountPointsCoverageComplete === false
        ? `Р Р°СЃС…РѕРґС‹ Ozon РїРѕ Р·Р°РіСЂСѓР¶РµРЅРЅС‹Рј РґР°РЅРЅС‹Рј: ${formatMoney(metrics.netOzonExpenses)}`
        : `Р§РёСЃС‚С‹Рµ СЂР°СЃС…РѕРґС‹ Ozon РїРѕСЃР»Рµ Р±Р°Р»Р»РѕРІ: ${formatMoney(metrics.netOzonExpenses)}`
    );
  }

  if (
    metrics.marketplace === "OZON" &&
    metrics.taxCalculationBase !== undefined &&
    metrics.taxesAmount !== undefined
  ) {
    if (metrics.taxesEstimated) {
      lines.push(
        "РќР°Р»РѕРіРѕРІР°СЏ РІС‹СЂСѓС‡РєР°: РѕР¶РёРґР°РµС‚СЃСЏ РѕС‚С‡С‘С‚ РЅР°С‡РёСЃР»РµРЅРёР№",
        `РќР°Р»РѕРіРѕРІС‹Р№ СЂРµР·РµСЂРІ: ${formatMoney(
          metrics.taxesAmount
        )} вЂ” РїСЂРµРґРІР°СЂРёС‚РµР»СЊРЅРѕ РѕС‚ СЌРєРѕРЅРѕРјРёС‡РµСЃРєРѕРіРѕ РѕР±РѕСЂРѕС‚Р° ${formatMoney(
          metrics.taxCalculationBase
        )}`,
        `РџСЂРёР±С‹Р»СЊ РґРѕ РЅР°Р»РѕРіРѕРІ: ${formatMoney(metrics.marginProfit ?? 0)}`,
        `РџСЂРµРґРІР°СЂРёС‚РµР»СЊРЅР°СЏ С‡РёСЃС‚Р°СЏ РїСЂРёР±С‹Р»СЊ Ozon: ${formatMoney(
          metrics.netProfitAfterTax
        )}`
      );
    } else {
      lines.push(
        `РќР°Р»РѕРіРѕРІР°СЏ РІС‹СЂСѓС‡РєР°: ${formatMoney(metrics.taxableRevenue ?? 0)}`,
        `РќР°Р»РѕРіРё: ${formatMoney(metrics.taxesAmount)}`,
        `РџСЂРёР±С‹Р»СЊ РґРѕ РЅР°Р»РѕРіРѕРІ: ${formatMoney(metrics.marginProfit ?? 0)}`,
        `Р§РёСЃС‚Р°СЏ РїСЂРёР±С‹Р»СЊ Ozon: ${formatMoney(metrics.netProfitAfterTax)}`
      );
    }
  }

  if (
    metrics.marketplace === "OZON" &&
    metrics.excludedLoansFactoringAmount !== undefined &&
    Math.abs(metrics.excludedLoansFactoringAmount) > 0.5
  ) {
    lines.push(
      `РСЃРєР»СЋС‡РµРЅРѕ РёР· РїСЂРёР±С‹Р»Рё: Р·Р°Р№РјС‹ / С„Р°РєС‚РѕСЂРёРЅРі ${formatMoney(
        metrics.excludedLoansFactoringAmount
      )}`
    );
  }

  const taxDrrText =
    metrics.marketplace === "OZON" &&
    metrics.taxRevenueCoverageComplete === false
      ? "РѕР¶РёРґР°РµС‚СЃСЏ РѕС‚С‡С‘С‚ РЅР°С‡РёСЃР»РµРЅРёР№"
      : formatPercent(metrics.drrByTaxableRevenue);

  lines.push(
    `Р”Р Р : РѕС‚ СЌРєРѕРЅ. РѕР±РѕСЂРѕС‚Р° ${formatPercent(metrics.drrByEconomicTurnover)} (РѕС‚ РЅР°Р»РѕРіРѕРІРѕР№ РІС‹СЂСѓС‡РєРё ${taxDrrText}, РѕС‚ Р·Р°РєР°Р·РѕРІ ${formatPercent(metrics.drrByOrders)})`,
    `РћСЃС‚Р°С‚РєРё: ${formatNumber(metrics.stockQty)} С€С‚`
  );

  return lines.join("\n");
}


function formatPercentChange(value: number | null, inverse = false) {
  if (value === null || !Number.isFinite(value)) return "РЅРµС‚ Р±Р°Р·С‹";
  if (value === 0) return "0.0%";

  const sign = value > 0 ? "+" : "";
  const marker = inverse
    ? value < 0
      ? "рџџў"
      : "рџ”ґ"
    : value > 0
      ? "рџџў"
      : "рџ”ґ";

  return `${marker} ${sign}${formatPercent(value)}`;
}

function formatPointDiff(value: number | null, inverse = true) {
  if (value === null || !Number.isFinite(value)) return "РЅРµС‚ Р±Р°Р·С‹";
  if (value === 0) return "0.0 Рї.Рї.";

  const sign = value > 0 ? "+" : "";
  const marker = inverse
    ? value < 0
      ? "рџџў"
      : "рџ”ґ"
    : value > 0
      ? "рџџў"
      : "рџ”ґ";

  return `${marker} ${sign}${new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 1,
  }).format(value)} Рї.Рї.`;
}

function buildComparisonLines(report: DailyReport) {
  if (!report.comparison) return [];

  const lines = [
    "",
    `Р”РёРЅР°РјРёРєР° Рє Р°РЅР°Р»РѕРіРёС‡РЅРѕРјСѓ РїРµСЂРёРѕРґСѓ (${report.comparison.dateLabel}):`,
    `вЂў Р—Р°РєР°Р·С‹ в‚Ѕ: ${formatPercentChange(report.comparison.totals.ordersAmountPercent)}`,
    `вЂў Р­РєРѕРЅРѕРјРёС‡РµСЃРєРёР№ РѕР±РѕСЂРѕС‚: ${formatPercentChange(report.comparison.totals.economicTurnoverPercent)}`,
  ];

  if (report.comparison.totals.taxableRevenuePercent !== null) {
    lines.push(
      `вЂў РќР°Р»РѕРіРѕРІР°СЏ РІС‹СЂСѓС‡РєР°: ${formatPercentChange(
        report.comparison.totals.taxableRevenuePercent
      )}`
    );
  }

  lines.push(
    `вЂў Р РµРєР»Р°РјР°: ${formatPercentChange(report.comparison.totals.adSpendPercent, true)}`,
    `вЂў Р”Р Р  РѕС‚ СЌРєРѕРЅ. РѕР±РѕСЂРѕС‚Р°: ${formatPointDiff(report.comparison.totals.drrByEconomicTurnoverPointDiff, true)}`,
    `вЂў Р”Р”РЎ: ${formatPercentChange(report.comparison.totals.netCashFlowPercent)}`
  );

  if (report.comparison.totals.netProfitImpactPercent !== null) {
    lines.push(
      `вЂў Р§РёСЃС‚Р°СЏ РїСЂРёР±С‹Р»СЊ: ${formatPercentChange(
        report.comparison.totals.netProfitImpactPercent
      )}`
    );
  }

  return lines;
}

function inlinePercentChange(value: number | null, inverse = false) {
  const formatted = formatPercentChange(value, inverse);
  return formatted === "РЅРµС‚ Р±Р°Р·С‹" ? "" : ` (${formatted})`;
}

function inlinePointDiff(value: number | null, inverse = true) {
  const formatted = formatPointDiff(value, inverse);
  return formatted === "РЅРµС‚ Р±Р°Р·С‹" ? "" : ` (${formatted})`;
}

function compactChangeSuffix(
  percent: number | null,
  inverse = false
) {
  if (percent === null || !Number.isFinite(percent)) return "";
  const formatted = formatPercentChange(percent, inverse);
  if (formatted === "РЅРµС‚ Р±Р°Р·С‹") return "";
  return ` ${formatted}`;
}

function compactPointSuffix(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "";
  const formatted = formatPointDiff(value, true);
  if (formatted === "РЅРµС‚ Р±Р°Р·С‹") return "";
  return ` ${formatted}`;
}

function taxableRevenueLine(metrics: MarketplaceDailyMetrics, dateLabel: string) {
  if (
    metrics.marketplace === "OZON" &&
    metrics.taxRevenueCoverageComplete === false
  ) {
    const missing = metrics.taxRevenueMissingDays?.length
      ? metrics.taxRevenueMissingDays.map(formatRuDateShort).join(", ")
      : formatRuDateShort(dateLabel);
    return `РќР°Р»РѕРіРѕРІР°СЏ РІС‹СЂСѓС‡РєР°: РЅРµС‚ РѕС‚С‡С‘С‚Р° РЅР°С‡РёСЃР»РµРЅРёР№ Р·Р° ${missing}`;
  }

  if (metrics.taxableRevenue === undefined) {
    return null;
  }

  return `РќР°Р»РѕРіРѕРІР°СЏ РІС‹СЂСѓС‡РєР°: ${formatMoney(metrics.taxableRevenue)}`;
}

function compactMarketplaceBlock(
  emoji: string,
  label: string,
  metrics: MarketplaceDailyMetrics,
  dateLabel: string
) {
  if (metrics.financialUnavailable) {
    const adsLine =
      metrics.adSpend > 0
        ? `Реклама WB отдельно (не P&L): ${formatMoney(metrics.adSpend)}`
        : "Реклама WB отдельно не показана как финансовый результат.";
    return [
      `${emoji} ${label}`,
      "WB финансовые данные неполны. Прибыль, оборот и ДРР недоступны и не равны 0 ₽.",
      adsLine,
      `Остатки: ${formatNumber(metrics.stockQty)} шт`,
    ].join("\n");
  }
  const profitLabel =
    metrics.marketplace === "WB"
      ? "РџСЂРёР±С‹Р»СЊ РїРѕСЃР»Рµ РЅР°Р»РѕРіРѕРІ WB"
      : "РџСЂРёР±С‹Р»СЊ РїРѕСЃР»Рµ РЅР°Р»РѕРіРѕРІ Ozon";
  const lines = [
    `${emoji} ${label}`,
    marketplaceOrdersLine(metrics),
    `Р­РєРѕРЅРѕРјРёС‡РµСЃРєРёР№ РѕР±РѕСЂРѕС‚: ${formatMoney(metrics.economicTurnover ?? metrics.salesAmount)}`,
  ];

  const taxableLine = taxableRevenueLine(metrics, dateLabel);
  if (taxableLine) lines.push(taxableLine);

  lines.push(marketplaceAdLine(metrics));
  lines.push(
    metrics.netProfitUnavailable
      ? "Чистая прибыль: недоступна — WB: не определён тип отчёта для налога"
      : `${profitLabel}: ${formatSignedMoney(metrics.netProfitAfterTax)}`
  );
  lines.push(
    `Р”Р Р : РѕС‚ СЌРєРѕРЅ. РѕР±РѕСЂРѕС‚Р° ${formatPercent(metrics.drrByEconomicTurnover)}`
  );
  lines.push(`РћСЃС‚Р°С‚РєРё: ${formatNumber(metrics.stockQty)} С€С‚`);
  return lines.join("\n");
}

function buildAttentionLines(report: DailyReport) {
  const lines: string[] = [];

  if (report.totals.netCashFlow < 0) {
    lines.push(`рџ”ґ Р”Р”РЎ: ${formatCompactMoney(report.totals.netCashFlow)}`);
  }

  for (const company of report.companies) {
    for (const item of [
      { marketplace: "WB" as const, metrics: company.wb },
      { marketplace: "Ozon" as const, metrics: company.ozon },
    ]) {
      if (
        !item.metrics.financialUnavailable &&
        item.metrics.adSpend > 0 &&
        (item.metrics.economicTurnover ?? 0) > 0 &&
        item.metrics.drrByEconomicTurnover >= 10
      ) {
        const tone = item.metrics.drrByEconomicTurnover >= 12 ? "рџџ " : "рџџЎ";
        lines.push(
          `${tone} ${company.companyName} В· ${item.marketplace}: Р”Р Р  ${formatPercent(
            item.metrics.drrByEconomicTurnover
          )}`
        );
      }
    }
  }

  if (lines.length === 0) return [];
  return ["вљ пёЏ Р’РќРРњРђРќРР•", ...lines];
}

export function formatDailyReportForTelegram(report: DailyReport) {
  const comparison = report.comparison?.totals ?? null;
  const combinedUnavailable = Boolean(report.combinedFinancialUnavailable);
  const profitAfterOwnerWithdrawal = combinedUnavailable
    ? null
    : report.totals.netProfitImpact - report.totals.ownerWithdrawals;
  const readinessIssues = collectTelegramReadinessIssues(report);
  const dateIso = primaryReportDate(report);
  const periodDate = formatRuDate(dateIso);
  const comparisonDate = report.comparison
    ? formatRuDate(report.comparison.dateLabel)
    : "";
  const marginPercent = combinedUnavailable
    ? null
    : report.totals.economicTurnover > 0
      ? (report.totals.netProfitImpact / report.totals.economicTurnover) * 100
      : 0;

  const header = [
    `рџ“Љ AvoroFin вЂ” СЃРІРѕРґРєР° СЃРѕР±СЃС‚РІРµРЅРЅРёРєР°`,
    `РџРµСЂРёРѕРґ: ${report.periodLabel}${periodDate ? ` (${periodDate})` : ""}`,
    comparisonDate ? `РЎСЂР°РІРЅРµРЅРёРµ: ${comparisonDate}` : "",
    ...formatTelegramReadinessBlock(readinessIssues),
  ].filter(Boolean);

  const topBlock = [
    "ИТОГО ПО БИЗНЕСУ",
    combinedUnavailable
      ? "WB финансовые данные неполны. Combined оборот/прибыль/ДРР недоступны и не равны 0 ₽. Ozon ниже показан отдельно."
      : `Экон. оборот: ${formatCompactMoney(
          report.totals.economicTurnover
        )}${compactChangeSuffix(comparison?.economicTurnoverPercent ?? null)}`,
    combinedUnavailable
      ? "Чистая прибыль после налогов: недоступна"
      : `Чистая прибыль после налогов: ${formatCompactMoney(
          report.totals.netProfitImpact
        )} · маржа ${formatPercent(marginPercent ?? 0)}`,
    combinedUnavailable
      ? "ДРР combined недоступен"
      : `Реклама: ${formatCompactMoney(report.totals.adSpend)} · ДРР ${formatPercent(
          report.totals.drrByEconomicTurnover
        )}${compactPointSuffix(comparison?.drrByEconomicTurnoverPointDiff ?? null)}`,
    `ДДС: ${formatCompactMoney(report.totals.netCashFlow)}`,
    `Вывод собственника: ${formatMoney(report.totals.ownerWithdrawals)}`,
    combinedUnavailable || profitAfterOwnerWithdrawal === null
      ? "Чистая прибыль после вывода собственника: недоступна"
      : `Чистая прибыль после вывода собственника: ${formatCompactMoney(
          profitAfterOwnerWithdrawal
        )}`,
    `Остатки: ${formatNumber(report.totals.stockQty)} шт`,
  ];

  const lines: string[] = [...header, "", ...topBlock];

  const attention = buildAttentionLines(report);
  if (attention.length > 0) {
    lines.push("", ...attention);
  }

  for (const company of report.companies) {
    const companyUnavailable = Boolean(company.wb.financialUnavailable);
    const companyWbNetProfit = company.wb.netProfitUnavailable
      ? 0
      : company.wb.netProfitAfterTax;
    const companyNetProfit = companyUnavailable
      ? null
      : companyWbNetProfit +
        company.ozon.netProfitAfterTax +
        company.finance.netProfitImpact;
    const companyStock = company.wb.stockQty + company.ozon.stockQty;
    const companyPreliminary =
      company.wb.netProfitStatus === "PRELIMINARY" ||
      company.ozon.netProfitStatus === "PRELIMINARY";

    lines.push(
      "",
      "──────────────",
      `${company.companyName}`,
      "",
      companyUnavailable || companyNetProfit === null
        ? "Итого combined: недоступно — WB финансовые данные неполны. Ozon ниже отдельно."
        : `${companyPreliminary ? "Итого (предварительно)" : "Итого"}: ${
            companyNetProfit >= 0 ? "+" : ""
          }${formatSignedMoney(companyNetProfit)}`,
      `Остатки: ${formatNumber(companyStock)} шт`,
      `ДДС: ${formatMoney(company.finance.netCashFlow)}`,
      "",
      compactMarketplaceBlock("WB", "WB", company.wb, dateIso),
      "",
      compactMarketplaceBlock("Ozon", "Ozon", company.ozon, dateIso)
    );

    if (Math.abs(company.finance.netProfitImpact) > 0.5) {
      lines.push(
        `рџ§ѕ РџСЂРѕС‡РёРµ P&L РѕРїРµСЂР°С†РёРё: ${formatSignedMoney(
          company.finance.netProfitImpact
        )}`
      );
    }

    if (company.finance.ownerWithdrawals !== 0) {
      lines.push(
        `Вывод собственника: ${formatMoney(company.finance.ownerWithdrawals)}`,
        companyUnavailable || companyNetProfit === null
          ? "Чистая прибыль после вывода: недоступна"
          : `${
              companyPreliminary
                ? "Предварительная чистая прибыль после вывода"
                : "Чистая прибыль после вывода"
            }: ${formatSignedMoney(
              companyNetProfit - company.finance.ownerWithdrawals
            )}`
      );
    }
  }

  return lines.join("\n");
}
