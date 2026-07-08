import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { syncMarketplaceDailyOrders } from "@/lib/marketplaceOrders/syncMarketplaceDailyOrders";
import { syncOzonFinance } from "@/lib/ozon/syncOzon";
import { syncOzonDailyEconomicTotals } from "@/lib/ozon/syncOzonDailyEconomicTotals";
import { syncWbDailySales } from "@/lib/wb/syncWbDailySales";
import { syncWbOperationalDetail } from "@/lib/wb/syncWbOperationalDetail";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

type MarketplaceApiConnectionForDaily = {
  companyId: string;
  marketplace: string;
  company: {
    name: string;
  };
};

const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const ORDER_SYNC_TIMEOUT_MS = 60_000;
const OZON_FINANCE_TIMEOUT_MS = 120_000;
const WB_OPERATIONAL_DETAIL_TIMEOUT_MS = 120_000;

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
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
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
        }),
      OZON_FINANCE_TIMEOUT_MS
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

async function runWbOperationalDetail(
  connection: MarketplaceApiConnectionForDaily,
  date: Date
) {
  try {
    const result = await withStepTimeout(
      `WB Operational Detail ${connection.company.name} ${formatDateOnly(date)}`,
      () =>
        syncWbOperationalDetail(connection.companyId, {
          dateFrom: date,
          dateTo: date,
        }),
      WB_OPERATIONAL_DETAIL_TIMEOUT_MS
    );

    return {
      marketplace: "WB",
      companyName: connection.company.name,
      dataType: "SALES_OPERATIONAL_DETAIL",
      ok: true,
      result,
    };
  } catch (error) {
    return {
      marketplace: "WB",
      companyName: connection.company.name,
      dataType: "SALES_OPERATIONAL_DETAIL",
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

export async function GET(req: Request) {
  try {
    const date = parseDateFromRequest(req);
    const dateText = formatDateOnly(date);
    const connections = await getActiveConnections();

    // Важно: этот route должен быть быстрым. Он готовит только выбранный день.
    // День сравнения уже был подготовлен своим ежедневным запуском. Для бэкфилла запускаем даты по очереди.
    const orderStats = await withStepTimeout(
      `Marketplace daily orders ${dateText}`,
      () =>
        syncMarketplaceDailyOrders({
          dateFrom: date,
          dateTo: date,
        }),
      ORDER_SYNC_TIMEOUT_MS
    );

    const results = [];

    for (const connection of connections) {
      if (connection.marketplace === "OZON") {
        // Рекламные расходы Ozon для управленческой сводки берём из Ozon Finance / category facts.
        // Performance Ads не запускаем здесь: API Ozon разрешает только 1 активный отчёт и часто даёт 429.
        results.push(await runOzonDailyFinance(connection, date));
        results.push(await runOzonDailyEconomicTotals(connection, date));
      }

      if (connection.marketplace === "WB") {
        results.push(await runWbDailySales(connection, date));
        results.push(await runWbOperationalDetail(connection, date));
        results.push(await ensureWbAdsJobForReportDate(connection, date));
      }
    }

    const failedResults = results.filter((item) => item && item.ok === false);

    return NextResponse.json({
      ok: failedResults.length === 0,
      date: dateText,
      purpose:
        "Fast daily priority sync for Telegram, Dashboard and Ozon Profit. Runs only the requested date. Ozon ads Performance is not queued here because daily owner metrics use Ozon Finance/category facts and Performance has strict active-report limits.",
      orderStats,
      results,
      failedResults,
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
