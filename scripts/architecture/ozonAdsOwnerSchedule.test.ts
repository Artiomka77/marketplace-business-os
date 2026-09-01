import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const v2Root = "C:\\Users\\artio\\Downloads\\AVOROFIN_TELEGRAM_OZON_RC_V2_20260901";

function read(relPath: string, base = root) {
  return fs.readFileSync(path.join(base, relPath), "utf8");
}

type CronEntry = { path: string; schedule: string };

function cronEntries(vercelText: string): CronEntry[] {
  const parsed = JSON.parse(vercelText) as { crons: CronEntry[] };
  return parsed.crons;
}

test("CASE_A_ROUTE_EXISTS_AND_BOUNDED", () => {
  const routePath = path.join(root, "app/api/cron/retry-ozon-report-ads/route.ts");
  assert.equal(fs.existsSync(routePath), true);
  const route = read("app/api/cron/retry-ozon-report-ads/route.ts");
  assert.match(route, /export const maxDuration = 60/);
  assert.equal(route.includes("rejectUnauthorizedCron"), true);
  assert.equal(route.includes("retryMissingOzonReportAds"), true);
});

test("CASE_B_EXACT_CRON_ENTRY", () => {
  const entries = cronEntries(read("vercel.json"));
  const ads = entries.filter(
    (entry) => entry.path === "/api/cron/retry-ozon-report-ads"
  );
  assert.equal(ads.length, 1);
  assert.equal(ads[0].schedule, "50 4,8,12 * * *");
});

test("CASE_C_SYNC_OZON_STILL_SLIM", () => {
  const entries = cronEntries(read("vercel.json"));
  const syncOzon = entries.filter((entry) => entry.path === "/api/cron/sync-ozon");
  assert.equal(syncOzon.length, 1);
  assert.equal(syncOzon[0].schedule, "0 3 * * *");

  const route = read("app/api/cron/sync-ozon/route.ts");
  assert.equal(route.includes('mode: "scheduled"'), true);
  assert.equal(route.includes("SYNC_OZON_ALL_SCHEDULED"), true);
  assert.equal(route.includes("waitForReport"), false);
  assert.equal(route.includes("syncOzonAds"), false);
});

test("CASE_D_NO_DUPLICATE_OWNER", () => {
  const entries = cronEntries(read("vercel.json"));
  assert.equal(
    entries.some((entry) => entry.path === "/api/cron/historical-sync-ozon-ads"),
    false
  );
  const performanceOwners = entries.filter((entry) =>
    [
      "/api/cron/retry-ozon-report-ads",
      "/api/cron/historical-sync-ozon-ads",
    ].includes(entry.path)
  );
  assert.equal(performanceOwners.length, 1);
  assert.equal(performanceOwners[0].path, "/api/cron/retry-ozon-report-ads");
});

test("CASE_E_EXISTING_CRONS_PRESERVED", () => {
  const v2 = cronEntries(read("vercel.json", v2Root));
  const v3 = cronEntries(read("vercel.json"));
  assert.equal(v3.length, v2.length + 1);

  for (const entry of v2) {
    assert.equal(
      v3.some(
        (candidate) =>
          candidate.path === entry.path && candidate.schedule === entry.schedule
      ),
      true,
      `missing preserved cron ${entry.path} ${entry.schedule}`
    );
  }

  const added = v3.filter(
    (entry) =>
      !v2.some(
        (old) => old.path === entry.path && old.schedule === entry.schedule
      )
  );
  assert.equal(added.length, 1);
  assert.deepEqual(added[0], {
    path: "/api/cron/retry-ozon-report-ads",
    schedule: "50 4,8,12 * * *",
  });
});

test("CASE_F_TIME_MAPPING", () => {
  const schedule = "50 4,8,12 * * *";
  assert.equal(cronEntries(read("vercel.json"))[cronEntries(read("vercel.json")).length - 1].schedule, schedule);
  // Vercel cron is UTC. Expected Moscow (UTC+3, no DST): 07:50 / 11:50 / 15:50 MSK.
  const utcHours = [4, 8, 12];
  const msk = utcHours.map((hour) => `${String(hour + 3).padStart(2, "0")}:50`);
  assert.deepEqual(msk, ["07:50", "11:50", "15:50"]);
});

test("CASE_G_SAFETY", () => {
  const taskOwned = new Set([
    "vercel.json",
    "scripts/architecture/ozonAdsOwnerSchedule.test.ts",
  ]);
  const protectedRel = [
    "lib/telegram/dailyReport.ts",
    "lib/ozon/syncOzon.ts",
    "lib/ozon/syncOzonAllSequence.ts",
    "lib/ozon/syncOzonCronContract.ts",
    "app/api/cron/sync-ozon/route.ts",
    "app/api/cron/retry-ozon-report-ads/route.ts",
    "app/api/cron/sync-marketplace-orders/route.ts",
    "lib/marketplaceOrders/syncMarketplaceDailyOrders.ts",
    "financial-core/v3/manifest.json",
    "financial-core/v3/snapshot/lib/telegram/dailyReport.ts",
    "prisma/schema.prisma",
    "lib/analytics/profitAnalytics.ts",
    "lib/analytics/profitAnalyticsOzon.ts",
  ];

  for (const rel of protectedRel) {
    const v2Path = path.join(v2Root, rel);
    const v3Path = path.join(root, rel);
    assert.equal(fs.existsSync(v2Path), true, `V2 missing ${rel}`);
    assert.equal(fs.existsSync(v3Path), true, `V3 missing ${rel}`);
    assert.equal(
      fs.readFileSync(v2Path).equals(fs.readFileSync(v3Path)),
      true,
      `V3 diverged from V2: ${rel}`
    );
    assert.equal(taskOwned.has(rel), false);
  }

  assert.equal(taskOwned.has("vercel.json"), true);
  assert.equal(
    fs.existsSync(path.join(root, "scripts/architecture/ozonAdsOwnerSchedule.test.ts")),
    true
  );
});
