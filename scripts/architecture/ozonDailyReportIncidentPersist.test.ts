import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { mapOzonAccrualByDay } from "../../lib/ozon/accrualByDay";
import {
  planCanonicalOzonAccrualPersist,
  validateMappedResult,
} from "../../lib/ozon/accrualIngestValidation";
import {
  aggregateOzonAccrualRouteResults,
  resolveOzonAccrualSyncWindow,
} from "../../lib/ozon/ozonAccrualSyncWindow";
import {
  classifyOzonDailySourceFreshness,
  formatOzonSourceFreshnessBlock,
} from "../../lib/ozon/ozonDailySourceFreshness";
import { planOzonAccrualIngest } from "../../lib/ozon/accrualIngestPolicy";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function mappedDay(
  date: string,
  extras: Partial<ReturnType<typeof mapOzonAccrualByDay>["days"][number]> = {},
) {
  return {
    date,
    totalReportAmount: 100,
    economicTurnover: 100,
    taxableRevenue: 80,
    discountPointsAmount: 10,
    partnerProgramsAmount: 0,
    grossOzonExpenses: 20,
    categoryAmounts: {},
    factsRows: 1,
    ...extras,
  };
}

function mappedResult(params: {
  days: string[];
  coverageComplete?: boolean;
  grossExpenseDifference?: number;
  unresolvedType71Groups?: Array<{
    key: string;
    accrualIds: number[];
    amounts: number[];
  }>;
  requestedDates?: string[];
}): ReturnType<typeof mapOzonAccrualByDay> {
  const days = params.days.map((date) => mappedDay(date));
  const requestedDates = params.requestedDates ?? params.days;
  return {
    mapperComplete: true,
    coverageComplete: params.coverageComplete ?? true,
    days,
    totals: mappedDay(params.days[0] ?? "1970-01-01"),
    facts: params.days.map((date) => ({
      date,
      typeId: 1,
      amount: 1,
      category: "x",
    })) as never,
    diagnostics: {
      accrualRows: days.length,
      factsRows: days.length,
      ignoredZeroComponents: 0,
      type71Rows: 0,
      type71Groups: 0,
      type71PairedGroups: 0,
      type71SingleGroups: 0,
      unresolvedType71Groups: params.unresolvedType71Groups ?? [],
      unknownMeaningfulTypeIds: [],
      grossExpenseDifference: params.grossExpenseDifference ?? 0,
      dailyGrossExpenseDifferences: [],
      apiCoverage: {
        envelopeComplete: true,
        coverageComplete: params.coverageComplete ?? true,
        emptyUnconfirmedDates: requestedDates.filter((d) => !params.days.includes(d)),
        missingEvidence: requestedDates
          .filter((d) => !params.days.includes(d))
          .map((d) => `EMPTY_DAY_UNCONFIRMED:${d}`),
      },
    },
  };
}

test("rolling 3-day missing newest persists prior days and leaves newest pending", () => {
  const mapped = mappedResult({
    days: ["2026-09-04", "2026-09-05"],
    requestedDates: ["2026-09-04", "2026-09-05", "2026-09-06"],
    coverageComplete: false,
  });
  const plan = planCanonicalOzonAccrualPersist({
    mapped,
    dateFrom: new Date("2026-09-04T00:00:00.000Z"),
    dateTo: new Date("2026-09-06T00:00:00.000Z"),
    requestedDates: ["2026-09-04", "2026-09-05", "2026-09-06"],
  });

  assert.deepEqual(plan.persistDates, ["2026-09-04", "2026-09-05"]);
  assert.deepEqual(plan.pendingDates, ["2026-09-06"]);
  assert.deepEqual(plan.fakeZeroDates, []);
  assert.equal(plan.abortEntireWindow, false);
  assert.equal(plan.ingestPlan.status, "PRELIMINARY");
  assert.equal(plan.ingestPlan.failFinality, true);
  assert.equal(plan.ingestPlan.coverageComplete, false);
});

test("unexplained gross does not abort mapped-day persist and is not FINAL", () => {
  const mapped = mappedResult({
    days: ["2026-09-06"],
    coverageComplete: true,
    grossExpenseDifference: 7413,
  });
  const plan = planCanonicalOzonAccrualPersist({
    mapped,
    dateFrom: new Date("2026-09-06T00:00:00.000Z"),
    dateTo: new Date("2026-09-06T00:00:00.000Z"),
    requestedDates: ["2026-09-06"],
  });

  assert.deepEqual(plan.persistDates, ["2026-09-06"]);
  assert.deepEqual(plan.pendingDates, []);
  assert.equal(plan.ingestPlan.status, "PRELIMINARY");
  assert.equal(plan.ingestPlan.failFinality, true);
  assert.equal(
    validateMappedResult({
      mapped,
      dateFrom: new Date("2026-09-06T00:00:00.000Z"),
      dateTo: new Date("2026-09-06T00:00:00.000Z"),
      requestedDates: ["2026-09-06"],
    }).unexplainedGross,
    true,
  );
});

test("single-day exact window persists the available day as FINAL when clean", () => {
  const mapped = mappedResult({ days: ["2026-09-06"] });
  const plan = planCanonicalOzonAccrualPersist({
    mapped,
    dateFrom: new Date("2026-09-06T00:00:00.000Z"),
    dateTo: new Date("2026-09-06T00:00:00.000Z"),
    requestedDates: ["2026-09-06"],
  });
  assert.deepEqual(plan.persistDates, ["2026-09-06"]);
  assert.equal(plan.ingestPlan.status, "FINAL");
  assert.equal(plan.ingestPlan.failFinality, false);
});

test("exact-date window resolver and route aggregate distinguish partial", () => {
  const exact = resolveOzonAccrualSyncWindow({ exactDate: "2026-09-06" });
  assert.equal(exact.mode, "EXACT_DATE");
  assert.equal(exact.dateFromText, "2026-09-06");
  const summary = aggregateOzonAccrualRouteResults([
    {
      companyName: "ИП Петров",
      ok: true,
      coverageComplete: false,
      ingestStatus: "PRELIMINARY",
      windowPartial: false,
      pendingDays: [],
    },
    {
      companyName: "ИП Лебедева",
      ok: true,
      coverageComplete: true,
      ingestStatus: "FINAL",
    },
  ]);
  assert.equal(summary.httpStatus, 200);
  assert.equal(summary.partial, true);
  assert.equal(summary.ok, false);
});

test("manual freshness distinguishes READY PRELIMINARY PENDING FAILED", () => {
  const ready = classifyOzonDailySourceFreshness({
    companyName: "ИП Лебедева",
    date: "2026-09-06",
    realizationRowCount: 1,
    latestImportStatus: "SUCCESS",
    latestJobError: null,
    latestIngestStatus: "FINAL",
    latestFailFinality: false,
    latestGrossExpenseDifference: 0,
    latestCoverageComplete: true,
  });
  const preliminary = classifyOzonDailySourceFreshness({
    companyName: "ИП Петров",
    date: "2026-09-06",
    realizationRowCount: 1,
    latestImportStatus: "SUCCESS",
    latestJobError: null,
    latestIngestStatus: "PRELIMINARY",
    latestFailFinality: true,
    latestGrossExpenseDifference: 7413,
    latestCoverageComplete: false,
  });
  const hasCanonicalAlone = classifyOzonDailySourceFreshness({
    companyName: "ИП Петров",
    date: "2026-09-06",
    realizationRowCount: 1,
    latestImportStatus: null,
    latestJobError: null,
  });
  const pending = classifyOzonDailySourceFreshness({
    companyName: "ИП Петров",
    date: "2026-09-07",
    realizationRowCount: 0,
    latestImportStatus: null,
    latestJobError: null,
  });
  const failed = classifyOzonDailySourceFreshness({
    companyName: "ИП Петров",
    date: "2026-09-06",
    realizationRowCount: 0,
    latestImportStatus: "RAW_PERSISTED",
    latestJobError: "Ozon /by-day fail-closed: unexplained gross difference 7413",
  });
  assert.equal(ready.state, "READY");
  assert.equal(preliminary.state, "PRELIMINARY");
  assert.equal(hasCanonicalAlone.state, "PRELIMINARY");
  assert.equal(pending.state, "PENDING");
  assert.equal(failed.state, "FAILED");
  const block = formatOzonSourceFreshnessBlock([
    ready,
    preliminary,
    pending,
    failed,
  ]);
  assert.match(block, /READY/);
  assert.match(block, /PRELIMINARY/);
  assert.match(block, /PENDING/);
  assert.match(block, /FAILED/);
});

test("ingest policy never fakes FINAL on unexplained gross", () => {
  const plan = planOzonAccrualIngest({
    coverageComplete: true,
    grossExpenseDifference: 7413,
  });
  assert.equal(plan.status, "PRELIMINARY");
  assert.equal(plan.abortEntireDay, false);
  assert.equal(plan.persistKnownFacts, true);
});

test("429 and 5xx remain bounded retryable in accrual client", () => {
  const source = fs.readFileSync(
    path.join(root, "lib/ozon/accrualByDay.ts"),
    "utf8",
  );
  assert.match(source, /DEFAULT_MAX_ATTEMPTS = 6/);
  assert.match(
    source,
    /RETRYABLE_STATUS = new Set\(\[408, 425, 429, 500, 502, 503, 504\]\)/,
  );
});

test("exact-date completeness retry is wired to sync-ozon-accruals", () => {
  const completeness = fs.readFileSync(
    path.join(root, "app/api/cron/daily-data-completeness-retry/route.ts"),
    "utf8",
  );
  assert.match(completeness, /sync-ozon-accruals/);
  assert.match(completeness, /date:/);
  const route = fs.readFileSync(
    path.join(root, "app/api/cron/sync-ozon-accruals/route.ts"),
    "utf8",
  );
  assert.match(route, /exactDate: url.searchParams.get\("date"\)/);
  const webhook = fs.readFileSync(
    path.join(root, "app/api/telegram/webhook/route.ts"),
    "utf8",
  );
  assert.match(webhook, /formatOwnerReportWithOzonFreshness/);
});

test("overlay still throws on unresolved type71, unknown meaningful types, and empty mapped days", () => {
  assert.throws(() =>
    planCanonicalOzonAccrualPersist({
      mapped: mappedResult({
        days: ["2026-09-06"],
        unresolvedType71Groups: [{ key: "x", accrualIds: [1], amounts: [1] }],
      }),
      dateFrom: new Date("2026-09-06T00:00:00.000Z"),
      dateTo: new Date("2026-09-06T00:00:00.000Z"),
      requestedDates: ["2026-09-06"],
    }),
  );
  assert.throws(() => {
    const mapped = mappedResult({ days: ["2026-09-06"] });
    mapped.diagnostics.unknownMeaningfulTypeIds = [
      { typeId: 76, rows: 1, amount: -10, name: "x", description: "y" },
    ];
    planCanonicalOzonAccrualPersist({
      mapped,
      dateFrom: new Date("2026-09-06T00:00:00.000Z"),
      dateTo: new Date("2026-09-06T00:00:00.000Z"),
      requestedDates: ["2026-09-06"],
    });
  });
  assert.throws(() =>
    planCanonicalOzonAccrualPersist({
      mapped: mappedResult({ days: [], requestedDates: ["2026-09-06"] }),
      dateFrom: new Date("2026-09-06T00:00:00.000Z"),
      dateTo: new Date("2026-09-06T00:00:00.000Z"),
      requestedDates: ["2026-09-06"],
    }),
  );
});

test("telegram preliminary labels are wired for Ozon and business total", () => {
  const source = fs.readFileSync(
    path.join(root, "lib/telegram/dailyReport.ts"),
    "utf8",
  );
  assert.match(source, /Предварительная прибыль после налогов Ozon/);
  assert.match(source, /Предварительная чистая прибыль после налогов/);
  assert.match(source, /ozonPreliminary/);
  assert.match(source, /businessPreliminary/);
});
