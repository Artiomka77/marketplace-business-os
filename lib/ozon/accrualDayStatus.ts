import { isOzonFinanciallyFinalStatus } from "@/lib/ozon/accrualIngestPolicy";

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

export function dayStatusKey(companyName: string, date: string) {
  return `${companyName}|${date}`;
}

export function normalizeOzonAccrualDayDataMode(
  value: unknown,
): OzonAccrualDayDataMode {
  const raw = String(value ?? "");
  if (raw === "FINAL_WITH_UNCLASSIFIED") return "FINAL_WITH_UNCLASSIFIED";
  if (raw === "FINAL") return "FINAL";
  return "PRELIMINARY";
}

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

export function isProtectedFinalOzonDayStatus(
  row: Pick<OzonAccrualDayStatusRecord, "dataMode" | "phase"> | null | undefined,
): boolean {
  return (
    isOzonFinanciallyFinalStatus(row?.dataMode) && row?.phase === "CANONICAL"
  );
}

/**
 * RAW staging must never downgrade a previously valid FINAL canonical day
 * when a multi-day range later fails (e.g. unknown type on D while D-1/D-2
 * were already FINAL). Only dates that are not already FINAL+CANONICAL
 * receive RAW_PHASE status rows.
 */
export function selectDatesForRawDayStatus(params: {
  dates: string[];
  existingByDate: Map<
    string,
    Pick<OzonAccrualDayStatusRecord, "dataMode" | "phase">
  >;
}): string[] {
  return params.dates.filter((date) => {
    const existing = params.existingByDate.get(date);
    return !isProtectedFinalOzonDayStatus(existing);
  });
}

export function buildRawOzonDayStatuses(params: {
  companyName: string;
  dates: string[];
  importSessionId: string;
  payloadSha256?: string | null;
  quarantineCount?: number;
}): OzonAccrualDayStatusRecord[] {
  return params.dates.map((date) => ({
    companyName: params.companyName,
    date,
    importSessionId: params.importSessionId,
    dataMode: "PRELIMINARY",
    coverageComplete: false,
    quarantineCount: params.quarantineCount ?? 0,
    missingEvidence: ["RAW_PHASE"],
    payloadSha256: params.payloadSha256 ?? null,
    phase: "RAW",
  }));
}

export function buildUnclassifiedMissingEvidence(
  unclassified: Array<{ amount?: number | null }>,
): string[] {
  if (!unclassified.length) return [];
  const absSum = unclassified.reduce(
    (sum, item) => sum + Math.abs(Number(item.amount ?? 0)),
    0,
  );
  const rounded = Number(absSum.toFixed(2));
  return [`UNCLASSIFIED_ADJUSTMENT:${rounded}`];
}

/** Parse owner-facing abs amount from missingEvidence tokens. */
export function parseUnclassifiedAdjustmentAmount(
  missingEvidence: string[] | null | undefined,
): number | null {
  if (!missingEvidence?.length) return null;
  let total = 0;
  let found = false;
  for (const item of missingEvidence) {
    const m = String(item).match(
      /UNCLASSIFIED_ADJUSTMENT(?::(\d+(?:\.\d+)?))?/i,
    );
    if (!m) continue;
    found = true;
    if (m[1]) total += Number(m[1]);
  }
  if (!found) return null;
  return Number(total.toFixed(2));
}

export function formatOzonUnclassifiedOwnerWarning(amountAbs: number): string {
  const formatted = new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(Math.abs(amountAbs));
  return `Ozon: ${formatted} ₽ пока без категории`;
}

export function buildCanonicalOzonDayStatuses(params: {
  companyName: string;
  dates: string[];
  importSessionId: string;
  payloadSha256?: string | null;
  dataMode: OzonAccrualDayDataMode | string;
  coverageComplete: boolean;
  quarantineCount: number;
  missingEvidence?: string[];
}): OzonAccrualDayStatusRecord[] {
  const dataMode = normalizeOzonAccrualDayDataMode(params.dataMode);
  const financiallyFinal = isOzonFinanciallyFinalStatus(dataMode);
  const missingEvidence = financiallyFinal
    ? dataMode === "FINAL_WITH_UNCLASSIFIED"
      ? params.missingEvidence && params.missingEvidence.length > 0
        ? params.missingEvidence
        : ["UNCLASSIFIED_ADJUSTMENT"]
      : []
    : params.missingEvidence && params.missingEvidence.length > 0
      ? params.missingEvidence
      : ["OZON_INGEST_PRELIMINARY"];
  return params.dates.map((date) => ({
    companyName: params.companyName,
    date,
    importSessionId: params.importSessionId,
    dataMode,
    coverageComplete: params.coverageComplete && financiallyFinal,
    quarantineCount: params.quarantineCount,
    missingEvidence,
    payloadSha256: params.payloadSha256 ?? null,
    phase: "CANONICAL",
  }));
}

export function upsertOzonDayStatusRecords(
  store: Map<string, OzonAccrualDayStatusRecord>,
  records: OzonAccrualDayStatusRecord[],
) {
  for (const record of records) {
    store.set(dayStatusKey(record.companyName, record.date), record);
  }
}

export function listOzonDayStatusRecords(params: {
  store: Map<string, OzonAccrualDayStatusRecord>;
  companyName?: string | null;
  dateFrom: string;
  dateTo: string;
}) {
  const dates = new Set(listInclusiveDateStrings(params.dateFrom, params.dateTo));
  return [...params.store.values()].filter((row) => {
    if (!dates.has(row.date)) return false;
    if (params.companyName && params.companyName !== "ALL") {
      return row.companyName === params.companyName;
    }
    return true;
  });
}
