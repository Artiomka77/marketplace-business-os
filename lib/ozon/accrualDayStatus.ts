export type OzonAccrualDayDataMode = "FINAL" | "PRELIMINARY";

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

export function buildCanonicalOzonDayStatuses(params: {
  companyName: string;
  dates: string[];
  importSessionId: string;
  payloadSha256?: string | null;
  dataMode: OzonAccrualDayDataMode;
  coverageComplete: boolean;
  quarantineCount: number;
  missingEvidence?: string[];
}): OzonAccrualDayStatusRecord[] {
  const missingEvidence =
    params.dataMode === "FINAL"
      ? []
      : params.missingEvidence && params.missingEvidence.length > 0
        ? params.missingEvidence
        : ["OZON_INGEST_PRELIMINARY"];
  return params.dates.map((date) => ({
    companyName: params.companyName,
    date,
    importSessionId: params.importSessionId,
    dataMode: params.dataMode === "FINAL" ? "FINAL" : "PRELIMINARY",
    coverageComplete: params.coverageComplete && params.dataMode === "FINAL",
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
