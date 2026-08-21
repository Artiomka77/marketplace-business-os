import { NextResponse } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/security/cronAuth";

import { prisma } from "@/lib/prisma";
import { runNextHistoricalSyncJob } from "@/lib/historicalSync/runHistoricalSyncJob";

export const dynamic = "force-dynamic";

const CRON_BATCH_LIMIT = 1;
const STUCK_RUNNING_MINUTES = 60;

type HistoricalRunResult = Awaited<ReturnType<typeof runNextHistoricalSyncJob>>;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function getStuckRunningBeforeDate() {
  return new Date(Date.now() - STUCK_RUNNING_MINUTES * 60 * 1000);
}

async function resetStuckRunningJobs() {
  return prisma.historicalSyncJob.updateMany({
    where: {
      status: "RUNNING",
      lastAttemptAt: {
        lte: getStuckRunningBeforeDate(),
      },
    },
    data: {
      status: "ERROR",
      lastError:
        "Задача была в обработке слишком долго. Система вернула её в очередь для повторной попытки.",
      retryCount: {
        increment: 1,
      },
    },
  });
}

async function getHistoricalSyncTotals() {
  const totals = await prisma.historicalSyncJob.groupBy({
    by: ["marketplace", "status"],
    _count: {
      _all: true,
    },
    orderBy: [
      {
        marketplace: "asc",
      },
      {
        status: "asc",
      },
    ],
  });

  return totals.map((row) => ({
    marketplace: row.marketplace,
    status: row.status,
    count: row._count._all,
  }));
}

export async function GET(request: Request) {
  const cronDenied = rejectUnauthorizedCron(request);
  if (cronDenied) return cronDenied;
  try {
    const resetResult = await resetStuckRunningJobs();

    const activeRunningJobs = await prisma.historicalSyncJob.count({
      where: {
        status: "RUNNING",
      },
    });

    if (activeRunningJobs > 0) {
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: "RUNNING_JOB_EXISTS",
        message:
          "Историческая загрузка уже выполняется. Следующий запуск продолжит очередь автоматически.",
        resetStuckJobs: resetResult.count,
        activeRunningJobs,
        totals: await getHistoricalSyncTotals(),
        executedAt: new Date().toISOString(),
      });
    }

    const results: HistoricalRunResult[] = [];

    for (let index = 0; index < CRON_BATCH_LIMIT; index += 1) {
      const result = await runNextHistoricalSyncJob({
        marketplace: "OZON",
      });

      results.push(result);

      if (result.skipped || !result.ok) {
        break;
      }
    }

    const completed = results.filter(
      (result) => result.ok && !result.skipped
    ).length;

    const skipped = results.some((result) => result.skipped);
    const failed = results.find((result) => !result.ok) ?? null;

    return NextResponse.json({
      success: !failed,
      ok: !failed,
      completed,
      skipped,
      stopped: Boolean(skipped || failed),
      stopReason: failed
        ? failed.isRateLimit
          ? "RATE_LIMIT"
          : "ERROR"
        : skipped
          ? "NO_PENDING_OZON_JOBS"
          : null,
      resetStuckJobs: resetResult.count,
      results,
      totals: await getHistoricalSyncTotals(),
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