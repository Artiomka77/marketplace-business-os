import { prisma } from "@/lib/prisma";
import {
  syncOzonAds,
  syncOzonFinance,
  syncOzonProducts,
} from "@/lib/ozon/syncOzon";

type RunHistoricalSyncJobOptions = {
  companyId?: string | null;
  marketplace?: "OZON";
};

type HistoricalSyncJobRow = {
  id: string;
  companyId: string | null;
  companyName: string;
  marketplace: string;
  dataType: string;
  dateFrom: Date;
  dateTo: Date;
  retryCount: number;
};

const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function isRateLimitError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();

  return (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("limited by global limiter") ||
    message.includes("rate limit")
  );
}

function getRetryAllowedDate() {
  return new Date(Date.now() - RATE_LIMIT_COOLDOWN_MS);
}

async function findNextOzonJob(options: RunHistoricalSyncJobOptions) {
  const job = await prisma.historicalSyncJob.findFirst({
    where: {
      marketplace: options.marketplace ?? "OZON",
      ...(options.companyId ? { companyId: options.companyId } : {}),
      OR: [
        {
          status: "PENDING",
        },
        {
          status: "ERROR",
        },
        {
          status: "RATE_LIMITED",
          OR: [
            {
              lastAttemptAt: null,
            },
            {
              lastAttemptAt: {
                lte: getRetryAllowedDate(),
              },
            },
          ],
        },
      ],
    },
    orderBy: [{ createdAt: "asc" }],
    select: {
      id: true,
      companyId: true,
      companyName: true,
      marketplace: true,
      dataType: true,
      dateFrom: true,
      dateTo: true,
      retryCount: true,
    },
  });

  return job as HistoricalSyncJobRow | null;
}

async function markJobRunning(jobId: string) {
  return prisma.historicalSyncJob.update({
    where: { id: jobId },
    data: {
      status: "RUNNING",
      startedAt: new Date(),
      lastAttemptAt: new Date(),
      lastError: null,
    },
  });
}

async function markJobSuccess(jobId: string) {
  return prisma.historicalSyncJob.update({
    where: { id: jobId },
    data: {
      status: "SUCCESS",
      completedSteps: 1,
      finishedAt: new Date(),
      lastError: null,
      cursorDate: null,
      cursorOffset: null,
      cursorReportNumber: null,
    },
  });
}

async function markJobFailed(jobId: string, error: unknown) {
  const errorText = getErrorMessage(error);
  const isRateLimit = isRateLimitError(error);

  await prisma.historicalSyncJob.update({
    where: { id: jobId },
    data: {
      status: isRateLimit ? "RATE_LIMITED" : "ERROR",
      lastAttemptAt: new Date(),
      lastError: errorText.slice(0, 1000),
      retryCount: {
        increment: 1,
      },
    },
  });

  return {
    isRateLimit,
    errorText,
  };
}

async function runOzonJob(job: HistoricalSyncJobRow) {
  if (!job.companyId) {
    throw new Error(`HistoricalSyncJob ${job.id}: companyId не заполнен`);
  }

  if (job.dataType === "FINANCE") {
    return syncOzonFinance(job.companyId, {
      dateFrom: job.dateFrom,
      dateTo: job.dateTo,
    });
  }

  if (job.dataType === "ADS") {
    return syncOzonAds(job.companyId, {
      dateFrom: job.dateFrom,
      dateTo: job.dateTo,
    });
  }

  if (job.dataType === "PRODUCTS") {
    return syncOzonProducts(job.companyId);
  }

  throw new Error(
    `HistoricalSyncJob ${job.id}: тип ${job.dataType} пока не поддерживается для Ozon`
  );
}

export async function runNextHistoricalSyncJob(
  options: RunHistoricalSyncJobOptions = {}
) {
  const job = await findNextOzonJob(options);

  if (!job) {
    return {
      ok: true,
      skipped: true,
      reason: "NO_PENDING_OZON_JOBS",
      message: "Нет ожидающих исторических задач Ozon.",
    };
  }

  await markJobRunning(job.id);

  try {
    const result = await runOzonJob(job);
    const rows =
      typeof result === "object" &&
      result !== null &&
      "rows" in result &&
      typeof result.rows === "number"
        ? result.rows
        : 0;

    await markJobSuccess(job.id);

    return {
      ok: true,
      skipped: false,
      jobId: job.id,
      companyId: job.companyId,
      companyName: job.companyName,
      marketplace: job.marketplace,
      dataType: job.dataType,
      dateFrom: job.dateFrom.toISOString().slice(0, 10),
      dateTo: job.dateTo.toISOString().slice(0, 10),
      rows,
      result,
    };
  } catch (error) {
    const failedResult = await markJobFailed(job.id, error);

    return {
      ok: false,
      skipped: false,
      jobId: job.id,
      companyId: job.companyId,
      companyName: job.companyName,
      marketplace: job.marketplace,
      dataType: job.dataType,
      dateFrom: job.dateFrom.toISOString().slice(0, 10),
      dateTo: job.dateTo.toISOString().slice(0, 10),
      error: failedResult.errorText,
      isRateLimit: failedResult.isRateLimit,
    };
  }
}