import { prisma } from "@/lib/prisma";

const WB_CRON_COOLDOWN_MS = 60 * 60 * 1000;

export type WbCronConnection = {
  companyId: string;
  lastAttemptAt: Date | null;
  lastError: string | null;
  retryCount: number;
};

export type WbCronCompanyResult = {
  companyId: string;
  ok: boolean;
  skipped: boolean;
  reason: string | null;
  result: unknown | null;
  error: string | null;
  isRateLimit: boolean;
};

export function getWbCronErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

export function isWbRateLimitText(value: unknown) {
  const text = getWbCronErrorMessage(value).toLowerCase();

  return (
    text.includes("429") ||
    text.includes("too many requests") ||
    text.includes("limited by global limiter") ||
    text.includes("rate limit")
  );
}

function getNextTryAt(lastAttemptAt: Date) {
  return new Date(lastAttemptAt.getTime() + WB_CRON_COOLDOWN_MS);
}

async function getActiveWbHistoricalJobsCount(companyId: string) {
  return prisma.historicalSyncJob.count({
    where: {
      companyId,
      marketplace: "WB",
      status: {
        in: ["PENDING", "RUNNING", "RATE_LIMITED"],
      },
    },
  });
}

function isWbInCooldown(connection: {
  lastError: string | null;
  lastAttemptAt: Date | null;
}) {
  if (!connection.lastError || !connection.lastAttemptAt) {
    return false;
  }

  if (!isWbRateLimitText(connection.lastError)) {
    return false;
  }

  return Date.now() - connection.lastAttemptAt.getTime() < WB_CRON_COOLDOWN_MS;
}

export async function getWbCronSkipResult(params: {
  companyId: string;
  syncName: string;
  lastError: string | null;
  lastAttemptAt: Date | null;
  retryCount: number;
}): Promise<WbCronCompanyResult | null> {
  const activeHistoricalJobs = await getActiveWbHistoricalJobsCount(
    params.companyId
  );

  if (activeHistoricalJobs > 0) {
    return {
      companyId: params.companyId,
      ok: true,
      skipped: true,
      reason: "WB_HISTORICAL_SYNC_ACTIVE",
      result: {
        name: params.syncName,
        rows: 0,
        skipped: true,
        reason: "WB_HISTORICAL_SYNC_ACTIVE",
        message: `Ежедневная синхронизация ${params.syncName} пропущена: сейчас идёт историческая загрузка WB. Осталось задач: ${activeHistoricalJobs}.`,
        retryCount: params.retryCount,
      },
      error: null,
      isRateLimit: false,
    };
  }

  if (
    isWbInCooldown({
      lastError: params.lastError,
      lastAttemptAt: params.lastAttemptAt,
    })
  ) {
    const nextTryAt = getNextTryAt(params.lastAttemptAt as Date);

    return {
      companyId: params.companyId,
      ok: true,
      skipped: true,
      reason: "WB_RATE_LIMIT_COOLDOWN",
      result: {
        name: params.syncName,
        rows: 0,
        skipped: true,
        reason: "WB_RATE_LIMIT_COOLDOWN",
        message: `${params.syncName} временно пропущен: недавно был лимит WB API. Повторить можно после ${nextTryAt.toLocaleString("ru-RU")}.`,
        retryCount: params.retryCount,
      },
      error: null,
      isRateLimit: true,
    };
  }

  return null;
}

export async function setWbCronLastAttempt(companyId: string) {
  await prisma.marketplaceApiConnection.update({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "WB",
      },
    },
    data: {
      lastAttemptAt: new Date(),
    },
  });
}

export async function setWbCronSuccess(
  companyId: string,
  lastError: string | null = null
) {
  await prisma.marketplaceApiConnection.update({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "WB",
      },
    },
    data: {
      status: "CONNECTED",
      lastSyncAt: new Date(),
      retryCount: 0,
      lastError,
    },
  });
}

export async function setWbCronError(params: {
  companyId: string;
  error: unknown;
  rateLimitPrefix: string;
}) {
  const errorText = getWbCronErrorMessage(params.error);
  const isRateLimit = isWbRateLimitText(errorText);

  await prisma.marketplaceApiConnection.update({
    where: {
      companyId_marketplace: {
        companyId: params.companyId,
        marketplace: "WB",
      },
    },
    data: {
      status: isRateLimit ? "CONNECTED" : "ERROR",
      lastAttemptAt: new Date(),
      retryCount: {
        increment: 1,
      },
      lastError: isRateLimit
        ? `${params.rateLimitPrefix} rate limit: ${errorText}`.slice(0, 1000)
        : errorText.slice(0, 1000),
    },
  });

  return {
    errorText,
    isRateLimit,
  };
}