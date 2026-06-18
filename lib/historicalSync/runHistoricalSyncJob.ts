import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  syncOzonAds,
  syncOzonFinance,
  syncOzonProducts,
} from "@/lib/ozon/syncOzon";
import {
  syncWbFinance,
  syncWbSalesByReportNumber,
} from "@/lib/wb/syncWb";

type MarketplaceFilter = "OZON" | "WB" | "ALL";
type HistoricalDataType = "FINANCE" | "ADS" | "PRODUCTS" | "SALES";

type RunHistoricalSyncJobOptions = {
  companyId?: string | null;
  marketplace?: MarketplaceFilter;
  dataTypes?: HistoricalDataType[];
};

type HistoricalSyncJobRow = {
  id: string;
  companyId: string | null;
  companyName: string;
  marketplace: string;
  dataType: string;
  dateFrom: Date;
  dateTo: Date;
  cursorReportNumber: string | null;
  retryCount: number;
};

const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;

const OZON_SUPPORTED_DATA_TYPES: HistoricalDataType[] = [
  "FINANCE",
  "ADS",
  "PRODUCTS",
];

const WB_SUPPORTED_DATA_TYPES: HistoricalDataType[] = ["FINANCE", "SALES"];

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

function intersectDataTypes(
  allowed: HistoricalDataType[],
  requested?: HistoricalDataType[]
) {
  if (!requested || requested.length === 0) {
    return allowed;
  }

  return allowed.filter((dataType) => requested.includes(dataType));
}

function getRunnableStatusWhere(): Prisma.HistoricalSyncJobWhereInput {
  return {
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
  };
}

function getWbSupportedWhere(
  requestedDataTypes?: HistoricalDataType[]
): Prisma.HistoricalSyncJobWhereInput {
  const dataTypes = intersectDataTypes(
    WB_SUPPORTED_DATA_TYPES,
    requestedDataTypes
  );

  const supportedBlocks: Prisma.HistoricalSyncJobWhereInput[] = [];

  if (dataTypes.includes("FINANCE")) {
    supportedBlocks.push({
      marketplace: "WB",
      dataType: "FINANCE",
    });
  }

  if (dataTypes.includes("SALES")) {
    supportedBlocks.push({
      marketplace: "WB",
      dataType: "SALES",
      cursorReportNumber: {
        not: null,
      },
    });
  }

  if (supportedBlocks.length === 0) {
    return {
      id: "__NO_SUPPORTED_WB_HISTORICAL_JOB__",
    };
  }

  return {
    OR: supportedBlocks,
  };
}

function getOzonSupportedWhere(
  requestedDataTypes?: HistoricalDataType[]
): Prisma.HistoricalSyncJobWhereInput {
  const dataTypes = intersectDataTypes(
    OZON_SUPPORTED_DATA_TYPES,
    requestedDataTypes
  );

  if (dataTypes.length === 0) {
    return {
      id: "__NO_SUPPORTED_OZON_HISTORICAL_JOB__",
    };
  }

  return {
    marketplace: "OZON",
    dataType: {
      in: dataTypes,
    },
  };
}

function getSupportedJobWhere(
  marketplace: MarketplaceFilter,
  requestedDataTypes?: HistoricalDataType[]
): Prisma.HistoricalSyncJobWhereInput {
  if (marketplace === "OZON") {
    return getOzonSupportedWhere(requestedDataTypes);
  }

  if (marketplace === "WB") {
    return getWbSupportedWhere(requestedDataTypes);
  }

  return {
    OR: [
      getOzonSupportedWhere(requestedDataTypes),
      getWbSupportedWhere(requestedDataTypes),
    ],
  };
}

function getNoPendingReason(
  marketplace: MarketplaceFilter,
  dataTypes?: HistoricalDataType[]
) {
  const dataTypeText =
    dataTypes && dataTypes.length > 0 ? dataTypes.join(", ") : null;

  if (marketplace === "WB") {
    return {
      reason: dataTypeText
        ? `NO_PENDING_WB_${dataTypeText}_JOBS`
        : "NO_PENDING_WB_JOBS",
      message: dataTypeText
        ? `Нет ожидающих исторических задач WB: ${dataTypeText}.`
        : "Нет ожидающих исторических задач WB.",
    };
  }

  if (marketplace === "ALL") {
    return {
      reason: dataTypeText
        ? `NO_PENDING_${dataTypeText}_JOBS`
        : "NO_PENDING_SUPPORTED_JOBS",
      message: dataTypeText
        ? `Нет ожидающих поддерживаемых исторических задач: ${dataTypeText}.`
        : "Нет ожидающих поддерживаемых исторических задач.",
    };
  }

  return {
    reason: dataTypeText
      ? `NO_PENDING_OZON_${dataTypeText}_JOBS`
      : "NO_PENDING_OZON_JOBS",
    message: dataTypeText
      ? `Нет ожидающих исторических задач Ozon: ${dataTypeText}.`
      : "Нет ожидающих исторических задач Ozon.",
  };
}

function getRowsFromResult(result: unknown) {
  if (
    typeof result === "object" &&
    result !== null &&
    "rows" in result &&
    typeof result.rows === "number"
  ) {
    return result.rows;
  }

  return 0;
}

function throwIfSkippedResult(result: unknown) {
  if (
    typeof result === "object" &&
    result !== null &&
    "skipped" in result &&
    result.skipped === true
  ) {
    const message =
      "message" in result && typeof result.message === "string"
        ? result.message
        : "Историческая задача была пропущена.";

    throw new Error(message);
  }
}

async function findNextHistoricalJob(options: RunHistoricalSyncJobOptions) {
  const marketplace = options.marketplace ?? "OZON";

  const job = await prisma.historicalSyncJob.findFirst({
    where: {
      ...(options.companyId ? { companyId: options.companyId } : {}),
      AND: [
        getSupportedJobWhere(marketplace, options.dataTypes),
        getRunnableStatusWhere(),
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
      cursorReportNumber: true,
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

async function runWbJob(job: HistoricalSyncJobRow) {
  if (!job.companyId) {
    throw new Error(`HistoricalSyncJob ${job.id}: companyId не заполнен`);
  }

  if (job.dataType === "FINANCE") {
    return syncWbFinance(job.companyId, {
      dateFrom: job.dateFrom,
      dateTo: job.dateTo,
    });
  }

  if (job.dataType === "SALES") {
    if (!job.cursorReportNumber) {
      throw new Error(
        `HistoricalSyncJob ${job.id}: для WB Sales не заполнен cursorReportNumber`
      );
    }

    return syncWbSalesByReportNumber(job.companyId, job.cursorReportNumber, {
      dateFrom: job.dateFrom,
      dateTo: job.dateTo,
    });
  }

  throw new Error(
    `HistoricalSyncJob ${job.id}: тип ${job.dataType} пока не поддерживается для WB`
  );
}

async function runMarketplaceJob(job: HistoricalSyncJobRow) {
  if (job.marketplace === "OZON") {
    return runOzonJob(job);
  }

  if (job.marketplace === "WB") {
    return runWbJob(job);
  }

  throw new Error(
    `HistoricalSyncJob ${job.id}: маркетплейс ${job.marketplace} пока не поддерживается`
  );
}

export async function runNextHistoricalSyncJob(
  options: RunHistoricalSyncJobOptions = {}
) {
  const marketplace = options.marketplace ?? "OZON";
  const job = await findNextHistoricalJob(options);

  if (!job) {
    const noPending = getNoPendingReason(marketplace, options.dataTypes);

    return {
      ok: true,
      skipped: true,
      reason: noPending.reason,
      message: noPending.message,
    };
  }

  await markJobRunning(job.id);

  try {
    const result = await runMarketplaceJob(job);

    throwIfSkippedResult(result);

    const rows = getRowsFromResult(result);

    await markJobSuccess(job.id);

    return {
      ok: true,
      skipped: false,
      jobId: job.id,
      companyId: job.companyId,
      companyName: job.companyName,
      marketplace: job.marketplace,
      dataType: job.dataType,
      cursorReportNumber: job.cursorReportNumber,
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
      cursorReportNumber: job.cursorReportNumber,
      dateFrom: job.dateFrom.toISOString().slice(0, 10),
      dateTo: job.dateTo.toISOString().slice(0, 10),
      error: failedResult.errorText,
      isRateLimit: failedResult.isRateLimit,
    };
  }
}