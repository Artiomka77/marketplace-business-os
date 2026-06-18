import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { runNextHistoricalSyncJob } from "@/lib/historicalSync/runHistoricalSyncJob";

export const dynamic = "force-dynamic";

const STUCK_RUNNING_MINUTES = 60;

type HistoricalRunResult = Awaited<ReturnType<typeof runNextHistoricalSyncJob>>;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function getStuckRunningBeforeDate() {
  return new Date(Date.now() - STUCK_RUNNING_MINUTES * 60 * 1000);
}

async function resetStuckWbFinanceJobs() {
  return prisma.historicalSyncJob.updateMany({
    where: {
      marketplace: "WB",
      dataType: "FINANCE",
      status: "RUNNING",
      lastAttemptAt: {
        lte: getStuckRunningBeforeDate(),
      },
    },
    data: {
      status: "ERROR",
      lastError:
        "WB Finance задача была в обработке слишком долго. Система вернула её в очередь для повторной попытки.",
      retryCount: {
        increment: 1,
      },
    },
  });
}

async function getWbFinanceTotals() {
  const totals = await prisma.historicalSyncJob.groupBy({
    by: ["marketplace", "dataType", "status"],
    where: {
      marketplace: "WB",
      dataType: "FINANCE",
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
    const resetResult = await resetStuckWbFinanceJobs();

    const activeRunningJobs = await prisma.historicalSyncJob.count({
      where: {
        marketplace: "WB",
        dataType: "FINANCE",
        status: "RUNNING",
      },
    });

    if (activeRunningJobs > 0) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: "WB_FINANCE_RUNNING_JOB_EXISTS",
        message:
          "WB Finance historical уже выполняется. Следующий запуск продолжит очередь автоматически.",
        resetStuckJobs: resetResult.count,
        activeRunningJobs,
        totals: await getWbFinanceTotals(),
        executedAt: new Date().toISOString(),
      });
    }

    const result: HistoricalRunResult = await runNextHistoricalSyncJob({
      marketplace: "WB",
    });

    return NextResponse.json({
      success: result.ok,
      ok: result.ok,
      completed: result.ok && !result.skipped ? 1 : 0,
      skipped: result.skipped,
      stopped: result.skipped || !result.ok,
      stopReason: !result.ok
        ? result.isRateLimit
          ? "RATE_LIMIT"
          : "ERROR"
        : result.skipped
          ? result.reason ?? "NO_PENDING_WB_FINANCE_JOBS"
          : null,
      resetStuckJobs: resetResult.count,
      result,
      totals: await getWbFinanceTotals(),
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