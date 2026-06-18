import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { syncOzonAll } from "@/lib/ozon/syncOzon";

export const dynamic = "force-dynamic";

const OZON_COOLDOWN_MS = 60 * 60 * 1000;

type OzonCronResult = {
  companyId: string;
  ok: boolean;
  skipped: boolean;
  reason: string | null;
  message: string | null;
  results?: unknown;
  error?: string | null;
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function isOzonRateLimitText(value: unknown) {
  const text = getErrorMessage(value).toLowerCase();

  return (
    text.includes("429") ||
    text.includes("rate limit") ||
    text.includes("rate exceeded") ||
    text.includes("too many requests")
  );
}

async function getActiveOzonHistoricalJobsCount(companyId: string) {
  return prisma.historicalSyncJob.count({
    where: {
      companyId,
      marketplace: "OZON",
      status: {
        in: ["PENDING", "RUNNING", "RATE_LIMITED"],
      },
    },
  });
}

async function isOzonInCooldown(companyId: string) {
  const connection = await prisma.marketplaceApiConnection.findUnique({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "OZON",
      },
    },
    select: {
      lastError: true,
      lastAttemptAt: true,
    },
  });

  if (!connection?.lastError || !connection.lastAttemptAt) {
    return false;
  }

  if (!isOzonRateLimitText(connection.lastError)) {
    return false;
  }

  return Date.now() - connection.lastAttemptAt.getTime() < OZON_COOLDOWN_MS;
}

async function syncCompanyOzon(companyId: string): Promise<OzonCronResult> {
  const activeHistoricalJobs = await getActiveOzonHistoricalJobsCount(companyId);

  if (activeHistoricalJobs > 0) {
    return {
      companyId,
      ok: true,
      skipped: true,
      reason: "OZON_HISTORICAL_SYNC_ACTIVE",
      message: `Ежедневная синхронизация Ozon пропущена: сейчас идёт историческая загрузка Ozon. Осталось задач: ${activeHistoricalJobs}.`,
      error: null,
    };
  }

  const isCooldown = await isOzonInCooldown(companyId);

  if (isCooldown) {
    return {
      companyId,
      ok: true,
      skipped: true,
      reason: "OZON_RATE_LIMIT_COOLDOWN",
      message:
        "Ежедневная синхронизация Ozon пропущена: недавно был лимит API. Система повторит позже.",
      error: null,
    };
  }

  try {
    const result = await syncOzonAll(companyId);

    return {
      companyId,
      ok: result.ok,
      skipped: false,
      reason: null,
      message: null,
      results: result.results,
      error: result.ok ? null : result.error,
    };
  } catch (error) {
    return {
      companyId,
      ok: false,
      skipped: false,
      reason: isOzonRateLimitText(error) ? "OZON_RATE_LIMIT" : "OZON_SYNC_ERROR",
      message: null,
      error: getErrorMessage(error),
    };
  }
}

export async function GET() {
  const connections = await prisma.marketplaceApiConnection.findMany({
    where: {
      marketplace: "OZON",
      isEnabled: true,
      ozonClientId: {
        not: null,
      },
      ozonApiKey: {
        not: null,
      },
    },
    select: {
      companyId: true,
    },
    orderBy: {
      companyId: "asc",
    },
  });

  const results: OzonCronResult[] = [];

  for (const connection of connections) {
    const result = await syncCompanyOzon(connection.companyId);
    results.push(result);
  }

  const syncedCompanies = results.filter((result) => !result.skipped).length;
  const skippedCompanies = results.filter((result) => result.skipped).length;

  return NextResponse.json({
    success: results.every((result) => result.ok),
    totalCompanies: results.length,
    syncedCompanies,
    skippedCompanies,
    results,
    executedAt: new Date().toISOString(),
  });
}