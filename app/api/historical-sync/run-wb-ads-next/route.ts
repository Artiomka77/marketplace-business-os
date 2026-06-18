import { NextResponse } from "next/server";

import { runNextHistoricalSyncJob } from "@/lib/historicalSync/runHistoricalSyncJob";

export const dynamic = "force-dynamic";

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

export async function GET() {
  try {
    const result = await runNextHistoricalSyncJob({
      marketplace: "WB",
      dataTypes: ["ADS"],
    });

    return NextResponse.json({
      success: result.ok,
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