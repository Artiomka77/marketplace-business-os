import {
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  formatWaitingSourceReason,
  getDefaultV6PeriodReadModelRepository,
  isDashboardV6ReadModelFirstEnabled,
  isSourceWaitingD6Reason,
  isTrustedV2HitAttestation,
  isV6PeriodReadModelFormula,
  resolveD1D5CorrectedBuildEligibility,
  shouldUseLiveD1D5EligibilityGate,
} from "@/lib/dashboard/v6PeriodReadModel";
import { prisma } from "@/lib/prisma";
import {
  createPrismaProfitReadModelRepository,
  createWaveBProfitTargetPrismaClient,
  loadProfitReadModel,
  type ProfitMarketplace,
} from "@/lib/profitReadModel";
import { readStockAbcSnapshots } from "@/lib/stocks/stockAbcSnapshots";

import {
  classifyReadinessStatus,
  normalizeReadinessKey,
  type ReadinessKey,
  type ReadinessPollStatus,
} from "./pollingPolicy";

export type LightweightReadiness = {
  status: ReadinessPollStatus;
  isReady: boolean;
  readModelKey: string;
  dateFrom: string;
  dateTo: string;
  companyScope: string;
  marketplace: string;
  updatedAt: string | null;
  reason: string | null;
  dataMode: string | null;
  surface: string;
};

function pack(
  key: ReadinessKey,
  params: {
    isReady: boolean;
    reason?: string | null;
    updatedAt?: string | null;
    dataMode?: string | null;
  }
): LightweightReadiness {
  const status = classifyReadinessStatus({
    isReady: params.isReady,
    reason: params.reason,
  });
  return {
    status,
    isReady: status === "READY",
    readModelKey: [
      key.surface,
      key.companyScope,
      key.marketplace,
      key.dateFrom,
      key.dateTo,
    ].join("|"),
    dateFrom: key.dateFrom,
    dateTo: key.dateTo,
    companyScope: key.companyScope,
    marketplace: key.marketplace,
    updatedAt: params.updatedAt ?? null,
    reason: params.reason ?? null,
    dataMode: params.dataMode ?? null,
    surface: key.surface,
  };
}

function asIsoDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  return text.length ? text : null;
}

async function probeDashboard(key: ReadinessKey): Promise<LightweightReadiness> {
  if (!isDashboardV6ReadModelFirstEnabled()) {
    return pack(key, {
      isReady: false,
      reason: "DASHBOARD_V6_READMODEL_FIRST_DISABLED",
    });
  }

  const repository = getDefaultV6PeriodReadModelRepository();
  const allPeriod = await repository.findPeriod({
    companyScope: "ALL",
    marketplace: "ALL",
    dateFrom: key.dateFrom,
    dateTo: key.dateTo,
    formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  });

  if (!allPeriod) {
    if (shouldUseLiveD1D5EligibilityGate()) {
      const eligibility = await resolveD1D5CorrectedBuildEligibility({
        dateFrom: key.dateFrom,
        dateTo: key.dateTo,
        companyName: key.companyScope === "ALL" ? null : key.companyScope,
      });
      if (!eligibility.eligible && isSourceWaitingD6Reason(eligibility.reason)) {
        return pack(key, {
          isReady: false,
          reason: formatWaitingSourceReason({
            d6Reason: eligibility.reason,
            modes: eligibility.modes,
          }),
        });
      }
      if (eligibility.eligible) {
        return pack(key, {
          isReady: false,
          reason: "BUILD_PENDING:V6_PERIOD_READMODEL_MISSING",
        });
      }
      return pack(key, {
        isReady: false,
        reason: eligibility.reason,
      });
    }
    return pack(key, {
      isReady: false,
      reason: "V6_PERIOD_READMODEL_MISSING",
    });
  }

  if (!isV6PeriodReadModelFormula(allPeriod.formulaVersion)) {
    return pack(key, {
      isReady: false,
      reason: "INCOMPATIBLE_FORMULA_VERSION",
      updatedAt: asIsoDate(allPeriod.generatedAt),
    });
  }

  if (
    !isTrustedV2HitAttestation({
      meta: allPeriod.meta,
      dateFrom: key.dateFrom,
      dateTo: key.dateTo,
      companyScope: "ALL",
    })
  ) {
    return pack(key, {
      isReady: false,
      reason: "V2_SAFETY_ATTESTATION_MISSING_OR_UNSAFE",
      updatedAt: asIsoDate(allPeriod.generatedAt),
    });
  }

  if (allPeriod.coverageStatus !== "COMPLETE") {
    return pack(key, {
      isReady: false,
      reason: `COVERAGE_${allPeriod.coverageStatus}`,
      updatedAt: asIsoDate(allPeriod.generatedAt),
      dataMode: allPeriod.dataMode ?? null,
    });
  }

  if (key.companyScope !== "ALL") {
    const companyPeriod = await repository.findPeriod({
      companyScope: key.companyScope,
      marketplace: "ALL",
      dateFrom: key.dateFrom,
      dateTo: key.dateTo,
      formulaVersion: FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
    });
    if (
      !companyPeriod ||
      companyPeriod.coverageStatus !== "COMPLETE" ||
      !isV6PeriodReadModelFormula(companyPeriod.formulaVersion) ||
      !isTrustedV2HitAttestation({
        meta: companyPeriod.meta,
        dateFrom: key.dateFrom,
        dateTo: key.dateTo,
        companyScope: key.companyScope,
      })
    ) {
      return pack(key, {
        isReady: false,
        reason: "V6_PERIOD_READMODEL_COMPANY_MISSING",
        updatedAt: asIsoDate(allPeriod.generatedAt),
      });
    }
    return pack(key, {
      isReady: true,
      updatedAt: asIsoDate(companyPeriod.generatedAt),
      dataMode: companyPeriod.dataMode ?? allPeriod.dataMode ?? null,
    });
  }

  return pack(key, {
    isReady: true,
    updatedAt: asIsoDate(allPeriod.generatedAt),
    dataMode: allPeriod.dataMode ?? null,
  });
}

function profitMarketplaceFromKey(key: ReadinessKey): ProfitMarketplace {
  return key.marketplace === "OZON" || key.marketplace === "Ozon" ? "OZON" : "WB";
}

async function probeProfit(
  key: ReadinessKey,
  marketplace: ProfitMarketplace
): Promise<LightweightReadiness> {
  const repository = createPrismaProfitReadModelRepository(
    createWaveBProfitTargetPrismaClient()
  );
  const { computeCheapProfitSourceVersion } = await import(
    "@/lib/profitReadModel/sourceVersion"
  );
  const loaded = await loadProfitReadModel({
    repository,
    marketplace,
    companyScope: key.companyScope,
    dateFrom: key.dateFrom,
    dateTo: key.dateTo,
    enqueueOnMiss: false,
    resolveCurrentSourceVersion: () =>
      computeCheapProfitSourceVersion({
        prisma,
        marketplace,
        companyScope: key.companyScope,
        dateFrom: key.dateFrom,
        dateTo: key.dateTo,
      }),
  });

  if (loaded.status === "HIT") {
    return pack(key, {
      isReady: true,
      updatedAt: loaded.meta?.generatedAt ?? null,
      dataMode: loaded.dataMode,
    });
  }

  const reason = loaded.reason;
  const retryableStale = reason === "SOURCE_FINGERPRINT_STALE";
  return pack(key, {
    isReady: false,
    reason: retryableStale ? "SOURCE_FINGERPRINT_STALE" : reason,
  });
}

async function probeProfitPair(key: ReadinessKey): Promise<LightweightReadiness> {
  const wantWb = key.marketplace === "ALL" || key.marketplace === "WB";
  const wantOzon =
    key.marketplace === "ALL" ||
    key.marketplace === "OZON" ||
    key.marketplace === "Ozon";

  const parts: LightweightReadiness[] = [];
  if (wantWb) {
    parts.push(await probeProfit({ ...key, marketplace: "WB" }, "WB"));
  }
  if (wantOzon) {
    parts.push(await probeProfit({ ...key, marketplace: "OZON" }, "OZON"));
  }

  const ready = parts.length > 0 && parts.every((part) => part.isReady);
  const errorPart = parts.find((part) => part.status === "ERROR");
  const pendingPart = parts.find((part) => part.status === "PENDING");
  const reason = ready
    ? null
    : errorPart?.reason ?? pendingPart?.reason ?? "PROFIT_PAIR_PENDING";

  return pack(key, {
    isReady: ready,
    reason,
    updatedAt: parts.map((part) => part.updatedAt).find(Boolean) ?? null,
    dataMode: parts.map((part) => part.dataMode).find(Boolean) ?? null,
  });
}

async function probeStockAbc(key: ReadinessKey): Promise<LightweightReadiness> {
  const packResult = await readStockAbcSnapshots({
    companyScope: key.companyScope,
    dateFrom: key.dateFrom,
    dateTo: key.dateTo,
  });
  const generatedAt =
    packResult.metadata.map((row) => row.generatedAt).find(Boolean) ?? null;
  if (packResult.isExact) {
    return pack(key, {
      isReady: true,
      updatedAt: generatedAt,
      dataMode: "FINAL",
    });
  }
  return pack(key, {
    isReady: false,
    reason: "STOCK_ABC_SNAPSHOT_NOT_EXACT",
    updatedAt: generatedAt,
  });
}

export async function getLightweightReadiness(input: {
  surface: string;
  dateFrom: string;
  dateTo: string;
  companyScope?: string | null;
  marketplace?: string | null;
}): Promise<LightweightReadiness> {
  const key = normalizeReadinessKey(input);

  if (!key.surface || !key.dateFrom || !key.dateTo) {
    return pack(key, { isReady: false, reason: "INVALID_STATUS_QUERY" });
  }

  switch (key.surface) {
    case "dashboard_v6":
      return probeDashboard(key);
    case "profit_wb":
      return probeProfit({ ...key, marketplace: "WB" }, "WB");
    case "profit_ozon":
      return probeProfit({ ...key, marketplace: "OZON" }, "OZON");
    case "profit_pair":
      return probeProfitPair(key);
    case "stock_abc":
      return probeStockAbc(key);
    default:
      return pack(key, { isReady: false, reason: "UNKNOWN_SURFACE" });
  }
}
