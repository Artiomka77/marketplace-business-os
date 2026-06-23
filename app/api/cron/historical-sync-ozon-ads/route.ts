import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { runNextHistoricalSyncJob } from "@/lib/historicalSync/runHistoricalSyncJob";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STUCK_RUNNING_MINUTES = 90;

type HistoricalRunResult = Awaited<ReturnType<typeof runNextHistoricalSyncJob>>;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function getStuckRunningBeforeDate() {
  return new Date(Date.now() - STUCK_RUNNING_MINUTES * 60 * 1000);
}

async function resetStuckOzonAdsJobs() {
  return prisma.historicalSyncJob.updateMany({
    where: {
      marketplace: "OZON",
      dataType: "ADS",
      status: "RUNNING",
      lastAttemptAt: {
        lte: getStuckRunningBeforeDate(),
      },
    },
    data: {
      status: "ERROR",
      lastError:
        "Ozon Ads historical задача была в обработке слишком долго. Система вернула её в очередь для повторной попытки.",
      retryCount: {
        increment: 1,
      },
    },
  });
}

async function getOzonAdsTotals() {
  const totals = await prisma.historicalSyncJob.groupBy({
    by: ["marketplace", "dataType", "status"],
    where: {
      marketplace: "OZON",
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

export async function GET() {
  try {
    const resetResult = await resetStuckOzonAdsJobs();

    const activeRunningOzonAdsJobs = await prisma.historicalSyncJob.count({
      where: {
        marketplace: "OZON",
        dataType: "ADS",
        status: "RUNNING",
      },
    });

    if (activeRunningOzonAdsJobs > 0) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: "OZON_ADS_RUNNING_JOB_EXISTS",
        message:
          "Ozon Ads historical уже выполняется. Чтобы не давить API и не плодить дубли, запуск пропущен.",
        resetStuckJobs: resetResult.count,
        activeRunningOzonAdsJobs,
        totals: await getOzonAdsTotals(),
        executedAt: new Date().toISOString(),
      });
    }

    const result: HistoricalRunResult = await runNextHistoricalSyncJob({
      marketplace: "OZON",
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
          ? result.reason ?? "NO_PENDING_OZON_ADS_JOBS"
          : null,
      resetStuckJobs: resetResult.count,
      result,
      totals: await getOzonAdsTotals(),
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
