export type OzonSourceFreshnessState =
  | "READY"
  | "PRELIMINARY"
  | "PENDING"
  | "FAILED";

export type OzonDailySourceFreshnessRow = {
  companyName: string;
  date: string;
  state: OzonSourceFreshnessState;
  reason: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function previewMentionsDate(
  preview: Record<string, unknown> | null,
  date: string,
): boolean {
  if (!preview) return false;
  const dateFrom = String(preview.dateFrom ?? "");
  const dateTo = String(preview.dateTo ?? "");
  if (dateFrom && dateTo && dateFrom <= date && dateTo >= date) return true;
  const persisted = preview.persistedDays;
  if (Array.isArray(persisted) && persisted.map(String).includes(date)) {
    return true;
  }
  return false;
}

/**
 * Four-state Ozon exact-day freshness.
 * Never promote to READY from hasCanonical alone.
 */
export function classifyOzonDailySourceFreshness(input: {
  companyName: string;
  date: string;
  realizationRowCount: number;
  latestImportStatus: string | null;
  latestJobError: string | null;
  latestIngestStatus?: string | null;
  latestFailFinality?: boolean | null;
  latestGrossExpenseDifference?: number | null;
  latestCoverageComplete?: boolean | null;
  previewJson?: unknown;
}): OzonDailySourceFreshnessRow {
  const status = String(input.latestImportStatus ?? "").toUpperCase();
  const jobError = String(input.latestJobError ?? "").trim();
  const hasCanonical = input.realizationRowCount > 0;
  const preview = asRecord(input.previewJson);
  const ingestStatus = String(
    input.latestIngestStatus ?? preview?.ingestStatus ?? "",
  ).toUpperCase();
  const failFinality =
    input.latestFailFinality === true || preview?.failFinality === true;
  const diagnostics = asRecord(preview?.diagnostics);
  const grossDiff = Number(
    input.latestGrossExpenseDifference ??
      diagnostics?.grossExpenseDifference ??
      0,
  );
  const coverageComplete =
    typeof input.latestCoverageComplete === "boolean"
      ? input.latestCoverageComplete
      : typeof preview?.coverageComplete === "boolean"
        ? preview.coverageComplete
        : null;

  const structuralFailed =
    status === "RAW_PERSISTED" ||
    status === "FAILED" ||
    /fail-closed|unresolved|unknown accrual types|SellerReturns mapping unresolved|reconciliation failed/i.test(
      `${status} ${jobError}`,
    );

  if (!hasCanonical && structuralFailed) {
    return {
      companyName: input.companyName,
      date: input.date,
      state: "FAILED",
      reason: jobError || "canonical persist aborted after raw evidence",
    };
  }

  if (!hasCanonical) {
    return {
      companyName: input.companyName,
      date: input.date,
      state: "PENDING",
      reason: "no canonical realization and no failed overlay evidence",
    };
  }

  const unexplainedGross = Math.abs(grossDiff) > 0.01;
  const isPreliminary =
    ingestStatus === "PRELIMINARY" ||
    failFinality ||
    unexplainedGross ||
    coverageComplete === false;

  if (isPreliminary) {
    return {
      companyName: input.companyName,
      date: input.date,
      state: "PRELIMINARY",
      reason: unexplainedGross
        ? `canonical known facts with unresolved gross difference ${grossDiff}`
        : "canonical known facts with PRELIMINARY ingest / incomplete coverage",
    };
  }

  const provenFinal =
    status === "SUCCESS" &&
    ingestStatus === "FINAL" &&
    failFinality === false &&
    !unexplainedGross &&
    coverageComplete === true;

  if (provenFinal) {
    return {
      companyName: input.companyName,
      date: input.date,
      state: "READY",
      reason: "canonical realization with FINAL ingest",
    };
  }

  // Canonical exists but FINAL ingest is not proven — never READY via hasCanonical.
  return {
    companyName: input.companyName,
    date: input.date,
    state: "PRELIMINARY",
    reason: "canonical present but FINAL ingest not proven",
  };
}

export function formatOzonSourceFreshnessBlock(
  rows: OzonDailySourceFreshnessRow[],
) {
  if (rows.length === 0) return "";
  return [
    "Ozon источник (свежесть):",
    ...rows.map(
      (row) =>
        `${row.companyName} ${row.date}: ${row.state}${
          row.reason ? ` — ${row.reason}` : ""
        }`,
    ),
  ].join("\n");
}

export function previewJsonMentionsExactDate(
  previewJson: unknown,
  date: string,
) {
  return previewMentionsDate(asRecord(previewJson), date);
}
