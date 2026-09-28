import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import {
  getWbDailySalesErrorMessage,
  syncWbDailySales,
} from "@/lib/wb/syncWbDailySales";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type WbConnectionForBackfill = {
  companyId: string;
  companyName: string;
};

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function addUtcDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return startOfUtcDay(result);
}

function parseDate(value: string | null, fieldName: string) {
  if (!value) {
    throw new Error(`Передайте ${fieldName} в формате YYYY-MM-DD`);
  }

  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    throw new Error(`${fieldName} должен быть в формате YYYY-MM-DD`);
  }

  const [, year, month, day] = match;

  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
}

function parseLimitDays(value: string | null) {
  const parsed = Number(value ?? 3);

  if (!Number.isFinite(parsed)) return 3;

  // Для WB Statistics API не гоняем большие пачки: меньше риск 429 и timeout.
  return Math.min(7, Math.max(1, Math.trunc(parsed)));
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function isRateLimitError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();

  return (
    message.includes("429") ||
    message.includes("too many requests") ||
    message.includes("limited by global limiter") ||
    message.includes("global limiter") ||
    message.includes("rate limit")
  );
}

function isAuthorized(req: Request) {
  if (process.env.NODE_ENV !== "production") {
    return true;
  }

  const secret = process.env.DEBUG_SECRET ?? process.env.CRON_SECRET;

  if (!secret) {
    return false;
  }

  const url = new URL(req.url);
  const tokenFromQuery = url.searchParams.get("secret");
  const authorization = req.headers.get("authorization");

  return tokenFromQuery === secret || authorization === `Bearer ${secret}`;
}

async function getConnection(req: Request): Promise<WbConnectionForBackfill> {
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId")?.trim() || null;
  const companyName = url.searchParams.get("companyName")?.trim() || null;

  if (!companyId && !companyName) {
    throw new Error("Передайте companyName или companyId. Backfill запускаем по одной компании.");
  }

  const connection = await prisma.marketplaceApiConnection.findFirst({
    where: {
      marketplace: "WB",
      isEnabled: true,
      wbToken: {
        not: null,
      },
      ...(companyId
        ? {
            companyId,
          }
        : {}),
      ...(companyName
        ? {
            company: {
              name: companyName,
            },
          }
        : {}),
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

  if (!connection) {
    throw new Error(
      "Активное WB-подключение не найдено. Проверьте companyName/companyId и настройки API."
    );
  }

  return {
    companyId: connection.companyId,
    companyName: connection.company.name,
  };
}

async function getExistingDailyGeoStatus(params: {
  companyName: string;
  reportNumber: string;
}) {
  const rows = await prisma.wbSale.findMany({
    where: {
      companyName: params.companyName,
      reportNumber: params.reportNumber,
    },
    select: {
      warehouseName: true,
      countryName: true,
      oblastOkrugName: true,
      regionName: true,
    },
  });

  return {
    rowsCount: rows.length,
    geoRowsCount: rows.filter(
      (row) =>
        row.warehouseName ||
        row.countryName ||
        row.oblastOkrugName ||
        row.regionName
    ).length,
  };
}

function makeNextUrl(req: Request, nextDateFrom: string | null) {
  if (!nextDateFrom) return null;

  const url = new URL(req.url);
  url.searchParams.set("dateFrom", nextDateFrom);

  return url.toString();
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Доступ запрещён. В production передайте DEBUG_SECRET или CRON_SECRET через ?secret=... либо Authorization: Bearer <secret>.",
      },
      { status: 401 }
    );
  }

  const url = new URL(req.url);

  let connection: WbConnectionForBackfill;
  let dateFrom: Date;
  let dateTo: Date;

  try {
    connection = await getConnection(req);
    dateFrom = parseDate(url.searchParams.get("dateFrom"), "dateFrom");
    dateTo = parseDate(url.searchParams.get("dateTo"), "dateTo");
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: getErrorMessage(error),
      },
      { status: 400 }
    );
  }

  if (dateFrom.getTime() > dateTo.getTime()) {
    return NextResponse.json(
      {
        ok: false,
        error: "dateFrom не может быть позже dateTo",
      },
      { status: 400 }
    );
  }

  const limitDays = parseLimitDays(url.searchParams.get("limitDays"));
  const force = url.searchParams.get("force") === "1";
  const results = [];

  let currentDate = startOfUtcDay(dateFrom);
  let processedDays = 0;
  let stoppedByRateLimit = false;

  while (currentDate.getTime() <= dateTo.getTime() && processedDays < limitDays) {
    const dateText = formatDateOnly(currentDate);
    const reportNumber = `WB_DAILY_STATISTICS_${dateText}`;

    try {
      const existing = await getExistingDailyGeoStatus({
        companyName: connection.companyName,
        reportNumber,
      });

      if (!force && existing.rowsCount > 0 && existing.geoRowsCount > 0) {
        results.push({
          date: dateText,
          ok: true,
          skipped: true,
          reason: "already_has_geo_rows",
          existing,
        });

        currentDate = addUtcDays(currentDate, 1);
        processedDays += 1;
        continue;
      }

      const result = await syncWbDailySales(connection.companyId, {
        date: currentDate,
      });

      results.push({
        date: dateText,
        ok: true,
        skipped: false,
        result,
      });
    } catch (error) {
      const message = getWbDailySalesErrorMessage(error);
      const rateLimited = isRateLimitError(error);

      results.push({
        date: dateText,
        ok: false,
        isRateLimit: rateLimited,
        error: message,
      });

      if (rateLimited) {
        stoppedByRateLimit = true;
        break;
      }
    }

    currentDate = addUtcDays(currentDate, 1);
    processedDays += 1;
  }

  const nextDateFrom =
    currentDate.getTime() <= dateTo.getTime() && !stoppedByRateLimit
      ? formatDateOnly(currentDate)
      : null;

  const okRows = results.filter((item) => item.ok);
  const failedRows = results.filter((item) => !item.ok);

  return NextResponse.json({
    ok: failedRows.length === 0,
    mode: "safe_wb_daily_sales_backfill",
    marketplace: "WB",
    companyName: connection.companyName,
    dateFrom: formatDateOnly(dateFrom),
    dateTo: formatDateOnly(dateTo),
    processedDays: results.length,
    limitDays,
    successfulDays: okRows.length,
    failedDays: failedRows.length,
    stoppedByRateLimit,
    nextDateFrom,
    nextUrl: makeNextUrl(req, nextDateFrom),
    advice: stoppedByRateLimit
      ? "WB вернул global limiter. Остановились безопасно. Подождите 30–60 минут и продолжите с nextDateFrom."
      : nextDateFrom
        ? "Есть ещё дни для дозагрузки. Запустите nextUrl следующим заходом."
        : "Период обработан.",
    results,
    executedAt: new Date().toISOString(),
  });
}
