import { mondaySundayWeekContainingDate } from "@/lib/wb/closedWeekFinalizer";
import type { CompletenessActionPlan } from "./watchdog";

export type ExactPeriodHealScope = {
  missingDate: string;
  wbWeek: { dateFrom: string; dateTo: string } | null;
  ozonExactDate: string | null;
  dailyOperationalDate: string | null;
};

/**
 * Map a completeness hole on date D to exact repair scopes.
 * WB historical holes repair the Monday–Sunday week containing D.
 * Ozon holes replay exact D only (never a rolling generic window).
 */
export function buildExactPeriodHealScope(input: {
  missingDate: string;
  plan: CompletenessActionPlan;
}): ExactPeriodHealScope {
  const missingDate = String(input.missingDate).trim();
  return {
    missingDate,
    wbWeek: input.plan.retryWbClosedWeek
      ? mondaySundayWeekContainingDate(missingDate)
      : null,
    ozonExactDate: input.plan.retryOzonReplay ? missingDate : null,
    dailyOperationalDate: input.plan.retryDailyOperational ? missingDate : null,
  };
}
