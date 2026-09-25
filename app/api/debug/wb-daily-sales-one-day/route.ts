import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import {
  getWbDailySalesErrorMessage,
  syncWbDailySales,
} from "@/lib/wb/syncWbDailySales";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type WbConnectionForManualSync = {
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

function parseDate(value: string | null) {
  if (!value) {
    return startOfUtcDay(new Date());
  }

  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    throw new Error("Дата должна быть в формате YYYY-MM-DD");
  }

  const [, year, month, day] = match;

  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12));
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

async function getConnection(req: Request): Promise<WbConnectionForManualSync> {
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId")?.trim() || null;
  const companyName = url.searchParams.get("companyName")?.trim() || null;

  if (!companyId && !companyName) {
    throw new Error("Передайте companyName или companyId");
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
  let date: Date;
  let connection: WbConnectionForManualSync;

  try {
    date = parseDate(url.searchParams.get("date"));
    connection = await getConnection(req);
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: getErrorMessage(error),
      },
      { status: 400 }
    );
  }

  try {
    const result = await syncWbDailySales(connection.companyId, {
      date,
    });

    return NextResponse.json({
      ok: true,
      mode: "one_company_one_day",
      marketplace: "WB",
      companyName: connection.companyName,
      date: formatDateOnly(date),
      result,
      message:
        "WB Daily Sales загружен за один день и одну компанию. Теперь проверьте WbSale по reportNumber WB_DAILY_STATISTICS_YYYY-MM-DD.",
      executedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = getWbDailySalesErrorMessage(error);
    const rateLimited = isRateLimitError(error);

    return NextResponse.json(
      {
        ok: false,
        mode: "one_company_one_day",
        marketplace: "WB",
        companyName: connection.companyName,
        date: formatDateOnly(date),
        isRateLimit: rateLimited,
        error: message,
        advice: rateLimited
          ? "WB вернул global limiter. Не запускайте повторно сразу. Подождите 30–60 минут и повторите только одну компанию/один день."
          : "Проверьте текст ошибки.",
        executedAt: new Date().toISOString(),
      },
      { status: rateLimited ? 429 : 500 }
    );
  }
}
