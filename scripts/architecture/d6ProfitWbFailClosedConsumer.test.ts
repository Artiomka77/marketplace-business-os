import assert from "node:assert/strict";
import test from "node:test";

import {
  isWbPnlUnavailable,
  resolveWbPnlAvailability,
  wbDependentRatioPercent,
  WB_PNL_UNAVAILABLE_REASON,
} from "../../lib/analytics/profitAnalytics";
import { requestedAllowsPreliminaryWbFallback } from "../../lib/wb/sourceOwnership";

test("true source-complete zero remains AVAILABLE and 0 is valid", () => {
  const availability = resolveWbPnlAvailability({
    dateFrom: "2026-08-17",
    dateTo: "2026-08-23",
    source: { isFinanciallyFinal: true, intervals: [] },
  });
  assert.equal(availability.status, "AVAILABLE");
  assert.equal(availability.kind, "FINAL");
  assert.equal(isWbPnlUnavailable(availability), false);
  assert.equal(wbDependentRatioPercent(availability, 0, 0), 0);
  assert.equal(wbDependentRatioPercent(availability, 0, 100), 0);
});

test("does not use rows.length as availability", () => {
  const emptyFinal = resolveWbPnlAvailability({
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    source: { isFinanciallyFinal: true, intervals: [{ preliminaryReasons: [] }] },
  });
  const nonemptyIncomplete = resolveWbPnlAvailability({
    dateFrom: "2026-01-01",
    dateTo: "2026-09-05",
    source: {
      isFinanciallyFinal: false,
      intervals: [{ preliminaryReasons: ["SOURCE_INCOMPLETE"] }],
    },
  });
  assert.equal(emptyFinal.status, "AVAILABLE");
  assert.equal(nonemptyIncomplete.status, "UNAVAILABLE");
});

test("January / February / Q2 / YTD / 2025 incomplete are UNAVAILABLE", () => {
  const ranges = [
    ["2026-01-01", "2026-01-31"],
    ["2026-02-01", "2026-02-28"],
    ["2026-04-01", "2026-06-30"],
    ["2026-01-01", "2026-09-05"],
    ["2025-01-01", "2025-12-31"],
  ] as const;
  for (const [dateFrom, dateTo] of ranges) {
    const availability = resolveWbPnlAvailability({
      dateFrom,
      dateTo,
      source: {
        isFinanciallyFinal: false,
        intervals: [{ preliminaryReasons: ["SOURCE_INCOMPLETE"] }],
      },
    });
    assert.equal(availability.status, "UNAVAILABLE", `${dateFrom}..${dateTo}`);
    if (availability.status === "UNAVAILABLE") {
      assert.equal(availability.reason, WB_PNL_UNAVAILABLE_REASON);
    }
    assert.equal(wbDependentRatioPercent(availability, 0, 0), null);
    assert.equal(wbDependentRatioPercent(availability, 100, 0), null);
    assert.equal(requestedAllowsPreliminaryWbFallback(dateFrom, dateTo), false);
  }
});

test("company-specific incomplete month is UNAVAILABLE", () => {
  const availability = resolveWbPnlAvailability({
    dateFrom: "2026-02-01",
    dateTo: "2026-02-28",
    source: {
      isFinanciallyFinal: false,
      intervals: [{ preliminaryReasons: ["SOURCE_INCOMPLETE"] }],
    },
  });
  assert.equal(availability.status, "UNAVAILABLE");
});

test("year-start 7-day custom range is PRELIMINARY; 8-day Jan start is UNAVAILABLE", () => {
  assert.equal(requestedAllowsPreliminaryWbFallback("2026-01-01", "2026-01-07"), true);
  const preliminary = resolveWbPnlAvailability({
    dateFrom: "2026-01-01",
    dateTo: "2026-01-07",
    source: {
      isFinanciallyFinal: false,
      intervals: [{ preliminaryReasons: ["FINANCE_INTERVAL_COVER_INCOMPLETE"] }],
    },
  });
  assert.equal(preliminary.status, "AVAILABLE");
  assert.equal(preliminary.kind, "PRELIMINARY");
  assert.equal(requestedAllowsPreliminaryWbFallback("2026-01-01", "2026-01-08"), false);
  const incomplete = resolveWbPnlAvailability({
    dateFrom: "2026-01-01",
    dateTo: "2026-01-08",
    source: {
      isFinanciallyFinal: false,
      intervals: [{ preliminaryReasons: ["SOURCE_INCOMPLETE"] }],
    },
  });
  assert.equal(incomplete.status, "UNAVAILABLE");
});

test("certified short periods remain PRELIMINARY-allowed or FINAL, never unavailable-from-policy", () => {
  for (const [dateFrom, dateTo] of [
    ["2026-08-17", "2026-08-23"],
    ["2026-09-01", "2026-09-03"],
  ] as const) {
    assert.equal(requestedAllowsPreliminaryWbFallback(dateFrom, dateTo), true);
    const preliminary = resolveWbPnlAvailability({
      dateFrom,
      dateTo,
      source: {
        isFinanciallyFinal: false,
        intervals: [{ preliminaryReasons: ["SOURCE_INCOMPLETE"] }],
      },
    });
    const final = resolveWbPnlAvailability({
      dateFrom,
      dateTo,
      source: { isFinanciallyFinal: true, intervals: [] },
    });
    assert.equal(preliminary.status, "AVAILABLE");
    assert.equal(preliminary.kind, "PRELIMINARY");
    assert.equal(final.status, "AVAILABLE");
    assert.equal(final.kind, "FINAL");
  }
});

test("complete August month is AVAILABLE FINAL when ownership is final", () => {
  const availability = resolveWbPnlAvailability({
    dateFrom: "2026-08-01",
    dateTo: "2026-08-31",
    source: { isFinanciallyFinal: true, intervals: [] },
  });
  assert.equal(availability.status, "AVAILABLE");
  assert.equal(availability.kind, "FINAL");
  assert.equal(wbDependentRatioPercent(availability, 500, 10000), 5);
});
