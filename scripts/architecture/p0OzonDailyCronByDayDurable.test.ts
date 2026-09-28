import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyOzonLegacyFinanceError,
  isExplicitByDayEligible,
  legacyFinanceAllowsByDayContinue,
  shouldSkipLegacyFinanceForByDay,
} from "../../lib/ozon/legacyFinanceStep";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("legacy 404 is OBSOLETE_METHOD and allows by-day continue when eligible", () => {
  const step = classifyOzonLegacyFinanceError(
    new Error("Ozon Finance API: 404 404 page not found"),
  );
  assert.equal(step.status, "OBSOLETE_METHOD");
  assert.equal(step.code, 404);
  assert.equal(legacyFinanceAllowsByDayContinue(step, true), true);
  assert.equal(legacyFinanceAllowsByDayContinue(step, false), false);
});

test("legacy obsolete code9 still classified", () => {
  const step = classifyOzonLegacyFinanceError(
    new Error('Ozon Finance API: 400 {"code":9,"message":"obsolete method"}'),
  );
  assert.equal(step.status, "OBSOLETE_METHOD");
  assert.equal(step.code, 9);
});

test("exact-date window is by-day eligible and skips legacy finance call", () => {
  const day = new Date("2026-09-27T00:00:00.000Z");
  assert.equal(
    isExplicitByDayEligible({
      dateFromOption: day,
      dateToOption: day,
      dateFrom: day,
      dateTo: day,
    }),
    true,
  );
  assert.equal(shouldSkipLegacyFinanceForByDay(true), true);
  assert.equal(shouldSkipLegacyFinanceForByDay(false), false);
});

test("cron route source uses syncOzonFinance with by-day overlay path", () => {
  const route = fs.readFileSync(
    path.join(root, "app/api/cron/sync-ozon-accruals/route.ts"),
    "utf8",
  );
  const sync = fs.readFileSync(path.join(root, "lib/ozon/syncOzon.ts"), "utf8");
  assert.match(route, /syncOzonFinance/);
  assert.match(sync, /syncOzonAccrualByDayOverlay/);
  assert.match(sync, /shouldSkipLegacyFinanceForByDay/);
  assert.match(sync, /\/v1\/finance\/accrual\/by-day/);
  // Live cron path must not require a successful transaction/list call when by-day eligible.
  assert.match(
    sync,
    /Skipped deprecated POST \/v3\/finance\/transaction\/list/,
  );
});

test("authoritative by-day client endpoint remains /v1/finance/accrual/by-day", () => {
  const accrual = fs.readFileSync(
    path.join(root, "lib/ozon/accrualByDay.ts"),
    "utf8",
  );
  assert.match(accrual, /\/v1\/finance\/accrual\/by-day/);
  assert.doesNotMatch(
    accrual,
    /api-seller\.ozon\.ru\/v3\/finance\/transaction\/list/,
  );
});
