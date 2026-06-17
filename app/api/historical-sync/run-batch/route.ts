import { NextRequest, NextResponse } from "next/server";

import { runNextHistoricalSyncJob } from "@/lib/historicalSync/runHistoricalSyncJob";

export const dynamic = "force-dynamic";

const DEFAULT_BATCH_LIMIT = 3;
const MAX_BATCH_LIMIT = 5;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function parseLimit(value: string | null) {
  if (!value) return DEFAULT_BATCH_LIMIT;

  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    return DEFAULT_BATCH_LIMIT;
  }

  return Math.min(Math.trunc(number), MAX_BATCH_LIMIT);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const companyId = searchParams.get("companyId");
    const limit = parseLimit(searchParams.get("limit"));

    const results = [];

    for (let index = 0; index < limit; index += 1) {
      const result = await runNextHistoricalSyncJob({
        marketplace: "OZON",
        companyId,
      });

      results.push(result);

      if (result.skipped) {
        break;
      }

      if (!result.ok) {
        break;
      }
    }

    const completed = results.filter(
      (result) => result.ok && !result.skipped
    ).length;

    const skipped = results.some((result) => result.skipped);
    const failed = results.find((result) => !result.ok) ?? null;

    return NextResponse.json({
      success: !failed,
      ok: !failed,
      limit,
      completed,
      stopped: Boolean(skipped || failed),
      stopReason: failed
        ? failed.isRateLimit
          ? "RATE_LIMIT"
          : "ERROR"
        : skipped
          ? "NO_PENDING_JOBS"
          : null,
      results,
      executedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        ok: false,
        error: getErrorMessage(error),
        executedAt: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}