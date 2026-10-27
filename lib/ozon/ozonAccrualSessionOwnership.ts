/**
 * Per company+day owner selection for Ozon /by-day ImportSession RAW.
 * Completeness requires explicit proof — missing coverageComplete is not zero-sales.
 */

export type OzonAccrualSessionCandidate = {
  id: string;
  companyName: string | null;
  status: string | null;
  createdAt: Date | string | number | null;
  previewJson: unknown;
};

export type OzonDaySessionOwner = {
  companyName: string;
  day: string;
  sessionId: string;
  complete: boolean;
  confirmedZeroProductSales: boolean;
  incompleteReason: string | null;
  preview: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function dayKey(value: unknown): string {
  return String(value ?? "").trim().slice(0, 10);
}

function createdAtMs(value: Date | string | number | null | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

/** Explicit completeness proof for a RAW /by-day session. */
export function isOzonAccrualCoverageProven(
  preview: Record<string, unknown> | null,
): { proven: boolean; reason: string | null } {
  if (!preview) return { proven: false, reason: "MISSING_PREVIEW" };
  if (preview.coverageComplete === false) {
    return { proven: false, reason: "COVERAGE_COMPLETE_FALSE" };
  }
  // Flag alone never proves completeness — RAW field must be present
  // (empty array = confirmed zero; missing field = unproven).
  if (!Array.isArray(preview.rawAccruals)) {
    return { proven: false, reason: "RAW_ACCRUALS_FIELD_MISSING" };
  }
  if (preview.coverageComplete === true) {
    return { proven: true, reason: null };
  }
  // Absent coverageComplete: require pagesByDay for every requested date.
  const requested = Array.isArray(preview.requestedDates)
    ? preview.requestedDates.map((d) => dayKey(d)).filter(Boolean)
    : [];
  const pages =
    preview.pagesByDay && typeof preview.pagesByDay === "object"
      ? (preview.pagesByDay as Record<string, unknown>)
      : null;
  if (!pages || requested.length === 0) {
    return { proven: false, reason: "COVERAGE_UNPROVEN" };
  }
  for (const day of requested) {
    if (!(Number(pages[day]) > 0)) {
      return { proven: false, reason: "PAGES_INCOMPLETE" };
    }
  }
  return { proven: true, reason: null };
}

export function listSessionRequestedDays(
  preview: Record<string, unknown>,
  periodFrom?: string | null,
  periodTo?: string | null,
): string[] {
  const from = periodFrom ? dayKey(periodFrom) : null;
  const to = periodTo ? dayKey(periodTo) : null;
  let days: string[] = [];
  if (Array.isArray(preview.requestedDates) && preview.requestedDates.length) {
    days = preview.requestedDates.map((d) => dayKey(d)).filter(Boolean);
  } else {
    const a = dayKey(preview.dateFrom);
    const b = dayKey(preview.dateTo);
    if (a && b && a === b) days = [a];
    else if (a && b) {
      let cur = a;
      while (cur <= b) {
        days.push(cur);
        const d = new Date(`${cur}T00:00:00.000Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        cur = d.toISOString().slice(0, 10);
      }
    }
  }
  return days.filter((d) => (!from || d >= from) && (!to || d <= to));
}

/**
 * Newest proven-complete session owns each company+day.
 * Partial sessions never auto-promote to complete authority.
 * When a newer complete zero-sales session owns the day, older sales are discarded.
 */
export function selectOzonAccrualDayOwners(params: {
  sessions: OzonAccrualSessionCandidate[];
  dateFrom: string;
  dateTo: string;
}): Map<string, OzonDaySessionOwner> {
  const byKey = new Map<
    string,
    Array<{
      session: OzonAccrualSessionCandidate;
      preview: Record<string, unknown>;
      proven: boolean;
      reason: string | null;
      createdAt: number;
    }>
  >();

  for (const session of params.sessions) {
    const preview = isRecord(session.previewJson) ? session.previewJson : null;
    if (!preview) continue;
    const companyName = String(session.companyName ?? "").trim();
    if (!companyName) continue;
    const { proven, reason } = isOzonAccrualCoverageProven(preview);
    const days = listSessionRequestedDays(
      preview,
      params.dateFrom,
      params.dateTo,
    );
    const createdAt = createdAtMs(session.createdAt);
    for (const day of days) {
      const key = `${companyName}|${day}`;
      const list = byKey.get(key) ?? [];
      list.push({ session, preview, proven, reason, createdAt });
      byKey.set(key, list);
    }
  }

  const owners = new Map<string, OzonDaySessionOwner>();
  for (const [key, list] of byKey) {
    list.sort((a, b) => b.createdAt - a.createdAt || b.session.id.localeCompare(a.session.id));
    const proven = list.find((item) => item.proven);
    const chosen = proven ?? list[0];
    if (!chosen) continue;
    const [companyName, day] = key.split("|");
    const rawAccruals = Array.isArray(chosen.preview.rawAccruals)
      ? chosen.preview.rawAccruals
      : [];
    const confirmedZero =
      Boolean(chosen.proven) &&
      Array.isArray(chosen.preview.rawAccruals) &&
      rawAccruals.length === 0;
    owners.set(key, {
      companyName,
      day,
      sessionId: chosen.session.id,
      complete: Boolean(chosen.proven),
      confirmedZeroProductSales: confirmedZero,
      incompleteReason: chosen.proven ? null : chosen.reason,
      preview: chosen.preview,
    });
  }
  return owners;
}
