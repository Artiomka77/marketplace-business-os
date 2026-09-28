import assert from "node:assert/strict";
import test from "node:test";

import {
  planWbSourceOwnership,
  requestedAllowsPreliminaryWbFallback,
  selectMaximalWbFinanceCover,
  selectMinimalWbFinanceCover,
  type WbOwnershipFinanceRow,
  type WbOwnershipSession,
} from "../../lib/wb/sourceOwnership";

const PETROV = "ИП Петров";
const LEBEDEVA = "ИП Лебедева";

function financeRow(
  companyName: string,
  reportNumber: string,
  dateFrom: string,
  dateTo = dateFrom
): WbOwnershipFinanceRow {
  return {
    companyName,
    reportNumber,
    dateFrom: new Date(`${dateFrom}T00:00:00.000Z`),
    dateTo: new Date(`${dateTo}T00:00:00.000Z`),
  };
}

function session(
  id: string,
  companyName: string,
  reportNumber: string,
  createdAt = "2026-08-24T00:00:00.000Z"
): WbOwnershipSession {
  return {
    id,
    fileName: `wb-${reportNumber}.xlsx`,
    companyName,
    reportType: "WB_SALES",
    status: "SUCCESS",
    createdAt: new Date(createdAt),
  };
}

test("one exact-cover source still wins the requested week", () => {
  const plan = planWbSourceOwnership({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyNames: [PETROV],
    financeRows: [financeRow(PETROV, "W1", "2026-08-17", "2026-08-23")],
    sessions: [session("s1", PETROV, "W1")],
  });
  assert.equal(plan.isFinanciallyFinal, true);
  assert.equal(plan.intervals[0]?.mode, "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS");
  assert.deepEqual(plan.selectedSessionIds, ["s1"]);
});

test("two adjacent sources compose a complete month path", () => {
  const cover = selectMinimalWbFinanceCover(
    [
      financeRow(PETROV, "W1", "2026-08-01", "2026-08-15"),
      financeRow(PETROV, "W2", "2026-08-16", "2026-08-31"),
    ],
    "2026-08-01",
    "2026-08-31"
  );
  assert.equal(cover.length, 2);
  assert.equal(cover[0]?.startKey, "2026-08-01");
  assert.equal(cover[1]?.endKey, "2026-08-31");
});

test("three adjacent sources compose one requested range", () => {
  const cover = selectMinimalWbFinanceCover(
    [
      financeRow(PETROV, "A", "2026-08-10", "2026-08-16"),
      financeRow(PETROV, "B", "2026-08-17", "2026-08-23"),
      financeRow(PETROV, "C", "2026-08-24", "2026-08-31"),
    ],
    "2026-08-10",
    "2026-08-31"
  );
  assert.equal(cover.length, 3);
});

test("partial gap in the middle is SOURCE_INCOMPLETE on a calendar month", () => {
  const plan = planWbSourceOwnership({
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    companyNames: [PETROV],
    financeRows: [
      financeRow(PETROV, "A", "2026-08-01", "2026-08-10"),
      financeRow(PETROV, "B", "2026-08-20", "2026-08-31"),
    ],
    sessions: [session("sa", PETROV, "A"), session("sb", PETROV, "B")],
  });
  assert.equal(plan.isFinanciallyFinal, false);
  assert.ok(
    plan.intervals.some((interval) =>
      interval.preliminaryReasons.includes("SOURCE_INCOMPLETE")
    )
  );
  const gap = plan.intervals.find((interval) =>
    interval.preliminaryReasons.includes("SOURCE_INCOMPLETE")
  );
  assert.equal(gap?.dateFrom, "2026-08-11");
  assert.equal(gap?.dateTo, "2026-08-19");
});

test("gap at beginning of a month is SOURCE_INCOMPLETE and does not operational-fill", () => {
  const plan = planWbSourceOwnership({
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    companyNames: [PETROV],
    financeRows: [financeRow(PETROV, "W", "2026-08-10", "2026-08-16")],
    sessions: [session("sw", PETROV, "W")],
  });
  assert.equal(plan.isFinanciallyFinal, false);
  assert.ok(plan.intervals.some((i) => i.preliminaryReasons.includes("SOURCE_INCOMPLETE")));
  assert.ok(plan.intervals.some((i) => i.mode === "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS"));
});

test("gap at end of a month is SOURCE_INCOMPLETE", () => {
  const maximal = selectMaximalWbFinanceCover(
    [financeRow(PETROV, "W", "2026-08-01", "2026-08-20")],
    "2026-08-01",
    "2026-08-31"
  );
  assert.equal(maximal.segments.length, 1);
  assert.equal(maximal.gaps.length, 1);
  assert.equal(maximal.gaps[0]?.startKey, "2026-08-21");
  assert.equal(maximal.gaps[0]?.endKey, "2026-08-31");
});

test("overlapping lower/higher weekly reports do not double-count", () => {
  const cover = selectMinimalWbFinanceCover(
    [
      financeRow(PETROV, "SHORT", "2026-08-01", "2026-08-10"),
      financeRow(PETROV, "LONG", "2026-08-01", "2026-08-31"),
    ],
    "2026-08-01",
    "2026-08-31"
  );
  assert.equal(cover.length, 1);
  assert.equal(cover[0]?.endKey, "2026-08-31");
});

test("full higher-priority supersession picks the longer contained interval", () => {
  const cover = selectMaximalWbFinanceCover(
    [
      financeRow(PETROV, "DAY", "2026-08-17"),
      financeRow(PETROV, "WEEK", "2026-08-17", "2026-08-23"),
    ],
    "2026-08-17",
    "2026-08-23"
  );
  assert.equal(cover.segments.length, 1);
  assert.equal(cover.segments[0]?.endKey, "2026-08-23");
  assert.equal(cover.gaps.length, 0);
});

test("partial higher-priority supersession only covers its own interval", () => {
  const maximal = selectMaximalWbFinanceCover(
    [
      financeRow(PETROV, "PARTIAL", "2026-08-01", "2026-08-10"),
      financeRow(PETROV, "TAIL", "2026-08-11", "2026-08-31"),
    ],
    "2026-08-01",
    "2026-08-31"
  );
  assert.equal(maximal.gaps.length, 0);
  assert.equal(maximal.segments.length, 2);
});

test("duplicate version replacement keeps the latest session only", () => {
  const plan = planWbSourceOwnership({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyNames: [PETROV],
    financeRows: [financeRow(PETROV, "W1", "2026-08-17", "2026-08-23")],
    sessions: [
      session("old", PETROV, "W1", "2026-08-24T09:00:00.000Z"),
      session("new", PETROV, "W1", "2026-08-24T10:00:00.000Z"),
    ],
  });
  assert.deepEqual(plan.selectedSessionIds, ["new"]);
});

test("same dates different companies are planned independently", () => {
  const plan = planWbSourceOwnership({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    companyNames: [PETROV, LEBEDEVA],
    financeRows: [
      financeRow(PETROV, "P1", "2026-08-17", "2026-08-23"),
      financeRow(LEBEDEVA, "L1", "2026-08-17", "2026-08-23"),
    ],
    sessions: [session("sp", PETROV, "P1"), session("sl", LEBEDEVA, "L1")],
  });
  assert.equal(plan.intervals.length, 2);
  assert.equal(plan.isFinanciallyFinal, true);
});

test("month / quarter / year boundaries refuse preliminary fallback", () => {
  assert.equal(requestedAllowsPreliminaryWbFallback("2026-08-01", "2026-08-31"), false);
  assert.equal(requestedAllowsPreliminaryWbFallback("2026-07-01", "2026-09-30"), false);
  assert.equal(requestedAllowsPreliminaryWbFallback("2026-01-01", "2026-09-05"), false);
  assert.equal(requestedAllowsPreliminaryWbFallback("2026-08-17", "2026-08-23"), true);
  assert.equal(requestedAllowsPreliminaryWbFallback("2026-09-01", "2026-09-03"), true);
});

test("year-start custom 1..7 day ranges keep preliminary fallback", () => {
  assert.equal(requestedAllowsPreliminaryWbFallback("2026-01-01", "2026-01-01"), true);
  assert.equal(requestedAllowsPreliminaryWbFallback("2026-01-01", "2026-01-02"), true);
  assert.equal(requestedAllowsPreliminaryWbFallback("2026-01-01", "2026-01-07"), true);
  assert.equal(requestedAllowsPreliminaryWbFallback("2026-01-01", "2026-01-08"), false);
  assert.equal(requestedAllowsPreliminaryWbFallback("2026-01-01", "2026-01-31"), false);
  assert.equal(requestedAllowsPreliminaryWbFallback("2026-01-01", "2026-03-31"), false);
  assert.equal(requestedAllowsPreliminaryWbFallback("2026-01-01", "2026-09-05"), false);
  assert.equal(requestedAllowsPreliminaryWbFallback("2025-12-29", "2026-01-04"), true);
  assert.equal(requestedAllowsPreliminaryWbFallback("2026-09-01", "2026-09-03"), true);
  assert.equal(requestedAllowsPreliminaryWbFallback("2026-08-17", "2026-08-23"), true);
});

test("Jan01..Jan07 with no finance is PRELIMINARY_NO_SOURCE without SOURCE_INCOMPLETE", () => {
  const plan = planWbSourceOwnership({
    dateFrom: "2026-01-01",
    dateTo: "2026-01-07",
    companyNames: [PETROV],
    financeRows: [],
    sessions: [],
  });
  assert.equal(plan.intervals[0]?.mode, "PRELIMINARY_NO_SOURCE");
  assert.ok(!plan.intervals[0]?.preliminaryReasons.includes("SOURCE_INCOMPLETE"));
  assert.ok(
    plan.intervals[0]?.preliminaryReasons.includes("FINANCE_INTERVAL_COVER_INCOMPLETE")
  );
});

test("Jan01..Jan08 with no finance is SOURCE_INCOMPLETE and does not operational-fill", () => {
  const plan = planWbSourceOwnership({
    dateFrom: "2026-01-01",
    dateTo: "2026-01-08",
    companyNames: [PETROV],
    financeRows: [],
    sessions: [],
  });
  assert.equal(plan.isFinanciallyFinal, false);
  assert.ok(
    plan.intervals.some((interval) =>
      interval.preliminaryReasons.includes("SOURCE_INCOMPLETE")
    )
  );
});

test("Jan01..Jan07 exact final cover remains exact/final", () => {
  const plan = planWbSourceOwnership({
    dateFrom: "2026-01-01",
    dateTo: "2026-01-07",
    companyNames: [PETROV],
    financeRows: [financeRow(PETROV, "W1", "2026-01-01", "2026-01-07")],
    sessions: [session("s1", PETROV, "W1")],
  });
  assert.equal(plan.isFinanciallyFinal, true);
  assert.equal(plan.intervals[0]?.mode, "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS");
});

test("Jan01..Jan08 exact complete cover remains exact/final", () => {
  const plan = planWbSourceOwnership({
    dateFrom: "2026-01-01",
    dateTo: "2026-01-08",
    companyNames: [PETROV],
    financeRows: [financeRow(PETROV, "W1", "2026-01-01", "2026-01-08")],
    sessions: [session("s1", PETROV, "W1")],
  });
  assert.equal(plan.isFinanciallyFinal, true);
  assert.equal(plan.intervals[0]?.mode, "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS");
});

test("incomplete long range never becomes a trusted whole-range owner", () => {
  const plan = planWbSourceOwnership({
    dateFrom: "2026-01-01",
    dateTo: "2026-09-05",
    companyNames: [PETROV],
    financeRows: [financeRow(PETROV, "AUG", "2026-08-17", "2026-08-23")],
    sessions: [session("saug", PETROV, "AUG")],
  });
  assert.equal(plan.isFinanciallyFinal, false);
  assert.ok(
    plan.intervals.some((interval) =>
      interval.preliminaryReasons.includes("SOURCE_INCOMPLETE")
    )
  );
});

test("February straddling weekly reports are not treated as contained month cover", () => {
  const plan = planWbSourceOwnership({
    dateFrom: "2026-02-01",
    dateTo: "2026-02-28",
    companyNames: [PETROV],
    financeRows: [
      financeRow(PETROV, "STRADDLE_START", "2026-01-26", "2026-02-01"),
      financeRow(PETROV, "INNER", "2026-02-02", "2026-02-22"),
      financeRow(PETROV, "STRADDLE_END", "2026-02-23", "2026-03-01"),
    ],
    sessions: [
      session("s0", PETROV, "STRADDLE_START"),
      session("s1", PETROV, "INNER"),
      session("s2", PETROV, "STRADDLE_END"),
    ],
  });
  assert.equal(plan.isFinanciallyFinal, false);
  assert.ok(
    plan.intervals.some((interval) =>
      interval.preliminaryReasons.includes("SOURCE_INCOMPLETE")
    )
  );
  const inner = plan.intervals.find(
    (interval) => interval.mode === "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS"
  );
  assert.equal(inner?.dateFrom, "2026-02-02");
  assert.equal(inner?.dateTo, "2026-02-22");
  assert.ok(!plan.selectedSessionIds.includes("s0"));
  assert.ok(!plan.selectedSessionIds.includes("s2"));
});

test("Q2 boundary-straddling weeks cannot complete the quarter under all-rows policy", () => {
  const plan = planWbSourceOwnership({
    dateFrom: "2026-04-01",
    dateTo: "2026-06-30",
    companyNames: [PETROV],
    financeRows: [
      financeRow(PETROV, "Q_START", "2026-03-30", "2026-04-05"),
      financeRow(PETROV, "Q_MID", "2026-04-06", "2026-06-28"),
      financeRow(PETROV, "Q_END", "2026-06-29", "2026-07-05"),
    ],
    sessions: [
      session("qs", PETROV, "Q_START"),
      session("qm", PETROV, "Q_MID"),
      session("qe", PETROV, "Q_END"),
    ],
  });
  assert.equal(plan.isFinanciallyFinal, false);
  assert.ok(!plan.selectedSessionIds.includes("qs"));
  assert.ok(!plan.selectedSessionIds.includes("qe"));
});

test("YTD missing start day fail-closes and does not operational-fill", () => {
  const plan = planWbSourceOwnership({
    dateFrom: "2026-01-01",
    dateTo: "2026-09-05",
    companyNames: [PETROV],
    financeRows: [financeRow(PETROV, "LATE", "2026-01-05", "2026-09-04")],
    sessions: [session("late", PETROV, "LATE")],
  });
  assert.equal(plan.isFinanciallyFinal, false);
  const startGap = plan.intervals.find((interval) =>
    interval.preliminaryReasons.includes("SOURCE_INCOMPLETE")
  );
  assert.equal(startGap?.dateFrom, "2026-01-01");
  assert.equal(startGap?.dateTo, "2026-01-04");
});

test("complete long aligned August remains financially final", () => {
  const plan = planWbSourceOwnership({
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    companyNames: [PETROV],
    financeRows: [
      financeRow(PETROV, "A", "2026-08-01", "2026-08-16"),
      financeRow(PETROV, "B", "2026-08-17", "2026-08-31"),
    ],
    sessions: [session("a", PETROV, "A"), session("b", PETROV, "B")],
  });
  assert.equal(plan.isFinanciallyFinal, true);
  assert.equal(plan.intervals.length, 2);
});

test("short window with no finance still uses the historical preliminary path", () => {
  const plan = planWbSourceOwnership({
    dateFrom: "2026-09-01",
    dateTo: "2026-09-03",
    companyNames: [PETROV],
    financeRows: [],
    sessions: [],
  });
  assert.equal(plan.intervals[0]?.mode, "PRELIMINARY_NO_SOURCE");
  assert.ok(
    !plan.intervals[0]?.preliminaryReasons.includes("SOURCE_INCOMPLETE")
  );
  assert.ok(
    plan.intervals[0]?.preliminaryReasons.includes(
      "FINANCE_INTERVAL_COVER_INCOMPLETE"
    )
  );
});
