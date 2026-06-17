import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { syncWbAds } from "@/lib/wb/syncWbAds";

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

export async function GET() {
  const connections = await prisma.marketplaceApiConnection.findMany({
    where: {
      marketplace: "WB",
      isEnabled: true,
      wbToken: {
        not: null,
      },
    },
    select: {
      companyId: true,
    },
  });

  const results = [];

  for (const connection of connections) {
    try {
      await prisma.marketplaceApiConnection.update({
        where: {
          companyId_marketplace: {
            companyId: connection.companyId,
            marketplace: "WB",
          },
        },
        data: {
          lastAttemptAt: new Date(),
        },
      });

      const result = await syncWbAds(connection.companyId);

      await prisma.marketplaceApiConnection.update({
        where: {
          companyId_marketplace: {
            companyId: connection.companyId,
            marketplace: "WB",
          },
        },
        data: {
          status: "CONNECTED",
          lastSyncAt: new Date(),
          retryCount: 0,
          lastError:
            result.skippedCampaigns > 0
              ? `WB Ads: обработано ${result.processedCampaigns} из ${result.totalCampaigns} кампаний. Остальные будут обработаны следующими запусками.`
              : null,
        },
      });

      results.push({
        companyId: connection.companyId,
        ok: true,
        result,
        error: null,
        isRateLimit: false,
      });
    } catch (error) {
      const errorText = getErrorMessage(error);
      const isRateLimit = isRateLimitError(error);

      await prisma.marketplaceApiConnection.update({
        where: {
          companyId_marketplace: {
            companyId: connection.companyId,
            marketplace: "WB",
          },
        },
        data: {
          status: isRateLimit ? "CONNECTED" : "ERROR",
          lastAttemptAt: new Date(),
          retryCount: {
            increment: 1,
          },
          lastError: errorText.slice(0, 1000),
        },
      });

      results.push({
        companyId: connection.companyId,
        ok: false,
        result: null,
        error: errorText,
        isRateLimit,
      });
    }
  }

  return NextResponse.json({
    success: results.every((result) => result.ok || result.isRateLimit),
    syncedCompanies: results.length,
    results,
    executedAt: new Date().toISOString(),
  });
}