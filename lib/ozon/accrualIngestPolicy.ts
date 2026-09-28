export type OzonUnknownTypeEvidence = {
  typeId: number;
  rows?: number;
  amount?: number;
  name?: string | null;
  description?: string | null;
};

export type OzonAccrualIngestPlan = {
  persistRawEvidence: true;
  persistKnownFacts: true;
  abortEntireDay: false;
  quarantine: OzonUnknownTypeEvidence[];
  coverageComplete: boolean;
  failFinality: boolean;
  replayAfterMapperUpdate: boolean;
  status: "FINAL" | "PRELIMINARY";
};

export function planOzonAccrualIngest(input: {
  coverageComplete: boolean;
  unknownMeaningfulTypeIds?: Array<{
    typeId?: number;
    rows?: number;
    amount?: number;
    name?: string | null;
    description?: string | null;
  }>;
  unresolvedType71Groups?: unknown[];
  grossExpenseDifference?: number;
}): OzonAccrualIngestPlan {
  const unknown: OzonUnknownTypeEvidence[] = (input.unknownMeaningfulTypeIds ?? []).map((item) => ({
    typeId: Number(item.typeId ?? 0),
    rows: item.rows,
    amount: item.amount,
    name: item.name,
    description: item.description,
  }));
  const hardFailure =
    (input.unresolvedType71Groups?.length ?? 0) > 0 ||
    Math.abs(input.grossExpenseDifference ?? 0) > 0.01;
  const failFinality = hardFailure || unknown.length > 0 || !input.coverageComplete;

  return {
    persistRawEvidence: true,
    persistKnownFacts: true,
    abortEntireDay: false,
    quarantine: unknown,
    coverageComplete: !failFinality,
    failFinality,
    replayAfterMapperUpdate: unknown.length > 0,
    status: failFinality ? "PRELIMINARY" : "FINAL",
  };
}

export function shouldAbortOzonDayIngest(plan: OzonAccrualIngestPlan) {
  return plan.abortEntireDay;
}
