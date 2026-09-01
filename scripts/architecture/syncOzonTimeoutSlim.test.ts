import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  resolveSyncOzonAllMode,
  runSyncOzonAllSequence,
  SYNC_OZON_ALL_FULL,
  SYNC_OZON_ALL_SCHEDULED,
} from "../../lib/ozon/syncOzonAllSequence";
import {
  fromSyncOzonAllResult,
  historicalSyncSkipResult,
  mapCompaniesSequentially,
  rateLimitCooldownSkipResult,
  summarizeOzonCronResults,
} from "../../lib/ozon/syncOzonCronContract";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relPath: string) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

function recordingHooks(calls: string[], adsImpl?: () => Promise<unknown>) {
  return {
    finance: async (companyId: string) => {
      calls.push(`finance:${companyId}`);
      return { name: "finance" };
    },
    products: async (companyId: string) => {
      calls.push(`products:${companyId}`);
      return { name: "products" };
    },
    stocks: async (companyId: string) => {
      calls.push(`stocks:${companyId}`);
      return { name: "stocks" };
    },
    ads: async (companyId: string) => {
      calls.push(`ads:${companyId}`);
      if (adsImpl) return adsImpl();
      return { name: "ads" };
    },
    setConnected: async (companyId: string) => {
      calls.push(`connected:${companyId}`);
    },
    setError: async (companyId: string, error: unknown) => {
      calls.push(`error:${companyId}:${String(error)}`);
    },
  };
}

test("CASE_A_SCHEDULED_CRON_MODE_DOES_NOT_RUN_ADS", async () => {
  const calls: string[] = [];
  const result = await runSyncOzonAllSequence(
    "company-1",
    { mode: "scheduled" },
    recordingHooks(calls)
  );

  assert.deepEqual(calls, [
    "finance:company-1",
    "products:company-1",
    "stocks:company-1",
    "connected:company-1",
  ]);
  assert.equal(calls.filter((item) => item.startsWith("ads:")).length, 0);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "scheduled");
  assert.deepEqual(result.ownedDomains, ["finance", "products", "stocks"]);
  assert.deepEqual(result.deferredDomains, ["ads"]);

  const route = read("app/api/cron/sync-ozon/route.ts");
  assert.equal(route.includes('mode: "scheduled"'), true);
  assert.equal(route.includes("waitForReport"), false);
  assert.equal(route.includes("syncOzonAds"), false);
});

test("CASE_B_MANUAL_FULL_DEFAULT_STILL_RUNS_ADS", async () => {
  const calls: string[] = [];
  const result = await runSyncOzonAllSequence(
    "company-1",
    {},
    recordingHooks(calls)
  );

  assert.deepEqual(calls, [
    "finance:company-1",
    "products:company-1",
    "stocks:company-1",
    "ads:company-1",
    "connected:company-1",
  ]);
  assert.equal(result.mode, "full");
  assert.deepEqual(result.ownedDomains, ["finance", "products", "stocks", "ads"]);
  assert.deepEqual(result.deferredDomains, []);
  assert.deepEqual(resolveSyncOzonAllMode().includeAds, true);
  assert.equal(SYNC_OZON_ALL_FULL.includeAds, true);
});

test("CASE_C_ADS_WAIT_CANNOT_CONSUME_SCHEDULED_CRON", async () => {
  const calls: string[] = [];
  let adsEntered = false;
  const neverReadyAds = async () => {
    adsEntered = true;
    throw new Error("waitForReport would hang");
  };

  const result = await runSyncOzonAllSequence(
    "company-1",
    { mode: "scheduled" },
    recordingHooks(calls, neverReadyAds)
  );

  assert.equal(adsEntered, false);
  assert.equal(calls.filter((item) => item.startsWith("ads:")).length, 0);
  assert.equal(result.ok, true);
  assert.deepEqual(result.deferredDomains, ["ads"]);
});

test("CASE_D_TWO_COMPANIES_REMAIN_SEQUENTIAL", async () => {
  const order: string[] = [];
  const results = await mapCompaniesSequentially(
    ["company-a", "company-b"],
    async (companyId) => {
      order.push(`start:${companyId}`);
      await Promise.resolve();
      order.push(`end:${companyId}`);
      return companyId;
    }
  );

  assert.deepEqual(results, ["company-a", "company-b"]);
  assert.deepEqual(order, [
    "start:company-a",
    "end:company-a",
    "start:company-b",
    "end:company-b",
  ]);

  const route = read("app/api/cron/sync-ozon/route.ts");
  assert.equal(route.includes("Promise.all"), false);
  assert.equal(route.includes("mapCompaniesSequentially"), true);
});

test("CASE_E_SCHEDULED_OWNED_STEP_FAILS_HTTP_CONTRACT", async () => {
  const calls: string[] = [];
  const hooks = recordingHooks(calls);
  hooks.products = async () => {
    calls.push("products:fail");
    throw new Error("Ozon products request failed");
  };

  const result = await runSyncOzonAllSequence(
    "company-1",
    { mode: "scheduled" },
    hooks
  );
  const classified = fromSyncOzonAllResult("company-1", result);
  const contract = summarizeOzonCronResults([classified]);

  assert.equal(result.ok, false);
  assert.equal(calls.filter((item) => item.startsWith("ads:")).length, 0);
  assert.equal(classified.status, "failed");
  assert.equal(contract.success, false);
  assert.equal(contract.httpStatus, 500);

  const retryable = fromSyncOzonAllResult("company-2", {
    ok: false,
    error: "429 rate limit",
    mode: "scheduled",
    deferredDomains: ["ads"],
  });
  assert.equal(summarizeOzonCronResults([retryable]).httpStatus, 503);
});

test("CASE_F_HISTORICAL_COOLDOWN_SKIP_UNCHANGED", () => {
  const historical = historicalSyncSkipResult("company-petrov", 1);
  const cooldown = rateLimitCooldownSkipResult("company-other");
  const contract = summarizeOzonCronResults([historical, cooldown]);

  assert.equal(historical.status, "skipped");
  assert.equal(cooldown.retryable, true);
  assert.equal(contract.success, false);
  assert.equal(contract.httpStatus, 503);
  assert.equal(SYNC_OZON_ALL_SCHEDULED.deferredDomains[0], "ads");
});

test("CASE_G_FULL_MANUAL_BEHAVIOR_STILL_INCLUDES_ADS", async () => {
  const withoutOption = resolveSyncOzonAllMode();
  const explicitFull = resolveSyncOzonAllMode({ mode: "full" });
  const scheduled = resolveSyncOzonAllMode({ mode: "scheduled" });

  assert.equal(withoutOption.includeAds, true);
  assert.equal(explicitFull.includeAds, true);
  assert.equal(scheduled.includeAds, false);

  const manualRoute = read("app/api/settings/api-connections/sync-ozon-all/route.ts");
  assert.equal(manualRoute.includes("syncOzonAll(companyId)"), true);
  assert.equal(manualRoute.includes('mode: "scheduled"'), false);

  const syncOzon = read("lib/ozon/syncOzon.ts");
  assert.match(syncOzon, /export async function syncOzonAll\(/);
  assert.equal(syncOzon.includes("runSyncOzonAllSequence(companyId, options"), true);
});

test("CASE_H_SAFETY_NO_CORE_PRISMA_TELEGRAM", () => {
  const sequence = read("lib/ozon/syncOzonAllSequence.ts");
  const route = read("app/api/cron/sync-ozon/route.ts");
  const contract = read("lib/ozon/syncOzonCronContract.ts");

  for (const text of [sequence, route, contract]) {
    assert.equal(text.includes("financial-core/v6"), false);
    assert.equal(text.includes("prisma/schema.prisma"), false);
    assert.equal(text.includes("lib/telegram/dailyReport"), false);
    assert.equal(text.includes("calculateTaxesAmount"), false);
  }
});
