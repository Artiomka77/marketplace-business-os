import { NextResponse } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/security/cronAuth";

import { prisma } from "@/lib/prisma";
import { runNextHistoricalSyncJob } from "@/lib/historicalSync/runHistoricalSyncJob";
import { createWbSalesHistoricalJobs } from "@/lib/historicalSync/createWbSalesHistoricalJobs";

export const dynamic = "force-dynamic";

const STUCK_RUNNING_MINUTES = 60;

type HistoricalRunResult = Awaited<ReturnType<typeof runNextHistoricalSyncJob>>;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function getStuckRunningBeforeDate() {
  return new Date(Date.now() - STUCK_RUNNING_MINUTES * 60 * 1000);
}

function getCompanyIdFromResult(result: HistoricalRunResult) {
  if (
    result &&
    typeof result === "object" &&
    "companyId" in result &&
    typeof result.companyId === "string"
  ) {
    return result.companyId;
  }

  return null;
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

export async function GET(request: Request) {
  const cronDenied = rejectUnauthorizedCron(request);
  if (cronDenied) return cronDenied;
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
          "WB historical уже выполняется. Чтобы не давить WB API, Finance запуск пропущен.",
        resetStuckJobs: resetResult.count,
        activeRunningWbJobs,
        totals: await getWbFinanceTotals(),
        executedAt: new Date().toISOString(),
      });
    }

    const result: HistoricalRunResult = await runNextHistoricalSyncJob({
      marketplace: "WB",
      dataTypes: ["FINANCE"],
    });

    let wbSalesJobs = null;

    if (result.ok && !result.skipped) {
      const companyId = getCompanyIdFromResult(result);

      if (companyId) {
        wbSalesJobs = await createWbSalesHistoricalJobs({
          companyId,
        });
      }
    }

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
      wbSalesJobs,
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