import { NextResponse } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/security/cronAuth";

import { prisma } from "@/lib/prisma";
import { runNextHistoricalSyncJob } from "@/lib/historicalSync/runHistoricalSyncJob";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STUCK_RUNNING_MINUTES = 90;
const RECENT_WB_ADS_WINDOW_DAYS = 2;

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

async function resetStuckWbAdsJobs() {
  return prisma.historicalSyncJob.updateMany({
    where: {
      marketplace: "WB",
      dataType: "ADS",
      status: "RUNNING",
      lastAttemptAt: {
        lte: getStuckRunningBeforeDate(),
      },
    },
    data: {
      status: "ERROR",
      lastError:
        "WB Ads historical задача была в обработке слишком долго. Система вернула её в очередь для повторной попытки.",
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

async function ensureRecentWbAdsJobs() {
  const period = getRecentWbAdsPeriod();
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
        dateFrom: period.dateFrom,
        dateTo: period.dateTo,
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
        dateFrom: period.dateFrom,
        dateTo: period.dateTo,
        cursorDate: period.dateFrom,
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
      dateFrom: period.dateFrom.toISOString().slice(0, 10),
      dateTo: period.dateTo.toISOString().slice(0, 10),
    },
    connections: connections.length,
    created,
    existing,
    details,
  };
}

async function getWbAdsTotals() {
  const totals = await prisma.historicalSyncJob.groupBy({
    by: ["marketplace", "dataType", "status"],
    where: {
      marketplace: "WB",
      dataType: "ADS",
    },
    _count: {
      _all: true,
    },
    orderBy: [
      {
        marketplace: "asc",
      },
      {
        dataType: "asc",
      },
      {
        status: "asc",
      },
    ],
  });

  return totals.map((row) => ({
    marketplace: row.marketplace,
    dataType: row.dataType,
    status: row.status,
    count: row._count._all,
  }));
}

export async function GET(request: Request) {
  const cronDenied = rejectUnauthorizedCron(request);
  if (cronDenied) return cronDenied;
  try {
    const resetResult = await resetStuckWbAdsJobs();
    const ensureResult = await ensureRecentWbAdsJobs();

    const activeRunningWbAdsJobs = await prisma.historicalSyncJob.count({
      where: {
        marketplace: "WB",
        dataType: "ADS",
        status: "RUNNING",
      },
    });

    if (activeRunningWbAdsJobs > 0) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: "WB_ADS_RUNNING_JOB_EXISTS",
        message:
          "WB Ads historical уже выполняется. Чтобы не давить WB API, Ads запуск пропущен.",
        resetStuckJobs: resetResult.count,
        ensureRecentWbAdsJobs: ensureResult,
        activeRunningWbAdsJobs,
        totals: await getWbAdsTotals(),
        executedAt: new Date().toISOString(),
      });
    }

    const result: HistoricalRunResult = await runNextHistoricalSyncJob({
      marketplace: "WB",
      dataTypes: ["ADS"],
    });

    return NextResponse.json({
      success: result.ok,
      ok: result.ok,
      completed: result.ok && !result.skipped && !result.partial ? 1 : 0,
      partial: result.partial ?? false,
      skipped: result.skipped,
      stopped: result.skipped || !result.ok,
      stopReason: !result.ok
        ? result.isRateLimit
          ? "RATE_LIMIT"
          : "ERROR"
        : result.skipped
          ? result.reason ?? "NO_PENDING_WB_ADS_JOBS"
          : null,
      resetStuckJobs: resetResult.count,
      ensureRecentWbAdsJobs: ensureResult,
      result,
      totals: await getWbAdsTotals(),
      executedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: getErrorMessage(error),
        executedAt: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
