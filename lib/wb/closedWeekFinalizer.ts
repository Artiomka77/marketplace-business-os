export const WB_CLOSED_WEEK_OWNER = "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS";

export type WbClosedWeekReport = {
  reportId: string;
  dateFrom?: string;
  dateTo?: string;
  kind?: "main" | "buyout" | "unknown";
};

export type WbClosedWeekPlan = {
  period: { dateFrom: string; dateTo: string };
  reportIds: string[];
  listedReports: WbClosedWeekReport[];
  missingExpectedIds: string[];
  alreadyPersistedIds: string[];
  idsToFetch: string[];
  complete: boolean;
  status: "FINAL" | "PRELIMINARY";
  ownerIfComplete: typeof WB_CLOSED_WEEK_OWNER;
  presentPartialAsFinal: false;
  manualFilesRequired: false;
};

export function planWbClosedWeekFinalize(input: {
  dateFrom: string;
  dateTo: string;
  listedReports: WbClosedWeekReport[];
  persistedReportIds?: string[];
  expectedReportIds?: string[];
}): WbClosedWeekPlan {
  const listedIds = unique(input.listedReports.map((row) => row.reportId));
  const persisted = new Set((input.persistedReportIds ?? []).map(String));
  const expected = unique(input.expectedReportIds ?? listedIds);
  const missingExpectedIds = expected.filter((id) => !listedIds.includes(id) && !persisted.has(id));
  const idsToFetch = listedIds.filter((id) => !persisted.has(id));
  const allExpectedPresent =
    expected.length > 0 &&
    expected.every((id) => listedIds.includes(id) || persisted.has(id));
  const complete = allExpectedPresent && idsToFetch.length === 0 && missingExpectedIds.length === 0;

  return {
    period: { dateFrom: input.dateFrom, dateTo: input.dateTo },
    reportIds: listedIds,
    listedReports: listedIds.map((reportId) => ({ reportId })),
    missingExpectedIds,
    alreadyPersistedIds: expected.filter((id) => persisted.has(id)),
    idsToFetch,
    complete,
    status: complete ? "FINAL" : "PRELIMINARY",
    ownerIfComplete: WB_CLOSED_WEEK_OWNER,
    presentPartialAsFinal: false,
    manualFilesRequired: false,
  };
}

export function closedWeekDashboardRule(plan: WbClosedWeekPlan) {
  return {
    mayPresentAsFinal: plan.status === "FINAL" && plan.complete,
    fallbackToLatestDayForbidden: true,
    owner: plan.complete ? WB_CLOSED_WEEK_OWNER : "PRELIMINARY",
  };
}

export function lastClosedMondaySundayWeek(now = new Date()) {
  const moscow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const weekday = moscow.getUTCDay();
  const daysSinceSunday = weekday === 0 ? 7 : weekday;
  const lastSunday = new Date(
    Date.UTC(moscow.getUTCFullYear(), moscow.getUTCMonth(), moscow.getUTCDate() - daysSinceSunday),
  );
  const lastMonday = new Date(lastSunday);
  lastMonday.setUTCDate(lastSunday.getUTCDate() - 6);
  return {
    dateFrom: lastMonday.toISOString().slice(0, 10),
    dateTo: lastSunday.toISOString().slice(0, 10),
  };
}

/**
 * Monday–Sunday week that contains the given calendar date (YYYY-MM-DD).
 * Used for historical WB holes so healers retry the missing week, not "latest closed".
 */
export function mondaySundayWeekContainingDate(dateText: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText).trim());
  if (!match) {
    throw new Error(`Invalid date for week scope: ${dateText}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcNoon = new Date(Date.UTC(year, month - 1, day, 12));
  const weekday = utcNoon.getUTCDay(); // 0=Sun .. 6=Sat
  const daysFromMonday = weekday === 0 ? 6 : weekday - 1;
  const monday = new Date(utcNoon);
  monday.setUTCDate(utcNoon.getUTCDate() - daysFromMonday);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return {
    dateFrom: monday.toISOString().slice(0, 10),
    dateTo: sunday.toISOString().slice(0, 10),
  };
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

export const planWbClosedWeekFinalizeAlias = planWbClosedWeekFinalize;
