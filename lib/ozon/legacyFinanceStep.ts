/**
 * Classify legacy Ozon Finance (/v3/finance/transaction/list) failures.
 * Obsolete method (code 9) OR hard-removed endpoint (404) may continue ONLY when
 * an explicit <=7-day /by-day canonical ingest is planned for the same call.
 */

export type LegacyFinanceStepStatus =
  | "OK"
  | "OBSOLETE_METHOD"
  | "FAILED";

export type LegacyFinanceStepOutcome = {
  status: LegacyFinanceStepStatus;
  code: number | null;
  message: string | null;
  retryable: boolean;
  endpoint: "POST /v3/finance/transaction/list";
};

export type ByDayCanonicalStepStatus =
  | "EXECUTION_SUCCESS"
  | "SKIPPED"
  | "FAILED";

export type ByDayCanonicalStepOutcome = {
  status: ByDayCanonicalStepStatus;
  reason: string | null;
  ingestStatus?: string | null;
  coverageComplete?: boolean | null;
  sourceReadiness?: "READY" | "PRELIMINARY" | "PENDING" | "FAILED" | null;
};

const OBSOLETE_CODE = 9;

export function classifyOzonLegacyFinanceError(
  error: unknown,
): LegacyFinanceStepOutcome {
  const message = String(error instanceof Error ? error.message : error).slice(
    0,
    2000,
  );
  const codeMatch = message.match(/"code"\s*:\s*(\d+)/);
  const code = codeMatch ? Number(codeMatch[1]) : null;
  const isObsoleteCode9 =
    /Ozon Finance API:\s*400/i.test(message) &&
    (code === OBSOLETE_CODE || /"code"\s*:\s*9\b/.test(message)) &&
    /obsolete method/i.test(message);
  // Live seller API now returns 404 HTML for the removed transaction/list path.
  // Treat as the same durability class as obsolete method so exact-day /by-day
  // cron can continue on the authoritative accrual endpoint.
  const isRemovedEndpoint404 = /Ozon Finance API:\s*404\b/i.test(message);

  if (isObsoleteCode9 || isRemovedEndpoint404) {
    return {
      status: "OBSOLETE_METHOD",
      code: isObsoleteCode9 ? OBSOLETE_CODE : 404,
      message,
      retryable: false,
      endpoint: "POST /v3/finance/transaction/list",
    };
  }

  const retryable =
    /\b(429|502|503|504|ECONNRESET|ETIMEDOUT|timeout|rate.?limit)\b/i.test(
      message,
    );

  return {
    status: "FAILED",
    code,
    message,
    retryable,
    endpoint: "POST /v3/finance/transaction/list",
  };
}

/**
 * EXPLICIT_BYDAY_ELIGIBLE =
 *   dateFrom provided AND dateTo provided AND inclusiveDays <= 7
 */
export function isExplicitByDayEligible(params: {
  dateFromOption?: Date | null;
  dateToOption?: Date | null;
  dateFrom: Date;
  dateTo: Date;
}): boolean {
  if (!params.dateFromOption || !params.dateToOption) return false;
  const from = Date.UTC(
    params.dateFrom.getUTCFullYear(),
    params.dateFrom.getUTCMonth(),
    params.dateFrom.getUTCDate(),
  );
  const to = Date.UTC(
    params.dateTo.getUTCFullYear(),
    params.dateTo.getUTCMonth(),
    params.dateTo.getUTCDate(),
  );
  const inclusiveDays = Math.round((to - from) / 86_400_000) + 1;
  return inclusiveDays >= 1 && inclusiveDays <= 7;
}

/**
 * Obsolete/removed legacy finance may continue only when an explicit by-day
 * ingest is planned. Broad syncOzonAll (no dates) must remain a visible Finance failure.
 */
export function legacyFinanceAllowsByDayContinue(
  step: LegacyFinanceStepOutcome,
  explicitByDayEligible: boolean,
): boolean {
  if (step.status === "OK") return true;
  if (step.status === "OBSOLETE_METHOD") return explicitByDayEligible;
  return false;
}

/**
 * Cron / exact-date accrual sync must use /v1/finance/accrual/by-day as authority.
 * Skip the stale transaction/list call entirely when by-day is eligible.
 */
export function shouldSkipLegacyFinanceForByDay(
  explicitByDayEligible: boolean,
): boolean {
  return explicitByDayEligible === true;
}
