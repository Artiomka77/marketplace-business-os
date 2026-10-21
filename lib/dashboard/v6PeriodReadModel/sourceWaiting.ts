/**
 * Dashboard V6 source-waiting classification.
 * Distinguishes "source not ready" from "build pending".
 * Does not change ownership selection or financial formulas.
 */

export const WAITING_SOURCE_REASON = "WAITING_SOURCE" as const;
export const BUILD_PENDING_REASON = "BUILD_PENDING" as const;

const SOURCE_WAITING_D6_REASONS = new Set([
  "D6_UNSAFE_WB_OWNERSHIP_MODE",
  "D6_UNSAFE_NO_WB_INTERVALS",
  "D6_UNSAFE_CALENDAR_MONTH_NOT_FINAL",
  "D6_UNSAFE_QUARTER_NOT_FINAL",
  "D6_UNSAFE_YTD_NOT_FINAL",
  "D6_UNSAFE_LONG_CUSTOM_RANGE_NOT_FINAL",
  "D6_UNSAFE_RANGE_FAIL_CLOSED",
  "D6_UNSAFE_UNKNOWN_WB_MODE_FAIL_CLOSED",
]);

export function isSourceWaitingD6Reason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  if (reason === WAITING_SOURCE_REASON) return true;
  if (reason.startsWith(`${WAITING_SOURCE_REASON}:`)) return true;
  if (reason.startsWith("WAITING_FOR_WB")) return true;
  return SOURCE_WAITING_D6_REASONS.has(reason);
}

export function isBuildPendingReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  if (reason === BUILD_PENDING_REASON) return true;
  if (reason.startsWith(`${BUILD_PENDING_REASON}:`)) return true;
  if (reason === "V6_PERIOD_READMODEL_MISSING") return true;
  if (reason === "V6_PERIOD_READMODEL_COMPANY_MISSING") return true;
  if (reason.startsWith("COVERAGE_")) return true;
  return false;
}

export function formatWaitingSourceReason(params: {
  d6Reason: string;
  modes?: string[];
  preliminaryReasons?: string[];
}): string {
  const modes = params.modes ?? [];
  const prelim = params.preliminaryReasons ?? [];
  const noSource =
    modes.includes("PRELIMINARY_NO_SOURCE") ||
    prelim.includes("SOURCE_INCOMPLETE") ||
    prelim.includes("FINANCE_INTERVAL_COVER_INCOMPLETE");
  if (noSource || params.d6Reason === "D6_UNSAFE_WB_OWNERSHIP_MODE") {
    return `${WAITING_SOURCE_REASON}:WAITING_FOR_WB_WEEKLY_CLOSE`;
  }
  return `${WAITING_SOURCE_REASON}:${params.d6Reason}`;
}

function formatRuDayMonth(iso: string): string {
  const day = iso.slice(8, 10);
  const month = iso.slice(5, 7);
  return `${day}.${month}`;
}

export function waitingSourceOwnerNote(params: {
  reason?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}): string | null {
  if (!isSourceWaitingD6Reason(params.reason)) return null;
  const from = params.dateFrom?.slice(0, 10) ?? "";
  const to = params.dateTo?.slice(0, 10) ?? "";
  if (
    from &&
    to &&
    (params.reason?.includes("WAITING_FOR_WB_WEEKLY_CLOSE") ||
      params.reason === "D6_UNSAFE_WB_OWNERSHIP_MODE" ||
      params.reason?.endsWith("D6_UNSAFE_WB_OWNERSHIP_MODE"))
  ) {
    return `WB: ожидается закрытие финансового отчёта за ${formatRuDayMonth(from)}–${formatRuDayMonth(to)}`;
  }
  return "Ожидаем закрытый источник WB для выбранного периода";
}
