import { NextRequest, NextResponse } from "next/server";

import { createHistoricalSyncJobs } from "@/lib/historicalSync/createHistoricalSyncJobs";

export const dynamic = "force-dynamic";

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const dateFromText = searchParams.get("dateFrom") ?? undefined;
    const dateToText = searchParams.get("dateTo") ?? undefined;
    const companyId = searchParams.get("companyId");

    const result = await createHistoricalSyncJobs({
      dateFromText,
      dateToText,
      companyId,
    });

    return NextResponse.json({
      success: true,
      ...result,
      executedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: getErrorMessage(error),
        executedAt: new Date().toISOString(),
      },
      { status: 500 }
    );
  }
}