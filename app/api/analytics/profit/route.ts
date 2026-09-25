import { NextResponse } from "next/server";
import {
  loadProfitReadModelPack,
  WaveDEConsumerUnavailableError,
  type ProfitMarketplace,
} from "@/lib/consumers/waveDE";

function headersHit() {
  return {
    "x-wave-de-source": "PROFIT_READ_MODEL",
    "x-wave-de-heavy-fc": "0",
  } as const;
}

function headersMiss() {
  return {
    "x-wave-de-source": "PROFIT_READ_MODEL",
    "x-wave-de-heavy-fc": "0",
  } as const;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const dateFrom = url.searchParams.get("dateFrom");
    const dateTo = url.searchParams.get("dateTo");
    const companyName = url.searchParams.get("companyName") || "ALL";
    const marketplaceRaw = (url.searchParams.get("marketplace") || "WB").toUpperCase();
    const marketplace = (marketplaceRaw === "OZON" ? "OZON" : "WB") as ProfitMarketplace;

    if (!dateFrom || !dateTo) {
      return NextResponse.json(
        {
          ok: false,
          unavailable: true,
          reason: "MISSING_PERIOD",
          message: "dateFrom/dateTo required",
        },
        { status: 400, headers: headersMiss() },
      );
    }

    const loaded = await loadProfitReadModelPack({
      marketplace,
      companyScope: companyName,
      dateFrom,
      dateTo,
    });

    const analytics =
      loaded.analytics && typeof loaded.analytics === "object"
        ? (loaded.analytics as Record<string, unknown>)
        : {};
    const skuRows = loaded.skuRows.map((r) => ({
      productKey: r.productKey,
      ...(typeof r.payload === "object" && r.payload
        ? (r.payload as Record<string, unknown>)
        : { payload: r.payload }),
    }));

    const result = { totals: loaded.totals ?? null };

    return NextResponse.json(
      {
        ok: true,
        success: true,
        source: "PROFIT_READ_MODEL",
        sourceMarker: "PROFIT_READ_MODEL_HIT",
        meta: loaded.meta,
        marketplace,
        ...analytics,
        formulaVersion: loaded.meta.formulaVersion,
        dataMode: loaded.meta.dataMode,
        coverageStatus: loaded.meta.coverageStatus,
        wbPnlUnavailable: result.totals === null,
        profitFinality:
          loaded.meta.dataMode === "FINAL" ? "FINAL" : "PRELIMINARY",
        costCoverageIncomplete: loaded.meta.coverageStatus !== "COMPLETE",
        totals: result.totals,
        comparison: loaded.comparison,
        rows: Array.isArray((analytics as any).rows)
          ? (analytics as any).rows
          : skuRows,
        skuRows,
        skuCount: skuRows.length,
        heavyFinancialCoreCalls: 0,
      },
      { headers: headersHit() },
    );
  } catch (error) {
    if (error instanceof WaveDEConsumerUnavailableError) {
      return NextResponse.json(
        {
          ok: false,
          unavailable: true,
          reason: error.reason,
          message: error.message,
          details: error.details ?? null,
          source: "PROFIT_READ_MODEL",
          sourceMarker: "PROFIT_READ_MODEL_MISS",
          heavyFinancialCoreCalls: 0,
        },
        { status: 409, headers: headersMiss() },
      );
    }
    console.error(error);
    return NextResponse.json(
      { error: "Ошибка расчета прибыли" },
      { status: 500 },
    );
  }
}
