import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { syncWbAds } from "@/lib/wb/syncWbAds";

const WB_ADS_COOLDOWN_MS = 60 * 60 * 1000;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function isRateLimitMessage(message: string) {
  const normalizedMessage = message.toLowerCase();

  return (
    normalizedMessage.includes("429") ||
    normalizedMessage.includes("too many requests") ||
    normalizedMessage.includes("limited by global limiter") ||
    normalizedMessage.includes("rate limit")
  );
}

function isRateLimitError(error: unknown) {
  return isRateLimitMessage(getErrorMessage(error));
}

function isWbAdsRateLimitText(errorText: string | null) {
  if (!errorText) {
    return false;
  }

  const normalizedText = errorText.toLowerCase();

  return normalizedText.includes("wb ads") && isRateLimitMessage(normalizedText);
}

function isWbAdsInCooldown(connection: {
  lastError: string | null;
  lastAttemptAt: Date | null;
}) {
  if (!connection.lastAttemptAt || !isWbAdsRateLimitText(connection.lastError)) {
    return false;
  }

  return Date.now() - connection.lastAttemptAt.getTime() < WB_ADS_COOLDOWN_MS;
}

function getCooldownMessage(lastAttemptAt: Date) {
  const nextTryAt = new Date(lastAttemptAt.getTime() + WB_ADS_COOLDOWN_MS);

  return `WB Ads недавно вернул 429. Чтобы не усиливать блокировку WB, повторный запуск временно пропущен. Повторить можно после ${nextTryAt.toLocaleString("ru-RU")}.`;
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
      lastAttemptAt: true,
      lastError: true,
      retryCount: true,
    },
  });

  const results = [];

  for (const connection of connections) {
    if (isWbAdsInCooldown(connection)) {
      results.push({
        companyId: connection.companyId,
        ok: true,
        result: {
          name: "WB Ads",
          rows: 0,
          skipped: true,
          reason: "RATE_LIMIT_COOLDOWN",
          message: getCooldownMessage(connection.lastAttemptAt as Date),
          retryCount: connection.retryCount,
        },
        error: null,
        isRateLimit: true,
      });

      continue;
    }

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
          lastError: isRateLimit
            ? `WB Ads rate limit: ${errorText}`.slice(0, 1000)
            : errorText.slice(0, 1000),
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