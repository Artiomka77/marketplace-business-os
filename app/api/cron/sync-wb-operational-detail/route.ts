import { NextResponse } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/security/cronAuth";

import { prisma } from "@/lib/prisma";
import {
  getWbOperationalDetailErrorMessage,
  syncWbOperationalDetail,
} from "@/lib/wb/syncWbOperationalDetail";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

type WbConnection = {
  companyId: string;
  company: {
    name: string;
  };
};

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
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

function parseDate(value: string | null, fallback: Date) {
  if (!value) return fallback;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Дата должна быть в формате YYYY-MM-DD");
  }

  return startOfUtcDay(new Date(`${value}T00:00:00Z`));
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
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

async function runForConnection(connection: WbConnection, dateFrom: Date, dateTo: Date) {
  try {
    const result = await syncWbOperationalDetail(connection.companyId, {
      dateFrom,
      dateTo,
    });

    return {
      marketplace: "WB",
      companyName: connection.company.name,
      dataType: "SALES_OPERATIONAL_DETAIL",
      ok: true,
      result,
    };
  } catch (error) {
    return {
      marketplace: "WB",
      companyName: connection.company.name,
      dataType: "SALES_OPERATIONAL_DETAIL",
      ok: false,
      error: getWbOperationalDetailErrorMessage(error),
    };
  }
}

export async function GET(req: Request) {
  const cronDenied = rejectUnauthorizedCron(req);
  if (cronDenied) return cronDenied;
  try {
    const url = new URL(req.url);
    const companyName = url.searchParams.get("companyName");
    const date = url.searchParams.get("date");
    const dateFromText = url.searchParams.get("dateFrom");
    const dateToText = url.searchParams.get("dateTo");

    const fallbackDate = getYesterdayMoscowDate();
    const dateFrom = parseDate(dateFromText ?? date, fallbackDate);
    const dateTo = parseDate(dateToText ?? date, dateFrom);

    if (dateFrom.getTime() > dateTo.getTime()) {
      throw new Error("dateFrom не может быть позже dateTo");
    }

    const connections = await getActiveWbConnections(companyName);
    const results = [];

    for (const connection of connections) {
      results.push(await runForConnection(connection, dateFrom, dateTo));
      await sleep(1200);
    }

    const failedResults = results.filter((result) => !result.ok);
    const totalSavedRows = results.reduce((sum, result) => {
      if (!result.ok) return sum;
      return sum + Number(result.result?.rows ?? 0);
    }, 0);

    return NextResponse.json({
      ok: failedResults.length === 0,
      dateFrom: formatDateOnly(dateFrom),
      dateTo: formatDateOnly(dateTo),
      totalCompanies: connections.length,
      syncedCompanies: results.filter((result) => result.ok).length,
      failedCompanies: failedResults.length,
      totalSavedRows,
      results,
      failedResults,
      executedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Ошибка загрузки WB operational detail",
        executedAt: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}
