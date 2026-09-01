import { NextResponse } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/security/cronAuth";

import { prisma } from "@/lib/prisma";
import { syncOzonAll } from "@/lib/ozon/syncOzon";
import { SYNC_OZON_ALL_SCHEDULED } from "@/lib/ozon/syncOzonAllSequence";
import {
  fromSyncOzonAllResult,
  fromSyncOzonThrownError,
  historicalSyncSkipResult,
  isOzonRateLimitText,
  mapCompaniesSequentially,
  rateLimitCooldownSkipResult,
  summarizeOzonCronResults,
  type OzonCronResult,
} from "@/lib/ozon/syncOzonCronContract";

export const dynamic = "force-dynamic";

const OZON_COOLDOWN_MS = 60 * 60 * 1000;
const SCHEDULED_MODE = SYNC_OZON_ALL_SCHEDULED.mode;
const SCHEDULED_OWNED_DOMAINS = [...SYNC_OZON_ALL_SCHEDULED.ownedDomains];
const SCHEDULED_DEFERRED_DOMAINS = [...SYNC_OZON_ALL_SCHEDULED.deferredDomains];

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
    return historicalSyncSkipResult(companyId, activeHistoricalJobs);
  }

  const isCooldown = await isOzonInCooldown(companyId);

  if (isCooldown) {
    return rateLimitCooldownSkipResult(companyId);
  }

  try {
    const result = await syncOzonAll(companyId, { mode: "scheduled" });
    return fromSyncOzonAllResult(companyId, result);
  } catch (error) {
    return fromSyncOzonThrownError(companyId, error);
  }
}

export async function GET(request: Request) {
  const cronDenied = rejectUnauthorizedCron(request);
  if (cronDenied) return cronDenied;
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

  const results = await mapCompaniesSequentially(connections, (connection) =>
    syncCompanyOzon(connection.companyId)
  );

  const contract = summarizeOzonCronResults(results);
  const syncedCompanies = results.filter((result) => !result.skipped).length;

  return NextResponse.json(
    {
      success: contract.success,
      mode: SCHEDULED_MODE,
      ownedDomains: SCHEDULED_OWNED_DOMAINS,
      deferredDomains: SCHEDULED_DEFERRED_DOMAINS,
      adsOwner: "retry-ozon-report-ads",
      totalCompanies: results.length,
      syncedCompanies,
      skippedCompanies: contract.skippedCompanies,
      failedCompanies: contract.failedCompanies,
      retryable: contract.retryable,
      results,
      executedAt: new Date().toISOString(),
    },
    { status: contract.httpStatus }
  );
}
