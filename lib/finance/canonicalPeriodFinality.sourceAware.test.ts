import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOzonCanonicalIngestFinality,
  resolveOzonPeriodFinality,
} from "./canonicalPeriodFinality.ts";
import { expandOzonRealizationCoveredDates } from "../ozon/ozonRealizationCoverage.ts";

test("missing AccrualDayStatus blocks FINAL without realization coverage", () => {
  const ozon = resolveOzonPeriodFinality({
    companyName: "ИП Петров",
    dateFrom: "2026-01-01",
    dateTo: "2026-01-03",
    days: [],
  });
  assert.equal(ozon.dataMode, "PRELIMINARY");
  assert.ok(
    ozon.missingEvidence.some((item) =>
      item.startsWith("MISSING_OZON_ACCRUAL_DAY_STATUS:"),
    ),
  );
});

test("official realization coverage alone can make historical days FINAL", () => {
  const realizationCoveredDates = expandOzonRealizationCoveredDates([
    {
      companyName: "ИП Петров",
      dateFrom: "2026-01-01",
      dateTo: "2026-01-03",
      contractNumber: "OZON_ACCRUALS_REPORT",
    },
  ]);
  const ozon = resolveOzonPeriodFinality({
    companyName: "ИП Петров",
    dateFrom: "2026-01-01",
    dateTo: "2026-01-03",
    days: [],
    realizationCoveredDates,
  });
  assert.equal(ozon.dataMode, "FINAL");
  assert.equal(ozon.coverageComplete, true);
  assert.equal(ozon.quarantineCount, 0);

  const totals = applyOzonCanonicalIngestFinality(
    {
      netProfitStatus: "FINAL" as const,
      taxRevenueCoverageComplete: true,
      discountPointsCoverageComplete: true,
    },
    ozon,
  );
  assert.equal(totals.netProfitStatus, "FINAL");
});

test("present incomplete AccrualDayStatus still blocks even if realization covers", () => {
  const realizationCoveredDates = expandOzonRealizationCoveredDates([
    {
      companyName: "ИП Лебедева",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-01",
    },
  ]);
  const ozon = resolveOzonPeriodFinality({
    companyName: "ИП Лебедева",
    dateFrom: "2026-08-01",
    dateTo: "2026-08-01",
    days: [
      {
        companyName: "ИП Лебедева",
        date: "2026-08-01",
        importSessionId: "sess-1",
        dataMode: "PRELIMINARY",
        coverageComplete: false,
        quarantineCount: 0,
        missingEvidence: ["OZON_DAY_INCOMPLETE"],
        phase: "CANONICAL",
      },
    ],
    realizationCoveredDates,
  });
  assert.equal(ozon.dataMode, "PRELIMINARY");
});
