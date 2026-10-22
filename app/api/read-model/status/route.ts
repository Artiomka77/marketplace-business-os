import { NextResponse } from "next/server";

import { getLightweightReadiness } from "@/lib/readModel/lightweightReadiness";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const surface = url.searchParams.get("surface") ?? "";
  const dateFrom = url.searchParams.get("dateFrom") ?? "";
  const dateTo = url.searchParams.get("dateTo") ?? "";
  const companyScope = url.searchParams.get("companyScope") ?? "ALL";
  const marketplace = url.searchParams.get("marketplace") ?? "ALL";

  const readiness = await getLightweightReadiness({
    surface,
    dateFrom,
    dateTo,
    companyScope,
    marketplace,
  });

  return NextResponse.json(readiness, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
