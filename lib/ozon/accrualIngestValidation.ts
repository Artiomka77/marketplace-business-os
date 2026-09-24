import type { OzonAccrualByDayResult } from "@/lib/ozon/accrualByDay";
import {
  planOzonAccrualIngest,
  type OzonAccrualIngestPlan,
} from "@/lib/ozon/accrualIngestPolicy";

const GROSS_TOLERANCE = 0.01;

const HARD_COVERAGE_PREFIXES = [
  "MISSING_API_ENVELOPE:",
  "API_HTTP_NOT_OK:",
  "NO_API_PAGES:",
  "PAGINATION_INCOMPLETE:",
] as const;

function startOfUtcDay(value: Date) {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

function expectedDayCount(dateFrom: Date, dateTo: Date) {
  return (
    Math.round(
      (startOfUtcDay(dateTo).getTime() - startOfUtcDay(dateFrom).getTime()) /
        86_400_000,
    ) + 1
  );
}

function isHardCoverageEvidence(item: string) {
  return HARD_COVERAGE_PREFIXES.some((prefix) => item.startsWith(prefix));
}

export function listUtcDatesInclusive(dateFrom: Date, dateTo: Date) {
  const from = startOfUtcDay(dateFrom);
  const to = startOfUtcDay(dateTo);
  const dates: string[] = [];
  for (let time = from.getTime(); time <= to.getTime(); time += 86_400_000) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * Unknown types may explain mapper gross difference only by their exact
 * source amounts. Known canonical facts already include excluded non-P&L
 * groups when those types are mapped; they must not be counted twice.
 */
export function unexplainedOzonGrossDifference(
  mapped: OzonAccrualByDayResult,
): number {
  const unknownSourceAmount = mapped.diagnostics.unknownMeaningfulTypeIds.reduce(
    (sum, item) => sum + item.amount,
    0,
  );
  return Number(
    (mapped.diagnostics.grossExpenseDifference - unknownSourceAmount).toFixed(2),
  );
}

export type OzonCanonicalPersistPlan = {
  ingestPlan: OzonAccrualIngestPlan;
  persistDates: string[];
  pendingDates: string[];
  fakeZeroDates: string[];
  abortEntireWindow: false;
  windowPartial: boolean;
  unexplainedGross: boolean;
  expectedDays: number;
  mappedDayCount: number;
};

/**
 * Corrected ingest validation:
 * - HARD fail-closed: unresolved type71, unknownMeaningfulTypeIds, 0 mapped days,
 *   structural API coverage failures
 * - ALLOW PRELIMINARY persist: unexplained gross != 0, partial rolling window
 */
export function validateOzonAccrualIngest(params: {
  mapped: OzonAccrualByDayResult;
  dateFrom: Date;
  dateTo: Date;
  requestedDates?: string[];
}): OzonAccrualIngestPlan {
  return planCanonicalOzonAccrualPersist(params).ingestPlan;
}

export function planCanonicalOzonAccrualPersist(params: {
  mapped: OzonAccrualByDayResult;
  dateFrom: Date;
  dateTo: Date;
  requestedDates?: string[];
}): OzonCanonicalPersistPlan {
  const { mapped } = params;
  const requestedDates = params.requestedDates ?? [];
  const expectedDays = expectedDayCount(params.dateFrom, params.dateTo);
  const mappedDayCount = mapped.days.length;

  if (requestedDates.length > 0 && requestedDates.length !== expectedDays) {
    throw new Error(
      `Ozon /by-day fail-closed: coverage incomplete: requested ${requestedDates.length} days instead of ${expectedDays}`,
    );
  }

  const coverage = mapped.diagnostics.apiCoverage;
  if (requestedDates.length > 0 && !coverage) {
    throw new Error(
      "Ozon /by-day fail-closed: coverage incomplete: missing API envelope evidence",
    );
  }
  if (coverage) {
    const hardCoverage = coverage.missingEvidence.filter(isHardCoverageEvidence);
    if (hardCoverage.length > 0) {
      throw new Error(
        `Ozon /by-day fail-closed: coverage incomplete: ${hardCoverage.join(",")}`,
      );
    }
  }

  if (mapped.diagnostics.unresolvedType71Groups.length > 0) {
    throw new Error(
      `Ozon /by-day fail-closed: SellerReturns mapping unresolved: ${JSON.stringify(mapped.diagnostics.unresolvedType71Groups)}`,
    );
  }

  // HARD fail-closed: unknown meaningful types never become trusted canonical facts.
  if (mapped.diagnostics.unknownMeaningfulTypeIds.length > 0) {
    throw new Error(
      `Ozon /by-day contains unknown accrual types: ${JSON.stringify(
        mapped.diagnostics.unknownMeaningfulTypeIds,
      )}`,
    );
  }

  if (mappedDayCount === 0) {
    throw new Error(
      `Ozon /by-day returned 0 mapped days instead of ${expectedDays}`,
    );
  }

  const unexplainedGrossValue = unexplainedOzonGrossDifference(mapped);
  const unexplainedGross = Math.abs(unexplainedGrossValue) > GROSS_TOLERANCE;
  const expectedDates = listUtcDatesInclusive(params.dateFrom, params.dateTo);
  const persistDates = mapped.days.map((day) => day.date);
  const pendingDates = expectedDates.filter((date) => !persistDates.includes(date));
  const windowPartial = pendingDates.length > 0 || mappedDayCount !== expectedDays;

  const ingestPlan = planOzonAccrualIngest({
    coverageComplete:
      mapped.coverageComplete && !windowPartial && !unexplainedGross,
    unknownMeaningfulTypeIds: [],
    unresolvedType71Groups: [],
    grossExpenseDifference: unexplainedGrossValue,
  });

  return {
    ingestPlan,
    persistDates,
    pendingDates,
    fakeZeroDates: [],
    abortEntireWindow: false,
    windowPartial,
    unexplainedGross,
    expectedDays,
    mappedDayCount,
  };
}

/** @deprecated alias kept for older tests — prefer planCanonicalOzonAccrualPersist */
export function validateMappedResult(params: {
  mapped: OzonAccrualByDayResult;
  dateFrom: Date;
  dateTo: Date;
  requestedDates?: string[];
}) {
  const plan = planCanonicalOzonAccrualPersist(params);
  return {
    ...plan.ingestPlan,
    windowPartial: plan.windowPartial,
    expectedDays: plan.expectedDays,
    mappedDayCount: plan.mappedDayCount,
    unexplainedGross: plan.unexplainedGross,
  };
}
