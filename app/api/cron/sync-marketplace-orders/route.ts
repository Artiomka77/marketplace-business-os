import { NextResponse } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/security/cronAuth";

import {
  marketplaceOrdersHttpStatus,
  syncMarketplaceDailyOrders,
} from "@/lib/marketplaceOrders/syncMarketplaceDailyOrders";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function toDate(value: string | null) {
  if (!value) return null;

  const [year, month, day] = value.split("-").map(Number);

  if (!year || !month || !day) return null;

  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

export async function GET(req: Request) {
  const cronDenied = rejectUnauthorizedCron(req);
  if (cronDenied) return cronDenied;
  const url = new URL(req.url);

  const date = toDate(url.searchParams.get("date"));
  const dateFrom = toDate(url.searchParams.get("from"));
  const dateTo = toDate(url.searchParams.get("to"));

  const result = await syncMarketplaceDailyOrders({
    date: date ?? undefined,
    dateFrom: dateFrom ?? undefined,
    dateTo: dateTo ?? undefined,
  });

  return NextResponse.json(result, {
    status: marketplaceOrdersHttpStatus(result),
  });
}
