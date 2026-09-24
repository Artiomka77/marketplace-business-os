import { createHash } from "node:crypto";

import { isoDateOnly } from "./fingerprint";

export const DASHBOARD_PERIOD_SNAPSHOT_JOB_ID_PREFIX = "v6rmj_" as const;

export type DashboardPeriodSnapshotJobIdentity = {
  formulaVersion: string;
  companyScope: string;
  dateFrom: string;
  dateTo: string;
};

/**
 * Deterministic DashboardPeriodSnapshotJob primary key.
 * Includes formulaVersion so V1 and V2 rows for the same scope/range coexist.
 * Does not mutate legacy `v6rm_` ids already stored in production.
 */
export function buildDashboardPeriodSnapshotJobId(
  params: DashboardPeriodSnapshotJobIdentity
): string {
  const formulaVersion = String(params.formulaVersion ?? "").trim();
  const companyScope = String(params.companyScope ?? "").trim() || "ALL";
  const dateFrom = isoDateOnly(params.dateFrom);
  const dateTo = isoDateOnly(params.dateTo);
  if (!formulaVersion) {
    throw new Error("buildDashboardPeriodSnapshotJobId: formulaVersion is required");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    throw new Error("buildDashboardPeriodSnapshotJobId: dateFrom/dateTo must be YYYY-MM-DD");
  }
  const canonical = `${formulaVersion}\n${companyScope}\n${dateFrom}\n${dateTo}`;
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `${DASHBOARD_PERIOD_SNAPSHOT_JOB_ID_PREFIX}${digest}`;
}

/** Forensic-only reconstruction of the legacy V1-style id (scope|from|to, no formula). */
export function buildLegacyDashboardPeriodSnapshotJobId(params: {
  companyScope: string;
  dateFrom: string;
  dateTo: string;
}): string {
  const companyScope = String(params.companyScope ?? "").trim() || "ALL";
  const dateFrom = isoDateOnly(params.dateFrom);
  const dateTo = isoDateOnly(params.dateTo);
  return `v6rm_${Buffer.from(`${companyScope}|${dateFrom}|${dateTo}`, "utf8")
    .toString("base64url")
    .slice(0, 48)}`;
}
