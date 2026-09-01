import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyMarketplaceOrderRow,
  marketplaceOrdersHttpStatus,
  summarizeMarketplaceOrderRows,
} from "../../lib/marketplaceOrders/syncMarketplaceDailyOrders";
import {
  fromSyncOzonAllResult,
  fromSyncOzonThrownError,
  historicalSyncSkipResult,
  rateLimitCooldownSkipResult,
  summarizeOzonCronResults,
} from "../../lib/ozon/syncOzonCronContract";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relPath: string) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

test("CASE_A_ORDERS_ALL_COMPLETE_HTTP_200", () => {
  const summary = summarizeMarketplaceOrderRows([
    {
      marketplace: "WB",
      companyName: "ИП Петров",
      date: "2026-08-31",
      skipped: false,
    },
    {
      marketplace: "OZON",
      companyName: "ИП Петров",
      date: "2026-08-31",
      skipped: false,
    },
    {
      marketplace: "OZON",
      companyName: "ИП без Ozon",
      date: "2026-08-31",
      skipped: true,
      reason: "Ozon Client-Id or Api-Key is not configured",
    },
  ]);

  assert.equal(summary.ok, true);
  assert.equal(summary.retryable, false);
  assert.equal(marketplaceOrdersHttpStatus(summary), 200);
  assert.equal(summary.incompleteRequired.length, 0);
  assert.equal(
    classifyMarketplaceOrderRow({
      skipped: true,
      reason: "Ozon Client-Id or Api-Key is not configured",
    }).status,
    "not_configured"
  );
});

test("CASE_B_ORDERS_ONE_OZON_RATE_LIMIT_HTTP_503", () => {
  const summary = summarizeMarketplaceOrderRows([
    {
      marketplace: "WB",
      companyName: "ИП Петров",
      date: "2026-08-31",
      skipped: false,
    },
    {
      marketplace: "OZON",
      companyName: "ИП Успех",
      date: "2026-08-31",
      skipped: false,
    },
    {
      marketplace: "OZON",
      companyName: "ИП Петров",
      date: "2026-08-31",
      skipped: true,
      reason: "Ozon Analytics API: 429 rate limit",
      isRateLimit: true,
    },
  ]);

  assert.equal(summary.ok, false);
  assert.equal(summary.retryable, true);
  assert.equal(marketplaceOrdersHttpStatus(summary), 503);
  assert.equal(summary.annotated.some((row) => row.companyName === "ИП Успех"), true);
  assert.equal(
    summary.incompleteRequired.some(
      (row) => row.companyName === "ИП Петров" && row.marketplace === "OZON"
    ),
    true
  );
  const ordersRoute = read("app/api/cron/sync-marketplace-orders/route.ts");
  assert.equal(ordersRoute.includes("completeness"), false);
  assert.equal(ordersRoute.includes("runInternalCron"), false);
  assert.equal(ordersRoute.includes("marketplaceOrdersHttpStatus(result)"), true);
});

test("CASE_C_ORDERS_INTERNAL_ERROR_HTTP_500", () => {
  const summary = summarizeMarketplaceOrderRows([
    {
      marketplace: "OZON",
      companyName: "ИП Петров",
      date: "2026-08-31",
      skipped: true,
      reason: "Ozon Analytics API: 500 internal",
      isRateLimit: false,
    },
  ]);

  assert.equal(summary.ok, false);
  assert.equal(summary.retryable, false);
  assert.equal(marketplaceOrdersHttpStatus(summary), 500);
});

test("CASE_D_SYNC_OZON_ALL_COMPLETE_HTTP_200", () => {
  const completed = fromSyncOzonAllResult("company-1", {
    ok: true,
    results: [{ step: "finance" }],
  });
  const contract = summarizeOzonCronResults([completed]);

  assert.equal(completed.ok, true);
  assert.equal(completed.status, "completed");
  assert.equal(contract.success, true);
  assert.equal(contract.httpStatus, 200);
});

test("CASE_E_SYNC_OZON_HISTORICAL_OR_COOLDOWN_SKIP_HTTP_503", () => {
  const historical = historicalSyncSkipResult("company-petrov", 2);
  const cooldown = rateLimitCooldownSkipResult("company-other");
  const completed = fromSyncOzonAllResult("company-ok", { ok: true, results: [] });

  assert.equal(historical.ok, false);
  assert.equal(historical.skipped, true);
  assert.equal(historical.status, "skipped");
  assert.equal(historical.retryable, true);
  assert.equal(historical.reason, "OZON_HISTORICAL_SYNC_ACTIVE");

  const historicalContract = summarizeOzonCronResults([completed, historical]);
  assert.equal(historicalContract.success, false);
  assert.equal(historicalContract.httpStatus, 503);
  assert.equal(historicalContract.retryable, true);
  assert.equal(historicalContract.skippedCompanies, 1);
  assert.equal(
    [completed, historical].some((row) => row.status === "completed"),
    true
  );

  const cooldownContract = summarizeOzonCronResults([cooldown]);
  assert.equal(cooldown.reason, "OZON_RATE_LIMIT_COOLDOWN");
  assert.equal(cooldownContract.success, false);
  assert.equal(cooldownContract.httpStatus, 503);
});

test("CASE_F_SYNC_OZON_FAILED_SUBSYNC", () => {
  const failed = fromSyncOzonAllResult("company-1", {
    ok: false,
    results: [{ step: "finance" }],
    error: "Ozon finance request failed",
  });
  const rateLimited = fromSyncOzonThrownError(
    "company-2",
    new Error("Ozon API 429 too many requests")
  );

  assert.equal(failed.ok, false);
  assert.equal(failed.status, "failed");
  assert.equal(failed.retryable, false);
  assert.equal(summarizeOzonCronResults([failed]).httpStatus, 500);
  assert.equal(summarizeOzonCronResults([failed]).success, false);

  assert.equal(rateLimited.status, "failed");
  assert.equal(rateLimited.retryable, true);
  assert.equal(summarizeOzonCronResults([rateLimited]).httpStatus, 503);

  const ozonRoute = read("app/api/cron/sync-ozon/route.ts");
  assert.equal(ozonRoute.includes("summarizeOzonCronResults"), true);
  assert.equal(ozonRoute.includes("status: contract.httpStatus"), true);
  assert.equal(ozonRoute.includes("syncOzonFinance("), false);
  assert.equal(ozonRoute.includes("waitForReport"), false);
});

test("CASE_G_NO_PROTECTED_CORE_OR_PRISMA_IN_THIS_PATCH_SURFACE", () => {
  const ordersRoute = read("app/api/cron/sync-marketplace-orders/route.ts");
  const ozonRoute = read("app/api/cron/sync-ozon/route.ts");
  const contract = read("lib/ozon/syncOzonCronContract.ts");
  const ordersLib = read("lib/marketplaceOrders/syncMarketplaceDailyOrders.ts");

  for (const text of [ordersRoute, ozonRoute, contract, ordersLib]) {
    assert.equal(text.includes("financial-core/v6"), false);
    assert.equal(text.includes("prisma/schema.prisma"), false);
    assert.equal(text.includes("calculateTaxesAmount"), false);
  }

  assert.equal(ordersRoute.includes("NextResponse.json(result, {"), true);
  assert.match(ozonRoute, /status:\s*contract\.httpStatus/);
});
