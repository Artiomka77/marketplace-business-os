import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { syncWbDailyFinancialReports } from "@/lib/wb/syncWbDailyFinancialReports";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
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

async function getConnections(companyName: string | null) {
  return prisma.marketplaceApiConnection.findMany({
    where: {
      marketplace: "WB",
      isEnabled: true,
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

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const dateParam = url.searchParams.get("date");
    const dateFromParam = url.searchParams.get("dateFrom");
    const dateToParam = url.searchParams.get("dateTo");
    const companyName = String(url.searchParams.get("companyName") ?? "").trim() || null;

    const defaultDate = getYesterdayMoscowDate();
    const dateFrom = parseDate(dateFromParam ?? dateParam, defaultDate);
    const dateTo = parseDate(dateToParam ?? dateParam, dateFrom);

    if (dateFrom.getTime() > dateTo.getTime()) {
      throw new Error("dateFrom не может быть позже dateTo");
    }

    const connections = await getConnections(companyName);
    const results = [];

    for (const connection of connections) {
      try {
        const result = await syncWbDailyFinancialReports(connection.companyId, {
          dateFrom,
          dateTo,
          period: "daily",
          loadDetailed: true,
        });

        results.push({
          ok: true,
          companyName: connection.company.name,
          result,
        });
      } catch (error) {
        results.push({
          ok: false,
          companyName: connection.company.name,
          error: getErrorMessage(error),
        });
      }
    }

    const failed = results.filter((item) => !item.ok);

    return NextResponse.json({
      ok: failed.length === 0,
      source: "WB daily financial reports + daily detailed reports",
      dateFrom: formatDateOnly(dateFrom),
      dateTo: formatDateOnly(dateTo),
      companyName,
      results,
      failed,
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
