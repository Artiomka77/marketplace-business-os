export type OzonUnknownTypeEvidence = {
  typeId: number;
  rows?: number;
  amount?: number;
  name?: string | null;
  description?: string | null;
};

export type OzonAccrualIngestStatus =
  | "FINAL"
  | "FINAL_WITH_UNCLASSIFIED"
  | "PRELIMINARY";

export type OzonAccrualIngestPlan = {
  persistRawEvidence: true;
  persistKnownFacts: true;
  abortEntireDay: false;
  /** Monetary-unsafe unknowns only (ambiguous/corrupt). */
  quarantine: OzonUnknownTypeEvidence[];
  /** Clear signed unknowns kept analytically unclassified. */
  unclassifiedAdjustments: OzonUnknownTypeEvidence[];
  coverageComplete: boolean;
  failFinality: boolean;
  replayAfterMapperUpdate: boolean;
  status: OzonAccrualIngestStatus;
};

export function isOzonFinanciallyFinalStatus(
  status: string | null | undefined,
): boolean {
  return status === "FINAL" || status === "FINAL_WITH_UNCLASSIFIED";
}

export function planOzonAccrualIngest(input: {
  coverageComplete: boolean;
  unknownMeaningfulTypeIds?: Array<{
    typeId?: number;
    rows?: number;
    amount?: number;
    name?: string | null;
    description?: string | null;
  }>;
  unclassifiedAdjustments?: Array<{
    typeId?: number;
    rows?: number;
    amount?: number;
    name?: string | null;
    description?: string | null;
  }>;
  unresolvedType71Groups?: unknown[];
  grossExpenseDifference?: number;
}): OzonAccrualIngestPlan {
  const unknown: OzonUnknownTypeEvidence[] = (
    input.unknownMeaningfulTypeIds ?? []
  ).map((item) => ({
    typeId: Number(item.typeId ?? 0),
    rows: item.rows,
    amount: item.amount,
    name: item.name,
    description: item.description,
  }));
  const unclassified: OzonUnknownTypeEvidence[] = (
    input.unclassifiedAdjustments ?? []
  ).map((item) => ({
    typeId: Number(item.typeId ?? 0),
    rows: item.rows,
    amount: item.amount,
    name: item.name,
    description: item.description,
  }));
  const hardFailure =
    (input.unresolvedType71Groups?.length ?? 0) > 0 ||
    Math.abs(input.grossExpenseDifference ?? 0) > 0.01 ||
    unknown.length > 0;
  // Unclassified-but-signed does NOT fail monetary finality.
  const failFinality = hardFailure || !input.coverageComplete;
  const status: OzonAccrualIngestStatus = failFinality
    ? "PRELIMINARY"
    : unclassified.length > 0
      ? "FINAL_WITH_UNCLASSIFIED"
      : "FINAL";

  return {
    persistRawEvidence: true,
    persistKnownFacts: true,
    abortEntireDay: false,
    quarantine: unknown,
    unclassifiedAdjustments: unclassified,
    coverageComplete: !failFinality,
    failFinality,
    replayAfterMapperUpdate: unknown.length > 0,
    status,
  };
}

export function shouldAbortOzonDayIngest(plan: OzonAccrualIngestPlan) {
  return plan.abortEntireDay;
}
