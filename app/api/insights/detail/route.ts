import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  LOCAL_AUTH_COOKIE_NAME,
  verifyLocalAuthToken,
} from "@/lib/auth/localAuth";
import { loadInsightsDetailSnapshot } from "@/lib/insights/loadDetailSnapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function first(
  value: string | string[] | undefined,
  fallback: string,
): string {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const t = String(entry ?? "").trim();
      if (t) return t;
    }
    return fallback;
  }
  if (value == null) return fallback;
  const t = String(value).trim();
  return t || fallback;
}

export async function GET(request: Request) {
  const cookieStore = await cookies();
  const token = cookieStore.get(LOCAL_AUTH_COOKIE_NAME)?.value;
  if (!verifyLocalAuthToken(token)) {
    return NextResponse.json(
      { ok: false, error: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const dateFrom = first(url.searchParams.get("dateFrom") ?? undefined, "");
  const dateTo = first(url.searchParams.get("dateTo") ?? undefined, "");
  const company = first(url.searchParams.get("company") ?? undefined, "ALL");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    return NextResponse.json(
      { ok: false, error: "INVALID_DATES" },
      { status: 400 },
    );
  }

  const t0 = Date.now();
  try {
    const detail = await loadInsightsDetailSnapshot({
      dateFrom,
      dateTo,
      selectedCompany: company,
    });
    return NextResponse.json({
      ok: true,
      elapsedMs: Date.now() - t0,
      detail,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - t0,
      },
      { status: 500 },
    );
  }
}
