import { listInclusiveDateStrings } from "@/lib/ozon/accrualDayStatus";

export type OzonRealizationIntervalRow = {
  companyName: string | null;
  dateFrom: Date | string;
  dateTo: Date | string;
  contractNumber?: string | null;
};

function toIsoDate(value: Date | string): string {
  if (typeof value === "string") {
    return value.slice(0, 10);
  }
  return value.toISOString().slice(0, 10);
}

/**
 * Expand official OzonRealizationSummary intervals into company-date keys.
 * Official realization is an approved monetary source for historical months
 * that pre-date AccrualDayStatus day rows.
 */
export function expandOzonRealizationCoveredDates(
  intervals: OzonRealizationIntervalRow[],
): Set<string> {
  const covered = new Set<string>();
  for (const row of intervals) {
    const companyName = String(row.companyName ?? "").trim();
    if (!companyName) continue;
    const dateFrom = toIsoDate(row.dateFrom);
    const dateTo = toIsoDate(row.dateTo);
    if (!dateFrom || !dateTo) continue;
    for (const date of listInclusiveDateStrings(dateFrom, dateTo)) {
      covered.add(`${companyName}|${date}`);
    }
  }
  return covered;
}

export function isOzonRealizationCoveredDate(
  covered: Set<string> | null | undefined,
  companyName: string,
  date: string,
): boolean {
  if (!covered || covered.size === 0) return false;
  return covered.has(`${companyName}|${date}`);
}

export type OzonRealizationCoverageClient = {
  $queryRaw: <T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<T>;
};

/**
 * Load official realization intervals fully inside [dateFrom, dateTo].
 * Any persisted OzonRealizationSummary row is an approved official artifact
 * (report import or accrual-by-day API materialization).
 */
export async function loadOzonRealizationCoveredDates(input: {
  client: OzonRealizationCoverageClient;
  dateFrom: string;
  dateTo: string;
  companyNames?: string[] | null;
}): Promise<Set<string>> {
  const allow = new Set(
    (input.companyNames ?? [])
      .map((name) => String(name ?? "").trim())
      .filter(Boolean),
  );

  const intervals = await input.client.$queryRaw<OzonRealizationIntervalRow[]>`
    SELECT
      "companyName",
      "dateFrom"::date AS "dateFrom",
      "dateTo"::date AS "dateTo",
      "contractNumber"
    FROM "OzonRealizationSummary"
    WHERE "dateFrom"::date >= CAST(${input.dateFrom} AS date)
      AND "dateTo"::date <= CAST(${input.dateTo} AS date)
  `;

  const scoped =
    allow.size === 0
      ? intervals
      : intervals.filter((row) =>
          allow.has(String(row.companyName ?? "").trim()),
        );

  return expandOzonRealizationCoveredDates(scoped);
}
