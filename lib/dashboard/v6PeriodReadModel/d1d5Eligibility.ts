import type { WbSourceOwnerMode, WbSourceOwnershipPlan } from "@/lib/wb/sourceOwnership";

const SAFE_FINAL_MODES = new Set<WbSourceOwnerMode>([
  "EXACT_FINANCE_COVER_SESSIONS_ALL_ROWS",
  "DAILY_FINANCE_MATCHED_SESSIONS_ALL_ROWS",
]);

const PRELIM_DAILY_MODE: WbSourceOwnerMode = "PRELIMINARY_DAILY_FALLBACK";

const UNSAFE_D6_MODES = new Set<WbSourceOwnerMode>([
  "PRELIMINARY_NO_SOURCE",
  "PRELIMINARY_OPERATIONAL_FALLBACK",
]);

/** Inclusive calendar days in [from, to] (ISO YYYY-MM-DD). */
export function inclusiveIsoDayCount(dateFrom: string, dateTo: string): number {
  const from = Date.parse(`${dateFrom.slice(0, 10)}T00:00:00.000Z`);
  const to = Date.parse(`${dateTo.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0;
  return Math.round((to - from) / 86400000) + 1;
}

export function lastIsoDayOfMonth(year: number, month1to12: number): string {
  const last = new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
  return `${year}-${String(month1to12).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

export function isCalendarMonthSpan(dateFrom: string, dateTo: string): boolean {
  const from = dateFrom.slice(0, 10);
  const to = dateTo.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-01$/.exec(from);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  return to === lastIsoDayOfMonth(year, month);
}

export function isCalendarQuarterSpan(dateFrom: string, dateTo: string): boolean {
  const from = dateFrom.slice(0, 10);
  const to = dateTo.slice(0, 10);
  const quarters: Array<[string, string]> = [
    [`${from.slice(0, 4)}-01-01`, `${from.slice(0, 4)}-03-31`],
    [`${from.slice(0, 4)}-04-01`, `${from.slice(0, 4)}-06-30`],
    [`${from.slice(0, 4)}-07-01`, `${from.slice(0, 4)}-09-30`],
    [`${from.slice(0, 4)}-10-01`, `${from.slice(0, 4)}-12-31`],
  ];
  return quarters.some(([qFrom, qTo]) => from === qFrom && to === qTo);
}

/** Jan 1 through a later date that is not itself a single calendar month. */
export function isYtdStyleSpan(dateFrom: string, dateTo: string): boolean {
  const from = dateFrom.slice(0, 10);
  const to = dateTo.slice(0, 10);
  if (!/^\d{4}-01-01$/.test(from)) return false;
  if (to <= from) return false;
  if (isCalendarMonthSpan(from, to)) return false;
  return from.slice(0, 4) === to.slice(0, 4);
}

export type D1D5EligibilityDecision = {
  eligible: boolean;
  reason: string;
  strategy: "A_V2_BOUNDED_SAFE_PERIOD_ELIGIBILITY";
};

export type D1D5SafetyPlanEvidence = {
  dateFrom: string;
  dateTo: string;
  companyScope: string;
  isFinanciallyFinal: boolean;
  selectedSessionIds: string[];
  intervals: Array<{
    companyName: string;
    dateFrom: string;
    dateTo: string;
    mode: string;
    selectedSessionIds: string[];
    exactCoverageComplete: boolean;
    dailyCalendarCoverageComplete: boolean;
    dailyReportCoverageComplete: boolean;
    isFinanciallyFinal: boolean;
  }>;
  syntheticReason?: string;
};

export function buildSafetyPlanEvidence(params: {
  dateFrom: string;
  dateTo: string;
  companyScope: string;
  plan: Pick<
    WbSourceOwnershipPlan,
    "intervals" | "isFinanciallyFinal" | "selectedSessionIds"
  >;
}): D1D5SafetyPlanEvidence {
  const intervals = params.plan.intervals ?? [];
  return {
    dateFrom: params.dateFrom.slice(0, 10),
    dateTo: params.dateTo.slice(0, 10),
    companyScope: params.companyScope,
    isFinanciallyFinal: params.plan.isFinanciallyFinal,
    selectedSessionIds: [...(params.plan.selectedSessionIds ?? [])].sort(),
    intervals: intervals.map((interval) => ({
      companyName: interval.companyName,
      dateFrom: interval.dateFrom,
      dateTo: interval.dateTo,
      mode: interval.mode,
      selectedSessionIds: [...(interval.selectedSessionIds ?? [])].sort(),
      exactCoverageComplete: interval.exactCoverageComplete,
      dailyCalendarCoverageComplete: interval.dailyCalendarCoverageComplete,
      dailyReportCoverageComplete: interval.dailyReportCoverageComplete,
      isFinanciallyFinal: interval.isFinanciallyFinal,
    })),
  };
}

export type V2BundleScopeEligibility = {
  eligible: boolean;
  failedScope: string | null;
  reason: string | null;
  scopes: Array<{
    companyScope: string;
    eligible: boolean;
    reason: string;
    planEvidence: D1D5SafetyPlanEvidence;
  }>;
};

/**
 * Atomic pre-write gate: ALL-safe does not authorize an unsafe company.
 * First failing scope fails the whole bundle.
 */
export function evaluateRequiredV2BundleEligibility(params: {
  dateFrom: string;
  dateTo: string;
  scopes: Array<{
    companyScope: string;
    plan: Pick<
      WbSourceOwnershipPlan,
      "intervals" | "isFinanciallyFinal" | "selectedSessionIds"
    >;
  }>;
}): V2BundleScopeEligibility {
  const scopes: V2BundleScopeEligibility["scopes"] = [];
  for (const scope of params.scopes) {
    const planEvidence = buildSafetyPlanEvidence({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      companyScope: scope.companyScope,
      plan: scope.plan,
    });
    const decision = evaluateD1D5CorrectedBuildEligibility({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      plan: scope.plan,
    });
    scopes.push({
      companyScope: scope.companyScope,
      eligible: decision.eligible,
      reason: decision.reason,
      planEvidence,
    });
    if (!decision.eligible) {
      return {
        eligible: false,
        failedScope: scope.companyScope,
        reason: decision.reason,
        scopes,
      };
    }
  }
  return {
    eligible: true,
    failedScope: null,
    reason: null,
    scopes,
  };
}

/**
 * Pure D1/D5 V2 build/HIT gate.
 * Does not change WB source-ownership selection — only refuses to materialize
 * a corrected-version row when the existing plan is D6-unsafe.
 *
 * Safe:
 * - financially final exact/daily-matched cover (closed weeks, certified months)
 * - open PRELIMINARY daily fallback for a short non-calendar/YTD/quarter window
 *
 * Fail-closed:
 * - PRELIMINARY_NO_SOURCE / PRELIMINARY_OPERATIONAL_FALLBACK
 * - calendar month / quarter / YTD that is not financially final
 * - long custom ranges (> 7 inclusive days) that are not financially final
 */
export function evaluateD1D5CorrectedBuildEligibility(params: {
  dateFrom: string;
  dateTo: string;
  plan: Pick<WbSourceOwnershipPlan, "intervals" | "isFinanciallyFinal">;
}): D1D5EligibilityDecision {
  const dateFrom = params.dateFrom.slice(0, 10);
  const dateTo = params.dateTo.slice(0, 10);
  const strategy = "A_V2_BOUNDED_SAFE_PERIOD_ELIGIBILITY" as const;
  const intervals = params.plan.intervals ?? [];
  const modes = intervals.map((interval) => interval.mode);

  if (intervals.length === 0) {
    return {
      eligible: false,
      reason: "D6_UNSAFE_NO_WB_INTERVALS",
      strategy,
    };
  }

  if (modes.some((mode) => UNSAFE_D6_MODES.has(mode))) {
    return {
      eligible: false,
      reason: "D6_UNSAFE_WB_OWNERSHIP_MODE",
      strategy,
    };
  }

  if (modes.some((mode) => !SAFE_FINAL_MODES.has(mode) && mode !== PRELIM_DAILY_MODE)) {
    return {
      eligible: false,
      reason: "D6_UNSAFE_UNKNOWN_WB_MODE_FAIL_CLOSED",
      strategy,
    };
  }

  const allFinalCover = modes.every((mode) => SAFE_FINAL_MODES.has(mode));
  if (allFinalCover && params.plan.isFinanciallyFinal) {
    return {
      eligible: true,
      reason: "D1D5_V2_SAFE_FINANCIALLY_FINAL_COVER",
      strategy,
    };
  }

  if (isCalendarMonthSpan(dateFrom, dateTo)) {
    return {
      eligible: false,
      reason: "D6_UNSAFE_CALENDAR_MONTH_NOT_FINAL",
      strategy,
    };
  }
  if (isCalendarQuarterSpan(dateFrom, dateTo)) {
    return {
      eligible: false,
      reason: "D6_UNSAFE_QUARTER_NOT_FINAL",
      strategy,
    };
  }
  if (isYtdStyleSpan(dateFrom, dateTo)) {
    return {
      eligible: false,
      reason: "D6_UNSAFE_YTD_NOT_FINAL",
      strategy,
    };
  }

  const days = inclusiveIsoDayCount(dateFrom, dateTo);
  if (days < 1 || days > 7) {
    return {
      eligible: false,
      reason: "D6_UNSAFE_LONG_CUSTOM_RANGE_NOT_FINAL",
      strategy,
    };
  }

  const prelimOk = modes.every(
    (mode) => SAFE_FINAL_MODES.has(mode) || mode === PRELIM_DAILY_MODE
  );
  const hasPrelimDaily = modes.includes(PRELIM_DAILY_MODE);
  if (prelimOk && hasPrelimDaily) {
    return {
      eligible: true,
      reason: "D1D5_V2_SAFE_PRELIMINARY_SHORT_DAILY_WINDOW",
      strategy,
    };
  }

  return {
    eligible: false,
    reason: "D6_UNSAFE_RANGE_FAIL_CLOSED",
    strategy,
  };
}

export class D1D5V2BuildForbiddenError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`D1D5_V2_BUILD_FORBIDDEN:${reason}`);
    this.name = "D1D5V2BuildForbiddenError";
    this.reason = reason;
  }
}

export async function resolveD1D5CorrectedBuildEligibility(params: {
  dateFrom: string;
  dateTo: string;
  companyName?: string | null;
}): Promise<
  D1D5EligibilityDecision & {
    isFinanciallyFinal: boolean;
    modes: string[];
    companyScope: string;
    planEvidence: D1D5SafetyPlanEvidence;
  }
> {
  const { selectCanonicalWbSaleSource } = await import("@/lib/wb/sourceOwnership");
  const companyScope =
    !params.companyName || params.companyName === "ALL"
      ? "ALL"
      : params.companyName;
  const plan = await selectCanonicalWbSaleSource({
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    companyName: companyScope === "ALL" ? null : companyScope,
  });
  const decision = evaluateD1D5CorrectedBuildEligibility({
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    plan,
  });
  const planEvidence = buildSafetyPlanEvidence({
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    companyScope,
    plan,
  });
  return {
    ...decision,
    isFinanciallyFinal: plan.isFinanciallyFinal,
    modes: plan.intervals.map((interval) => interval.mode),
    companyScope,
    planEvidence,
  };
}

export function shouldUseLiveD1D5EligibilityGate(): boolean {
  if (process.env.V6_READMODEL_D1D5_ELIGIBILITY === "off") return false;
  if (process.env.V6_READMODEL_D1D5_ELIGIBILITY === "live") return true;
  if (process.env.V6_READMODEL_FORCE_MEMORY === "1") return false;
  if (process.env.NODE_TEST_CONTEXT) return false;
  return true;
}
