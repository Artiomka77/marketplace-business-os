import { NextResponse } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/security/cronAuth";

import { prisma } from "@/lib/prisma";
import {
  getWbDailySalesErrorMessage,
  syncWbDailySales,
} from "@/lib/wb/syncWbDailySales";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type WbConnectionForDailySales = {
  companyId: string;
  company: {
    name: string;
  };
};

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
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

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getActiveWbConnections(companyName?: string | null) {
  return prisma.marketplaceApiConnection.findMany({
    where: {
      isEnabled: true,
      marketplace: "WB",
      wbToken: {
        not: null,
      },
      company: {
        isActive: true,
        ...(companyName ? { name: companyName } : {}),
      },
    },
    select: {
      companyId: true,
      company: {
        select: {
          name: true,
        },
      },
    },
    orderBy: {
      companyId: "asc",
    },
  });
}

async function runWbDailySales(
  connection: WbConnectionForDailySales,
  date: Date
) {
  try {
    const result = await syncWbDailySales(connection.companyId, {
      date,
    });

    return {
      marketplace: "WB",
      companyName: connection.company.name,
      dataType: "SALES_DAILY",
      ok: true,
      result,
    };
  } catch (error) {
    return {
      marketplace: "WB",
      companyName: connection.company.name,
      dataType: "SALES_DAILY",
      ok: false,
      error: getWbDailySalesErrorMessage(error),
    };
  }
}

export async function GET(req: Request) {
  const cronDenied = rejectUnauthorizedCron(req);
  if (cronDenied) return cronDenied;
  try {
    const url = new URL(req.url);
    const companyName = url.searchParams.get("companyName");
    const date = parseDateFromRequest(req);
    const dateText = formatDateOnly(date);

    const connections = await getActiveWbConnections(companyName);

    const results = [];

    for (const connection of connections) {
      results.push(await runWbDailySales(connection, date));

      // Небольшая пауза между кабинетами WB, чтобы не бить API подряд.
      await sleep(1200);
    }

    const failedResults = results.filter((result) => !result.ok);
    const totalSavedRows = results.reduce((sum, result) => {
      if (!result.ok) return sum;

      return sum + Number(result.result?.salesRows ?? result.result?.rows ?? 0);
    }, 0);

    return NextResponse.json({
      ok: failedResults.length === 0,
      date: dateText,
      totalCompanies: connections.length,
      syncedCompanies: results.filter((result) => result.ok).length,
      failedCompanies: failedResults.length,
      totalSavedRows,
      results,
      executedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Ошибка загрузки WB Daily Sales",
        executedAt: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
