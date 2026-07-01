import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { runNextHistoricalSyncJob } from "@/lib/historicalSync/runHistoricalSyncJob";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STUCK_RUNNING_MINUTES = 90;
const RECENT_WB_ADS_WINDOW_DAYS = 2;
const MAX_PRIORITY_RUNS = 3;

type HistoricalRunResult = Awaited<ReturnType<typeof runNextHistoricalSyncJob>>;

type WbConnectionRow = {
  companyId: string;
  companyName: string;
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function getStuckRunningBeforeDate() {
  return new Date(Date.now() - STUCK_RUNNING_MINUTES * 60 * 1000);
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

function getRecentWbAdsPeriod() {
  const today = startOfUtcDay(new Date());

  return {
    dateFrom: addUtcDays(today, -RECENT_WB_ADS_WINDOW_DAYS),
    dateTo: today,
  };
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function resetStuckRecentWbAdsJobs(dateFrom: Date, dateTo: Date) {
  return prisma.historicalSyncJob.updateMany({
    where: {
      marketplace: "WB",
      dataType: "ADS",
      dateFrom,
      dateTo,
      status: "RUNNING",
      lastAttemptAt: {
        lte: getStuckRunningBeforeDate(),
      },
    },
    data: {
      status: "ERROR",
      lastError:
        "Свежая WB Ads задача была в обработке слишком долго. Система вернула её в очередь для повторной попытки.",
      retryCount: {
        increment: 1,
      },
    },
  });
}

async function getActiveWbConnections(): Promise<WbConnectionRow[]> {
  const connections = await prisma.marketplaceApiConnection.findMany({
    where: {
      marketplace: "WB",
      isEnabled: true,
      wbToken: {
        not: null,
      },
      company: {
        isActive: true,
      },
    },
    select: {
      companyId: true,
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

  return connections.map((connection) => ({
    companyId: connection.companyId,
    companyName: connection.company.name,
  }));
}

async function ensureRecentWbAdsJobs(dateFrom: Date, dateTo: Date) {
  const connections = await getActiveWbConnections();

  let created = 0;
  let existing = 0;

  const details = [];

  for (const connection of connections) {
    const existingJob = await prisma.historicalSyncJob.findFirst({
      where: {
        companyId: connection.companyId,
        companyName: connection.companyName,
        marketplace: "WB",
        dataType: "ADS",
        dateFrom,
        dateTo,
      },
      select: {
        id: true,
        status: true,
      },
    });

    if (existingJob) {
      existing += 1;
      details.push({
        companyName: connection.companyName,
        jobId: existingJob.id,
        status: existingJob.status,
        created: false,
      });
      continue;
    }

    const job = await prisma.historicalSyncJob.create({
      data: {
        companyId: connection.companyId,
        companyName: connection.companyName,
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
      },
    });

    created += 1;
    details.push({
      companyName: connection.companyName,
      jobId: job.id,
      status: job.status,
      created: true,
    });
  }

  return {
    period: {
      dateFrom: formatDateOnly(dateFrom),
      dateTo: formatDateOnly(dateTo),
    },
    connections: connections.length,
    created,
    existing,
    details,
  };
}

async function getRecentWbAdsTotals(dateFrom: Date, dateTo: Date) {
  const totals = await prisma.historicalSyncJob.groupBy({
    by: ["status"],
    where: {
      marketplace: "WB",
      dataType: "ADS",
      dateFrom,
      dateTo,
    },
    _count: {
      _all: true,
    },
    orderBy: {
      status: "asc",
    },
  });

  return totals.map((row) => ({
    status: row.status,
    count: row._count._all,
  }));
}

async function runRecentWbAdsJob(dateFrom: Date, dateTo: Date) {
  return runNextHistoricalSyncJob({
    marketplace: "WB",
    dataTypes: ["ADS"],
    dateFrom,
    dateTo,
  });
}

export async function GET() {
  try {
    const period = getRecentWbAdsPeriod();
    const resetResult = await resetStuckRecentWbAdsJobs(
      period.dateFrom,
      period.dateTo
    );
    const ensureResult = await ensureRecentWbAdsJobs(
      period.dateFrom,
      period.dateTo
    );

    const activeRunningRecentWbAdsJobs = await prisma.historicalSyncJob.count({
      where: {
        marketplace: "WB",
        dataType: "ADS",
        dateFrom: period.dateFrom,
        dateTo: period.dateTo,
        status: "RUNNING",
      },
    });

    if (activeRunningRecentWbAdsJobs > 0) {
      return NextResponse.json({
        success: true,
        ok: true,
        skipped: true,
        reason: "RECENT_WB_ADS_RUNNING_JOB_EXISTS",
        message:
          "Свежая WB Ads задача уже выполняется. Чтобы не давить WB API, запуск пропущен.",
        period: {
          dateFrom: formatDateOnly(period.dateFrom),
          dateTo: formatDateOnly(period.dateTo),
        },
        resetStuckJobs: resetResult.count,
        ensureRecentWbAdsJobs: ensureResult,
        activeRunningRecentWbAdsJobs,
        totals: await getRecentWbAdsTotals(period.dateFrom, period.dateTo),
        executedAt: new Date().toISOString(),
      });
    }

    const results: HistoricalRunResult[] = [];

    for (let index = 0; index < MAX_PRIORITY_RUNS; index++) {
      const result = await runRecentWbAdsJob(period.dateFrom, period.dateTo);
      results.push(result);

      if (!result.ok || result.skipped || result.isRateLimit) {
        break;
      }

      if (!result.partial) {
        const pendingCount = await prisma.historicalSyncJob.count({
          where: {
            marketplace: "WB",
            dataType: "ADS",
            dateFrom: period.dateFrom,
            dateTo: period.dateTo,
            status: {
              in: ["PENDING", "ERROR", "RATE_LIMITED"],
            },
          },
        });

        if (pendingCount === 0) {
          break;
        }
      }

      await sleep(1500);
    }

    const failedResult = results.find((result) => !result.ok);
    const rateLimitedResult = results.find((result) => result.isRateLimit);
    const completed = results.filter(
      (result) => result.ok && !result.skipped && !result.partial
    ).length;
    const partial = results.some((result) => result.partial);

    return NextResponse.json({
      success: !failedResult,
      ok: !failedResult,
      completed,
      partial,
      skipped: results.every((result) => result.skipped),
      stopped: Boolean(failedResult || rateLimitedResult),
      stopReason: failedResult
        ? failedResult.isRateLimit
          ? "RATE_LIMIT"
          : "ERROR"
        : rateLimitedResult
          ? "RATE_LIMIT"
          : null,
      period: {
        dateFrom: formatDateOnly(period.dateFrom),
        dateTo: formatDateOnly(period.dateTo),
      },
      resetStuckJobs: resetResult.count,
      ensureRecentWbAdsJobs: ensureResult,
      results,
      totals: await getRecentWbAdsTotals(period.dateFrom, period.dateTo),
      executedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        ok: false,
        error: getErrorMessage(error),
        executedAt: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
