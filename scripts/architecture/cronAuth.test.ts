import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isCronAuthorized,
  rejectUnauthorizedCron,
} from "../../lib/security/cronAuth";
import { rejectUnauthorizedDailyReport } from "../../lib/security/telegramDailyReportAuth";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function cronRequest(authorization?: string) {
  return new Request("http://127.0.0.1/api/cron/example", {
    headers: authorization ? { authorization } : undefined,
  });
}

function dailyRequest(authorization?: string) {
  return new Request("http://127.0.0.1/api/telegram/daily-report?send=false", {
    headers: authorization ? { authorization } : undefined,
  });
}

test("cron missing env is denied", () => {
  delete process.env.CRON_SECRET;
  assert.equal(isCronAuthorized(cronRequest("Bearer test-secret")), false);
  assert.equal(rejectUnauthorizedCron(cronRequest("Bearer test-secret"))?.status, 401);
});

test("cron blank env is denied", () => {
  process.env.CRON_SECRET = "   ";
  assert.equal(isCronAuthorized(cronRequest("Bearer test-secret")), false);
});

test("cron missing header is denied", () => {
  process.env.CRON_SECRET = "test-secret";
  assert.equal(isCronAuthorized(cronRequest()), false);
});

test("cron wrong bearer is denied", () => {
  process.env.CRON_SECRET = "test-secret";
  assert.equal(isCronAuthorized(cronRequest("Bearer other-secret")), false);
});

test("cron correct bearer is allowed", () => {
  process.env.CRON_SECRET = "test-secret";
  assert.equal(isCronAuthorized(cronRequest("Bearer test-secret")), true);
  assert.equal(rejectUnauthorizedCron(cronRequest("Bearer test-secret")), null);
});

test("telegram production missing secret is 503", () => {
  const env = process.env as { NODE_ENV?: string };
  const previous = env.NODE_ENV;
  env.NODE_ENV = "production";
  delete process.env.TELEGRAM_DAILY_REPORT_SECRET;
  assert.equal(rejectUnauthorizedDailyReport(dailyRequest())?.status, 503);
  env.NODE_ENV = previous;
});

test("telegram present secret wrong bearer is 401", () => {
  process.env.TELEGRAM_DAILY_REPORT_SECRET = "daily-secret";
  assert.equal(
    rejectUnauthorizedDailyReport(dailyRequest("Bearer other"))?.status,
    401
  );
});

test("telegram present secret correct bearer is allowed", () => {
  process.env.TELEGRAM_DAILY_REPORT_SECRET = "daily-secret";
  assert.equal(
    rejectUnauthorizedDailyReport(dailyRequest("Bearer daily-secret")),
    null
  );
});

test("auth-probe route is side-effect-free READ_ONLY_PROBE", () => {
  const probePath = path.join(root, "app/api/cron/auth-probe/route.ts");
  const text = fs.readFileSync(probePath, "utf8");
  const forbidden = [
    "@/lib/prisma",
    "prisma.",
    "syncWb",
    "syncOzon",
    "sendTelegram",
    "buildDailyReport",
    "runCurrentPrioritySync",
    "runNextHistoricalSyncJob",
    "retryMissingOzonReportAds",
    "syncMarketplaceDailyOrders",
    "historicalSync",
    "writeFile",
  ];
  for (const needle of forbidden) {
    assert.equal(text.includes(needle), false, needle);
  }
  assert.equal(text.includes('from "@/lib/security/cronAuth"'), true);
  assert.equal(text.includes("rejectUnauthorizedCron"), true);
  assert.equal(text.includes('probe: "cron-auth"'), true);
});
