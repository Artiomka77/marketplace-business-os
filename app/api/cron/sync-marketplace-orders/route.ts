import { NextResponse } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/security/cronAuth";

import {
  marketplaceOrdersHttpStatus,
  syncMarketplaceDailyOrders,
} from "@/lib/marketplaceOrders/syncMarketplaceDailyOrders";
import { runMarketplaceOrderRecoveryPass } from "@/lib/marketplaceOrders/runOrderRecoveryPass";
import {
  createOrderSyncRunId,
  logMarketplaceOrdersEvent,
} from "@/lib/marketplaceOrders/orderSyncLog";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function toDate(value: string | null) {
  if (!value) return null;

  const [year, month, day] = value.split("-").map(Number);

  if (!year || !month || !day) return null;

  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function isScheduledDefault(url: URL) {
  return !url.searchParams.get("date") && !url.searchParams.get("from") && !url.searchParams.get("to");
}

export async function GET(req: Request) {
  const cronDenied = rejectUnauthorizedCron(req);
  if (cronDenied) return cronDenied;
  const url = new URL(req.url);
  const started = Date.now();

  if (isScheduledDefault(url)) {
    const pass = await runMarketplaceOrderRecoveryPass({
      route: "/api/cron/sync-marketplace-orders",
    });
    const result = pass.body;
    const headers: Record<string, string> = {};
    if (pass.httpStatus === 503) {
      headers["Retry-After"] = "3600";
    }
    return NextResponse.json(result, { status: pass.httpStatus, headers });
  }

  const date = toDate(url.searchParams.get("date"));
  const dateFrom = toDate(url.searchParams.get("from"));
  const dateTo = toDate(url.searchParams.get("to"));
  const runId = createOrderSyncRunId();
  const synced = await syncMarketplaceDailyOrders({
    date: date ?? undefined,
    dateFrom: dateFrom ?? undefined,
    dateTo: dateTo ?? undefined,
  });
  const result = {
    ...synced,
    recovery: {
      noOp: false,
      attempted: synced.results.length,
      planned: synced.results.length,
      reasonCode: "MANUAL",
    },
  };
  const httpStatus = marketplaceOrdersHttpStatus(result);
  logMarketplaceOrdersEvent({
    runId,
    route: "/api/cron/sync-marketplace-orders",
    mode: result.mode,
    phase: "summary",
    status: result.ok ? "complete" : result.retryable ? "retryable_incomplete" : "terminal_incomplete",
    retryable: result.retryable,
    durationMs: Date.now() - started,
    httpStatus,
    incompleteCount: result.incompleteRequired.length,
    partialSuccess: result.partialSuccess,
  });
  const headers: Record<string, string> = {};
  if (httpStatus === 503) {
    headers["Retry-After"] = "3600";
  }
  return NextResponse.json(result, { status: httpStatus, headers });
}
