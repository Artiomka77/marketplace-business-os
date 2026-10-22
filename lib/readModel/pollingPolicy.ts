export type ReadModelSurface =
  | "dashboard_v6"
  | "profit_wb"
  | "profit_ozon"
  | "profit_pair"
  | "stock_abc";

export type ReadinessPollStatus =
  | "READY"
  | "PENDING"
  | "WAITING_SOURCE"
  | "ERROR";

export type ReadinessKey = {
  surface: string;
  dateFrom: string;
  dateTo: string;
  companyScope: string;
  marketplace: string;
};

export function normalizeReadinessKey(input: {
  surface: string;
  dateFrom: string;
  dateTo: string;
  companyScope?: string | null;
  marketplace?: string | null;
}): ReadinessKey {
  return {
    surface: String(input.surface || "").trim(),
    dateFrom: String(input.dateFrom || "").slice(0, 10),
    dateTo: String(input.dateTo || "").slice(0, 10),
    companyScope: String(input.companyScope || "ALL").trim() || "ALL",
    marketplace: String(input.marketplace || "ALL").trim() || "ALL",
  };
}

export function sameReadinessKey(a: ReadinessKey, b: ReadinessKey): boolean {
  return (
    a.surface === b.surface &&
    a.dateFrom === b.dateFrom &&
    a.dateTo === b.dateTo &&
    a.companyScope === b.companyScope &&
    a.marketplace === b.marketplace
  );
}

export function nextPollDelayMs(elapsedMs: number, hidden: boolean): number {
  if (hidden) return 20_000;
  if (elapsedMs < 30_000) return 3_000;
  if (elapsedMs < 120_000) return 5_000;
  return 10_000;
}

export function buildReadModelStatusUrl(key: ReadinessKey): string {
  const q = new URLSearchParams();
  q.set("surface", key.surface);
  q.set("dateFrom", key.dateFrom);
  q.set("dateTo", key.dateTo);
  q.set("companyScope", key.companyScope);
  q.set("marketplace", key.marketplace);
  return `/api/read-model/status?${q.toString()}`;
}

export const NONRETRYABLE_READINESS_REASONS = new Set([
  "DASHBOARD_V6_READMODEL_FIRST_DISABLED",
  "LEGACY_FORMULA_REJECTED",
  "INCOMPATIBLE_FORMULA_VERSION",
  "PAYLOAD_CHECKSUM_MISMATCH",
  "COMPANY_SCOPE_MISMATCH",
  "MARKETPLACE_MISMATCH",
  "CLOSED_STALE_INCOMPLETE",
  "UNKNOWN_SURFACE",
  "INVALID_STATUS_QUERY",
]);

export function isWaitingSourceReason(reason?: string | null): boolean {
  if (!reason) return false;
  if (reason === "WAITING_SOURCE") return true;
  if (reason.startsWith("WAITING_SOURCE:")) return true;
  if (reason.startsWith("WAITING_FOR_WB")) return true;
  return (
    reason === "D6_UNSAFE_WB_OWNERSHIP_MODE" ||
    reason === "D6_UNSAFE_NO_WB_INTERVALS" ||
    reason === "D6_UNSAFE_CALENDAR_MONTH_NOT_FINAL" ||
    reason === "D6_UNSAFE_QUARTER_NOT_FINAL" ||
    reason === "D6_UNSAFE_YTD_NOT_FINAL" ||
    reason === "D6_UNSAFE_LONG_CUSTOM_RANGE_NOT_FINAL" ||
    reason === "D6_UNSAFE_RANGE_FAIL_CLOSED" ||
    reason === "D6_UNSAFE_UNKNOWN_WB_MODE_FAIL_CLOSED"
  );
}

export function isBuildPendingReason(reason?: string | null): boolean {
  if (!reason) return false;
  if (reason === "BUILD_PENDING") return true;
  if (reason.startsWith("BUILD_PENDING:")) return true;
  if (reason === "V6_PERIOD_READMODEL_MISSING") return true;
  if (reason === "V6_PERIOD_READMODEL_COMPANY_MISSING") return true;
  if (reason.startsWith("COVERAGE_")) return true;
  return false;
}

export function classifyReadinessStatus(params: {
  isReady: boolean;
  reason?: string | null;
}): ReadinessPollStatus {
  if (params.isReady) return "READY";
  if (params.reason && NONRETRYABLE_READINESS_REASONS.has(params.reason)) {
    return "ERROR";
  }
  if (isWaitingSourceReason(params.reason)) {
    return "WAITING_SOURCE";
  }
  return "PENDING";
}
