import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { syncWbAds } from "@/lib/wb/syncWbAds";
import {
  getWbCronSkipResult,
  setWbCronError,
  setWbCronLastAttempt,
  setWbCronSuccess,
  type WbCronCompanyResult,
  type WbCronConnection,
} from "@/lib/wb/wbCronProtection";

export const dynamic = "force-dynamic";

export async function GET() {
  const connections: WbCronConnection[] =
    await prisma.marketplaceApiConnection.findMany({
      where: {
        marketplace: "WB",
        isEnabled: true,
        wbToken: {
          not: null,
        },
      },
      select: {
        companyId: true,
        lastAttemptAt: true,
        lastError: true,
        retryCount: true,
      },
      orderBy: {
        companyId: "asc",
      },
    });

  const results: WbCronCompanyResult[] = [];

  for (const connection of connections) {
    const skipResult = await getWbCronSkipResult({
      companyId: connection.companyId,
      syncName: "WB Ads",
      lastAttemptAt: connection.lastAttemptAt,
      lastError: connection.lastError,
      retryCount: connection.retryCount,
    });

    if (skipResult) {
      results.push(skipResult);
      continue;
    }

    try {
      await setWbCronLastAttempt(connection.companyId);

      const result = await syncWbAds(connection.companyId);

      await setWbCronSuccess(
        connection.companyId,
        result.skippedCampaigns > 0
          ? `WB Ads: обработано ${result.processedCampaigns} из ${result.totalCampaigns} кампаний. Остальные будут обработаны следующими запусками.`
          : null
      );

      results.push({
        companyId: connection.companyId,
        ok: true,
        skipped: false,
        reason: null,
        result,
        error: null,
        isRateLimit: false,
      });
    } catch (error) {
      const errorResult = await setWbCronError({
        companyId: connection.companyId,
        error,
        rateLimitPrefix: "WB Ads",
      });

      results.push({
        companyId: connection.companyId,
        ok: false,
        skipped: false,
        reason: errorResult.isRateLimit ? "WB_RATE_LIMIT" : "WB_ADS_SYNC_ERROR",
        result: null,
        error: errorResult.errorText,
        isRateLimit: errorResult.isRateLimit,
      });
    }
  }

  return NextResponse.json({
    success: results.every((result) => result.ok || result.isRateLimit),
    totalCompanies: results.length,
    syncedCompanies: results.filter((result) => !result.skipped).length,
    skippedCompanies: results.filter((result) => result.skipped).length,
    results,
    executedAt: new Date().toISOString(),
  });
}