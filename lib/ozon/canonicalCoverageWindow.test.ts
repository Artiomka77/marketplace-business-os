import assert from "node:assert/strict";
import test from "node:test";
import {
  formatOzonCoverageReadyThroughText,
  hasOzonFinalDaysAfterCoveragePrefix,
  resolveOzonAnalyticsDateTo,
  resolveOzonCanonicalCoverageWindow,
  type OzonAccrualDayStatusRecord,
} from "./canonicalCoverageWindow.ts";

function day(
  date: string,
  overrides: Partial<OzonAccrualDayStatusRecord> = {}
): OzonAccrualDayStatusRecord {
  return {
    companyName: "ИП Петров",
    date,
    importSessionId: "s",
    dataMode: "FINAL",
    coverageComplete: true,
    quarantineCount: 0,
    missingEvidence: [],
    phase: "CANONICAL",
    ...overrides,
  };
}

test("01-05 FINAL + 06 missing => coveredThrough 05, partial", () => {
  const window = resolveOzonCanonicalCoverageWindow({
    companyName: "ИП Петров",
    dateFrom: "2026-10-01",
    dateTo: "2026-10-06",
    days: [
      day("2026-10-01"),
      day("2026-10-02"),
      day("2026-10-03"),
      day("2026-10-04"),
      day("2026-10-05"),
    ],
  });
  assert.equal(window.coveredThrough, "2026-10-05");
  assert.equal(window.isPartial, true);
  assert.deepEqual(window.missingDates, ["2026-10-06"]);
});

test("no accrual days => no covered window", () => {
  const window = resolveOzonCanonicalCoverageWindow({
    companyName: "ИП Петров",
    dateFrom: "2026-10-01",
    dateTo: "2026-10-06",
    days: [],
  });
  assert.equal(window.coveredThrough, null);
  assert.equal(window.hasCanonicalCovered, false);
});

test("gap breaks prefix coverage", () => {
  const window = resolveOzonCanonicalCoverageWindow({
    companyName: "ИП Петров",
    dateFrom: "2026-10-01",
    dateTo: "2026-10-04",
    days: [day("2026-10-01"), day("2026-10-03"), day("2026-10-04")],
  });
  assert.equal(window.coveredThrough, "2026-10-01");
  assert.deepEqual(window.missingDates, ["2026-10-02", "2026-10-03", "2026-10-04"]);
});

test("coverage text for owner case", () => {
  const text = formatOzonCoverageReadyThroughText({
    coveredFrom: "2026-10-01",
    coveredThrough: "2026-10-05",
    missingDates: ["2026-10-06"],
  });
  assert.equal(
    text,
    "Ozon: финансовые данные готовы по 01–05.10; 06.10 ещё формируется"
  );
});

test("mid-window gap with later FINAL => analytics uses full requestedDateTo", () => {
  const days = [
    day("2026-09-08"),
    // 09-20 missing from status in this fixture
    day("2026-09-21"),
    day("2026-09-22"),
  ];
  const coverageWindow = resolveOzonCanonicalCoverageWindow({
    companyName: "ИП Петров",
    dateFrom: "2026-09-08",
    dateTo: "2026-09-22",
    days,
  });
  assert.equal(coverageWindow.coveredThrough, "2026-09-08");
  assert.equal(
    hasOzonFinalDaysAfterCoveragePrefix({
      companyName: "ИП Петров",
      dateFrom: "2026-09-08",
      dateTo: "2026-09-22",
      coveredThrough: coverageWindow.coveredThrough,
      days,
    }),
    true,
  );
  assert.equal(
    resolveOzonAnalyticsDateTo({
      requestedDateTo: "2026-09-22",
      coverageWindow,
      companyName: "ИП Петров",
      dateFrom: "2026-09-08",
      days,
    }),
    "2026-09-22",
  );
});

test("trailing-only gap keeps coveredThrough as analyticsDateTo", () => {
  const days = [
    day("2026-10-01"),
    day("2026-10-02"),
    day("2026-10-03"),
    day("2026-10-04"),
    day("2026-10-05"),
  ];
  const coverageWindow = resolveOzonCanonicalCoverageWindow({
    companyName: "ИП Петров",
    dateFrom: "2026-10-01",
    dateTo: "2026-10-06",
    days,
  });
  assert.equal(
    resolveOzonAnalyticsDateTo({
      requestedDateTo: "2026-10-06",
      coverageWindow,
      companyName: "ИП Петров",
      dateFrom: "2026-10-01",
      days,
    }),
    "2026-10-05",
  );
});

test("no day-status prefix => analytics uses requestedDateTo", () => {
  const coverageWindow = resolveOzonCanonicalCoverageWindow({
    companyName: "ИП Петров",
    dateFrom: "2026-01-01",
    dateTo: "2026-10-18",
    days: [day("2026-08-14"), day("2026-08-15")],
  });
  assert.equal(coverageWindow.coveredThrough, null);
  assert.equal(
    resolveOzonAnalyticsDateTo({
      requestedDateTo: "2026-10-18",
      coverageWindow,
      companyName: "ИП Петров",
      dateFrom: "2026-01-01",
      days: [day("2026-08-14"), day("2026-08-15")],
    }),
    "2026-10-18",
  );
});
