import { NextResponse } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/security/cronAuth";

import { retryMissingOzonReportAds } from "@/lib/ozon/reportAdsRetry";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function parseDate(value: string | null) {
  if (!value) return undefined;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("date должен быть в формате YYYY-MM-DD");
  }

  return new Date(`${value}T00:00:00Z`);
}

export async function GET(req: Request) {
  const cronDenied = rejectUnauthorizedCron(req);
  if (cronDenied) return cronDenied;
  try {
    const url = new URL(req.url);
    const date = parseDate(url.searchParams.get("date"));
    const companyId = url.searchParams.get("companyId");
    const includePerformance = url.searchParams.get("performance") !== "0";

    const result = await retryMissingOzonReportAds({
      dateFrom: date,
      dateTo: date,
      companyId,
      includePerformance,
    });

    return NextResponse.json({
      ok: true,
      purpose:
        "Retry Ozon ad expenses for Telegram owner report until Ozon Finance or Performance data appears.",
      ...result,
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
