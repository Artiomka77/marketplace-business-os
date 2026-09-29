import { prisma } from "@/lib/prisma";
import { sequentialAll } from "@/lib/db/sequentialAll";
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
  // Старые значения оставляем для обратной совместимости команд и ссылок.
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
  /** COGS from canonical profit analytics (profitTotals.totalCost). */
  totalCost?: number;
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
    totalCostPercent: number | null;
    cogsSharePointDiff: number | null;
    marginPointDiff: number | null;
    afterOwnerWithdrawalPercent: number | null;
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
    /** Aggregated COGS across available cabinets. */
    totalCost?: number;
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
  /** Same-period previous DailyReport for level dynamics (skipComparison build). */
  previousReport?: DailyReport | null;
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
    .replace(/[\u2013\u2014\u2212]/g, "-")
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
      params.days === 1 ? dateToLabel : `${dateFromLabel} — ${dateToLabel}`,
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
        : `${formatDateInput(mondayNoon)} — ${formatDateInput(yesterdayNoon)}`,
    periodLabel: "Текущая неделя",
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
    periodLabel: "Сегодня",
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
    dateLabel: `${formatDateInput(previousMondayNoon)} — ${formatDateInput(previousSundayNoon)}`,
    periodLabel: "Прошлая закрытая неделя",
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
    dateLabel: `${formatDateInput(monthStartNoon)} — ${formatDateInput(monthEndNoon)}`,
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
    dateLabel: `${dateFromLabel} — ${dateToLabel}`,
    periodLabel: "Текущий квартал",
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
    dateLabel: `${formatDateInput(new Date(Date.UTC(year, 0, 1, 12)))} — ${formatDateInput(new Date(Date.UTC(year, month, day, 12)))}`,
    periodLabel: "С начала года",
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
        dateLabel: `${params.from} — ${params.to}`,
        periodLabel: "Выбранный период",
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
        periodLabel: "Выбранный день",
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
      label: "Вчера",
      now: params?.now,
    });
  }

  if (preset === "day_before_yesterday") {
    return makeMoscowDayRange({
      offsetDays: 2,
      label: "Позавчера",
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
      label: "Текущий месяц",
      now: params?.now,
    });
  }

  if (preset === "previous_month") {
    return makeMoscowMonthRange({
      offsetMonths: -1,
      label: "Прошлый месяц",
      now: params?.now,
    });
  }

  if (preset === "last_30_days") {
    return makeMoscowRange({
      days: 30,
      label: "Последние 30 дней",
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
      label: "Последние 3 дня",
      now: params?.now,
    });
  }

  if (preset === "7d") {
    return makeMoscowRange({
      days: 7,
      label: "Последние 7 дней",
      now: params?.now,
    });
  }

  if (preset === "15d") {
    return makeMoscowRange({
      days: 15,
      label: "Последние 15 дней",
      now: params?.now,
    });
  }

  if (preset === "6m") {
    return makeMoscowRange({
      days: 183,
      label: "Последние 6 месяцев",
      now: params?.now,
    });
  }

  return makeMoscowDayRange({
    offsetDays: 1,
    label: "Вчера",
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
  return value === "продажа" || value === "сторно возвратов";
}

function isWbReturnOperation(reason: string | null | undefined) {
  const value = normalizeText(reason);

  // В ежедневных и детализированных WB-отчётах возврат может приходить
  // не только точным значением "Возврат", но и расширенным текстом операции.
  // "Сторно возвратов" при этом оставляем положительной операцией.
  return value.includes("возврат") && value !== "сторно возвратов";
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

  // Часть API-синхронизаций хранит актуальные остатки без ImportSession.
  // Поэтому если по последней сессии строк нет, берём текущие строки компании.
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
  // Ozon stock sync перезаписывает текущие строки по компании и часто хранит
  // importSessionId = null. Поэтому нельзя искать только последнюю ImportSession.
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
    value.includes("оплата за клик") ||
    value.includes("продвижение с оплатой за заказ") ||
    value.includes("продвижение") ||
    value.includes("СЂРµРєР»Р°РјР°") ||
    value.includes("СЂРµРєР»Р°Рј") ||
    value.includes("трафарет") ||
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
  const [transactions, categories] = await sequentialAll([
    async () => (prisma.financeTransaction.findMany({
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
    })),
    async () => (prisma.financeCategory.findMany({
      select: {
        name: true,
        categoryType: true,
        parentName: true,
        profitTreatment: true,
      },
    })),
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

    // Если за день уже есть финальный недельный WB Sales — используем его.
    // Иначе используем оперативный daily sales, чтобы не было пустоты в утреннем отчёте.
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
  ] = await sequentialAll([
    async () => (getOrderStats({
        companyName,
        marketplace: "WB",
        range,
      })),
    async () => (prisma.wbSale.findMany({
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
      })),
    async () => (prisma.wbFinance.findMany({
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
      })),
    async () => (prisma.wbAds.findMany({
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
      })),
    async () => (getLatestWbStockQty(companyName)),
    async () => (prisma.productCost.findMany({
        select: {
          vendorCode: true,
          nmId: true,
          costPrice: true,
        },
        orderBy: {
          costDate: "desc",
        },
      })),
    async () => (prisma.company.findFirst({
        where: {
          name: companyName,
        },
        select: {
          usnRate: true,
          vatRate: true,
        },
      })),
    async () => (getProfitAnalytics({
        dateFrom: getMoscowDateInput(range.dateFrom),
        dateTo: getMoscowDateInput(getInclusiveDateTo(range.dateToExclusive)),
        companyName,
      })),
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
    ? "WB заказы за этот период ещё не загружены в MarketplaceDailyOrderStat"
    : ordersDataIncomplete
      ? `WB заказы загружены частично: ${orderStats.loadedDays} из ${orderStats.expectedDays} дней`
      : null;

  const salesDataMissing =
    effectiveSalesRows.length === 0 && orderStats.ordersQty > 0;
  const salesDataMissingReason = salesDataMissing
    ? "WB Sales/выкупы за этот период ещё не загружены в WbSale"
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
      totalCost: undefined,
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

  // Если ежедневный финансовый отчёт WB загружен, Telegram считает прибыль
  // от "Итого к оплате WB", как /profit-wb и управленческая экономика:
  // Итого к оплате WB − себестоимость − реклама − налог.
  const canonicalNetProfitAfterTax =
    financeTotals.totalToPay -
    canonicalCostOfGoods -
    finalAdSpend -
    canonicalTaxesAmount;

  // Единый источник истины: прибыль WB должна совпадать с /profit-wb.
  // Самостоятельный расчёт DailyReport остаётся только fallback, когда
  // каноническая аналитика ещё не вернула данные.
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
    salesLabel: "Экономический оборот",
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
    totalCost: profitAnalyticsHasWbData
      ? profitTotals.totalCost
      : canonicalCostOfGoods,
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
  ] = await sequentialAll([
    async () => (getOrderStats({
      companyName,
      marketplace: "OZON",
      range,
    })),
    async () => (prisma.ozonFinance.findMany({
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
    })),
    async () => (prisma.ozonAds.findMany({
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
    })),
    async () => (getLatestOzonStockQty(companyName)),
    async () => (prisma.productCost.findMany({
      select: {
        vendorCode: true,
        nmId: true,
        costPrice: true,
      },
      orderBy: {
        costDate: "desc",
      },
    })),
    async () => (prisma.wbProductCard.findMany({
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
    })),
    async () => (prisma.ozonProduct.findMany({
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
    })),
    async () => (prisma.company.findFirst({
      where: {
        name: companyName,
      },
      select: {
        usnRate: true,
        vatRate: true,
      },
    })),
    async () => (getProfitAnalyticsOzon({
      dateFrom: getMoscowDateInput(range.dateFrom),
      dateTo: getMoscowDateInput(getInclusiveDateTo(range.dateToExclusive)),
      companyName,
    })),
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

  // Для управленческого отчёта берём фактические рекламные списания из Ozon Finance,
  // если они есть. Performance API оставляем как fallback, чтобы не задвоить CPC/CPO.
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
  const missingCanonicalEvidence = ozonFinality.missingEvidence ?? [];
  const canonicalDayIncomplete =
    ozonFinality.dataMode !== "FINAL" ||
    missingCanonicalEvidence.length > 0 ||
    ozonFinality.quarantineCount > 0;
  let taxRevenueCoverageComplete = profitTotals.taxRevenueCoverageComplete !== false;
  let discountPointsCoverageComplete =
    profitTotals.discountPointsCoverageComplete !== false;
  // Missing / incomplete canonical accrual day must never look "coverage complete".
  if (canonicalDayIncomplete) {
    taxRevenueCoverageComplete = false;
    discountPointsCoverageComplete = false;
  }
  const ozonEconomicsIncomplete =
    profitAnalyticsHasOzonEconomicActivity(profitTotals) &&
    (!taxRevenueCoverageComplete || !discountPointsCoverageComplete);
  const ozonEconomicsWarning = ozonEconomicsIncomplete
    ? "налоговая выручка / баллы Ozon ещё не закрыты — прибыль до налогов рассчитана от экономического оборота, налог и чистая прибыль предварительные"
    : canonicalDayIncomplete
      ? "Ожидаем данные начислений Ozon"
      : null;
  const ozonFinancialUnavailable = canonicalDayIncomplete;
  const ozonFinancialUnavailableReason = ozonFinancialUnavailable
    ? missingCanonicalEvidence[0] ??
      "OZON_CANONICAL_ACCRUAL_INCOMPLETE"
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
  // Единый источник истины: реклама и прибыль Ozon должны совпадать
  // с /profit-ozon. Второй независимый пересчёт внутри DailyReport
  // создавал расхождения между страницами и Telegram.
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
    ? "Ozon заказы за этот период ещё не загружены в MarketplaceDailyOrderStat"
    : ordersDataIncomplete
      ? `Ozon заказы загружены частично: ${orderStats.loadedDays} из ${orderStats.expectedDays} дней`
      : null;

  const hasOzonActivity = orderStats.rowsCount > 0 || finalSalesAmount > 0;
  const adDataMissing =
    hasOzonActivity &&
    finalAdSpend === 0 &&
    financeAdRowsCount === 0 &&
    performanceAdRowsCount === 0;
  const adDataMissingReason = adDataMissing
    ? "Ozon рекламные расходы за этот период ещё не загружены из Ozon Finance/Performance"
    : null;

  if (ozonFinancialUnavailable) {
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
      salesAmount: 0,
      salesLabel: "Экономический оборот",
      salesQtyIsReliable: false,
      salesDataMissing: true,
      salesDataMissingReason: "Ожидаем данные начислений Ozon",
      adSpend: finalAdSpend,
      adSpendSource: "Ozon Ads (не полный P&L)",
      adDataMissing,
      adDataMissingReason,
      drrByOrders: 0,
      drrBySales: 0,
      drrByEconomicTurnover: 0,
      drrByTaxableRevenue: 0,
    stockQty,
    netProfitAfterTax: 0,
    netProfitUnavailable: true,
    netProfitUnavailableReason: ozonFinancialUnavailableReason,
    financialUnavailable: true,
    financialUnavailableReason: ozonFinancialUnavailableReason,
    totalCost: undefined,
    taxableRevenue: undefined,
    economicTurnover: undefined,
      discountPointsAmount: undefined,
      partnerProgramsAmount: undefined,
      grossOzonExpenses: undefined,
      netOzonExpenses: undefined,
      excludedLoansFactoringAmount: undefined,
      taxRevenueCoverageComplete: false,
      discountPointsCoverageComplete: false,
      taxRevenueMissingDays: profitTotals.taxRevenueMissingDays ?? [],
      discountPointsMissingDays: profitTotals.discountPointsMissingDays ?? [],
      ozonEconomicsWarning:
        ozonEconomicsWarning ?? "Ожидаем данные начислений Ozon",
      marginProfit: undefined,
      taxesAmount: undefined,
      taxCalculationBase: undefined,
      taxCalculationMode: undefined,
      taxesEstimated: true,
      netProfitStatus: "PRELIMINARY" as const,
      ozonQuarantineCount: ozonFinality.quarantineCount,
      ozonCanonicalImportSession: ozonFinality.canonicalImportSession ?? null,
      ozonMissingEvidence: missingCanonicalEvidence,
    };
  }

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
    salesLabel: profitAnalyticsHasOzonData ? "Экономический оборот" : "Начисления",
    salesQtyIsReliable: false,
    salesDataMissing: false,
    salesDataMissingReason: null,
    adSpend: finalAdSpend,
    adSpendSource: profitAnalyticsHasOzonData
      ? "Ozon Finance / реализация"
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
    totalCost: profitAnalyticsHasOzonData ? profitTotals.totalCost : undefined,
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
  if (source.totalCost !== undefined && source.totalCost !== null) {
    target.totalCost = (target.totalCost ?? 0) + source.totalCost;
  }
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
    dateLabel: `${getMoscowDateInput(dateFrom)} — ${getMoscowDateInput(inclusiveTo)}`,
    periodLabel: "Аналогичный предыдущий период",
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
  const currentCogs = current.totals.totalCost;
  const previousCogs = previous.totals.totalCost;
  const ozonCogsNonComparable = current.companies.some((c) => {
    const prevC = previous.companies.find((p) => p.companyName === c.companyName);
    return (
      Math.abs(prevC?.ozon.totalCost ?? -1) < 0.5 &&
      (c.ozon.totalCost ?? 0) > 100 &&
      prevC?.ozon.totalCost !== undefined
    );
  });
  const currentCogsShare =
    currentCogs !== undefined &&
    current.totals.economicTurnover > 0.0001
      ? (currentCogs / current.totals.economicTurnover) * 100
      : null;
  const previousCogsShare =
    previousCogs !== undefined &&
    previous.totals.economicTurnover > 0.0001
      ? (previousCogs / previous.totals.economicTurnover) * 100
      : null;
  const currentMargin =
    current.totals.economicTurnover > 0.0001
      ? (current.totals.netProfitImpact / current.totals.economicTurnover) * 100
      : null;
  const previousMargin =
    previous.totals.economicTurnover > 0.0001
      ? (previous.totals.netProfitImpact / previous.totals.economicTurnover) *
        100
      : null;
  const currentAfter =
    current.totals.netProfitImpact - current.totals.ownerWithdrawals;
  const previousAfter =
    previous.totals.netProfitImpact - previous.totals.ownerWithdrawals;

  const combinedUnavailable =
    Boolean(current.combinedFinancialUnavailable) ||
    Boolean(previous.combinedFinancialUnavailable);

  return {
    periodLabel: previous.periodLabel,
    dateLabel: previous.dateLabel,
    totals: {
      ordersAmountPercent: percentChange(
        current.totals.ordersAmount,
        previous.totals.ordersAmount
      ),
      salesAmountPercent: combinedUnavailable
        ? null
        : percentChange(
            current.totals.salesAmount,
            previous.totals.salesAmount
          ),
      economicTurnoverPercent: combinedUnavailable
        ? null
        : percentChange(
            current.totals.economicTurnover,
            previous.totals.economicTurnover
          ),
      taxableRevenuePercent:
        !combinedUnavailable &&
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
        !combinedUnavailable &&
        !isPreliminaryFinancialResult(current) &&
        !isPreliminaryFinancialResult(previous)
          ? percentChange(
              current.totals.netProfitImpact,
              previous.totals.netProfitImpact
            )
          : null,
      drrBySalesPointDiff:
        !combinedUnavailable &&
        Number.isFinite(current.totals.drrBySales) &&
        Number.isFinite(previous.totals.drrBySales)
          ? current.totals.drrBySales - previous.totals.drrBySales
          : null,
      drrByEconomicTurnoverPointDiff:
        !combinedUnavailable &&
        Number.isFinite(current.totals.drrByEconomicTurnover) &&
        Number.isFinite(previous.totals.drrByEconomicTurnover)
          ? current.totals.drrByEconomicTurnover -
            previous.totals.drrByEconomicTurnover
          : null,
      totalCostPercent:
        !ozonCogsNonComparable &&
        currentCogs !== undefined &&
        previousCogs !== undefined
          ? percentChange(currentCogs, previousCogs)
          : null,
      cogsSharePointDiff:
        !ozonCogsNonComparable &&
        currentCogsShare !== null &&
        previousCogsShare !== null
          ? currentCogsShare - previousCogsShare
          : null,
      marginPointDiff:
        !combinedUnavailable &&
        currentMargin !== null &&
        previousMargin !== null &&
        !isPreliminaryFinancialResult(current) &&
        !isPreliminaryFinancialResult(previous)
          ? currentMargin - previousMargin
          : null,
      afterOwnerWithdrawalPercent:
        !combinedUnavailable &&
        !isPreliminaryFinancialResult(current) &&
        !isPreliminaryFinancialResult(previous)
          ? percentChange(currentAfter, previousAfter)
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
      warnings.push("нет заказов за период");
    }

    if (hasIncompleteOrderData(report)) {
      warnings.push(
        `заказы загружены не за весь выбранный период: ${report.totals.orderDataLoadedDays} из ${report.totals.orderDataExpectedDays} дневных срезов. ДРР от заказов может быть завышен`
      );
    }

    if (report.totals.economicTurnover <= 0) {
      warnings.push("нет экономического оборота за период");
    }

    if (report.totals.drrByEconomicTurnover > 20) {
      warnings.push(
        `ДРР от экономического оборота выше 20%: ${formatPercent(report.totals.drrByEconomicTurnover)}`
      );
    }
  }

  if (report.totals.netCashFlow < 0) {
    warnings.push(`отрицательный ДДС: ${formatMoney(report.totals.netCashFlow)}`);
  }

  if (report.totals.netProfitImpact < 0) {
    warnings.push(
      `${isPreliminaryFinancialResult(report) ? "отрицательная предварительная прибыль" : "отрицательная чистая прибыль"}: ${formatMoney(
        report.totals.netProfitImpact
      )}`
    );
  }

  if (!suppressReadinessWarnings) {
    for (const company of report.companies) {
      if (company.wb.ordersDataMissing) {
        warnings.push(`${company.companyName} WB: заказы ещё не загружены`);
      } else if (company.wb.ordersDataIncomplete) {
        warnings.push(
          `${company.companyName} WB: заказы загружены частично (${company.wb.orderDataLoadedDays} из ${company.wb.orderDataExpectedDays} дней)`
        );
      }

      if (company.ozon.ordersDataMissing) {
        warnings.push(`${company.companyName} Ozon: заказы ещё не загружены`);
      } else if (company.ozon.ordersDataIncomplete) {
        warnings.push(
          `${company.companyName} Ozon: заказы загружены частично (${company.ozon.orderDataLoadedDays} из ${company.ozon.orderDataExpectedDays} дней)`
        );
      }

      if (company.wb.adDataMissing) {
        warnings.push(`${company.companyName} WB: реклама ещё не загружена`);
      }

      if (company.ozon.adDataMissing) {
        warnings.push(`${company.companyName} Ozon: реклама ещё не загружена`);
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
          `${company.companyName} Ozon: продажи/начисления ещё не загружены`
        );
      }

      if (company.ozon.ozonEconomicsWarning) {
        const missingTaxDays = company.ozon.taxRevenueMissingDays?.length
          ? ` Нет налоговой выручки за дни: ${company.ozon.taxRevenueMissingDays.join(", ")}.`
          : "";
        const missingPointDays = company.ozon.discountPointsMissingDays?.length
          ? ` Нет баллов за дни: ${company.ozon.discountPointsMissingDays.join(", ")}.`
          : "";
        warnings.push(
          `${company.companyName} Ozon: ${company.ozon.ozonEconomicsWarning}.${missingTaxDays}${missingPointDays}`
        );
      }
    }
  }

  if (report.totals.stockQty <= 0) {
    warnings.push("не вижу остатков по последним загруженным отчётам");
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

  const companiesRaw = await prisma.company.findMany({
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
  // Owner report order: ИП Петров then ИП Лебедева (stable beyond name asc).
  const companies = [...companiesRaw].sort((a, b) => {
    const rank = (name: string) => {
      const n = name.toLowerCase();
      if (n.includes("петров")) return 0;
      if (n.includes("лебед")) return 1;
      return 10;
    };
    const ra = rank(a.name);
    const rb = rank(b.name);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name, "ru");
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
      totalCost: undefined,
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
    const [wb, ozon, finance] = await sequentialAll([
    async () => (getWbMetrics(company.name, range)),
    async () => (getOzonMetrics(company.name, range)),
    async () => (getFinanceMetricsForCompany({
        companyName: company.name,
        range,
      })),
  ]);

    const realNetProfit =
      wb.financialUnavailable || ozon.financialUnavailable
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
    if (wb.financialUnavailable || ozon.financialUnavailable) {
      report.wbFinancialUnavailable = Boolean(wb.financialUnavailable);
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
    report.previousReport = previousReport;
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
  const sign = value < 0 ? "−" : "";

  if (abs >= 1_000_000) {
    const millions = abs / 1_000_000;
    const formatted = new Intl.NumberFormat("ru-RU", {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    }).format(millions);
    return `${sign}${formatted} млн ₽`;
  }

  if (abs >= 1000) {
    const thousands = abs / 1000;
    const formatted = new Intl.NumberFormat("ru-RU", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(thousands);
    return `${sign}${formatted} тыс. ₽`;
  }

  return `${sign}${formatNumber(abs)} ₽`;
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
        "заказы",
        `не загружены заказы за ${dateShort}`
      );
    } else if (company.wb.ordersDataIncomplete) {
      push(
        company.companyName,
        "WB",
        "заказы",
        `заказы загружены частично за ${dateShort}: ${company.wb.orderDataLoadedDays} из ${company.wb.orderDataExpectedDays} РґРЅ.`
      );
    }

    if (company.wb.salesDataMissing) {
      push(
        company.companyName,
        "WB",
        "продажи",
        `не загружены продажи/выкупы за ${dateShort}`
      );
    }

    if (company.wb.adDataMissing) {
      push(
        company.companyName,
        "WB",
        "СЂРµРєР»Р°РјР°",
        `не загружена реклама за ${dateShort}`
      );
    }

    // WB_WEEKLY_NOT_CLOSED / dataMode=PRELIMINARY is the normal daily-summary
    // state while the official week is still open. Do not treat it as a missing
    // daily source. Warn only when a concrete WB daily source is absent.

    if (company.ozon.ordersDataMissing) {
      push(
        company.companyName,
        "Ozon",
        "заказы",
        `не загружены заказы за ${dateShort}`
      );
    } else if (company.ozon.ordersDataIncomplete) {
      push(
        company.companyName,
        "Ozon",
        "заказы",
        `заказы загружены частично за ${dateShort}: ${company.ozon.orderDataLoadedDays} из ${company.ozon.orderDataExpectedDays} РґРЅ.`
      );
    }

    if (company.ozon.adDataMissing) {
      push(
        company.companyName,
        "Ozon",
        "СЂРµРєР»Р°РјР°",
        `не загружена реклама за ${dateShort}`
      );
    }

    if (company.ozon.financialUnavailable) {
      push(
        company.companyName,
        "Ozon",
        "начисления",
        `ожидаем данные начислений Ozon за ${dateShort}`
      );
    } else if (company.ozon.taxRevenueCoverageComplete === false) {
      const missing = company.ozon.taxRevenueMissingDays?.length
        ? company.ozon.taxRevenueMissingDays.map(formatRuDateShort).join(", ")
        : dateShort;
      push(
        company.companyName,
        "Ozon",
        "отчёт начислений",
        `нет отчёта начислений за ${missing}`
      );
    }

    if (
      !company.ozon.financialUnavailable &&
      company.ozon.discountPointsCoverageComplete === false
    ) {
      const missing = company.ozon.discountPointsMissingDays?.length
        ? company.ozon.discountPointsMissingDays.map(formatRuDateShort).join(", ")
        : dateShort;
      push(
        company.companyName,
        "Ozon",
        "отчёт баллов",
        `нет отчёта баллов за ${missing}`
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
    "⚠️ Неполные данные:",
    ...issues.map(
      (issue) =>
        `• ${issue.companyName} · ${issue.marketplace}: ${issue.reason}`
    ),
  ];
}

function marketplaceSalesLine(metrics: MarketplaceDailyMetrics) {
  if (metrics.salesDataMissing) {
    return `${metrics.salesLabel}: данные ещё не загружены`;
  }

  if (metrics.economicTurnover !== undefined) {
    if (metrics.marketplace === "OZON" && metrics.ozonEconomicsWarning) {
      return `Экономический оборот: ${formatMoney(metrics.economicTurnover)} (${metrics.ozonEconomicsWarning})`;
    }

    const details: string[] = [];
    const taxableRevenue = metrics.taxableRevenue ?? 0;
    const discountPointsAmount = metrics.discountPointsAmount ?? 0;
    const partnerProgramsAmount = metrics.partnerProgramsAmount ?? 0;

    if (metrics.taxableRevenue !== undefined) {
      details.push(`налоговая выручка ${formatMoney(taxableRevenue)}`);
    }

    if (metrics.discountPointsAmount !== undefined && Math.abs(discountPointsAmount) > 0.5) {
      details.push(`баллы ${formatMoney(discountPointsAmount)}`);
    }

    if (metrics.partnerProgramsAmount !== undefined && Math.abs(partnerProgramsAmount) > 0.5) {
      details.push(`программы партнёров ${formatMoney(partnerProgramsAmount)}`);
    }

    const knownEconomicParts =
      (metrics.taxableRevenue !== undefined ? taxableRevenue : 0) +
      (metrics.discountPointsAmount !== undefined ? discountPointsAmount : 0) +
      (metrics.partnerProgramsAmount !== undefined ? partnerProgramsAmount : 0);
    const unclassifiedEconomicPart = metrics.economicTurnover - knownEconomicParts;

    if (metrics.marketplace === "OZON" && details.length > 0 && Math.abs(unclassifiedEconomicPart) > 0.5) {
      details.push(`неразнесённая часть ${formatMoney(unclassifiedEconomicPart)}`);
    }

    return `Экономический оборот: ${formatMoney(metrics.economicTurnover)}${
      details.length > 0 ? ` (${details.join(" + ")})` : ""
    }`;
  }

  if (metrics.salesQtyIsReliable) {
    return `${metrics.salesLabel}: ${formatNumber(metrics.salesQty)} шт / ${formatMoney(
      metrics.salesAmount
    )}`;
  }

  return `${metrics.salesLabel}: ${formatMoney(metrics.salesAmount)}`;
}

function marketplaceOrdersLine(metrics: MarketplaceDailyMetrics) {
  if (metrics.ordersDataMissing) {
    return "Заказы: данные ещё не загружены";
  }

  const coverageText = metrics.ordersDataIncomplete
    ? ` · частично: ${formatNumber(metrics.orderDataLoadedDays)} из ${formatNumber(
        metrics.orderDataExpectedDays
      )} дней`
    : "";

  return `Заказы: ${formatNumber(metrics.ordersQty)} шт / ${formatMoney(
    metrics.ordersAmount
  )}${coverageText}`;
}

function marketplaceAdLine(metrics: MarketplaceDailyMetrics) {
  if (metrics.adDataMissing) {
    return "Реклама: данные ещё не загружены";
  }

  return `Реклама: ${formatMoney(metrics.adSpend)}`;
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
    return "Реклама: нет достаточно данных для оценки ДРР.";
  }

  if (totalDrr <= 7) {
    return `Реклама в рабочей зоне: ДРР ${formatPercent(
      totalDrr
    )} от экономического оборота.`;
  }

  if (totalDrr <= 10) {
    return `Реклама требует контроля: ДРР ${formatPercent(
      totalDrr
    )} от экономического оборота.`;
  }

  return `Реклама перегрета: ДРР ${formatPercent(
    totalDrr
  )} от экономического оборота, нужно проверить кампании.`;
}

function getCashFlowConclusion(report: DailyReport) {
  if (report.totals.netCashFlow < 0) {
    return `Денежный поток отрицательный: ${formatMoney(
      report.totals.netCashFlow
    )}. Деньги из бизнеса уходят быстрее, чем заходят.`;
  }

  if (report.totals.netCashFlow > 0) {
    return `Денежный поток положительный: ${formatMoney(
      report.totals.netCashFlow
    )}. За период касса прошла устойчиво.`;
  }

  return "Денежный поток около нуля: касса без запаса прочности.";
}

function getProfitConclusion(report: DailyReport) {
  const preliminary = isPreliminaryFinancialResult(report);
  const label = preliminary
    ? "Предварительная прибыль"
    : "Чистая прибыль";

  if (report.totals.netProfitImpact < 0) {
    return `${label} РїРѕРґ РґР°РІР»РµРЅРёРµРј: ${formatMoney(
      report.totals.netProfitImpact
    )}. ${preliminary ? "Итог уточнится после закрытия налоговой выручки Ozon и финансового периода WB." : "Нужно смотреть расходы и выводы."}`;
  }

  if (report.totals.netProfitImpact > 0) {
    return `${label} за период положительная: ${formatMoney(
      report.totals.netProfitImpact
    )}.${preliminary ? " Итог уточнится после закрытия налоговой выручки Ozon и финансового периода WB." : ""}`;
  }

  return `${label} около нуля.${preliminary ? " Итог пока предварительный." : ""}`;
}

function buildOwnerConclusion(report: DailyReport) {
  const lines: string[] = ["Вывод по периоду:"];

  lines.push(
    `Оборот заказов: ${formatMoney(report.totals.ordersAmount)} при остатках ${formatNumber(
      report.totals.stockQty
    )} шт.`
  );

  lines.push(getDrrConclusion(report));
  lines.push(getCashFlowConclusion(report));
  lines.push(getProfitConclusion(report));

  if (report.totals.ownerWithdrawals > 0 && report.totals.netCashFlow < 0) {
    lines.push(
      `Вывод собственника ${formatMoney(
        report.totals.ownerWithdrawals
      )} усилил кассовый разрыв за период.`
    );
  }

  const highestDrrItem = getHighestDrrItem(report);

  if (highestDrrItem && highestDrrItem.drrByEconomicTurnover >= 10) {
    lines.push(
      `Самая дорогая связка по рекламе: ${
        highestDrrItem.label
      } — ДРР ${formatPercent(highestDrrItem.drrByEconomicTurnover)} от экономического оборота.`
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
    return `Проверить ${highestDrrItem.label}: ДРР высокий, но объём экономического оборота маленький — не масштабировать рекламу без проверки товаров и ставок.`;
  }

  return `Проверить ${highestDrrItem.label}: ДРР ${formatPercent(
    highestDrrItem.drrByEconomicTurnover
  )} от экономического оборота — найти кампании/товары, которые съедают бюджет.`;
}

function getSalesGapAction(report: DailyReport) {
  if (report.totals.ordersAmount <= 0 || hasIncompleteOrderData(report)) return null;

  const salesToOrdersRatio =
    (report.totals.salesAmount / report.totals.ordersAmount) * 100;

  if (salesToOrdersRatio < 55) {
    return `Проверить разрыв заказов и продаж/начислений: сейчас продажи/начисления ≈ ${formatPercent(
      salesToOrdersRatio
    )} от суммы заказов. Для выбранного периода это может быть нормальной задержкой, но тренд нужно смотреть в динамике.`;
  }

  return null;
}

function buildOwnerActions(report: DailyReport) {
  const actions: string[] = [];

  if (hasIncompleteOrderData(report) && (!report.dataReadiness || report.dataReadiness.isFinal)) {
    actions.push(
      "Не делать окончательные выводы по ДРР от заказов, пока заказы не накопятся за весь период. Главный ориентир — ДРР от экономического оборота."
    );
  }

  if (report.totals.netCashFlow < 0) {
    actions.push(
      "Проверить крупные расходы периода и отделить обязательные платежи от тех, что можно перенести."
    );
  }

  if (report.totals.ownerWithdrawals > 0 && report.totals.netCashFlow < 0) {
    actions.push(
      "В периоды с минусовым ДДС не увеличивать вывод собственника без проверки ближайших платежей."
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
      `Остатки ${formatNumber(
        report.totals.stockQty
      )} шт: следующим шагом смотреть не общий остаток, а SKU с большим запасом и слабым спросом.`
    );
  }

  return ["Что сделать дальше:", ...actions.slice(0, 4).map((action, index) => `${index + 1}. ${action}`)];
}

function marketplaceLine(label: string, metrics: MarketplaceDailyMetrics) {
  const lines = [`${label}`, marketplaceOrdersLine(metrics), marketplaceSalesLine(metrics)];


  lines.push(marketplaceAdLine(metrics));

  if (metrics.marketplace === "OZON" && metrics.netOzonExpenses !== undefined) {
    lines.push(
      metrics.discountPointsCoverageComplete === false
        ? `Расходы Ozon по загруженным данным: ${formatMoney(metrics.netOzonExpenses)}`
        : `Чистые расходы Ozon после баллов: ${formatMoney(metrics.netOzonExpenses)}`
    );
  }

  if (
    metrics.marketplace === "OZON" &&
    metrics.taxCalculationBase !== undefined &&
    metrics.taxesAmount !== undefined
  ) {
    if (metrics.taxesEstimated) {
      lines.push(
        "Налоговая выручка: ожидается отчёт начислений",
        `Налоговый резерв: ${formatMoney(
          metrics.taxesAmount
        )} — предварительно от экономического оборота ${formatMoney(
          metrics.taxCalculationBase
        )}`,
        `Прибыль до налогов: ${formatMoney(metrics.marginProfit ?? 0)}`,
        `Предварительная чистая прибыль Ozon: ${formatMoney(
          metrics.netProfitAfterTax
        )}`
      );
    } else {
      lines.push(
        `Налоговая выручка: ${formatMoney(metrics.taxableRevenue ?? 0)}`,
        `Налоги: ${formatMoney(metrics.taxesAmount)}`,
        `Прибыль до налогов: ${formatMoney(metrics.marginProfit ?? 0)}`,
        `Чистая прибыль Ozon: ${formatMoney(metrics.netProfitAfterTax)}`
      );
    }
  }

  if (
    metrics.marketplace === "OZON" &&
    metrics.excludedLoansFactoringAmount !== undefined &&
    Math.abs(metrics.excludedLoansFactoringAmount) > 0.5
  ) {
    lines.push(
      `Исключено из прибыли: займы / факторинг ${formatMoney(
        metrics.excludedLoansFactoringAmount
      )}`
    );
  }

  const taxDrrText =
    metrics.marketplace === "OZON" &&
    metrics.taxRevenueCoverageComplete === false
      ? "ожидается отчёт начислений"
      : formatPercent(metrics.drrByTaxableRevenue);

  lines.push(
    `ДРР: от экон. оборота ${formatPercent(metrics.drrByEconomicTurnover)} (от налоговой выручки ${taxDrrText}, от заказов ${formatPercent(metrics.drrByOrders)})`,
    `Остатки: ${formatNumber(metrics.stockQty)} шт`
  );

  return lines.join("\n");
}


function formatPercentChange(value: number | null, _inverse = false) {
  if (value === null || !Number.isFinite(value)) return "нет базы";
  // V3.4: do NOT suppress valid large % — only near-zero / non-finite.
  // Comparability (near-zero previous, incomplete coverage, grain mismatch)
  // is decided upstream; abs(percent) alone is not a suppression reason.
  if (Math.abs(value) < 0.05) return "→0%";

  const abs = formatPercent(Math.abs(value)).replace(/%$/, "");
  const arrow = value > 0 ? "▲" : "▼";
  return `${arrow}${abs}%`;
}

function formatPointDiff(value: number | null, _inverse = true) {
  if (value === null || !Number.isFinite(value)) return "нет базы";
  // V3.4: large pp moves (e.g. +80.4) stay visible when comparable upstream.
  if (Math.abs(value) < 0.05) return "→0 п.п.";

  const abs = new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
  }).format(Math.abs(value));
  const arrow = value > 0 ? "▲" : "▼";
  return `${arrow}${abs} п.п.`;
}

/** Absolute RUB delta for sign-crossing / near-zero-previous profit. */
export function formatAbsMoneyChange(delta: number | null) {
  if (delta === null || !Number.isFinite(delta)) return "нет базы";
  if (Math.abs(delta) < 0.5) return "→0 ₽";
  const abs = formatMoney(Math.abs(delta));
  const arrow = delta > 0 ? "▲" : "▼";
  return `${arrow}${abs}`;
}

export function compactAbsMoneySuffix(delta: number | null) {
  if (delta === null || !Number.isFinite(delta)) return "";
  const formatted = formatAbsMoneyChange(delta);
  if (formatted === "нет базы") return "";
  return ` ${formatted}`;
}

function buildComparisonLines(report: DailyReport) {
  if (!report.comparison) return [];

  const lines = [
    "",
    `Динамика к аналогичному периоду (${report.comparison.dateLabel}):`,
    `• Заказы ₽: ${formatPercentChange(report.comparison.totals.ordersAmountPercent)}`,
    `• Экономический оборот: ${formatPercentChange(report.comparison.totals.economicTurnoverPercent)}`,
  ];

  if (report.comparison.totals.taxableRevenuePercent !== null) {
    lines.push(
      `• Налоговая выручка: ${formatPercentChange(
        report.comparison.totals.taxableRevenuePercent
      )}`
    );
  }

  lines.push(
    `• Реклама: ${formatPercentChange(report.comparison.totals.adSpendPercent, true)}`,
    `• ДРР от экон. оборота: ${formatPointDiff(report.comparison.totals.drrByEconomicTurnoverPointDiff, true)}`,
    `• ДДС: ${formatPercentChange(report.comparison.totals.netCashFlowPercent)}`
  );

  if (report.comparison.totals.netProfitImpactPercent !== null) {
    lines.push(
      `• Чистая прибыль: ${formatPercentChange(
        report.comparison.totals.netProfitImpactPercent
      )}`
    );
  }

  return lines;
}

function inlinePercentChange(value: number | null, inverse = false) {
  const formatted = formatPercentChange(value, inverse);
  return formatted === "нет базы" ? "" : ` (${formatted})`;
}

function inlinePointDiff(value: number | null, inverse = true) {
  const formatted = formatPointDiff(value, inverse);
  return formatted === "нет базы" ? "" : ` (${formatted})`;
}

function compactChangeSuffix(
  percent: number | null,
  inverse = false
) {
  if (percent === null || !Number.isFinite(percent)) return "";
  const formatted = formatPercentChange(percent, inverse);
  if (formatted === "нет базы") return "";
  return ` ${formatted}`;
}

function compactPointSuffix(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "";
  const formatted = formatPointDiff(value, true);
  if (formatted === "нет базы") return "";
  return ` ${formatted}`;
}

export {
  formatPercentChange,
  formatPointDiff,
  compactChangeSuffix,
  compactPointSuffix,
  formatAbsMoneyChange,
  compactAbsMoneySuffix,
};

function taxableRevenueLine(metrics: MarketplaceDailyMetrics, dateLabel: string) {
  if (
    metrics.marketplace === "OZON" &&
    metrics.taxRevenueCoverageComplete === false
  ) {
    const missing = metrics.taxRevenueMissingDays?.length
      ? metrics.taxRevenueMissingDays.map(formatRuDateShort).join(", ")
      : formatRuDateShort(dateLabel);
    return `Налоговая выручка: нет отчёта начислений за ${missing}`;
  }

  if (metrics.taxableRevenue === undefined) {
    return null;
  }

  return `Налоговая выручка: ${formatMoney(metrics.taxableRevenue)}`;
}

function compactMarketplaceBlock(
  emoji: string,
  label: string,
  metrics: MarketplaceDailyMetrics,
  dateLabel: string
) {
  if (metrics.financialUnavailable) {
    const marketplaceLabel = metrics.marketplace === "OZON" ? "Ozon" : "WB";
    const adsLine =
      metrics.adSpend > 0
        ? `Реклама ${marketplaceLabel} отдельно (не P&L): ${formatMoney(metrics.adSpend)}`
        : `Реклама ${marketplaceLabel} отдельно не показана как финансовый результат.`;
    const financeLine =
      metrics.marketplace === "OZON"
        ? "Ozon финансовые данные неполны. Оборот, налоговая выручка, прибыль и ДРР недоступны и не равны 0 ₽. Ожидаем данные начислений Ozon."
        : "WB финансовые данные неполны. Прибыль, оборот и ДРР недоступны и не равны 0 ₽.";
    const orderLine =
      metrics.marketplace === "OZON" ? marketplaceOrdersLine(metrics) : null;
    return [
      `${emoji === label ? label : `${emoji} ${label}`}`,
      financeLine,
      orderLine,
      adsLine,
      `Остатки: ${formatNumber(metrics.stockQty)} шт`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  const ozonPreliminary =
    metrics.marketplace === "OZON" &&
    (metrics.netProfitStatus === "PRELIMINARY" ||
      metrics.taxRevenueCoverageComplete === false ||
      metrics.discountPointsCoverageComplete === false);
  const profitLabel =
    metrics.marketplace === "WB"
      ? "Прибыль после налогов WB"
      : ozonPreliminary
        ? "Предварительная прибыль после налогов Ozon"
        : "Прибыль после налогов Ozon";
  const lines = [
    `${emoji === label ? label : `${emoji} ${label}`}`,
    marketplaceOrdersLine(metrics),
    `Экономический оборот: ${formatMoney(metrics.economicTurnover ?? metrics.salesAmount)}`,
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
    `ДРР: от экон. оборота ${formatPercent(metrics.drrByEconomicTurnover)}`
  );
  lines.push(`Остатки: ${formatNumber(metrics.stockQty)} шт`);
  return lines.join("\n");
}

function buildAttentionLines(report: DailyReport) {
  const lines: string[] = [];

  if (report.totals.netCashFlow < 0) {
    lines.push(`🔴 ДДС: ${formatCompactMoney(report.totals.netCashFlow)}`);
  }

  for (const company of report.companies) {
    for (const item of [
      { marketplace: "WB" as const, metrics: company.wb },
      { marketplace: "Ozon" as const, metrics: company.ozon },
    ]) {
      if (
        !item.metrics.financialUnavailable &&
        !marketplaceHasIncompleteProfitSource(item.metrics) &&
        !item.metrics.ozonEconomicsWarning &&
        item.metrics.adSpend > 0 &&
        (item.metrics.economicTurnover ?? 0) > 0 &&
        item.metrics.drrByEconomicTurnover >= 10
      ) {
        const tone = item.metrics.drrByEconomicTurnover >= 12 ? "🟠" : "🟡";
        lines.push(
          `${tone} ${company.companyName} · ${item.marketplace}: ДРР ${formatPercent(
            item.metrics.drrByEconomicTurnover
          )}`
        );
      } else if (
        item.marketplace === "Ozon" &&
        (item.metrics.financialUnavailable ||
          marketplaceHasIncompleteProfitSource(item.metrics) ||
          item.metrics.ozonEconomicsWarning)
      ) {
        const dateShort = formatRuDateShort(primaryReportDate(report));
        lines.push(
          `⚠️ ${company.companyName} · Ozon: ожидаются начисления за ${dateShort}`
        );
      }
    }
  }

  if (lines.length === 0) return [];
  return ["⚠️ ВНИМАНИЕ", ...lines];
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
    `📊 AvoroFin — сводка собственника`,
    `Период: ${report.periodLabel}${periodDate ? ` (${periodDate})` : ""}`,
    comparisonDate ? `Сравнение: ${comparisonDate}` : "",
    ...formatTelegramReadinessBlock(readinessIssues),
  ].filter(Boolean);

  const businessPreliminary =
    !combinedUnavailable &&
    report.companies.some(
      (company) =>
        company.wb.netProfitStatus === "PRELIMINARY" ||
        company.ozon.netProfitStatus === "PRELIMINARY" ||
        company.ozon.taxRevenueCoverageComplete === false ||
        company.ozon.discountPointsCoverageComplete === false,
    );
  const netProfitLabel = businessPreliminary
    ? "Предварительная чистая прибыль после налогов"
    : "Чистая прибыль после налогов";

  const topBlock = [
    "ИТОГО ПО БИЗНЕСУ",
    combinedUnavailable
      ? "Финансовые данные маркетплейса неполны. Combined оборот/прибыль/ДРР недоступны и не равны 0 ₽."
      : `Экон. оборот: ${formatCompactMoney(
          report.totals.economicTurnover
        )}${compactChangeSuffix(comparison?.economicTurnoverPercent ?? null)}`,
    combinedUnavailable
      ? `${netProfitLabel}: недоступна`
      : `${netProfitLabel}: ${formatCompactMoney(
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
    const companyUnavailable = Boolean(
      company.wb.financialUnavailable || company.ozon.financialUnavailable
    );
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
        ? "Итого combined: недоступно — финансовые данные маркетплейса неполны."
        : `${companyPreliminary ? "Итого (предварительно)" : "Итого"}: ${
            companyNetProfit >= 0 ? "+" : ""
          }${formatSignedMoney(companyNetProfit)}`,
      `Остатки: ${formatNumber(companyStock)} шт`,
      `ДДС: ${formatMoney(company.finance.netCashFlow)}`,
      "",
      compactMarketplaceBlock("🟣", "WB", company.wb, dateIso),
      "",
      compactMarketplaceBlock("🔵", "Ozon", company.ozon, dateIso)
    );

    if (Math.abs(company.finance.netProfitImpact) > 0.5) {
      lines.push(
        `🧾 Прочие P&L операции: ${formatSignedMoney(
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
