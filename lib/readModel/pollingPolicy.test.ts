import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReadModelStatusUrl,
  classifyReadinessStatus,
  nextPollDelayMs,
  normalizeReadinessKey,
  sameReadinessKey,
} from "./pollingPolicy.ts";

test("poll delay backoff and hidden tab", () => {
  assert.equal(nextPollDelayMs(0, false), 3000);
  assert.equal(nextPollDelayMs(29_999, false), 3000);
  assert.equal(nextPollDelayMs(30_000, false), 5000);
  assert.equal(nextPollDelayMs(119_999, false), 5000);
  assert.equal(nextPollDelayMs(120_000, false), 10000);
  assert.equal(nextPollDelayMs(0, true), 20000);
});

test("exact key isolation", () => {
  const a = normalizeReadinessKey({
    surface: "profit_wb",
    dateFrom: "2026-09-28",
    dateTo: "2026-10-04",
    companyScope: "ИП Петров",
    marketplace: "WB",
  });
  const otherPeriod = { ...a, dateFrom: "2026-09-21", dateTo: "2026-09-27" };
  const otherCompany = { ...a, companyScope: "ИП Лебедева" };
  const otherSurface = { ...a, surface: "profit_ozon" };
  assert.equal(sameReadinessKey(a, { ...a }), true);
  assert.equal(sameReadinessKey(a, otherPeriod), false);
  assert.equal(sameReadinessKey(a, otherCompany), false);
  assert.equal(sameReadinessKey(a, otherSurface), false);
});

test("status url carries exact key", () => {
  const url = buildReadModelStatusUrl(
    normalizeReadinessKey({
      surface: "dashboard_v6",
      dateFrom: "2026-09-28",
      dateTo: "2026-10-04",
      companyScope: "ALL",
    })
  );
  assert.match(url, /surface=dashboard_v6/);
  assert.match(url, /dateFrom=2026-09-28/);
  assert.match(url, /companyScope=ALL/);
});

test("nonretryable reasons stop as ERROR", () => {
  assert.equal(classifyReadinessStatus({ isReady: true }), "READY");
  assert.equal(
    classifyReadinessStatus({ isReady: false, reason: "V6_PERIOD_READMODEL_MISSING" }),
    "PENDING"
  );
  assert.equal(
    classifyReadinessStatus({
      isReady: false,
      reason: "BUILD_PENDING:V6_PERIOD_READMODEL_MISSING",
    }),
    "PENDING"
  );
  assert.equal(
    classifyReadinessStatus({
      isReady: false,
      reason: "WAITING_SOURCE:WAITING_FOR_WB_WEEKLY_CLOSE",
    }),
    "WAITING_SOURCE"
  );
  assert.equal(
    classifyReadinessStatus({
      isReady: false,
      reason: "D6_UNSAFE_WB_OWNERSHIP_MODE",
    }),
    "WAITING_SOURCE"
  );
  assert.equal(
    classifyReadinessStatus({
      isReady: false,
      reason: "INCOMPATIBLE_FORMULA_VERSION",
    }),
    "ERROR"
  );
});
