const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

export type OzonAccrualSyncWindowMode =
  | "EXACT_DATE"
  | "ROLLING_3_COMPLETED_MOSCOW";

export type OzonAccrualSyncWindow = {
  dateFromText: string;
  dateToText: string;
  dateFrom: Date;
  dateTo: Date;
  mode: OzonAccrualSyncWindowMode;
};

export function getCompletedMoscowWindow(now = new Date()): OzonAccrualSyncWindow {
  const moscowNow = new Date(now.getTime() + MOSCOW_OFFSET_MS);
  const completedTo = new Date(
    Date.UTC(
      moscowNow.getUTCFullYear(),
      moscowNow.getUTCMonth(),
      moscowNow.getUTCDate() - 1,
    ),
  );
  const completedFrom = new Date(completedTo);
  completedFrom.setUTCDate(completedFrom.getUTCDate() - 2);

  const dateFromText = completedFrom.toISOString().slice(0, 10);
  const dateToText = completedTo.toISOString().slice(0, 10);
  return {
    dateFromText,
    dateToText,
    dateFrom: new Date(`${dateFromText}T00:00:00.000Z`),
    dateTo: new Date(`${dateToText}T23:59:59.999Z`),
    mode: "ROLLING_3_COMPLETED_MOSCOW",
  };
}

export function resolveOzonAccrualSyncWindow(params: {
  exactDate?: string | null;
  now?: Date;
}): OzonAccrualSyncWindow {
  const exactDate = params.exactDate?.trim() ?? "";
  if (exactDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exactDate)) {
      throw new Error("date должен быть в формате YYYY-MM-DD");
    }
    return {
      dateFromText: exactDate,
      dateToText: exactDate,
      dateFrom: new Date(`${exactDate}T00:00:00.000Z`),
      dateTo: new Date(`${exactDate}T23:59:59.999Z`),
      mode: "EXACT_DATE",
    };
  }
  return getCompletedMoscowWindow(params.now);
}

export type OzonAccrualCompanyRouteResult = {
  companyName: string;
  ok: boolean;
  executionOk?: boolean;
  sourceReadiness?: "READY" | "PRELIMINARY" | "PENDING" | "FAILED";
  coverageComplete?: boolean;
  ingestStatus?: string;
  windowPartial?: boolean;
  persistedDays?: string[];
  pendingDays?: string[];
  error?: string;
};

export type OzonSourceReadiness = "READY" | "PRELIMINARY" | "PENDING" | "FAILED";

/**
 * Separate execution success from canonical readiness.
 * Never coerce Boolean(ingestStatus string) into success.
 */
export function classifyOzonByDayRouteOutcome(input: {
  executionOk: boolean;
  ingestStatus?: string | null;
  coverageComplete?: boolean | null;
  windowPartial?: boolean | null;
  pendingDays?: string[] | null;
  failFinality?: boolean | null;
}): {
  executionOk: boolean;
  sourceReadiness: OzonSourceReadiness;
  /** Company-level ok: false only for FAILED execution/readiness. */
  ok: boolean;
} {
  if (!input.executionOk) {
    return { executionOk: false, sourceReadiness: "FAILED", ok: false };
  }

  const status = String(input.ingestStatus ?? "").trim().toUpperCase();
  if (
    status === "FAILED" ||
    status === "ERROR" ||
    input.failFinality === true
  ) {
    return { executionOk: true, sourceReadiness: "FAILED", ok: false };
  }

  const pending = (input.pendingDays?.length ?? 0) > 0;
  const ready =
    status === "FINAL" &&
    input.coverageComplete === true &&
    input.windowPartial !== true &&
    !pending;

  if (ready) {
    return { executionOk: true, sourceReadiness: "READY", ok: true };
  }

  if (
    status === "PRELIMINARY" ||
    input.coverageComplete === false ||
    input.windowPartial === true ||
    pending
  ) {
    return { executionOk: true, sourceReadiness: "PRELIMINARY", ok: true };
  }

  if (!status) {
    return { executionOk: true, sourceReadiness: "PENDING", ok: true };
  }

  // Unknown non-empty ingestStatus must never be treated as READY/OK blindly.
  return { executionOk: true, sourceReadiness: "PENDING", ok: true };
}

export function aggregateOzonAccrualRouteResults(
  results: OzonAccrualCompanyRouteResult[],
) {
  const attemptedOk = results.length > 0 && results.every((item) => item.ok);
  const partial = results.some(
    (item) =>
      item.ok &&
      (item.coverageComplete === false ||
        item.windowPartial === true ||
        (item.pendingDays?.length ?? 0) > 0 ||
        item.ingestStatus === "PRELIMINARY" ||
        item.sourceReadiness === "PRELIMINARY" ||
        item.sourceReadiness === "PENDING"),
  );
  const failed = results.some(
    (item) => item.ok === false || item.sourceReadiness === "FAILED",
  );

  return {
    ok: attemptedOk && !partial && !failed,
    partial,
    attemptedOk,
    httpStatus: failed ? 500 : 200,
  };
}
