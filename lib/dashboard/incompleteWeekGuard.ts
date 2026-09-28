import type { DataReadinessSummary } from "@/lib/analytics/dataReadiness";

export type DashboardWeekPresentation = {
  mayPresentAsFinal: boolean;
  status: "FINAL" | "PRELIMINARY" | "INCOMPLETE";
  reason: string | null;
  badgeText: string | null;
};

function parseIso(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

export function isClosedWeekPeriod(dateFrom: string, dateTo: string, now = new Date()) {
  const start = parseIso(dateFrom);
  const end = parseIso(dateTo);
  const days = Math.round((end - start) / 86_400_000) + 1;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return days >= 7 && end < today;
}

/**
 * Loans V4 / Wave A incomplete-week presentation.
 * Optional inputs restore the certified FC Dashboard contract:
 * canonicalDataMode, wbExactCoverComplete, ozonCoverageComplete, ozonQuarantineCount.
 */
export function evaluateDashboardIncompleteWeek(input: {
  dateFrom: string;
  dateTo: string;
  dataReadiness?: Pick<DataReadinessSummary, "isFinal" | "status" | "issues"> | null;
  wbExactCoverComplete?: boolean | null;
  canonicalDataMode?: "FINAL" | "PRELIMINARY" | null;
  ozonCoverageComplete?: boolean | null;
  ozonQuarantineCount?: number | null;
  now?: Date;
}): DashboardWeekPresentation {
  const closedWeek = isClosedWeekPeriod(input.dateFrom, input.dateTo, input.now);
  const financeMissing =
    input.dataReadiness?.issues?.some((issue) => issue.kind === "WB_FINANCE_MISSING") === true;
  const exactCover =
    input.wbExactCoverComplete === true ||
    (input.wbExactCoverComplete == null && input.dataReadiness?.isFinal === true && !financeMissing);
  const readinessIncomplete =
    input.dataReadiness?.isFinal === false ||
    input.dataReadiness?.status === "incomplete" ||
    input.dataReadiness?.status === "preliminary";
  const ozonQuarantine =
    typeof input.ozonQuarantineCount === "number" && input.ozonQuarantineCount > 0;
  const ozonCoverageBlocked = input.ozonCoverageComplete === false;
  const canonicalPreliminary = input.canonicalDataMode === "PRELIMINARY";

  if (closedWeek && (input.wbExactCoverComplete === false || financeMissing)) {
    return {
      mayPresentAsFinal: false,
      status: "INCOMPLETE",
      reason: "WB_EXACT_WEEK_COVER_MISSING",
      badgeText: "WB неделя неполная / PRELIMINARY",
    };
  }

  if (closedWeek && !exactCover && readinessIncomplete) {
    return {
      mayPresentAsFinal: false,
      status: "INCOMPLETE",
      reason: "WB_CLOSED_WEEK_NOT_FINAL",
      badgeText: "WB неделя предварительная",
    };
  }

  if (ozonQuarantine) {
    return {
      mayPresentAsFinal: false,
      status: "PRELIMINARY",
      reason: "OZON_QUARANTINE_ACTIVE",
      badgeText: "Ozon quarantine / PRELIMINARY",
    };
  }

  if (ozonCoverageBlocked) {
    return {
      mayPresentAsFinal: false,
      status: "PRELIMINARY",
      reason: "OZON_COVERAGE_INCOMPLETE",
      badgeText: "Ozon coverage / PRELIMINARY",
    };
  }

  if (canonicalPreliminary) {
    return {
      mayPresentAsFinal: false,
      status: "PRELIMINARY",
      reason: "CANONICAL_DATA_MODE_PRELIMINARY",
      badgeText: "PRELIMINARY",
    };
  }

  if (input.dataReadiness?.isFinal === true && exactCover) {
    return {
      mayPresentAsFinal: true,
      status: "FINAL",
      reason: null,
      badgeText: null,
    };
  }

  return {
    mayPresentAsFinal: false,
    status: "PRELIMINARY",
    reason: "PERIOD_NOT_FINAL",
    badgeText: input.dataReadiness?.status === "incomplete" ? "Данные неполные" : "PRELIMINARY",
  };
}
