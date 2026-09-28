import { prisma } from "@/lib/prisma";
import { syncOzonAds, syncOzonFinance } from "@/lib/ozon/syncOzon";

type OzonReportAdsRetryOptions = {
  dateFrom?: Date;
  dateTo?: Date;
  companyId?: string | null;
  includePerformance?: boolean;
};

type OzonConnectionForRetry = {
  companyId: string;
  ozonPerformanceClientId: string | null;
  ozonPerformanceClientSecret: string | null;
  company: {
    name: string;
  };
};

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function endOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      23,
      59,
      59,
      999
    )
  );
}

function addUtcDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function getYesterdayMoscowDate() {
  const moscowNow = new Date(Date.now() + 3 * 60 * 60 * 1000);

  return new Date(
    Date.UTC(
      moscowNow.getUTCFullYear(),
      moscowNow.getUTCMonth(),
      moscowNow.getUTCDate() - 1
    )
  );
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function toNumber(value: unknown) {
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
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function isOzonFinanceClickAdOperation(operationType: unknown) {
  const value = normalizeText(operationType);

  return (
    value.includes("оплата за клик") ||
    value.includes("cpc") ||
    (value.includes("клик") &&
      (value.includes("реклам") || value.includes("продвиж")))
  );
}

function isOzonFinanceOrderAdOperation(operationType: unknown) {
  const value = normalizeText(operationType);

  return (
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

function getDateRange(options: OzonReportAdsRetryOptions) {
  const defaultDate = getYesterdayMoscowDate();
  const dateFrom = startOfUtcDay(options.dateFrom ?? defaultDate);
  const dateTo = endOfUtcDay(options.dateTo ?? options.dateFrom ?? defaultDate);

  if (dateFrom.getTime() > dateTo.getTime()) {
    throw new Error("dateFrom не может быть позже dateTo");
  }

  return {
    dateFrom,
    dateTo,
    dateToExclusive: addUtcDays(startOfUtcDay(dateTo), 1),
    dateFromText: formatDateOnly(dateFrom),
    dateToText: formatDateOnly(dateTo),
  };
}

async function getActiveOzonConnections(companyId?: string | null) {
  return prisma.marketplaceApiConnection.findMany({
    where: {
      isEnabled: true,
      marketplace: "OZON",
      companyId: companyId || undefined,
      ozonClientId: {
        not: null,
      },
      ozonApiKey: {
        not: null,
      },
      company: {
        isActive: true,
      },
    },
    select: {
      companyId: true,
      ozonPerformanceClientId: true,
      ozonPerformanceClientSecret: true,
      company: {
        select: {
          name: true,
        },
      },
    },
    orderBy: {
      companyId: "asc",
    },
  });
}

async function getOzonReportAdsStatus(params: {
  companyName: string;
  dateFrom: Date;
  dateToExclusive: Date;
}) {
  const [ordersCount, financeRows, performanceRows] = await Promise.all([
    prisma.marketplaceDailyOrderStat.count({
      where: {
        companyName: params.companyName,
        marketplace: "OZON",
        orderDate: {
          gte: params.dateFrom,
          lt: params.dateToExclusive,
        },
      },
    }),
    prisma.ozonFinance.findMany({
      where: {
        companyName: params.companyName,
        accrualDate: {
          gte: params.dateFrom,
          lt: params.dateToExclusive,
        },
      },
      select: {
        operationType: true,
        totalAmount: true,
        salesAmount: true,
      },
    }),
    prisma.ozonAds.findMany({
      where: {
        companyName: params.companyName,
        reportDate: {
          gte: params.dateFrom,
          lt: params.dateToExclusive,
        },
      },
      select: {
        spend: true,
      },
    }),
  ]);

  const financeAdRows = financeRows.filter((row) =>
    isOzonFinanceAdOperation(row.operationType)
  );
  const financeAdSpend = financeAdRows.reduce((sum, row) => {
    const totalAmount = Math.abs(toNumber(row.totalAmount));
    const salesAmount = Math.abs(toNumber(row.salesAmount));
    return sum + (totalAmount > 0 ? totalAmount : salesAmount);
  }, 0);
  const performanceAdSpend = performanceRows.reduce(
    (sum, row) => sum + toNumber(row.spend),
    0
  );
  const hasOzonActivity = ordersCount > 0 || financeRows.length > 0;
  const hasAdData =
    financeAdRows.length > 0 || performanceRows.length > 0 || financeAdSpend > 0 || performanceAdSpend > 0;

  return {
    hasOzonActivity,
    hasAdData,
    ordersRows: ordersCount,
    financeRows: financeRows.length,
    financeAdRows: financeAdRows.length,
    financeAdSpend,
    performanceRows: performanceRows.length,
    performanceAdSpend,
  };
}

async function retryOzonReportAdsForConnection(params: {
  connection: OzonConnectionForRetry;
  dateFrom: Date;
  dateTo: Date;
  dateToExclusive: Date;
  includePerformance: boolean;
}) {
  const companyName = params.connection.company.name;

  const before = await getOzonReportAdsStatus({
    companyName,
    dateFrom: params.dateFrom,
    dateToExclusive: params.dateToExclusive,
  });

  if (!before.hasOzonActivity) {
    return {
      companyId: params.connection.companyId,
      companyName,
      ok: true,
      skipped: true,
      reason: "NO_OZON_ACTIVITY_FOR_PERIOD",
      before,
      after: before,
    };
  }

  if (before.hasAdData) {
    return {
      companyId: params.connection.companyId,
      companyName,
      ok: true,
      skipped: true,
      reason: "AD_DATA_ALREADY_LOADED",
      before,
      after: before,
    };
  }

  const syncResults: unknown[] = [];

  syncResults.push(
    await syncOzonFinance(params.connection.companyId, {
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
    })
  );

  const afterFinance = await getOzonReportAdsStatus({
    companyName,
    dateFrom: params.dateFrom,
    dateToExclusive: params.dateToExclusive,
  });

  if (afterFinance.hasAdData || !params.includePerformance) {
    return {
      companyId: params.connection.companyId,
      companyName,
      ok: true,
      skipped: false,
      reason: afterFinance.hasAdData
        ? "AD_DATA_LOADED_FROM_OZON_FINANCE"
        : "OZON_FINANCE_RETRIED_BUT_AD_DATA_STILL_MISSING",
      before,
      after: afterFinance,
      syncResults,
    };
  }

  const hasPerformanceCredentials =
    Boolean(params.connection.ozonPerformanceClientId) &&
    Boolean(params.connection.ozonPerformanceClientSecret);

  if (!hasPerformanceCredentials) {
    return {
      companyId: params.connection.companyId,
      companyName,
      ok: true,
      skipped: false,
      reason: "OZON_FINANCE_RETRIED_NO_PERFORMANCE_CREDENTIALS",
      before,
      after: afterFinance,
      syncResults,
    };
  }

  try {
    syncResults.push(
      await syncOzonAds(params.connection.companyId, {
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
      })
    );
  } catch (error) {
    const afterFailedPerformance = await getOzonReportAdsStatus({
      companyName,
      dateFrom: params.dateFrom,
      dateToExclusive: params.dateToExclusive,
    });

    return {
      companyId: params.connection.companyId,
      companyName,
      ok: false,
      skipped: false,
      reason: "OZON_PERFORMANCE_RETRY_FAILED",
      error: error instanceof Error ? error.message : "Неизвестная ошибка",
      before,
      after: afterFailedPerformance,
      syncResults,
    };
  }

  const afterPerformance = await getOzonReportAdsStatus({
    companyName,
    dateFrom: params.dateFrom,
    dateToExclusive: params.dateToExclusive,
  });

  return {
    companyId: params.connection.companyId,
    companyName,
    ok: true,
    skipped: false,
    reason: afterPerformance.hasAdData
      ? "AD_DATA_LOADED_AFTER_RETRY"
      : "RETRIED_BUT_AD_DATA_STILL_MISSING",
    before,
    after: afterPerformance,
    syncResults,
  };
}

export async function retryMissingOzonReportAds(
  options: OzonReportAdsRetryOptions = {}
) {
  const range = getDateRange(options);
  const includePerformance = options.includePerformance ?? true;
  const connections = await getActiveOzonConnections(options.companyId);
  const results = [];

  for (const connection of connections) {
    results.push(
      await retryOzonReportAdsForConnection({
        connection,
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        dateToExclusive: range.dateToExclusive,
        includePerformance,
      })
    );
  }

  return {
    dateFrom: range.dateFromText,
    dateTo: range.dateToText,
    includePerformance,
    checkedCompanies: connections.length,
    results,
  };
}
