import {
  marketplaceOrdersHttpStatus,
  syncMarketplaceDailyOrders,
  type MarketplaceOrderSyncResult,
} from "@/lib/marketplaceOrders/syncMarketplaceDailyOrders";
import {
  formatDateOnly,
  getMarketplaceOrderRecoveryScopes,
  getYesterdayMoscowDate,
  isPrimaryOrderSyncDue,
  type OrderRecoveryDeps,
} from "@/lib/marketplaceOrders/orderRecoveryPlanner";
import {
  createOrderSyncRunId,
  logMarketplaceOrdersEvent,
} from "@/lib/marketplaceOrders/orderSyncLog";

export type RecoveryPassResult = {
  ok: boolean;
  retryable: boolean;
  partialSuccess: boolean;
  incompleteRequired: MarketplaceOrderSyncResult["incompleteRequired"];
  mode: string;
  dates: string[];
  recovery: {
    noOp: boolean;
    attempted: number;
    planned: number;
    reasonCode: string;
  };
  results: MarketplaceOrderSyncResult["results"];
  wbStoppedByRateLimit?: boolean;
};

function safeIncomplete(
  rows: MarketplaceOrderSyncResult["incompleteRequired"]
): MarketplaceOrderSyncResult["incompleteRequired"] {
  return rows.map((row) => ({
    companyName: row.companyName,
    marketplace: row.marketplace,
    date: row.date,
    reason: row.reasonCode ?? row.reason ?? null,
    reasonCode: row.reasonCode ?? null,
    status: row.status,
    retryable: row.retryable,
  }));
}

export async function runMarketplaceOrderRecoveryPass(params: {
  route: string;
  now?: Date;
  targetDate?: Date;
  deps?: OrderRecoveryDeps;
  syncFn?: typeof syncMarketplaceDailyOrders;
  onScopeCall?: (scope: { companyName: string; marketplace: string; date: string }) => void;
}): Promise<{ body: RecoveryPassResult; httpStatus: 200 | 503 | 500; runId: string; durationMs: number }> {
  const started = Date.now();
  const runId = createOrderSyncRunId(params.now);
  const now = params.now ?? new Date();
  const targetDate = params.targetDate ?? getYesterdayMoscowDate(now);
  const dateText = formatDateOnly(targetDate);

  if (!isPrimaryOrderSyncDue(targetDate, now)) {
    const body: RecoveryPassResult = {
      ok: true,
      retryable: false,
      partialSuccess: false,
      incompleteRequired: [],
      mode: "recovery",
      dates: [dateText],
      recovery: {
        noOp: true,
        attempted: 0,
        planned: 0,
        reasonCode: "PRIMARY_SYNC_NOT_DUE",
      },
      results: [],
    };
    const durationMs = Date.now() - started;
    logMarketplaceOrdersEvent({
      runId,
      route: params.route,
      mode: "recovery",
      targetDate: dateText,
      phase: "summary",
      status: "noop",
      reasonCode: "PRIMARY_SYNC_NOT_DUE",
      durationMs,
      httpStatus: 200,
      recoveryNoOp: true,
      attempted: 0,
      incompleteCount: 0,
      partialSuccess: false,
    });
    return { body, httpStatus: 200, runId, durationMs };
  }

  const planned = await getMarketplaceOrderRecoveryScopes({
    targetDate,
    now,
    deps: params.deps,
  });

  if (planned.length === 0) {
    const body: RecoveryPassResult = {
      ok: true,
      retryable: false,
      partialSuccess: false,
      incompleteRequired: [],
      mode: "recovery",
      dates: [dateText],
      recovery: {
        noOp: true,
        attempted: 0,
        planned: 0,
        reasonCode: "ALL_REQUIRED_SCOPES_FRESH",
      },
      results: [],
    };
    const durationMs = Date.now() - started;
    logMarketplaceOrdersEvent({
      runId,
      route: params.route,
      mode: "recovery",
      targetDate: dateText,
      phase: "summary",
      status: "noop",
      durationMs,
      httpStatus: 200,
      recoveryNoOp: true,
      attempted: 0,
      incompleteCount: 0,
      partialSuccess: false,
    });
    return { body, httpStatus: 200, runId, durationMs };
  }

  const syncFn = params.syncFn ?? syncMarketplaceDailyOrders;
  const synced = await syncFn({
    dateFrom: targetDate,
    dateTo: targetDate,
    mode: "daily",
    scopeFilter: planned.map((scope) => ({
      companyName: scope.companyName,
      marketplace: scope.marketplace,
      date: scope.date,
    })),
    onScopeCall: params.onScopeCall,
  });

  const httpStatus = marketplaceOrdersHttpStatus(synced);
  const completed = synced.results.filter((row) => !("skipped" in row) || row.skipped === false).length;
  const body: RecoveryPassResult = {
    ok: synced.ok,
    retryable: synced.retryable,
    partialSuccess: !synced.ok && completed > 0,
    incompleteRequired: safeIncomplete(synced.incompleteRequired),
    mode: "recovery",
    dates: synced.dates,
    recovery: {
      noOp: false,
      attempted: planned.length,
      planned: planned.length,
      reasonCode: synced.ok ? "RECOVERY_COMPLETE" : synced.retryable ? "RECOVERY_RETRYABLE" : "RECOVERY_TERMINAL",
    },
    results: synced.results,
    wbStoppedByRateLimit: synced.wbStoppedByRateLimit,
  };
  const durationMs = Date.now() - started;
  logMarketplaceOrdersEvent({
    runId,
    route: params.route,
    mode: "recovery",
    targetDate: dateText,
    phase: "summary",
    status: synced.ok ? "complete" : synced.retryable ? "retryable_incomplete" : "terminal_incomplete",
    retryable: synced.retryable,
    durationMs,
    httpStatus,
    recoveryPlanned: true,
    recoveryNoOp: false,
    attempted: planned.length,
    incompleteCount: synced.incompleteRequired.length,
    partialSuccess: body.partialSuccess,
    rowsWritten: completed,
  });
  for (const scope of planned) {
    const match = synced.incompleteRequired.find(
      (row) => row.companyName === scope.companyName && row.marketplace === scope.marketplace
    );
    if (!match) continue;
    logMarketplaceOrdersEvent({
      runId,
      route: params.route,
      mode: "recovery",
      targetDate: dateText,
      companyName: scope.companyName,
      marketplace: scope.marketplace,
      phase: "scope",
      status: String(match.status ?? "incomplete"),
      retryable: match.retryable,
      reasonCode: match.reasonCode ?? scope.reasonCode,
    });
  }
  return { body, httpStatus, runId, durationMs };
}
