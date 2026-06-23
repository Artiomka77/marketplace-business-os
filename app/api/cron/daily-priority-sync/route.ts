import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { syncMarketplaceDailyOrders } from "@/lib/marketplaceOrders/syncMarketplaceDailyOrders";
import { syncWbDailySales } from "@/lib/wb/syncWbDailySales";
import { syncOzonFinance } from "@/lib/ozon/syncOzon";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type MarketplaceApiConnectionForDaily = {
  companyId: string;
  marketplace: string;
  company: {
    name: string;
  };
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
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
    const result = await syncOzonFinance(connection.companyId, {
      dateFrom: date,
      dateTo: date,
    });

    return {
      marketplace: "OZON",
      companyName: connection.company.name,
      dataType: "FINANCE",
      ok: true,
      result,
    };
  } catch (error) {
    return {
      marketplace: "OZON",
      companyName: connection.company.name,
      dataType: "FINANCE",
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
    const result = await syncWbDailySales(connection.companyId, {
      date,
    });

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

async function ensureOzonAdsJobForReportDate(
  connection: MarketplaceApiConnectionForDaily,
  date: Date
) {
  const dateFrom = date;
  const dateTo = date;

  const existingJob = await prisma.historicalSyncJob.findFirst({
    where: {
      companyId: connection.companyId,
      companyName: connection.company.name,
      marketplace: "OZON",
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
      marketplace: "OZON",
      companyName: connection.company.name,
      dataType: "ADS",
      ok: true,
      created: false,
      jobId: existingJob.id,
      status: existingJob.status,
      cursorOffset: existingJob.cursorOffset,
      lastError: existingJob.lastError,
      dateFrom: formatDateOnly(dateFrom),
      dateTo: formatDateOnly(dateTo),
      message:
        "Ozon Ads задача уже есть. Она будет обрабатываться отдельным cron /api/cron/historical-sync-ozon-ads, чтобы daily-priority-sync не зависал.",
    };
  }

  const job = await prisma.historicalSyncJob.create({
    data: {
      companyId: connection.companyId,
      companyName: connection.company.name,
      marketplace: "OZON",
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
    marketplace: "OZON",
    companyName: connection.company.name,
    dataType: "ADS",
    ok: true,
    created: true,
    jobId: job.id,
    status: job.status,
    cursorOffset: job.cursorOffset,
    dateFrom: formatDateOnly(dateFrom),
    dateTo: formatDateOnly(dateTo),
    message:
      "Ozon Ads задача создана. Она будет обрабатываться отдельным cron /api/cron/historical-sync-ozon-ads, чтобы daily-priority-sync не зависал.",
  };
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
      dataType: "ADS",
      ok: true,
      created: false,
      jobId: existingJob.id,
      status: existingJob.status,
      cursorOffset: existingJob.cursorOffset,
      lastError: existingJob.lastError,
      dateFrom: formatDateOnly(dateFrom),
      dateTo: formatDateOnly(dateTo),
      message:
        "WB Ads задача уже есть. Она будет обрабатываться безопасно чанками через /api/cron/historical-sync-wb-ads.",
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
    dataType: "ADS",
    ok: true,
    created: true,
    jobId: job.id,
    status: job.status,
    cursorOffset: job.cursorOffset,
    dateFrom: formatDateOnly(dateFrom),
    dateTo: formatDateOnly(dateTo),
    message:
      "WB Ads задача создана. Она будет обрабатываться безопасно чанками через /api/cron/historical-sync-wb-ads.",
  };
}

export async function GET(req: Request) {
  try {
    const date = parseDateFromRequest(req);
    const dateText = formatDateOnly(date);
    const connections = await getActiveConnections();

    const orderStats = await syncMarketplaceDailyOrders({
      dateFrom: date,
      dateTo: date,
    });

    const results = [];

    for (const connection of connections) {
      if (connection.marketplace === "OZON") {
        // Быстрый источник для Ozon — только Finance.
        // Ozon Ads не запускаем здесь напрямую: Performance API может работать
        // дольше лимита Vercel и валить весь daily-priority-sync по timeout.
        results.push(await runOzonDailyFinance(connection, date));
        results.push(await ensureOzonAdsJobForReportDate(connection, date));
      }

      if (connection.marketplace === "WB") {
        // WB Daily Sales — короткий оперативный источник продаж/возвратов.
        // Он нужен, чтобы утренний отчёт не оставался без WB продаж до недельного финального отчёта.
        results.push(await runWbDailySales(connection, date));

        // WB Ads не запускаем напрямую в FULL-режиме.
        // Здесь только гарантируем свежую задачу, а загрузку делает отдельный
        // route historical-sync-wb-ads безопасным темпом.
        results.push(await ensureWbAdsJobForReportDate(connection, date));
      }
    }

    return NextResponse.json({
      ok: true,
      date: dateText,
      purpose:
        "Daily priority sync for Telegram owner report. Orders, WB Daily Sales and Ozon Finance run directly. Ozon Ads and WB Ads are queued and processed by separate cron routes to avoid Vercel timeout.",
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
