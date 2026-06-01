import { NextResponse } from "next/server";
import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);

    const dateFrom = url.searchParams.get("dateFrom");
    const dateTo = url.searchParams.get("dateTo");

    const result = await getProfitAnalytics({
      dateFrom,
      dateTo,
    });

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      { error: "Ошибка расчета прибыли" },
      { status: 500 }
    );
  }
}