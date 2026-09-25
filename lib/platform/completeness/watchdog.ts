export type CompletenessSnapshot = {
  wbClosedWeekComplete: boolean;
  wbExactOwner: boolean;
  ozonCoverageComplete: boolean;
  ozonUnknownQuarantine: boolean;
  openDayDailyComplete: boolean;
};

export type CompletenessActionPlan = {
  retryWbClosedWeek: boolean;
  retryOzonReplay: boolean;
  retryDailyOperational: boolean;
  promotePreliminaryToFinal: boolean;
  markFinal: boolean;
  alertPersistentFailure: boolean;
  manualMarketplaceFilesRequired: false;
};

export function snapshotFromMissingReasons(input: {
  missingReasons: Array<{ marketplace?: string; dataType?: string }>;
  date: string;
  today?: Date;
}): CompletenessSnapshot {
  const reasons = input.missingReasons ?? [];
  const dataTypeOf = (reason: { dataType?: string }) => String(reason.dataType ?? "");
  const has = (marketplace: string, dataType?: string) =>
    reasons.some(
      (reason) =>
        reason.marketplace === marketplace &&
        (!dataType || dataTypeOf(reason).includes(dataType)),
    );
  const closedWeek = isLikelyClosedWeekDate(input.date, input.today);
  const wbSalesMissing = has("WB", "SALES") || has("WB", "FINANCE");
  const ozonMissing =
    has("OZON", "SALES") ||
    has("OZON", "OZON_ECONOMIC_TOTALS") ||
    has("OZON", "UNKNOWN");

  return {
    wbClosedWeekComplete: !(closedWeek && wbSalesMissing),
    wbExactOwner: !(closedWeek && wbSalesMissing),
    ozonCoverageComplete: !ozonMissing,
    ozonUnknownQuarantine: has("OZON", "UNKNOWN"),
    openDayDailyComplete: !reasons.some((reason) => reason.marketplace !== "WB" || !closedWeek),
  };
}

export function planCompletenessSelfHeal(
  snapshot: CompletenessSnapshot,
  options?: { persistentFailureAttempts?: number },
): CompletenessActionPlan {
  const retryWbClosedWeek = !snapshot.wbClosedWeekComplete || !snapshot.wbExactOwner;
  const retryOzonReplay = !snapshot.ozonCoverageComplete || snapshot.ozonUnknownQuarantine;
  const retryDailyOperational = !snapshot.openDayDailyComplete;
  const promotePreliminaryToFinal =
    snapshot.wbClosedWeekComplete &&
    snapshot.wbExactOwner &&
    snapshot.ozonCoverageComplete &&
    !snapshot.ozonUnknownQuarantine;
  const attempts = options?.persistentFailureAttempts ?? 0;

  return {
    retryWbClosedWeek,
    retryOzonReplay,
    retryDailyOperational,
    promotePreliminaryToFinal,
    markFinal: promotePreliminaryToFinal,
    alertPersistentFailure: attempts >= 3 && !promotePreliminaryToFinal,
    manualMarketplaceFilesRequired: false,
  };
}

export function buildCompletenessJobRecord(input: {
  date: string;
  snapshot: CompletenessSnapshot;
  plan: CompletenessActionPlan;
}) {
  return {
    jobType: "DAILY_COMPLETENESS",
    scope: `ALL|ALL|${input.date}|completeness`,
    idempotencyKey: `jr:v1:DAILY_COMPLETENESS:none|none|ALL|${input.date}|completeness`,
    fingerprint: JSON.stringify(input.snapshot),
    lockKey: `lock:v1:DAILY_COMPLETENESS:none|none|ALL|${input.date}|completeness`,
    status: input.plan.markFinal ? "SUCCEEDED" : "PENDING",
    provenance: {
      source: "completeness-watchdog",
      retryWbClosedWeek: input.plan.retryWbClosedWeek,
      retryOzonReplay: input.plan.retryOzonReplay,
      retryDailyOperational: input.plan.retryDailyOperational,
      manualMarketplaceFilesRequired: false,
    },
  };
}

/** Default stale RUNNING window for completeness JobRun reclaim. */
export const COMPLETENESS_JOB_STALE_RUNNING_MS = 30 * 60 * 1000;

export type CompletenessJobRunView = {
  status: string;
  attempts: number;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
};

/**
 * RUNNING without startedAt, or RUNNING older than staleMs, is reclaimable.
 * Prevents a stranded lock from blocking the next same-scope completeness run forever.
 */
export function isStaleCompletenessJobRun(
  run: CompletenessJobRunView | null | undefined,
  now: Date = new Date(),
  staleMs: number = COMPLETENESS_JOB_STALE_RUNNING_MS,
): boolean {
  if (!run) return false;
  if (run.status !== "RUNNING") return false;
  if (!run.startedAt) return true;
  const startedMs = new Date(run.startedAt).getTime();
  if (!Number.isFinite(startedMs)) return true;
  return now.getTime() - startedMs >= staleMs;
}

export function buildCompletenessJobRunStartData(input: {
  job: ReturnType<typeof buildCompletenessJobRecord>;
  now?: Date;
  attempts?: number;
}) {
  const now = input.now ?? new Date();
  return {
    jobType: input.job.jobType,
    scope: input.job.scope,
    idempotencyKey: input.job.idempotencyKey,
    fingerprint: input.job.fingerprint,
    lockKey: input.job.lockKey,
    status: "RUNNING" as const,
    attempts: input.attempts ?? 1,
    startedAt: now,
    finishedAt: null as Date | null,
    nextAttemptAt: null as Date | null,
    errorClass: null as string | null,
    errorCode: null as string | null,
    errorMessage: null as string | null,
    provenance: input.job.provenance,
  };
}

export function buildCompletenessJobRunFinishData(input: {
  ok: boolean;
  now?: Date;
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  const now = input.now ?? new Date();
  return {
    status: (input.ok ? "SUCCEEDED" : "FAILED") as "SUCCEEDED" | "FAILED",
    finishedAt: now,
    errorClass: input.ok ? null : ("RETRYABLE" as string | null),
    errorCode: input.ok ? null : (input.errorCode ?? "COMPLETENESS_INCOMPLETE"),
    errorMessage: input.ok ? null : (input.errorMessage ?? "completeness still incomplete"),
  };
}

function isLikelyClosedWeekDate(date: string, today = new Date()) {
  const [year, month, day] = date.split("-").map(Number);
  const end = Date.UTC(year, month - 1, day);
  const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return end < now;
}
