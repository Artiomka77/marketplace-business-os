import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { runNextHistoricalSyncJob } from "@/lib/historicalSync/runHistoricalSyncJob";

export const dynamic = "force-dynamic";

const STUCK_RUNNING_MINUTES = 90;

type HistoricalRunResult = Awaited<ReturnType<typeof runNextHistoricalSyncJob>>;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function getStuckRunningBeforeDate() {
  return new Date(Date.now() - STUCK_RUNNING_MINUTES * 60 * 1000);
}

async function resetStuckWbJobs() {
  return prisma.historicalSyncJob.updateMany({
    where: {
      marketplace: "WB",
      status: "RUNNING",
      lastAttemptAt: {
        lte: getStuckRunningBeforeDate(),
      },
    },
    data: {
      status: "ERROR",
      lastError:
        "WB historical задача была в обработке слишком долго. Система вернула её в очередь для повторной попытки.",
      retryCount: {
        increment: 1,
      },
    },
  });
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

export async function GET() {
  try {
    const resetResult = await resetStuckWbJobs();

    const activeRunningWbJobs = await prisma.historicalSyncJob.count({
      where: {
        marketplace: "WB",
        status: "RUNNING",
      },
    });

    if (activeRunningWbJobs > 0) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: "WB_RUNNING_JOB_EXISTS",
        message:
          "WB historical уже выполняется. Чтобы не давить WB API, Ads запуск пропущен.",
        resetStuckJobs: resetResult.count,
        activeRunningWbJobs,
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