export type OzonAccrualDayDataMode =
  | "FINAL"
  | "FINAL_WITH_UNCLASSIFIED"
  | "PRELIMINARY";

export type OzonAccrualDayStatusRecord = {
  companyName: string;
  date: string;
  importSessionId: string;
  dataMode: OzonAccrualDayDataMode;
  coverageComplete: boolean;
  quarantineCount: number;
  missingEvidence: string[];
  payloadSha256?: string | null;
  phase: "RAW" | "CANONICAL";
};

export function listInclusiveDateStrings(dateFrom: string, dateTo: string) {
  const out: string[] = [];
  for (
    let cursor = new Date(`${dateFrom}T00:00:00.000Z`);
    cursor.getTime() <= new Date(`${dateTo}T00:00:00.000Z`).getTime();
    cursor = new Date(cursor.getTime() + 86_400_000)
  ) {
    out.push(cursor.toISOString().slice(0, 10));
  }
  return out;
}

export type OzonCanonicalCoverageWindow = {
  coveredThrough: string | null;
  coveredDates: string[];
  missingDates: string[];
  isPartial: boolean;
  hasCanonicalCovered: boolean;
};

function isFinalCompleteDay(
  row: OzonAccrualDayStatusRecord | undefined
): boolean {
  return (
    row != null &&
    (row.dataMode === "FINAL" || row.dataMode === "FINAL_WITH_UNCLASSIFIED") &&
    row.coverageComplete === true &&
    row.phase === "CANONICAL" &&
    row.quarantineCount === 0
  );
}

/**
 * True when FINAL canonical days exist after the contiguous prefix ends.
 * A mid-window hole must not hide later known FINAL money from analytics.
 */
export function hasOzonFinalDaysAfterCoveragePrefix(input: {
  companyName: string;
  dateFrom: string;
  dateTo: string;
  coveredThrough: string | null;
  days: OzonAccrualDayStatusRecord[];
}): boolean {
  if (!input.coveredThrough) return false;
  return input.days.some(
    (row) =>
      row.companyName === input.companyName &&
      row.date > input.coveredThrough! &&
      row.date >= input.dateFrom &&
      row.date <= input.dateTo &&
      isFinalCompleteDay(row),
  );
}

/**
 * Analytics end date for Dashboard/Telegram Ozon metrics.
 * - Trailing-only incompleteness → keep FINAL prefix (coveredThrough).
 * - Mid-window gap with later FINAL days → use full requestedDateTo so
 *   post-gap money is not truncated away (YTD_GATE Dashboard residual).
 * - No day-status prefix at all → requestedDateTo (Profit analytics owns history).
 */
export function resolveOzonAnalyticsDateTo(input: {
  requestedDateTo: string;
  coverageWindow: OzonCanonicalCoverageWindow;
  companyName: string;
  dateFrom: string;
  days: OzonAccrualDayStatusRecord[];
}): string {
  const { coverageWindow, requestedDateTo } = input;
  if (!coverageWindow.coveredThrough) {
    return requestedDateTo;
  }
  if (
    hasOzonFinalDaysAfterCoveragePrefix({
      companyName: input.companyName,
      dateFrom: input.dateFrom,
      dateTo: requestedDateTo,
      coveredThrough: coverageWindow.coveredThrough,
      days: input.days,
    })
  ) {
    return requestedDateTo;
  }
  return coverageWindow.coveredThrough;
}

/**
 * Longest prefix of requested dates where the company has FINAL canonical accrual.
 * Trailing open/missing days (e.g. today) must not erase the known prefix.
 */
export function resolveOzonCanonicalCoverageWindow(input: {
  companyName: string;
  dateFrom: string;
  dateTo: string;
  days: OzonAccrualDayStatusRecord[];
}): OzonCanonicalCoverageWindow {
  const expected = listInclusiveDateStrings(input.dateFrom, input.dateTo);
  const coveredDates: string[] = [];
  const missingDates: string[] = [];
  let prefixOpen = true;

  for (const date of expected) {
    const row = input.days.find(
      (item) => item.companyName === input.companyName && item.date === date
    );
    if (prefixOpen && isFinalCompleteDay(row)) {
      coveredDates.push(date);
      continue;
    }
    prefixOpen = false;
    missingDates.push(date);
  }

  const coveredThrough =
    coveredDates.length > 0 ? coveredDates[coveredDates.length - 1]! : null;

  return {
    coveredThrough,
    coveredDates,
    missingDates,
    isPartial: coveredThrough != null && missingDates.length > 0,
    hasCanonicalCovered: coveredThrough != null,
  };
}

function formatRuDayMonth(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${day}.${month}`;
}

/** Example: Ozon: финансовые данные готовы по 01–05.10; 06.10 ещё формируется */
export function formatOzonCoverageReadyThroughText(input: {
  coveredFrom: string;
  coveredThrough: string;
  missingDates: string[];
}): string {
  const [, fromMonth, fromDay] = input.coveredFrom.split("-");
  const [, throughMonth, throughDay] = input.coveredThrough.split("-");
  let range: string;
  if (input.coveredFrom === input.coveredThrough) {
    range = formatRuDayMonth(input.coveredThrough);
  } else if (fromMonth === throughMonth) {
    range = `${fromDay}–${throughDay}.${throughMonth}`;
  } else {
    range = `${formatRuDayMonth(input.coveredFrom)}–${formatRuDayMonth(input.coveredThrough)}`;
  }
  if (input.missingDates.length === 0) {
    return `Ozon: финансовые данные готовы по ${range}`;
  }
  const pending = input.missingDates.map(formatRuDayMonth).join(", ");
  const verb = input.missingDates.length === 1 ? "ещё формируется" : "ещё формируются";
  return `Ozon: финансовые данные готовы по ${range}; ${pending} ${verb}`;
}
