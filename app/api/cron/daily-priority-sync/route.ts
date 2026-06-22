import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { syncMarketplaceDailyOrders } from "@/lib/marketplaceOrders/syncMarketplaceDailyOrders";
import { syncOzonFinance } from "@/lib/ozon/syncOzon";
import { syncWbAds } from "@/lib/wb/syncWbAds";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type MarketplaceApiConnectionForDaily = {
  companyId: string;
  marketplace: string;
  company: {
    name: string;
  };
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function addUtcDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function getYesterdayMoscowDate() {
  const moscowNow = new Date(Date.now() + 3 * 60 * 60 * 1000);

  return new Date(
    Date.UTC(
      moscowNow.getUTCFullYear(),
      moscowNow.getUTCMonth(),
      moscowNow.getUTCDate() - 1
    )
  );
}

function parseDateFromRequest(req: Request) {
  const url = new URL(req.url);
  const dateText = url.searchParams.get("date");

  if (!dateText) {
    return getYesterdayMoscowDate();
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)) {
    throw new Error("date должен быть в формате YYYY-MM-DD");
  }

  return startOfUtcDay(new Date(`${dateText}T00:00:00Z`));
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

async function getActiveConnections() {
  return prisma.marketplaceApiConnection.findMany({
    where: {
      isEnabled: true,
      company: {
        isActive: true,
      },
      OR: [
        {
          marketplace: "WB",
          wbToken: {
            not: null,
          },
        },
        {
          marketplace: "OZON",
          ozonClientId: {
            not: null,
          },
          ozonApiKey: {
            not: null,
          },
        },
      ],
    },
    select: {
      companyId: true,
      marketplace: true,
      company: {
        select: {
          name: true,
        },
      },
    },
    orderBy: [
      {
        marketplace: "asc",
      },
      {
        companyId: "asc",
      },
    ],
  });
}

async function runOzonDailyFinance(
  connection: MarketplaceApiConnectionForDaily,
  date: Date
) {
  try {
    const result = await syncOzonFinance(connection.companyId, {
      dateFrom: date,
      dateTo: date,
    });

    return {
      marketplace: "OZON",
      companyName: connection.company.name,
      dataType: "FINANCE",
      ok: true,
      result,
    };
  } catch (error) {
    return {
      marketplace: "OZON",
      companyName: connection.company.name,
      dataType: "FINANCE",
      ok: false,
      error: getErrorMessage(error),
    };
  }
}

async function runWbDailyAds(
  connection: MarketplaceApiConnectionForDaily,
  date: Date
) {
  try {
    const result = await syncWbAds(connection.companyId, {
      dateFrom: date,
      dateTo: date,
      mode: "FULL",
    });

    return {
      marketplace: "WB",
      companyName: connection.company.name,
      dataType: "ADS",
      ok: true,
      result,
    };
  } catch (error) {
    return {
      marketplace: "WB",
      companyName: connection.company.name,
      dataType: "ADS",
      ok: false,
      error: getErrorMessage(error),
    };
  }
}

export async function GET(req: Request) {
  try {
    const date = parseDateFromRequest(req);
    const dateText = formatDateOnly(date);
    const connections = await getActiveConnections();

    const orderStats = await syncMarketplaceDailyOrders({
      dateFrom: date,
      dateTo: date,
    });

    const results = [];

    for (const connection of connections) {
      if (connection.marketplace === "OZON") {
        results.push(await runOzonDailyFinance(connection, date));
      }

      if (connection.marketplace === "WB") {
        results.push(await runWbDailyAds(connection, date));
      }
    }

    return NextResponse.json({
      ok: true,
      date: dateText,
      purpose:
        "Daily priority sync for Telegram owner report. Runs before historical backlog and before report delivery.",
      orderStats,
      results,
      executedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: getErrorMessage(error),
        executedAt: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
