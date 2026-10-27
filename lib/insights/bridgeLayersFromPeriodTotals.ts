/**
 * Shared residual-layer extraction from producer ProfitPeriodMetric totals.
 * Used by loadDetailSnapshot and offline replay so both paths share one algorithm.
 *
 * Completeness contract (FIN_PROOF):
 * - null / undefined / "" / non-finite ≠ known zero
 * - known zero must be an explicit finite 0 on the producer payload
 * - missing formulaVersion / dataMode cannot yield FINAL
 * - expected marketplace absent → unavailable (null), not silent zero
 */

import {
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
} from "@/lib/profitReadModel/contract";
import type { LiveBridgeLayers } from "@/lib/insights/accountResidualBridge";

export type PeriodMetricBridgeRow = {
  marketplace: string;
  formulaVersion?: string | null;
  dataMode?: string | null;
  totals?: Record<string, unknown> | null;
};

const WB_FORMULA = FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1;
const OZON_FORMULA = FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1;

/**
 * Present + finite number. Rejects null/undefined/"" / whitespace / NaN.
 * Number(null)===0 and Number("")===0 are NOT accepted as known zero.
 */
export function presentFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pick at most one WB and one Ozon period for the scope. Duplicate formula
 * versions for the same marketplace are rejected (unavailable), not summed.
 * Missing formulaVersion is NOT treated as compatible.
 */
export function selectCompatiblePeriodMetrics(
  periods: PeriodMetricBridgeRow[],
): {
  selected: PeriodMetricBridgeRow[];
  rejectedReason: string | null;
} {
  const byMp = new Map<string, PeriodMetricBridgeRow[]>();
  for (const p of periods) {
    const mp = String(p.marketplace || "").toUpperCase();
    if (mp !== "WB" && mp !== "OZON") continue;
    const list = byMp.get(mp) ?? [];
    list.push(p);
    byMp.set(mp, list);
  }

  const selected: PeriodMetricBridgeRow[] = [];
  for (const [mp, list] of byMp) {
    const expected = mp === "WB" ? WB_FORMULA : OZON_FORMULA;
    const compatible = list.filter(
      (p) =>
        p.formulaVersion != null &&
        String(p.formulaVersion).trim() !== "" &&
        String(p.formulaVersion) === expected,
    );
    if (compatible.length === 0 && list.length > 0) {
      return {
        selected: [],
        rejectedReason: `NO_COMPATIBLE_FORMULA_${mp}`,
      };
    }
    if (compatible.length > 1) {
      const exact = compatible.filter(
        (p) => String(p.formulaVersion) === expected,
      );
      if (exact.length === 1) {
        selected.push(exact[0]);
        continue;
      }
      return {
        selected: [],
        rejectedReason: `DUPLICATE_FORMULA_VERSIONS_${mp}`,
      };
    }
    if (compatible.length === 1) selected.push(compatible[0]);
  }

  return { selected, rejectedReason: null };
}

export function buildBridgeLayersFromPeriodTotals(params: {
  companyScope: string;
  skuNetProfit: number | null;
  periods: PeriodMetricBridgeRow[];
  financeSignedImpact: number | null;
  /**
   * Marketplaces that inventory says should be present for this scope/period.
   * Default both — absence becomes unavailable, not known-zero.
   * Pass a subset only when the cabinet truly has no activity on that MP.
   */
  expectedMarketplaces?: Array<"WB" | "OZON">;
}): LiveBridgeLayers & { rejectedReason?: string | null } {
  const expected = params.expectedMarketplaces ?? ["WB", "OZON"];
  const { selected, rejectedReason } = selectCompatiblePeriodMetrics(
    params.periods,
  );
  if (rejectedReason) {
    return {
      companyScope: params.companyScope,
      skuNetProfit: params.skuNetProfit,
      wbUnallocatedAds: null,
      wbStorage: null,
      wbUnallocatedLogistics: null,
      wbUnallocatedAcceptance: null,
      wbUnallocatedPenalties: null,
      ozonPartnerResidual: null,
      ozonUnallocatedExpenses: null,
      financeSignedImpact: params.financeSignedImpact,
      observedAccountMarketplaceProfit: null,
      sourceVersion: null,
      finality: null,
      rejectedReason,
    };
  }

  let wbUnallocatedAds: number | null = null;
  let wbStorage: number | null = null;
  let wbUnallocatedLogistics: number | null = null;
  let wbUnallocatedAcceptance: number | null = null;
  let wbUnallocatedPenalties: number | null = null;
  let ozonPartnerResidual: number | null = null;
  let ozonUnallocatedExpenses: number | null = null;
  let observedAccountMp: number | null = null;
  let sawWb = false;
  let sawOzon = false;
  const versions: string[] = [];
  let finality: string | null = null;
  let missingDataMode = false;

  for (const p of selected) {
    const t = (p.totals ?? {}) as Record<string, unknown>;
    const mp = String(p.marketplace).toUpperCase();
    // Every selected expected period must expose a present+finite netProfitAfterTax.
    // Skipping a missing net (and summing the rest) falsely yields RECONCILED/FINAL.
    const net = presentFiniteNumber(t.netProfitAfterTax);
    if (net == null) {
      return {
        companyScope: params.companyScope,
        skuNetProfit: params.skuNetProfit,
        wbUnallocatedAds: null,
        wbStorage: null,
        wbUnallocatedLogistics: null,
        wbUnallocatedAcceptance: null,
        wbUnallocatedPenalties: null,
        ozonPartnerResidual: null,
        ozonUnallocatedExpenses: null,
        financeSignedImpact: params.financeSignedImpact,
        observedAccountMarketplaceProfit: null,
        sourceVersion: null,
        finality: null,
        rejectedReason: `MISSING_NET_PROFIT_AFTER_TAX_${mp || "UNKNOWN"}`,
      };
    }
    observedAccountMp = (observedAccountMp ?? 0) + net;

    if (mp === "WB") {
      sawWb = true;
      wbUnallocatedAds = presentFiniteNumber(
        t.undistributedAdsCost ?? t.unallocatedAdsCost,
      );
      wbStorage = presentFiniteNumber(t.unallocatedStorageCost);
      wbUnallocatedLogistics = presentFiniteNumber(t.unallocatedLogisticsCost);
      wbUnallocatedAcceptance = presentFiniteNumber(t.unallocatedAcceptanceCost);
      wbUnallocatedPenalties = presentFiniteNumber(t.unallocatedPenaltiesAmount);
    }
    if (mp === "OZON") {
      sawOzon = true;
      ozonPartnerResidual = presentFiniteNumber(
        t.unallocatedPartnerResidual ?? t.unallocatedPartnerPrograms,
      );
      const uComm = presentFiniteNumber(t.unallocatedCommissionCost);
      const uLog = presentFiniteNumber(t.unallocatedLogisticsCost);
      const uDed = presentFiniteNumber(t.unallocatedDeductionsCost);
      // All three mandatory Ozon expense residuals must be present+finite.
      if (uComm == null || uLog == null || uDed == null) {
        ozonUnallocatedExpenses = null;
      } else {
        ozonUnallocatedExpenses = uComm + uLog + uDed;
      }
    }
    if (p.formulaVersion) versions.push(String(p.formulaVersion));
    if (p.dataMode == null || String(p.dataMode).trim() === "") {
      missingDataMode = true;
    } else if (p.dataMode === "PRELIMINARY" || finality === "PRELIMINARY") {
      finality = "PRELIMINARY";
    } else if (!finality) {
      finality = String(p.dataMode);
    }
  }

  // Absent expected marketplace → leave null (incomplete load), do not invent 0.
  // Only when inventory says the MP is not expected may residuals be known-zero.
  if (!sawWb) {
    if (expected.includes("WB")) {
      wbUnallocatedAds = null;
      wbStorage = null;
      wbUnallocatedLogistics = null;
      wbUnallocatedAcceptance = null;
      wbUnallocatedPenalties = null;
    } else {
      wbUnallocatedAds = 0;
      wbStorage = 0;
      wbUnallocatedLogistics = 0;
      wbUnallocatedAcceptance = 0;
      wbUnallocatedPenalties = 0;
    }
  }
  if (!sawOzon) {
    if (expected.includes("OZON")) {
      ozonPartnerResidual = null;
      ozonUnallocatedExpenses = null;
    } else {
      ozonPartnerResidual = 0;
      ozonUnallocatedExpenses = 0;
    }
  }

  // Missing dataMode or missing source versions cannot claim FINAL.
  if (missingDataMode || versions.length === 0) {
    finality = "PRELIMINARY";
  }
  if (finality === "FINAL" && versions.length < selected.length) {
    finality = "PRELIMINARY";
  }

  return {
    companyScope: params.companyScope,
    skuNetProfit: params.skuNetProfit,
    wbUnallocatedAds,
    wbStorage,
    wbUnallocatedLogistics,
    wbUnallocatedAcceptance,
    wbUnallocatedPenalties,
    ozonPartnerResidual,
    ozonUnallocatedExpenses,
    financeSignedImpact: params.financeSignedImpact,
    observedAccountMarketplaceProfit: observedAccountMp,
    sourceVersion: versions.length ? versions.join("+") : null,
    finality,
    rejectedReason: null,
  };
}
