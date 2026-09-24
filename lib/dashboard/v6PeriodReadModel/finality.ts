/**
 * Wave A finality resolution — MUST mirror Loans V4 / Financial Core V6 readiness,
 * not calendar closed-ness alone. Direct FC signals demote FINAL when present.
 */
import { getDataReadinessSummary, type DataReadinessSummary } from "@/lib/analytics/dataReadiness";
import {
  evaluateDashboardIncompleteWeek,
  type DashboardWeekPresentation,
} from "@/lib/dashboard/incompleteWeekGuard";

import type { V6CoverageStatus, V6DataMode } from "./contract";
import { isOpenPeriod, isoDateOnly } from "./fingerprint";

export type DirectFinalitySignals = {
  /** Direct WB sourceOwnershipFinal from profitAnalytics.totals. */
  wbSourceOwnershipFinal?: boolean | null;
  /** Direct WB taxesUnavailable from profitAnalytics.totals when the field exists. */
  wbTaxesUnavailable?: boolean | null;
  ozonCoverageComplete?: boolean | null;
  ozonQuarantineCount?: number | null;
  canonicalDataMode?: V6DataMode | null;
  wbExactCoverComplete?: boolean | null;
};

export type V6FinalityResolution = {
  dataMode: V6DataMode;
  /** COMPLETE = payload HIT-able; never equals "financially FINAL". */
  coverageStatus: V6CoverageStatus;
  issues: string[];
  readiness: Pick<DataReadinessSummary, "isFinal" | "status" | "issues">;
  weekPresentation: DashboardWeekPresentation;
  /** Always false: calendar closed alone never promotes FINAL. */
  closedDateAutoFinal: false;
  periodOpen: boolean;
  direct: Required<{
    wbSourceOwnershipFinal: boolean | null;
    wbTaxesUnavailable: boolean | null;
    ozonCoverageComplete: boolean | null;
    ozonQuarantineCount: number;
    canonicalDataMode: V6DataMode | null;
  }>;
};

function normalizeDirect(signals?: DirectFinalitySignals | null) {
  return {
    wbSourceOwnershipFinal:
      signals?.wbSourceOwnershipFinal === undefined
        ? null
        : signals.wbSourceOwnershipFinal,
    wbTaxesUnavailable:
      signals?.wbTaxesUnavailable === undefined
        ? null
        : signals.wbTaxesUnavailable,
    ozonCoverageComplete:
      signals?.ozonCoverageComplete === undefined
        ? null
        : signals.ozonCoverageComplete,
    ozonQuarantineCount:
      typeof signals?.ozonQuarantineCount === "number"
        ? Math.max(0, signals.ozonQuarantineCount)
        : 0,
    canonicalDataMode: signals?.canonicalDataMode ?? null,
  };
}

/**
 * Calendar may force PRELIMINARY (open/current period).
 * FINAL only when existing incomplete-week + readiness + direct FC signals allow it.
 */
export function resolveV6DataModeFromEvidence(params: {
  dateFrom: string;
  dateTo: string;
  todayIso?: string;
  readiness: Pick<DataReadinessSummary, "isFinal" | "status" | "issues">;
  weekPresentation?: DashboardWeekPresentation;
  direct?: DirectFinalitySignals | null;
}): {
  dataMode: V6DataMode;
  periodOpen: boolean;
  closedDateAutoFinal: false;
  weekPresentation: DashboardWeekPresentation;
  direct: V6FinalityResolution["direct"];
} {
  const dateFrom = isoDateOnly(params.dateFrom);
  const dateTo = isoDateOnly(params.dateTo);
  const periodOpen = isOpenPeriod(dateTo, params.todayIso);
  const direct = normalizeDirect(params.direct);
  const weekPresentation =
    params.weekPresentation ??
    evaluateDashboardIncompleteWeek({
      dateFrom,
      dateTo,
      dataReadiness: params.readiness,
      wbExactCoverComplete:
        params.direct?.wbExactCoverComplete ??
        !params.readiness.issues.some((issue) => issue.kind === "WB_FINANCE_MISSING"),
      canonicalDataMode: direct.canonicalDataMode,
      ozonCoverageComplete: direct.ozonCoverageComplete,
      ozonQuarantineCount: direct.ozonQuarantineCount,
    });

  // Open/current period is always PRELIMINARY regardless of underlying statuses.
  if (periodOpen) {
    return {
      dataMode: "PRELIMINARY",
      periodOpen: true,
      closedDateAutoFinal: false,
      weekPresentation: {
        ...weekPresentation,
        mayPresentAsFinal: false,
        status:
          weekPresentation.status === "INCOMPLETE"
            ? "INCOMPLETE"
            : "PRELIMINARY",
      },
      direct,
    };
  }

  // Direct FC fail-closed demotions (never proxy via netProfitStatus alone).
  if (direct.wbSourceOwnershipFinal === false) {
    return {
      dataMode: "PRELIMINARY",
      periodOpen: false,
      closedDateAutoFinal: false,
      weekPresentation: {
        mayPresentAsFinal: false,
        status: "PRELIMINARY",
        reason: "WB_SOURCE_OWNERSHIP_NOT_FINAL",
        badgeText: "WB source ownership / PRELIMINARY",
      },
      direct,
    };
  }

  if (direct.wbTaxesUnavailable === true) {
    return {
      dataMode: "PRELIMINARY",
      periodOpen: false,
      closedDateAutoFinal: false,
      weekPresentation: {
        mayPresentAsFinal: false,
        status: "PRELIMINARY",
        reason: "WB_TAXES_UNAVAILABLE",
        badgeText: "WB taxes unavailable / PRELIMINARY",
      },
      direct,
    };
  }

  // Closed calendar is necessary but NEVER sufficient for FINAL.
  const dataMode: V6DataMode =
    weekPresentation.mayPresentAsFinal && params.readiness.isFinal
      ? "FINAL"
      : "PRELIMINARY";

  return {
    dataMode,
    periodOpen: false,
    closedDateAutoFinal: false,
    weekPresentation,
    direct,
  };
}

export function coverageStatusFromEvidence(params: {
  hasUsablePayload: boolean;
  readiness: Pick<DataReadinessSummary, "status">;
}): V6CoverageStatus {
  if (!params.hasUsablePayload) return "MISSING";
  // COMPLETE = HIT-able payload. Financial incompleteness lives in dataMode + issues.
  void params.readiness;
  return "COMPLETE";
}

export async function resolveV6ReadModelFinality(params: {
  dateFrom: string;
  dateTo: string;
  todayIso?: string;
  companyName?: string | null;
  hasUsablePayload?: boolean;
  direct?: DirectFinalitySignals | null;
}): Promise<V6FinalityResolution> {
  const dateFrom = isoDateOnly(params.dateFrom);
  const dateTo = isoDateOnly(params.dateTo);
  const readiness = await getDataReadinessSummary({
    dateFrom,
    dateTo,
    companyName: params.companyName ?? null,
  });
  const direct = normalizeDirect(params.direct);
  const weekPresentation = evaluateDashboardIncompleteWeek({
    dateFrom,
    dateTo,
    dataReadiness: readiness,
    wbExactCoverComplete:
      params.direct?.wbExactCoverComplete ??
      !readiness.issues.some((issue) => issue.kind === "WB_FINANCE_MISSING"),
    canonicalDataMode: direct.canonicalDataMode,
    ozonCoverageComplete: direct.ozonCoverageComplete,
    ozonQuarantineCount: direct.ozonQuarantineCount,
  });
  const mode = resolveV6DataModeFromEvidence({
    dateFrom,
    dateTo,
    todayIso: params.todayIso,
    readiness,
    weekPresentation,
    direct: params.direct,
  });
  const coverageStatus = coverageStatusFromEvidence({
    hasUsablePayload: params.hasUsablePayload !== false,
    readiness,
  });

  return {
    dataMode: mode.dataMode,
    coverageStatus,
    issues: readiness.issues.map((issue) => issue.kind),
    readiness: {
      isFinal: readiness.isFinal,
      status: readiness.status,
      issues: readiness.issues,
    },
    weekPresentation: mode.weekPresentation,
    closedDateAutoFinal: false,
    periodOpen: mode.periodOpen,
    direct: mode.direct,
  };
}

/** Pure helper for synthetic/matrix tests — no DB. */
export function resolveV6FinalityFromSynthetic(params: {
  dateFrom: string;
  dateTo: string;
  todayIso: string;
  readinessIsFinal: boolean;
  readinessStatus: DataReadinessSummary["status"];
  issueKinds?: Array<DataReadinessSummary["issues"][number]["kind"]>;
  hasUsablePayload?: boolean;
  direct?: DirectFinalitySignals | null;
}): V6FinalityResolution {
  const issues = (params.issueKinds ?? []).map((kind) => ({
    kind,
    level:
      kind === "CURRENT_PERIOD" ||
      kind === "WB_WEEKLY_NOT_CLOSED" ||
      kind === "OZON_ADS_PENDING"
        ? ("warning" as const)
        : ("danger" as const),
    title: kind,
    text: kind,
  }));
  const readiness = {
    isFinal: params.readinessIsFinal,
    status: params.readinessStatus,
    issues,
  };
  const direct = normalizeDirect(params.direct);
  const weekPresentation = evaluateDashboardIncompleteWeek({
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    dataReadiness: readiness,
    wbExactCoverComplete:
      params.direct?.wbExactCoverComplete ??
      !issues.some((i) => i.kind === "WB_FINANCE_MISSING"),
    canonicalDataMode: direct.canonicalDataMode,
    ozonCoverageComplete: direct.ozonCoverageComplete,
    ozonQuarantineCount: direct.ozonQuarantineCount,
  });
  const mode = resolveV6DataModeFromEvidence({
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    todayIso: params.todayIso,
    readiness,
    weekPresentation,
    direct: params.direct,
  });
  return {
    dataMode: mode.dataMode,
    coverageStatus: coverageStatusFromEvidence({
      hasUsablePayload: params.hasUsablePayload !== false,
      readiness,
    }),
    issues: issues.map((i) => i.kind),
    readiness,
    weekPresentation: mode.weekPresentation,
    closedDateAutoFinal: false,
    periodOpen: mode.periodOpen,
    direct: mode.direct,
  };
}

/** Read optional taxesUnavailable without requiring the field on locked V6 totals type. */
export function readDirectTaxesUnavailable(totals: object | null | undefined): boolean | null {
  if (!totals || typeof totals !== "object") return null;
  if (!("taxesUnavailable" in totals)) return null;
  return (totals as { taxesUnavailable?: unknown }).taxesUnavailable === true;
}

export function readDirectSourceOwnershipFinal(
  totals: object | null | undefined
): boolean | null {
  if (!totals || typeof totals !== "object") return null;
  if (!("sourceOwnershipFinal" in totals)) return null;
  return (totals as { sourceOwnershipFinal?: unknown }).sourceOwnershipFinal === true;
}
