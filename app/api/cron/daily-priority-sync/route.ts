import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { syncMarketplaceDailyOrders } from "@/lib/marketplaceOrders/syncMarketplaceDailyOrders";
import { syncOzonFinance } from "@/lib/ozon/syncOzon";
import { syncOzonDailyEconomicTotals } from "@/lib/ozon/syncOzonDailyEconomicTotals";
import { syncWbDailySales } from "@/lib/wb/syncWbDailySales";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type MarketplaceApiConnectionForDaily = {
  companyId: string;
  marketplace: string;
  company: {
    name: string;
  };
};

const STEP_TIMEOUT_MS = 25_000;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
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

function parseDateFromRequest(req: Request) {
  const url = new URL(req.url);
  const dateText = url.searchParams.get("date");

  if (!dateText) {
    return getYesterdayMoscowDate();
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
    throw new Error("date должен быть в формате YYYY-MM-DD");
  }

  return startOfUtcDay(new Date(`${dateText}T00:00:00Z`));
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

async function withStepTimeout<T>(
  label: string,
  promiseFactory: () => Promise<T>,
  timeoutMs = STEP_TIMEOUT_MS
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promiseFactory(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label}: timeout after ${timeoutMs} ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function getActiveConnections() {
  return prisma.marketplaceApiConnection.findMany({
    where: {
      isEnabled: true,
      company: {
        isActive: true,
      },
      OR: [
        {
          marketplace: "WB",
          wbToken: {
            not: null,
          },
        },
        {
          marketplace: "OZON",
          ozonClientId: {
            not: null,
          },
          ozonApiKey: {
            not: null,
          },
        },
      ],
    },
    select: {
      companyId: true,
      marketplace: true,
      company: {
        select: {
          name: true,
        },
      },
    },
    orderBy: [
      {
        marketplace: "asc",
      },
      {
        companyId: "asc",
      },
    ],
  });
}

async function runOzonDailyFinance(
  connection: MarketplaceApiConnectionForDaily,
  date: Date
) {
  try {
    const result = await withStepTimeout(
      `Ozon Finance ${connection.company.name} ${formatDateOnly(date)}`,
      () =>
        syncOzonFinance(connection.companyId, {
          dateFrom: date,
          dateTo: date,
        })
    );

    return {
      marketplace: "OZON",
      companyName: connection.company.name,
      dataType: "FINANCE",
      date: formatDateOnly(date),
      ok: true,
      result,
    };
  } catch (error) {
    return {
      marketplace: "OZON",
      companyName: connection.company.name,
      dataType: "FINANCE",
      date: formatDateOnly(date),
      ok: false,
      error: getErrorMessage(error),
    };
  }
}

async function runOzonDailyEconomicTotals(
  connection: MarketplaceApiConnectionForDaily,
  date: Date
) {
  try {
    const result = await withStepTimeout(
      `Ozon Economic Totals ${connection.company.name} ${formatDateOnly(date)}`,
      () =>
        syncOzonDailyEconomicTotals(connection.companyId, {
          dateFrom: date,
          dateTo: date,
        })
    );

    return {
      marketplace: "OZON",
      companyName: connection.company.name,
      dataType: "ECONOMIC_TOTALS",
      date: formatDateOnly(date),
      ok: true,
      result,
    };
  } catch (error) {
    return {
      marketplace: "OZON",
      companyName: connection.company.name,
      dataType: "ECONOMIC_TOTALS",
      date: formatDateOnly(date),
      ok: false,
      error: getErrorMessage(error),
    };
  }
}

async function runWbDailySales(
  connection: MarketplaceApiConnectionForDaily,
  date: Date
) {
  try {
    const result = await withStepTimeout(
      `WB Daily Sales ${connection.company.name} ${formatDateOnly(date)}`,
      () =>
        syncWbDailySales(connection.companyId, {
          date,
        })
    );

    return {
      marketplace: "WB",
      companyName: connection.company.name,
      dataType: "SALES_DAILY",
      ok: true,
      result,
    };
  } catch (error) {
    return {
      marketplace: "WB",
      companyName: connection.company.name,
      dataType: "SALES_DAILY",
      ok: false,
      error: getErrorMessage(error),
    };
  }
}

async function ensureWbAdsJobForReportDate(
  connection: MarketplaceApiConnectionForDaily,
  date: Date
) {
  const dateFrom = addUtcDays(date, -1);
  const dateTo = addUtcDays(date, 1);

  const existingJob = await prisma.historicalSyncJob.findFirst({
    where: {
      companyId: connection.companyId,
      companyName: connection.company.name,
      marketplace: "WB",
      dataType: "ADS",
      dateFrom,
      dateTo,
    },
    select: {
      id: true,
      status: true,
      cursorOffset: true,
      lastError: true,
    },
  });

  if (existingJob) {
    return {
      marketplace: "WB",
      companyName: connection.company.name,
      dataType: "ADS_JOB",
      ok: true,
      created: false,
      jobId: existingJob.id,
      status: existingJob.status,
      cursorOffset: existingJob.cursorOffset,
      lastError: existingJob.lastError,
      dateFrom: formatDateOnly(dateFrom),
      dateTo: formatDateOnly(dateTo),
    };
  }

  const job = await prisma.historicalSyncJob.create({
    data: {
      companyId: connection.companyId,
      companyName: connection.company.name,
      marketplace: "WB",
      dataType: "ADS",
      dateFrom,
      dateTo,
      cursorDate: dateFrom,
      cursorOffset: 0,
      status: "PENDING",
      totalSteps: 1,
      completedSteps: 0,
    },
    select: {
      id: true,
      status: true,
      cursorOffset: true,
    },
  });

  return {
    marketplace: "WB",
    companyName: connection.company.name,
    dataType: "ADS_JOB",
    ok: true,
    created: true,
    jobId: job.id,
    status: job.status,
    cursorOffset: job.cursorOffset,
    dateFrom: formatDateOnly(dateFrom),
    dateTo: formatDateOnly(dateTo),
  };
}

async function ensureOzonAdsJobForReportDate(
  connection: MarketplaceApiConnectionForDaily,
  date: Date
) {
  const existingJob = await prisma.historicalSyncJob.findFirst({
    where: {
      companyId: connection.companyId,
      companyName: connection.company.name,
      marketplace: "OZON",
      dataType: "ADS",
      dateFrom: date,
      dateTo: date,
    },
    select: {
      id: true,
      status: true,
      cursorOffset: true,
      lastError: true,
    },
  });

  if (existingJob) {
    return {
      marketplace: "OZON",
      companyName: connection.company.name,
      dataType: "ADS_JOB",
      ok: true,
      created: false,
      jobId: existingJob.id,
      status: existingJob.status,
      cursorOffset: existingJob.cursorOffset,
      lastError: existingJob.lastError,
      dateFrom: formatDateOnly(date),
      dateTo: formatDateOnly(date),
    };
  }

  const job = await prisma.historicalSyncJob.create({
    data: {
      companyId: connection.companyId,
      companyName: connection.company.name,
      marketplace: "OZON",
      dataType: "ADS",
      dateFrom: date,
      dateTo: date,
      cursorDate: date,
      cursorOffset: 0,
      status: "PENDING",
      totalSteps: 1,
      completedSteps: 0,
    },
    select: {
      id: true,
      status: true,
      cursorOffset: true,
    },
  });

  return {
    marketplace: "OZON",
    companyName: connection.company.name,
    dataType: "ADS_JOB",
    ok: true,
    created: true,
    jobId: job.id,
    status: job.status,
    cursorOffset: job.cursorOffset,
    dateFrom: formatDateOnly(date),
    dateTo: formatDateOnly(date),
  };
}

export async function GET(req: Request) {
  try {
    const date = parseDateFromRequest(req);
    const comparisonDate = addUtcDays(date, -1);
    const dateText = formatDateOnly(date);
    const connections = await getActiveConnections();

    const orderStats = await withStepTimeout(
      `Marketplace daily orders ${formatDateOnly(comparisonDate)} - ${dateText}`,
      () =>
        syncMarketplaceDailyOrders({
          dateFrom: comparisonDate,
          dateTo: date,
        })
    );

    const results = [];

    for (const connection of connections) {
      if (connection.marketplace === "OZON") {
        for (const targetDate of [comparisonDate, date]) {
          results.push(await runOzonDailyFinance(connection, targetDate));
          results.push(await runOzonDailyEconomicTotals(connection, targetDate));
          results.push(await ensureOzonAdsJobForReportDate(connection, targetDate));
        }
      }

      if (connection.marketplace === "WB") {
        results.push(await runWbDailySales(connection, date));
        results.push(await ensureWbAdsJobForReportDate(connection, date));
      }
    }

    return NextResponse.json({
      ok: true,
      date: dateText,
      comparisonDate: formatDateOnly(comparisonDate),
      purpose:
        "Fast daily priority sync for Telegram, Dashboard and Ozon Profit. Heavy Ozon/WB ads are queued as historical jobs so the morning route does not hang.",
      orderStats,
      results,
      executedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: getErrorMessage(error),
        executedAt: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
