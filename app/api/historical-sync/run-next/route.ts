import { NextRequest, NextResponse } from "next/server";

import { runNextHistoricalSyncJob } from "@/lib/historicalSync/runHistoricalSyncJob";

export const dynamic = "force-dynamic";

type MarketplaceParam = "OZON" | "WB" | "ALL";

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function parseMarketplace(value: string | null): MarketplaceParam {
  if (value === "WB") {
    return "WB";
  }

  if (value === "ALL") {
    return "ALL";
  }

  return "OZON";
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    const companyId = searchParams.get("companyId");
    const marketplace = parseMarketplace(searchParams.get("marketplace"));

    const result = await runNextHistoricalSyncJob({
      marketplace,
      companyId,
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