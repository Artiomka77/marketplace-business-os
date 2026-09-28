import {
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  LEGACY_V4_PERIOD_SNAPSHOT_FORMULA,
  isV6PeriodReadModelFormula,
  rejectsLegacyV4AsV6Final,
  type DashboardV6LoadResult,
  type PeriodCompanyMarketplaceMetricsPayload,
} from "./contract";
import {
  shouldUseLiveD1D5EligibilityGate,
  resolveD1D5CorrectedBuildEligibility,
} from "./d1d5Eligibility";
import { isTrustedV2HitAttestation } from "./v2SafetyAttestation";
import { isoDateOnly } from "./fingerprint";
import type { V6PeriodReadModelRepository } from "./repository";

function liveFallbackEnabled() {
  return process.env.DASHBOARD_V6_READMODEL_LIVE_FALLBACK === "1";
}

export function isDashboardV6ReadModelFirstEnabled() {
  // Ordinary candidate path is read-model-first unless explicitly disabled.
  if (process.env.DASHBOARD_V6_READMODEL_FIRST === "0") return false;
  return true;
}

async function resolveRebuildGate(
  params: {
    dateFrom: string;
    dateTo: string;
    companyScope: string;
    rebuildGate?: () => Promise<{ eligible: boolean; reason: string }>;
  }
): Promise<{ eligible: boolean; reason: string }> {
  if (params.rebuildGate) return params.rebuildGate();
  if (!shouldUseLiveD1D5EligibilityGate()) {
    return { eligible: true, reason: "UNIT_TEST_OR_EXPLICIT_OFF" };
  }
  return resolveD1D5CorrectedBuildEligibility({
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    companyName: params.companyScope === "ALL" ? null : params.companyScope,
  });
}

async function requestRebuildIfEligible(params: {
  repository: V6PeriodReadModelRepository;
  companyScope: string;
  dateFrom: string;
  dateTo: string;
  priority: number;
  rebuildGate?: () => Promise<{ eligible: boolean; reason: string }>;
}): Promise<{ eligible: boolean; reason: string }> {
  const gate = await resolveRebuildGate({
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    companyScope: params.companyScope,
    rebuildGate: params.rebuildGate,
  });
  if (!gate.eligible) return gate;
  await params.repository.requestRebuild?.({
    companyScope: params.companyScope,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    priority: params.priority,
  });
  return gate;
}

/**
 * Snapshot-first Dashboard loader.
 * Never executes buildDailyReport / getDashboardDailyAnalytics.
 * Optional cheap rebuild request only (no production job enqueue in Wave A tests).
 */
export async function loadDashboardV6PeriodReadModel(params: {
  repository: V6PeriodReadModelRepository;
  dateFrom: string;
  dateTo: string;
  companyScope?: string | null;
  nowMs?: number;
  rebuildGate?: () => Promise<{ eligible: boolean; reason: string }>;
}): Promise<DashboardV6LoadResult> {
  if (liveFallbackEnabled() && process.env.NODE_ENV !== "test") {
    // Explicit rollback flag exists, but ordinary path must remain read-model-first.
    // Callers must not use this as default.
  }

  const dateFrom = isoDateOnly(params.dateFrom);
  const dateTo = isoDateOnly(params.dateTo);
  const requestedScope =
    !params.companyScope || params.companyScope === "ALL"
      ? "ALL"
      : params.companyScope;

  // Probe ALL identity row for formula / coverage / mode.
  const allPeriod = await params.repository.findPeriod({
    companyScope: "ALL",
    marketplace: "ALL",
    dateFrom,
    dateTo,
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  });

  if (!allPeriod) {
    // Detect legacy V4 collision attempts via explicit formula probe when adapters support it.
    const legacyProbe = await params.repository.findPeriod({
      companyScope: "ALL",
      marketplace: "ALL",
      dateFrom,
      dateTo,
      formulaVersion: LEGACY_V4_PERIOD_SNAPSHOT_FORMULA,
    });
    if (legacyProbe && rejectsLegacyV4AsV6Final(legacyProbe.formulaVersion)) {
      const gate = await requestRebuildIfEligible({
        repository: params.repository,
        companyScope: requestedScope,
        dateFrom,
        dateTo,
        priority: 50,
        rebuildGate: params.rebuildGate,
      });
      return {
        status: "UNAVAILABLE",
        reason: gate.eligible
          ? "LEGACY_V4_FORMULA_REJECTED_AS_V6_FINAL"
          : gate.reason,
        formulaVersionExpected: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
        rejectedFormulaVersion: legacyProbe.formulaVersion,
        sourceMarker: "READ_MODEL_MISS",
      };
    }

    const gate = await requestRebuildIfEligible({
      repository: params.repository,
      companyScope: requestedScope,
      dateFrom,
      dateTo,
      priority: 100,
      rebuildGate: params.rebuildGate,
    });
    if (!gate.eligible) {
      return {
        status: "UNAVAILABLE",
        reason: gate.reason,
        formulaVersionExpected: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
        sourceMarker: "READ_MODEL_MISS",
      };
    }
    return {
      status: "PENDING",
      reason: "V6_PERIOD_READMODEL_MISSING",
      formulaVersionExpected: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
      sourceMarker: "READ_MODEL_MISS",
    };
  }

  if (!isV6PeriodReadModelFormula(allPeriod.formulaVersion)) {
    return {
      status: "UNAVAILABLE",
      reason: "INCOMPATIBLE_FORMULA_VERSION",
      formulaVersionExpected: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
      rejectedFormulaVersion: allPeriod.formulaVersion,
      sourceMarker: "READ_MODEL_MISS",
    };
  }

  if (
    !isTrustedV2HitAttestation({
      meta: allPeriod.meta,
      dateFrom,
      dateTo,
      companyScope: "ALL",
    })
  ) {
    return {
      status: "UNAVAILABLE",
      reason: "V2_SAFETY_ATTESTATION_MISSING_OR_UNSAFE",
      formulaVersionExpected: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
      sourceMarker: "READ_MODEL_MISS",
    };
  }

  if (allPeriod.coverageStatus !== "COMPLETE") {
    const coverageGate = await requestRebuildIfEligible({
      repository: params.repository,
      companyScope: requestedScope,
      dateFrom,
      dateTo,
      priority: 80,
      rebuildGate: params.rebuildGate,
    });
    if (!coverageGate.eligible) {
      return {
        status: "UNAVAILABLE",
        reason: coverageGate.reason,
        formulaVersionExpected: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
        sourceMarker: "READ_MODEL_MISS",
      };
    }
    return {
      status: "PENDING",
      reason: `COVERAGE_${allPeriod.coverageStatus}`,
      formulaVersionExpected: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
      sourceMarker: "READ_MODEL_MISS",
    };
  }

  const staleAfterMs = allPeriod.meta?.staleAfterMs ?? null;
  const generatedAtMs = Date.parse(allPeriod.generatedAt);
  const nowMs = params.nowMs ?? Date.now();
  if (
    allPeriod.dataMode === "PRELIMINARY" &&
    staleAfterMs != null &&
    Number.isFinite(generatedAtMs) &&
    nowMs - generatedAtMs > staleAfterMs
  ) {
    await requestRebuildIfEligible({
      repository: params.repository,
      companyScope: requestedScope,
      dateFrom,
      dateTo,
      priority: 60,
      rebuildGate: params.rebuildGate,
    });
    // Still serve PRELIMINARY hit if present; rebuild is background-only.
  }

  const discovered =
    requestedScope === "ALL"
      ? await params.repository.listPeriodCompanyScopes({
          dateFrom,
          dateTo,
          formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
        })
      : [requestedScope];

  const companyRows: PeriodCompanyMarketplaceMetricsPayload[] = [];
  let selectedCompanyPeriod: Awaited<
    ReturnType<V6PeriodReadModelRepository["findPeriod"]>
  > = null;

  for (const companyName of discovered) {
    const row = await params.repository.findPeriod({
      companyScope: companyName,
      marketplace: "ALL",
      dateFrom,
      dateTo,
      formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    });
    if (!row || row.coverageStatus !== "COMPLETE") continue;
    if (!isV6PeriodReadModelFormula(row.formulaVersion)) continue;
    if (
      !isTrustedV2HitAttestation({
        meta: row.meta,
        dateFrom,
        dateTo,
        companyScope: companyName,
      })
    ) {
      continue;
    }
    companyRows.push(row.payload);
    if (requestedScope === companyName) {
      selectedCompanyPeriod = row;
    }
  }

  // Selected-company UI readiness/finality must use that company's meta — not ALL.
  if (requestedScope !== "ALL") {
    if (!selectedCompanyPeriod) {
      const companyGate = await requestRebuildIfEligible({
        repository: params.repository,
        companyScope: requestedScope,
        dateFrom,
        dateTo,
        priority: 90,
        rebuildGate: params.rebuildGate,
      });
      if (!companyGate.eligible) {
        return {
          status: "UNAVAILABLE",
          reason: companyGate.reason,
          formulaVersionExpected: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
          sourceMarker: "READ_MODEL_MISS",
        };
      }
      return {
        status: "PENDING",
        reason: "V6_PERIOD_READMODEL_COMPANY_MISSING",
        formulaVersionExpected: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
        sourceMarker: "READ_MODEL_MISS",
      };
    }
  }

  const dailyScope = requestedScope === "ALL" ? "ALL" : requestedScope;
  const dailyRows = await params.repository.findDailyRange({
    companyScope: dailyScope,
    marketplace: "ALL",
    dateFrom,
    dateTo,
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  });

  const bundleMeta =
    requestedScope === "ALL"
      ? allPeriod.meta
      : (selectedCompanyPeriod?.meta ?? allPeriod.meta);

  return {
    status: "HIT",
    bundle: {
      meta: bundleMeta,
      companyRows,
      dailyPoints: dailyRows.map((row) => row.payload),
      sourceMarker: "READ_MODEL",
    },
  };
}
