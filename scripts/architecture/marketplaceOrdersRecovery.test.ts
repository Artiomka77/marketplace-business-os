import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyMarketplaceOrderRow,
  marketplaceOrdersHttpStatus,
  summarizeMarketplaceOrderRows,
  syncMarketplaceDailyOrders,
  type MarketplaceOrderSyncResult,
} from "../../lib/marketplaceOrders/syncMarketplaceDailyOrders";
import {
  getExpectedPrimarySyncAt,
  getMarketplaceOrderRecoveryScopes,
  getYesterdayMoscowDate,
  isPrimaryOrderSyncDue,
  PRIMARY_ORDER_SYNC_UTC_HOUR,
  PRIMARY_ORDER_SYNC_UTC_MINUTE,
  type ConfiguredOrderScope,
  type ExistingOrderStat,
} from "../../lib/marketplaceOrders/orderRecoveryPlanner";
import { runMarketplaceOrderRecoveryPass } from "../../lib/marketplaceOrders/runOrderRecoveryPass";
import { logMarketplaceOrdersEvent } from "../../lib/marketplaceOrders/orderSyncLog";
import { GET as ordersGET } from "../../app/api/cron/sync-marketplace-orders/route";
import { GET as completenessGET } from "../../app/api/cron/daily-data-completeness-retry/route";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relPath: string) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

function captureLogLines(fn: () => void): string[] {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

function company(name: string, id: string) {
  return {
    id,
    name,
    apiConnections: [
      { marketplace: "WB", isEnabled: true, wbToken: "x", ozonClientId: null, ozonApiKey: null },
      { marketplace: "OZON", isEnabled: true, wbToken: null, ozonClientId: "c", ozonApiKey: "k" },
    ],
  };
}

const fourConfigured: ConfiguredOrderScope[] = [
  { companyId: "1", companyName: "ИП Лебедева", marketplace: "WB", configured: true },
  { companyId: "1", companyName: "ИП Лебедева", marketplace: "OZON", configured: true },
  { companyId: "2", companyName: "ИП Петров", marketplace: "WB", configured: true },
  { companyId: "2", companyName: "ИП Петров", marketplace: "OZON", configured: true },
];

function fakeSyncResult(
  overrides: Partial<MarketplaceOrderSyncResult>
): MarketplaceOrderSyncResult {
  return {
    ok: true,
    retryable: false,
    mode: "daily",
    marketplace: "ALL",
    dates: ["2026-09-01"],
    safeRecheckDays: null,
    wbStoppedByRateLimit: false,
    incompleteRequired: [],
    results: [{ skipped: false, status: "completed" }],
    partialSuccess: false,
    ...overrides,
  };
}

function stat(
  companyName: string,
  marketplace: string,
  date: string,
  lastSuccessfulSyncAt: string | null
): ExistingOrderStat {
  return {
    companyName,
    marketplace,
    orderDate: new Date(`${date}T12:00:00.000Z`),
    lastSuccessfulSyncAt: lastSuccessfulSyncAt ? new Date(lastSuccessfulSyncAt) : null,
  };
}

function statWithLegacyUpdatedAt(
  companyName: string,
  marketplace: string,
  date: string,
  lastSuccessfulSyncAt: string | null,
  updatedAt: string
): ExistingOrderStat & { updatedAt: Date } {
  return {
    ...stat(companyName, marketplace, date, lastSuccessfulSyncAt),
    updatedAt: new Date(updatedAt),
  };
}

function upsertFnSource(): string {
  const src = read("lib/marketplaceOrders/syncMarketplaceDailyOrders.ts");
  const start = src.indexOf("async function upsertDailyOrderStat");
  const end = src.indexOf("async function getCompaniesWithConnections");
  assert.ok(start >= 0 && end > start);
  return src.slice(start, end);
}

function namedFnSource(fnName: string): string {
  const src = read("lib/marketplaceOrders/syncMarketplaceDailyOrders.ts");
  const start = src.indexOf(`export async function ${fnName}`);
  assert.ok(start >= 0, fnName);
  const next = src.indexOf("\nexport async function ", start + 1);
  const next2 = src.indexOf("\nasync function ", start + 1);
  const candidates = [next, next2].filter((n) => n > start);
  const end = candidates.length ? Math.min(...candidates) : src.length;
  return src.slice(start, end);
}

test("A_status_all_complete_200", () => {
  const summary = summarizeMarketplaceOrderRows([
    { marketplace: "WB", companyName: "ИП Петров", date: "2026-09-01", skipped: false },
    { marketplace: "OZON", companyName: "ИП Петров", date: "2026-09-01", skipped: false },
  ]);
  assert.equal(summary.ok, true);
  assert.equal(marketplaceOrdersHttpStatus(summary), 200);
});

test("A_status_not_configured_stays_200", () => {
  const summary = summarizeMarketplaceOrderRows([
    { marketplace: "WB", companyName: "A", date: "2026-09-01", skipped: false },
    {
      marketplace: "OZON",
      companyName: "A",
      date: "2026-09-01",
      skipped: true,
      reason: "Ozon Client-Id or Api-Key is not configured",
    },
  ]);
  assert.equal(classifyMarketplaceOrderRow({ skipped: true, reason: "Ozon Client-Id or Api-Key is not configured" }).status, "not_configured");
  assert.equal(summary.ok, true);
  assert.equal(marketplaceOrdersHttpStatus(summary), 200);
});

test("A_status_one_rate_limit_503", () => {
  const summary = summarizeMarketplaceOrderRows([
    { marketplace: "WB", companyName: "A", date: "2026-09-01", skipped: false },
    { marketplace: "OZON", companyName: "A", date: "2026-09-01", skipped: true, isRateLimit: true, reason: "429" },
  ]);
  assert.equal(marketplaceOrdersHttpStatus(summary), 503);
  assert.equal(summary.retryable, true);
});

test("A_status_multiple_rate_limit_503", () => {
  const summary = summarizeMarketplaceOrderRows([
    { marketplace: "WB", companyName: "A", date: "2026-09-01", skipped: true, isRateLimit: true, reason: "429" },
    { marketplace: "OZON", companyName: "A", date: "2026-09-01", skipped: true, isRateLimit: true, reason: "429" },
  ]);
  assert.equal(marketplaceOrdersHttpStatus(summary), 503);
});

test("A_status_mixed_rate_limit_and_terminal_500", () => {
  const summary = summarizeMarketplaceOrderRows([
    { marketplace: "WB", companyName: "A", date: "2026-09-01", skipped: true, isRateLimit: true, reason: "429" },
    { marketplace: "OZON", companyName: "A", date: "2026-09-01", skipped: true, isRateLimit: false, reason: "500" },
  ]);
  assert.equal(marketplaceOrdersHttpStatus(summary), 500);
});

test("A_status_terminal_only_500", () => {
  const summary = summarizeMarketplaceOrderRows([
    { marketplace: "OZON", companyName: "A", date: "2026-09-01", skipped: true, isRateLimit: false, reason: "boom" },
  ]);
  assert.equal(marketplaceOrdersHttpStatus(summary), 500);
});

test("B_planner_all_four_fresh_zero_scopes", async () => {
  const now = new Date("2026-09-02T10:00:00.000Z");
  const targetDate = new Date("2026-09-01T12:00:00.000Z");
  const cutoff = getExpectedPrimarySyncAt(targetDate);
  assert.equal(cutoff.toISOString(), "2026-09-02T03:20:00.000Z");
  const scopes = await getMarketplaceOrderRecoveryScopes({
    targetDate,
    now,
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => [
        stat("ИП Лебедева", "WB", "2026-09-01", "2026-09-02T03:20:04.000Z"),
        stat("ИП Лебедева", "OZON", "2026-09-01", "2026-09-02T03:20:05.000Z"),
        stat("ИП Петров", "WB", "2026-09-01", "2026-09-02T03:20:10.000Z"),
        stat("ИП Петров", "OZON", "2026-09-01", "2026-09-02T03:20:15.000Z"),
      ],
    },
  });
  assert.equal(scopes.length, 0);
});

test("B_planner_one_stale_existing_row", async () => {
  const scopes = await getMarketplaceOrderRecoveryScopes({
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    now: new Date("2026-09-02T10:00:00.000Z"),
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => [
        stat("ИП Лебедева", "WB", "2026-09-01", "2026-09-02T03:20:04.000Z"),
        stat("ИП Лебедева", "OZON", "2026-09-01", "2026-09-02T00:45:35.000Z"),
        stat("ИП Петров", "WB", "2026-09-01", "2026-09-02T03:20:10.000Z"),
        stat("ИП Петров", "OZON", "2026-09-01", "2026-09-02T03:20:15.000Z"),
      ],
    },
  });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].companyName, "ИП Лебедева");
  assert.equal(scopes[0].marketplace, "OZON");
  assert.equal(scopes[0].reasonCode, "STALE");
});

test("B_planner_one_missing_row", async () => {
  const scopes = await getMarketplaceOrderRecoveryScopes({
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    now: new Date("2026-09-02T10:00:00.000Z"),
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => [
        stat("ИП Лебедева", "WB", "2026-09-01", "2026-09-02T03:20:04.000Z"),
        stat("ИП Петров", "WB", "2026-09-01", "2026-09-02T03:20:10.000Z"),
        stat("ИП Петров", "OZON", "2026-09-01", "2026-09-02T03:20:15.000Z"),
      ],
    },
  });
  assert.equal(scopes.length, 1);
  assert.deepEqual(
    { companyName: scopes[0].companyName, marketplace: scopes[0].marketplace, reasonCode: scopes[0].reasonCode },
    { companyName: "ИП Лебедева", marketplace: "OZON", reasonCode: "MISSING" }
  );
});

test("B_planner_lebedeva_ozon_like_only_that_scope", async () => {
  const scopes = await getMarketplaceOrderRecoveryScopes({
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    now: new Date("2026-09-02T06:45:00.000Z"),
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => [
        stat("ИП Лебедева", "WB", "2026-09-01", "2026-09-02T03:20:04.488Z"),
        stat("ИП Лебедева", "OZON", "2026-09-01", "2026-09-02T00:45:35.909Z"),
        stat("ИП Петров", "WB", "2026-09-01", "2026-09-02T03:20:10.744Z"),
        stat("ИП Петров", "OZON", "2026-09-01", "2026-09-02T03:20:15.765Z"),
      ],
    },
  });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].marketplace, "OZON");
  assert.equal(scopes[0].companyName, "ИП Лебедева");
});

test("B_planner_disabled_not_configured_not_required", async () => {
  const scopes = await getMarketplaceOrderRecoveryScopes({
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    now: new Date("2026-09-02T10:00:00.000Z"),
    deps: {
      listConfiguredScopes: async () => [
        { companyId: "1", companyName: "A", marketplace: "WB", configured: true },
        { companyId: "1", companyName: "A", marketplace: "OZON", configured: false },
      ],
      listExistingStats: async () => [stat("A", "WB", "2026-09-01", "2026-09-02T03:20:04.000Z")],
    },
  });
  assert.equal(scopes.length, 0);
});

test("C_fresh_scopes_do_not_call_transport", async () => {
  const calls: string[] = [];
  const pass = await runMarketplaceOrderRecoveryPass({
    route: "/api/cron/sync-marketplace-orders",
    now: new Date("2026-09-02T10:00:00.000Z"),
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => [
        stat("ИП Лебедева", "WB", "2026-09-01", "2026-09-02T03:20:04.000Z"),
        stat("ИП Лебедева", "OZON", "2026-09-01", "2026-09-02T03:20:05.000Z"),
        stat("ИП Петров", "WB", "2026-09-01", "2026-09-02T03:20:10.000Z"),
        stat("ИП Петров", "OZON", "2026-09-01", "2026-09-02T03:20:15.000Z"),
      ],
    },
    syncFn: async () => {
      calls.push("sync");
      throw new Error("should not sync");
    },
  });
  assert.equal(pass.httpStatus, 200);
  assert.equal(pass.body.recovery.noOp, true);
  assert.deepEqual(calls, []);
});

test("C_stale_scope_calls_only_that_company_marketplace", async () => {
  const calls: string[] = [];
  const result = await syncMarketplaceDailyOrders({
    dateFrom: new Date("2026-09-01T12:00:00.000Z"),
    dateTo: new Date("2026-09-01T12:00:00.000Z"),
    wbDelayMs: 0,
    delayMs: 0,
    scopeFilter: [{ companyName: "ИП Лебедева", marketplace: "OZON", date: "2026-09-01" }],
    getCompanies: async () => [company("ИП Лебедева", "1"), company("ИП Петров", "2")],
    onScopeCall: (scope) => calls.push(`${scope.companyName}:${scope.marketplace}`),
    executeWb: async () => {
      throw new Error("WB should not run");
    },
    executeOzon: async ({ company: c }) => ({
      marketplace: "OZON",
      companyName: c.name,
      date: "2026-09-01",
      skipped: false,
    }),
  });
  assert.deepEqual(calls, ["ИП Лебедева:OZON"]);
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
});

test("C_rerun_after_fresh_upsert_becomes_noop", async () => {
  const stats = [
    stat("ИП Лебедева", "WB", "2026-09-01", "2026-09-02T03:20:04.000Z"),
    stat("ИП Лебедева", "OZON", "2026-09-01", "2026-09-02T00:45:35.000Z"),
    stat("ИП Петров", "WB", "2026-09-01", "2026-09-02T03:20:10.000Z"),
    stat("ИП Петров", "OZON", "2026-09-01", "2026-09-02T03:20:15.000Z"),
  ];
  const first = await runMarketplaceOrderRecoveryPass({
    route: "/test",
    now: new Date("2026-09-02T10:00:00.000Z"),
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => stats,
    },
    syncFn: async () => {
      stats[1] = stat("ИП Лебедева", "OZON", "2026-09-01", "2026-09-02T10:00:01.000Z");
      return fakeSyncResult({ ok: true, retryable: false, results: [{ skipped: false, status: "completed" }] });
    },
  });
  assert.equal(first.body.recovery.noOp, false);
  const second = await runMarketplaceOrderRecoveryPass({
    route: "/test",
    now: new Date("2026-09-02T10:00:02.000Z"),
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => stats,
    },
    syncFn: async () => {
      throw new Error("duplicate sync");
    },
  });
  assert.equal(second.httpStatus, 200);
  assert.equal(second.body.recovery.noOp, true);
});

test("D_scheduled_default_complete_noop_200", async () => {
  const pass = await runMarketplaceOrderRecoveryPass({
    route: "/api/cron/sync-marketplace-orders",
    now: new Date("2026-09-02T03:45:00.000Z"),
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => [
        stat("ИП Лебедева", "WB", "2026-09-01", "2026-09-02T03:20:04.000Z"),
        stat("ИП Лебедева", "OZON", "2026-09-01", "2026-09-02T03:20:05.000Z"),
        stat("ИП Петров", "WB", "2026-09-01", "2026-09-02T03:20:10.000Z"),
        stat("ИП Петров", "OZON", "2026-09-01", "2026-09-02T03:20:15.000Z"),
      ],
    },
    syncFn: async () => {
      throw new Error("no external calls");
    },
  });
  assert.equal(pass.httpStatus, 200);
  assert.equal(pass.body.recovery.noOp, true);
});

test("D_scheduled_one_retryable_stale_only_that_scope_then_503", async () => {
  const pass = await runMarketplaceOrderRecoveryPass({
    route: "/api/cron/sync-marketplace-orders",
    now: new Date("2026-09-02T03:45:00.000Z"),
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => [
        stat("ИП Лебедева", "WB", "2026-09-01", "2026-09-02T03:20:04.000Z"),
        stat("ИП Лебедева", "OZON", "2026-09-01", "2026-09-02T00:45:35.000Z"),
        stat("ИП Петров", "WB", "2026-09-01", "2026-09-02T03:20:10.000Z"),
        stat("ИП Петров", "OZON", "2026-09-01", "2026-09-02T03:20:15.000Z"),
      ],
    },
    syncFn: async (options = {}) => {
      assert.equal(options.scopeFilter?.length, 1);
      assert.equal(options.scopeFilter?.[0].marketplace, "OZON");
      return fakeSyncResult({
        ok: false,
        retryable: true,
        incompleteRequired: [
          {
            companyName: "ИП Лебедева",
            marketplace: "OZON",
            date: "2026-09-01",
            reason: "RATE_LIMIT",
            reasonCode: "RATE_LIMIT",
            status: "skipped",
            retryable: true,
          },
        ],
        results: [{ skipped: true, status: "skipped" }],
        partialSuccess: false,
      });
    },
  });
  assert.equal(pass.httpStatus, 503);
});

test("D_successful_recovery_200", async () => {
  const pass = await runMarketplaceOrderRecoveryPass({
    route: "/api/cron/sync-marketplace-orders",
    now: new Date("2026-09-02T03:45:00.000Z"),
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => [
        stat("ИП Лебедева", "WB", "2026-09-01", "2026-09-02T03:20:04.000Z"),
        stat("ИП Лебедева", "OZON", "2026-09-01", "2026-09-02T00:45:35.000Z"),
        stat("ИП Петров", "WB", "2026-09-01", "2026-09-02T03:20:10.000Z"),
        stat("ИП Петров", "OZON", "2026-09-01", "2026-09-02T03:20:15.000Z"),
      ],
    },
    syncFn: async () => fakeSyncResult({ ok: true, retryable: false, results: [{ skipped: false, status: "completed" }] }),
  });
  assert.equal(pass.httpStatus, 200);
  assert.equal(pass.body.recovery.noOp, false);
});

test("T1_20260902_2010Z_target_sep1_recovery_may_run", async () => {
  const now = new Date("2026-09-02T20:10:00.000Z");
  const targetDate = getYesterdayMoscowDate(now);
  assert.equal(targetDate.toISOString().slice(0, 10), "2026-09-01");
  assert.equal(getExpectedPrimarySyncAt(targetDate).toISOString(), "2026-09-02T03:20:00.000Z");
  assert.equal(isPrimaryOrderSyncDue(targetDate, now), true);
  const calls: string[] = [];
  const pass = await runMarketplaceOrderRecoveryPass({
    route: "/api/cron/daily-data-completeness-retry",
    now,
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => [
        stat("ИП Лебедева", "WB", "2026-09-01", "2026-09-02T03:20:04.000Z"),
        stat("ИП Лебедева", "OZON", "2026-09-01", "2026-09-02T00:45:35.000Z"),
        stat("ИП Петров", "WB", "2026-09-01", "2026-09-02T03:20:10.000Z"),
        stat("ИП Петров", "OZON", "2026-09-01", "2026-09-02T03:20:15.000Z"),
      ],
    },
    syncFn: async (options = {}) => {
      calls.push("sync");
      assert.equal(options.scopeFilter?.length, 1);
      return fakeSyncResult({ ok: true, retryable: false });
    },
  });
  assert.equal(pass.body.recovery.reasonCode, "RECOVERY_COMPLETE");
  assert.deepEqual(calls, ["sync"]);
});

async function assertPrePrimaryNoop(nowIso: string) {
  const now = new Date(nowIso);
  const targetDate = getYesterdayMoscowDate(now);
  assert.equal(targetDate.toISOString().slice(0, 10), "2026-09-02");
  assert.equal(getExpectedPrimarySyncAt(targetDate).toISOString(), "2026-09-03T03:20:00.000Z");
  assert.equal(isPrimaryOrderSyncDue(targetDate, now), false);
  const calls: string[] = [];
  const listed: string[] = [];
  const pass = await runMarketplaceOrderRecoveryPass({
    route: "/api/cron/daily-data-completeness-retry",
    now,
    deps: {
      listConfiguredScopes: async () => {
        listed.push("configured");
        return fourConfigured;
      },
      listExistingStats: async () => {
        listed.push("stats");
        return [stat("ИП Лебедева", "OZON", "2026-09-02", "2026-09-02T18:15:00.000Z")];
      },
    },
    syncFn: async () => {
      calls.push("sync");
      throw new Error("marketplace must not be called before primary");
    },
  });
  assert.equal(pass.httpStatus, 200);
  assert.equal(pass.body.recovery.noOp, true);
  assert.equal(pass.body.recovery.reasonCode, "PRIMARY_SYNC_NOT_DUE");
  assert.deepEqual(calls, []);
  assert.equal(listed.length, 0);
  const scopes = await getMarketplaceOrderRecoveryScopes({
    targetDate,
    now,
    deps: {
      listConfiguredScopes: async () => {
        listed.push("planner-configured");
        return fourConfigured;
      },
      listExistingStats: async () => {
        listed.push("planner-stats");
        return [stat("ИП Лебедева", "OZON", "2026-09-02", "2026-09-02T18:15:00.000Z")];
      },
    },
  });
  assert.equal(scopes.length, 0);
  assert.equal(listed.length, 0);
}

test("T2_20260902_2110Z_moscow_midnight_primary_not_due", async () => {
  await assertPrePrimaryNoop("2026-09-02T21:10:00.000Z");
});

test("T3_20260902_2210Z_primary_not_due", async () => {
  await assertPrePrimaryNoop("2026-09-02T22:10:00.000Z");
});

test("T4_20260902_2310Z_primary_not_due", async () => {
  await assertPrePrimaryNoop("2026-09-02T23:10:00.000Z");
});

test("T5_20260903_031959Z_primary_not_due", async () => {
  await assertPrePrimaryNoop("2026-09-03T03:19:59.000Z");
});

test("T6_20260903_032000Z_cutoff_is_sep3_0320Z", async () => {
  const now = new Date("2026-09-03T03:20:00.000Z");
  const targetDate = new Date("2026-09-02T12:00:00.000Z");
  assert.equal(getYesterdayMoscowDate(now).toISOString().slice(0, 10), "2026-09-02");
  assert.equal(getExpectedPrimarySyncAt(targetDate).toISOString(), "2026-09-03T03:20:00.000Z");
  assert.equal(isPrimaryOrderSyncDue(targetDate, now), true);
  const scopes = await getMarketplaceOrderRecoveryScopes({
    targetDate,
    now,
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => [
        stat("ИП Лебедева", "WB", "2026-09-02", "2026-09-03T03:20:00.000Z"),
        stat("ИП Лебедева", "OZON", "2026-09-02", "2026-09-02T18:15:00.000Z"),
        stat("ИП Петров", "WB", "2026-09-02", "2026-09-03T03:20:01.000Z"),
        stat("ИП Петров", "OZON", "2026-09-02", "2026-09-03T03:20:02.000Z"),
      ],
    },
  });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].companyName, "ИП Лебедева");
  assert.equal(scopes[0].marketplace, "OZON");
  assert.equal(scopes[0].reasonCode, "STALE");
});

test("T7_20260903_0345Z_scheduled_recovery_fresh_vs_stale", async () => {
  const now = new Date("2026-09-03T03:45:00.000Z");
  const targetDate = getYesterdayMoscowDate(now);
  assert.equal(targetDate.toISOString().slice(0, 10), "2026-09-02");
  const scopes = await getMarketplaceOrderRecoveryScopes({
    targetDate,
    now,
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => [
        stat("ИП Лебедева", "WB", "2026-09-02", "2026-09-03T03:20:04.000Z"),
        stat("ИП Лебедева", "OZON", "2026-09-02", "2026-09-02T18:15:00.000Z"),
        stat("ИП Петров", "WB", "2026-09-02", "2026-09-03T03:20:10.000Z"),
        stat("ИП Петров", "OZON", "2026-09-02", "2026-09-03T03:21:00.000Z"),
      ],
    },
  });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].marketplace, "OZON");
  assert.equal(scopes[0].companyName, "ИП Лебедева");
  const calls: string[] = [];
  const pass = await runMarketplaceOrderRecoveryPass({
    route: "/api/cron/sync-marketplace-orders",
    now,
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => [
        stat("ИП Лебедева", "WB", "2026-09-02", "2026-09-03T03:20:04.000Z"),
        stat("ИП Лебедева", "OZON", "2026-09-02", "2026-09-02T18:15:00.000Z"),
        stat("ИП Петров", "WB", "2026-09-02", "2026-09-03T03:20:10.000Z"),
        stat("ИП Петров", "OZON", "2026-09-02", "2026-09-03T03:21:00.000Z"),
      ],
    },
    syncFn: async (options = {}) => {
      calls.push(`${options.scopeFilter?.[0]?.companyName}:${options.scopeFilter?.[0]?.marketplace}`);
      return fakeSyncResult({ ok: true, retryable: false });
    },
  });
  assert.equal(pass.httpStatus, 200);
  assert.equal(pass.body.recovery.noOp, false);
  assert.deepEqual(calls, ["ИП Лебедева:OZON"]);
});

test("T8_intraday_row_at_2110Z_is_not_false_fresh", async () => {
  const now = new Date("2026-09-02T21:10:00.000Z");
  const targetDate = new Date("2026-09-02T12:00:00.000Z");
  const pass = await runMarketplaceOrderRecoveryPass({
    route: "/api/cron/daily-data-completeness-retry",
    now,
    targetDate,
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => [
        stat("ИП Лебедева", "WB", "2026-09-02", "2026-09-02T18:15:00.000Z"),
        stat("ИП Лебедева", "OZON", "2026-09-02", "2026-09-02T18:15:00.000Z"),
        stat("ИП Петров", "WB", "2026-09-02", "2026-09-02T18:15:00.000Z"),
        stat("ИП Петров", "OZON", "2026-09-02", "2026-09-02T18:15:00.000Z"),
      ],
    },
    syncFn: async () => {
      throw new Error("intraday row must not authorize recovery or false-fresh skip via sync");
    },
  });
  assert.equal(pass.httpStatus, 200);
  assert.equal(pass.body.recovery.reasonCode, "PRIMARY_SYNC_NOT_DUE");
  assert.notEqual(pass.body.recovery.reasonCode, "ALL_REQUIRED_SCOPES_FRESH");
  const scopes = await getMarketplaceOrderRecoveryScopes({
    targetDate,
    now,
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => [stat("ИП Лебедева", "OZON", "2026-09-02", "2026-09-02T18:15:00.000Z")],
    },
  });
  assert.equal(scopes.length, 0);
});

test("E_completeness_route_exists_and_auth", async () => {
  // Current Docker keeps the evolved completeness watchdog (not the Sep-2 orders-only thin route).
  // Orders bounded recovery lives on sync-marketplace-orders; completeness may still heal via priority sync.
  const routePath = path.join(root, "app/api/cron/daily-data-completeness-retry/route.ts");
  assert.equal(fs.existsSync(routePath), true);
  const text = read("app/api/cron/daily-data-completeness-retry/route.ts");
  assert.equal(text.includes("rejectUnauthorizedCron"), true);
  assert.match(text, /export const maxDuration = \d+/);
  assert.equal(text.includes("Stage 1B"), false);
  process.env.CRON_SECRET = "test-secret";
  const denied = await completenessGET(new Request("http://127.0.0.1/api/cron/daily-data-completeness-retry"));
  assert.equal(denied.status, 401);
});

test("E_completeness_stale_retryable_503_and_terminal_500", async () => {
  const staleDeps = {
    listConfiguredScopes: async () => fourConfigured,
    listExistingStats: async () => [
      stat("ИП Лебедева", "WB", "2026-09-01", "2026-09-02T03:20:04.000Z"),
      stat("ИП Лебедева", "OZON", "2026-09-01", "2026-09-02T00:45:35.000Z"),
      stat("ИП Петров", "WB", "2026-09-01", "2026-09-02T03:20:10.000Z"),
      stat("ИП Петров", "OZON", "2026-09-01", "2026-09-02T03:20:15.000Z"),
    ],
  };
  const retryable = await runMarketplaceOrderRecoveryPass({
    route: "/api/cron/daily-data-completeness-retry",
    now: new Date("2026-09-02T05:10:00.000Z"),
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    deps: staleDeps,
    syncFn: async () =>
      fakeSyncResult({
        ok: false,
        retryable: true,
        incompleteRequired: [
          {
            companyName: "ИП Лебедева",
            marketplace: "OZON",
            date: "2026-09-01",
            reason: "RATE_LIMIT",
            reasonCode: "RATE_LIMIT",
            status: "skipped",
            retryable: true,
          },
        ],
        results: [{ skipped: true, status: "skipped" }],
        partialSuccess: false,
      }),
  });
  assert.equal(retryable.httpStatus, 503);
  const terminal = await runMarketplaceOrderRecoveryPass({
    route: "/api/cron/daily-data-completeness-retry",
    now: new Date("2026-09-02T05:10:00.000Z"),
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    deps: staleDeps,
    syncFn: async () =>
      fakeSyncResult({
        ok: false,
        retryable: false,
        incompleteRequired: [
          {
            companyName: "ИП Лебедева",
            marketplace: "OZON",
            date: "2026-09-01",
            reason: "UPSTREAM_ERROR",
            reasonCode: "UPSTREAM_ERROR",
            status: "failed",
            retryable: false,
          },
        ],
        results: [{ skipped: true, status: "failed" }],
        partialSuccess: false,
      }),
  });
  assert.equal(terminal.httpStatus, 500);
});

test("F_daily_priority_contract_and_safe_event", () => {
  const route = read("app/api/cron/daily-priority-sync/route.ts");
  assert.equal(route.includes("ok: failedResults.length === 0"), true);
  assert.equal(route.includes("PRIMARY_INCOMPLETE_RECOVERY_EXPECTED"), true);
  assert.equal(route.includes('rejectUnauthorizedCron'), true);
  const lines = captureLogLines(() => {
    logMarketplaceOrdersEvent({
      runId: "mos-test",
      route: "/api/cron/daily-priority-sync",
      phase: "order_stats",
      status: "retryable_incomplete",
      retryable: true,
      recoveryPlanned: true,
      reasonCode: "PRIMARY_INCOMPLETE_RECOVERY_EXPECTED",
      incompleteCount: 1,
    });
  });
  const blob = lines.join("");
  assert.equal(blob.includes("avorofin_marketplace_orders_sync"), true);
  assert.equal(blob.includes("CRON_SECRET"), false);
  assert.equal(blob.includes("Bearer"), false);
});

test("G_schedule_integrity", () => {
  const vercel = JSON.parse(read("vercel.json")) as { crons: { path: string; schedule: string }[] };
  const orders = vercel.crons.find((c) => c.path === "/api/cron/sync-marketplace-orders");
  const primary = vercel.crons.find((c) => c.path === "/api/cron/daily-priority-sync");
  const hourly = vercel.crons.find((c) => c.path === "/api/cron/daily-data-completeness-retry");
  assert.equal(primary?.schedule, "20 3 * * *");
  assert.equal(orders?.schedule, "45 3 * * *");
  assert.equal(hourly?.schedule, "10 5-23 * * *");
  assert.equal(fs.existsSync(path.join(root, "app/api/cron/daily-data-completeness-retry/route.ts")), true);
  assert.equal(fs.existsSync(path.join(root, "app/api/cron/sync-marketplace-orders/route.ts")), true);
});

test("H_logs_and_orders_route_do_not_mention_secrets", () => {
  const ordersRoute = read("app/api/cron/sync-marketplace-orders/route.ts");
  assert.equal(ordersRoute.includes("completeness"), false);
  const logSrc = read("lib/marketplaceOrders/orderSyncLog.ts");
  assert.equal(logSrc.includes("captureLogLines"), false);
  const recoveryPass = read("lib/marketplaceOrders/runOrderRecoveryPass.ts");
  assert.equal(recoveryPass.includes("recoveryScopesToFilter"), false);
  for (const text of [ordersRoute, logSrc, recoveryPass]) {
    assert.equal(text.includes("CRON_SECRET"), false);
    assert.equal(/wbToken/.test(text), false);
    assert.equal(/ozonApiKey/.test(text), false);
  }
});

test("I_financial_core_formulas_untouched_and_v4_schema_marker", () => {
  const ordersRoute = read("app/api/cron/sync-marketplace-orders/route.ts");
  const planner = read("lib/marketplaceOrders/orderRecoveryPlanner.ts");
  for (const text of [ordersRoute, planner]) {
    assert.equal(text.includes("financial-core/v6"), false);
    assert.equal(text.includes("calculateTaxesAmount"), false);
  }
  const schema = read("prisma/schema.prisma");
  assert.equal(schema.includes("model MarketplaceDailyOrderStat"), true);
  assert.match(schema, /updatedAt DateTime @updatedAt/);
  assert.match(schema, /lastSuccessfulSyncAt DateTime\? @db\.Timestamptz\(6\)/);
  assert.equal(schema.includes("@updatedAt on lastSuccessfulSyncAt"), false);
  assert.match(schema, /@@unique\(\[companyName, marketplace, orderDate\]\)/);
});

test("orders_GET_unauthorized_401", async () => {
  process.env.CRON_SECRET = "test-secret";
  const res = await ordersGET(new Request("http://127.0.0.1/api/cron/sync-marketplace-orders"));
  assert.equal(res.status, 401);
});

test("V4_cutoff_unchanged_next_calendar_day_0320Z", () => {
  const targetDate = new Date("2026-09-01T12:00:00.000Z");
  assert.equal(getExpectedPrimarySyncAt(targetDate).toISOString(), "2026-09-02T03:20:00.000Z");
  assert.equal(PRIMARY_ORDER_SYNC_UTC_HOUR, 3);
  assert.equal(PRIMARY_ORDER_SYNC_UTC_MINUTE, 20);
});

test("V4_pre_primary_null_markers_PRIMARY_SYNC_NOT_DUE_attempted_0", async () => {
  const now = new Date("2026-09-03T03:19:59.000Z");
  const targetDate = getYesterdayMoscowDate(now);
  assert.equal(targetDate.toISOString().slice(0, 10), "2026-09-02");
  const listed: string[] = [];
  const calls: string[] = [];
  const pass = await runMarketplaceOrderRecoveryPass({
    route: "/api/cron/daily-data-completeness-retry",
    now,
    deps: {
      listConfiguredScopes: async () => {
        listed.push("configured");
        return fourConfigured;
      },
      listExistingStats: async () => {
        listed.push("stats");
        return fourConfigured.map((scope) => stat(scope.companyName, scope.marketplace, "2026-09-02", null));
      },
    },
    syncFn: async () => {
      calls.push("sync");
      throw new Error("null markers must not recover before primary");
    },
  });
  assert.equal(pass.httpStatus, 200);
  assert.equal(pass.body.recovery.noOp, true);
  assert.equal(pass.body.recovery.reasonCode, "PRIMARY_SYNC_NOT_DUE");
  assert.equal(pass.body.recovery.attempted, 0);
  assert.deepEqual(calls, []);
  assert.equal(listed.length, 0);
});

test("V4_post_primary_missing_row_MISSING", async () => {
  const scopes = await getMarketplaceOrderRecoveryScopes({
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    now: new Date("2026-09-02T10:00:00.000Z"),
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => [
        stat("ИП Лебедева", "WB", "2026-09-01", "2026-09-02T03:20:04.000Z"),
        stat("ИП Петров", "WB", "2026-09-01", "2026-09-02T03:20:10.000Z"),
        stat("ИП Петров", "OZON", "2026-09-01", "2026-09-02T03:20:15.000Z"),
      ],
    },
  });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].reasonCode, "MISSING");
  assert.equal(scopes[0].companyName, "ИП Лебедева");
  assert.equal(scopes[0].marketplace, "OZON");
});

test("V4_post_primary_null_marker_STALE", async () => {
  const scopes = await getMarketplaceOrderRecoveryScopes({
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    now: new Date("2026-09-02T10:00:00.000Z"),
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => [
        stat("ИП Лебедева", "WB", "2026-09-01", "2026-09-02T03:20:04.000Z"),
        stat("ИП Лебедева", "OZON", "2026-09-01", null),
        stat("ИП Петров", "WB", "2026-09-01", "2026-09-02T03:20:10.000Z"),
        stat("ИП Петров", "OZON", "2026-09-01", "2026-09-02T03:20:15.000Z"),
      ],
    },
  });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].reasonCode, "STALE");
  assert.equal(scopes[0].companyName, "ИП Лебедева");
  assert.equal(scopes[0].marketplace, "OZON");
});

test("V4_marker_1ms_before_cutoff_STALE", async () => {
  const scopes = await getMarketplaceOrderRecoveryScopes({
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    now: new Date("2026-09-02T10:00:00.000Z"),
    deps: {
      listConfiguredScopes: async () => [
        { companyId: "1", companyName: "A", marketplace: "WB", configured: true },
      ],
      listExistingStats: async () => [stat("A", "WB", "2026-09-01", "2026-09-02T03:19:59.999Z")],
    },
  });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].reasonCode, "STALE");
});

test("V4_marker_exactly_cutoff_FRESH", async () => {
  const scopes = await getMarketplaceOrderRecoveryScopes({
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    now: new Date("2026-09-02T10:00:00.000Z"),
    deps: {
      listConfiguredScopes: async () => [
        { companyId: "1", companyName: "A", marketplace: "WB", configured: true },
      ],
      listExistingStats: async () => [stat("A", "WB", "2026-09-01", "2026-09-02T03:20:00.000Z")],
    },
  });
  assert.equal(scopes.length, 0);
});

test("V4_marker_after_cutoff_FRESH", async () => {
  const scopes = await getMarketplaceOrderRecoveryScopes({
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    now: new Date("2026-09-02T10:00:00.000Z"),
    deps: {
      listConfiguredScopes: async () => [
        { companyId: "1", companyName: "A", marketplace: "OZON", configured: true },
      ],
      listExistingStats: async () => [stat("A", "OZON", "2026-09-01", "2026-09-02T03:20:04.488Z")],
    },
  });
  assert.equal(scopes.length, 0);
});

test("V4_mixed_legacy_updatedAt_moscow_naive_does_not_affect_classification", async () => {
  const scopes = await getMarketplaceOrderRecoveryScopes({
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    now: new Date("2026-09-02T10:00:00.000Z"),
    deps: {
      listConfiguredScopes: async () => [
        { companyId: "1", companyName: "ИП Лебедева", marketplace: "WB", configured: true },
      ],
      listExistingStats: async () => [
        statWithLegacyUpdatedAt(
          "ИП Лебедева",
          "WB",
          "2026-09-01",
          "2026-09-02T03:20:04.488Z",
          "2026-09-02T06:20:04.488Z"
        ),
      ],
    },
  });
  assert.equal(scopes.length, 0);
});

test("V4_mixed_legacy_updatedAt_utc_naive_does_not_affect_classification", async () => {
  const scopes = await getMarketplaceOrderRecoveryScopes({
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    now: new Date("2026-09-02T10:00:00.000Z"),
    deps: {
      listConfiguredScopes: async () => [
        { companyId: "1", companyName: "ИП Лебедева", marketplace: "OZON", configured: true },
      ],
      listExistingStats: async () => [
        statWithLegacyUpdatedAt(
          "ИП Лебедева",
          "OZON",
          "2026-09-01",
          null,
          "2026-09-02T15:11:28.041Z"
        ),
      ],
    },
  });
  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].reasonCode, "STALE");
});

test("V4_no_v3_moscow_sql_in_recovery_runtime", () => {
  const planner = read("lib/marketplaceOrders/orderRecoveryPlanner.ts");
  const recoveryPass = read("lib/marketplaceOrders/runOrderRecoveryPass.ts");
  for (const text of [planner, recoveryPass]) {
    assert.equal(text.includes("AT TIME ZONE"), false);
    assert.equal(text.includes("Europe/Moscow"), false);
    assert.equal(text.includes("utcInstantFromMoscowWallClockText"), false);
    assert.equal(text.includes("MARKETPLACE_ORDER_STAT_UPDATED_AT_TIMEZONE"), false);
  }
  assert.equal(planner.includes("updatedAt.getTime"), false);
  assert.match(planner, /lastSuccessfulSyncAt/);
});

test("V4_successful_wb_and_ozon_upsert_sets_marker_atomically", () => {
  const upsert = upsertFnSource();
  assert.match(upsert, /const successfulSyncAt = new Date\(\);/);
  assert.equal((upsert.match(/prisma\.marketplaceDailyOrderStat\.upsert/g) || []).length, 1);
  assert.equal(upsert.includes("marketplaceDailyOrderStat.update("), false);
  assert.match(upsert, /create:\s*\{[\s\S]*lastSuccessfulSyncAt:\s*successfulSyncAt/);
  assert.match(upsert, /update:\s*\{[\s\S]*lastSuccessfulSyncAt:\s*successfulSyncAt/);
  assert.equal(upsert.includes("updatedAt:"), false);
  const wb = namedFnSource("syncWbDailyOrdersForCompany");
  assert.ok(wb.indexOf("await fetchWbOrdersForDate") < wb.indexOf("await upsertDailyOrderStat"));
  assert.ok(wb.indexOf("WB token is not configured") < wb.indexOf("await upsertDailyOrderStat"));
  const ozon = namedFnSource("syncOzonDailyOrdersForCompany");
  assert.ok(ozon.indexOf("await fetchOzonOrdersForDate") < ozon.indexOf("await upsertDailyOrderStat"));
  assert.ok(ozon.indexOf("Ozon Client-Id or Api-Key is not configured") < ozon.indexOf("await upsertDailyOrderStat"));
});

test("V4_failed_skipped_rate_limited_scopes_do_not_advance_marker", () => {
  const src = read("lib/marketplaceOrders/syncMarketplaceDailyOrders.ts");
  const safeWb = src.slice(
    src.indexOf("async function safeSyncWbDailyOrdersForCompany"),
    src.indexOf("async function safeSyncOzonDailyOrdersForCompany")
  );
  const safeOzon = src.slice(
    src.indexOf("async function safeSyncOzonDailyOrdersForCompany"),
    src.indexOf("export async function syncMarketplaceDailyOrders")
  );
  assert.equal(safeWb.includes("upsertDailyOrderStat"), false);
  assert.equal(safeOzon.includes("upsertDailyOrderStat"), false);
  assert.match(safeWb, /catch \(error\)/);
  assert.match(safeOzon, /catch \(error\)/);
  assert.match(safeWb, /isRateLimit:/);
  assert.match(safeOzon, /isRateLimit:/);
  const wb = namedFnSource("syncWbDailyOrdersForCompany");
  const ozon = namedFnSource("syncOzonDailyOrdersForCompany");
  assert.match(wb, /skipped:\s*true/);
  assert.match(ozon, /skipped:\s*true/);
  const upsertIdxWb = wb.indexOf("await upsertDailyOrderStat");
  const skipReturnWb = wb.indexOf("skipped: true");
  assert.ok(skipReturnWb >= 0 && skipReturnWb < upsertIdxWb);
  const upsertIdxOzon = ozon.indexOf("await upsertDailyOrderStat");
  const skipReturnOzon = ozon.indexOf("skipped: true");
  assert.ok(skipReturnOzon >= 0 && skipReturnOzon < upsertIdxOzon);
});

test("V4_successful_recovery_marker_makes_next_planner_pass_noop", async () => {
  const stats = [
    stat("ИП Лебедева", "WB", "2026-09-01", "2026-09-02T03:20:04.000Z"),
    stat("ИП Лебедева", "OZON", "2026-09-01", null),
    stat("ИП Петров", "WB", "2026-09-01", "2026-09-02T03:20:10.000Z"),
    stat("ИП Петров", "OZON", "2026-09-01", "2026-09-02T03:20:15.000Z"),
  ];
  const first = await runMarketplaceOrderRecoveryPass({
    route: "/test",
    now: new Date("2026-09-02T10:00:00.000Z"),
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => stats,
    },
    syncFn: async (options = {}) => {
      assert.equal(options.scopeFilter?.length, 1);
      assert.equal(options.scopeFilter?.[0].marketplace, "OZON");
      stats[1] = stat("ИП Лебедева", "OZON", "2026-09-01", "2026-09-02T10:00:01.000Z");
      return fakeSyncResult({ ok: true, retryable: false, results: [{ skipped: false, status: "completed" }] });
    },
  });
  assert.equal(first.body.recovery.noOp, false);
  const second = await runMarketplaceOrderRecoveryPass({
    route: "/test",
    now: new Date("2026-09-02T10:00:02.000Z"),
    targetDate: new Date("2026-09-01T12:00:00.000Z"),
    deps: {
      listConfiguredScopes: async () => fourConfigured,
      listExistingStats: async () => stats,
    },
    syncFn: async () => {
      throw new Error("duplicate sync");
    },
  });
  assert.equal(second.httpStatus, 200);
  assert.equal(second.body.recovery.noOp, true);
});

test("V4_unique_idempotency_and_manual_full_sync_unchanged", () => {
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /@@unique\(\[companyName, marketplace, orderDate\]\)/);
  const upsert = upsertFnSource();
  assert.match(upsert, /companyName_marketplace_orderDate/);
  const ordersRoute = read("app/api/cron/sync-marketplace-orders/route.ts");
  assert.match(ordersRoute, /url\.searchParams\.get\("date"\)/);
  assert.match(ordersRoute, /url\.searchParams\.get\("from"\)/);
  assert.match(ordersRoute, /url\.searchParams\.get\("to"\)/);
  assert.match(ordersRoute, /reasonCode: "MANUAL"/);
  assert.match(ordersRoute, /isScheduledDefault/);
  const migration = read(
    "prisma/migrations/20260902210000_add_marketplace_order_last_successful_sync/migration.sql"
  );
  assert.match(migration, /ADD COLUMN "lastSuccessfulSyncAt" TIMESTAMPTZ\(6\);/);
  assert.equal(/UPDATE\s/i.test(migration), false);
  assert.equal(/DROP\s/i.test(migration), false);
  assert.equal(/DELETE\s/i.test(migration), false);
  assert.equal(/CREATE INDEX/i.test(migration), false);
});
