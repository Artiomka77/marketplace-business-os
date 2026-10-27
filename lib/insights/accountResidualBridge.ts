/**
 * Explicit SKU → marketplace account residual bridge.
 * Documents unallocated WB ads/storage, Ozon account-level expense residual,
 * and Ozon partner residual. Does NOT invent SKU allocation.
 */

export type AccountResidualBridgeInput = {
  skuNetProfit: number;
  wbUnallocatedAds: number;
  wbStorage: number;
  /** WB logistics (and similar ops) on account but not on SKU rows. */
  wbUnallocatedLogistics?: number;
  /** WB acceptance on account but not on SKU rows. */
  wbUnallocatedAcceptance?: number;
  /** WB penalties on account but not on SKU rows. */
  wbUnallocatedPenalties?: number;
  ozonPartnerResidual: number;
  /** Ozon category-fact expenses not on SKUs (commission/logistics/deductions/…). */
  ozonUnallocatedExpenses?: number;
  financeSignedImpact: number;
};

export type AccountResidualBridge = {
  skuNetProfit: number;
  wbUnallocatedAds: number;
  wbStorage: number;
  wbUnallocatedLogistics: number;
  wbUnallocatedAcceptance: number;
  wbUnallocatedPenalties: number;
  ozonPartnerResidual: number;
  ozonUnallocatedExpenses: number;
  /** SKU − WB residuals − Ozon unallocated expenses + partner residual */
  marketplaceProfit: number;
  financeSignedImpact: number;
  /** marketplace + financeSignedImpact (finance is typically negative) */
  businessProfit: number;
  /** sku − marketplace */
  skuToMarketplaceGap: number;
  formula: string;
};

export function buildAccountResidualBridge(
  input: AccountResidualBridgeInput,
): AccountResidualBridge {
  const ozonUnallocatedExpenses = Number(input.ozonUnallocatedExpenses ?? 0) || 0;
  const wbUnallocatedLogistics = Number(input.wbUnallocatedLogistics ?? 0) || 0;
  const wbUnallocatedAcceptance = Number(input.wbUnallocatedAcceptance ?? 0) || 0;
  const wbUnallocatedPenalties = Number(input.wbUnallocatedPenalties ?? 0) || 0;
  const marketplaceProfit =
    input.skuNetProfit -
    input.wbUnallocatedAds -
    input.wbStorage -
    wbUnallocatedLogistics -
    wbUnallocatedAcceptance -
    wbUnallocatedPenalties -
    ozonUnallocatedExpenses +
    input.ozonPartnerResidual;
  const businessProfit = marketplaceProfit + input.financeSignedImpact;
  const skuToMarketplaceGap = input.skuNetProfit - marketplaceProfit;
  return {
    ...input,
    wbUnallocatedLogistics,
    wbUnallocatedAcceptance,
    wbUnallocatedPenalties,
    ozonUnallocatedExpenses,
    marketplaceProfit,
    businessProfit,
    skuToMarketplaceGap,
    formula:
      "SKU − WB_unallocated_ads − WB_unallocated_storage − WB_unallocated_logistics − WB_unallocated_acceptance − WB_unallocated_penalties − Ozon_unallocated_expenses + Ozon_partner_residual = MP; MP + Finance = business",
  };
}

/** Accepted week 19–25.10.2026 bridge (STORE_ACTUAL) — regression fixture ONLY. */
export const WEEK_2026_10_19_25_ACCEPTED_BRIDGE: AccountResidualBridgeInput = {
  skuNetProfit: 2068397.96,
  wbUnallocatedAds: 157139,
  wbStorage: 8175.3,
  ozonPartnerResidual: 21393.12,
  financeSignedImpact: -37512.87,
};

export type LiveBridgeLayers = {
  companyScope: string;
  skuNetProfit: number | null;
  /** Account − already-on-SKU ads (not total adsCost). */
  wbUnallocatedAds: number | null;
  /** Account − already-on-SKU storage. */
  wbStorage: number | null;
  /** Account − already-on-SKU logistics (incl. ownership-interval estimates). */
  wbUnallocatedLogistics?: number | null;
  /** Account − already-on-SKU acceptance. */
  wbUnallocatedAcceptance?: number | null;
  /** Account − already-on-SKU penalties. */
  wbUnallocatedPenalties?: number | null;
  /** Account partner − SKU-attributed partner (not total partner). */
  ozonPartnerResidual: number | null;
  /** Account Ozon expenses not present on SKU rows (honest residual). */
  ozonUnallocatedExpenses?: number | null;
  financeSignedImpact: number | null;
  /** Independently observed account MP profit (WB+Ozon nets). */
  observedAccountMarketplaceProfit?: number | null;
  sourceVersion?: string | null;
  finality?: string | null;
};

export type LiveAccountResidualBridge = AccountResidualBridge & {
  companyScope: string;
  status: "RECONCILED" | "DIVERGED" | "LIVE";
  observedAccountMarketplaceProfit: number | null;
  accountBridgeResidual: number | null;
  sourceVersion: string | null;
  finality: string | null;
};

/**
 * Build a scope-aware bridge only when every live layer is finite.
 * Missing inputs → null (UNAVAILABLE), never FALL BACK to week constants.
 * RECONCILED only when calculated MP matches independent account MP (±0.02).
 */
export function buildLiveAccountResidualBridge(
  layers: LiveBridgeLayers,
): LiveAccountResidualBridge | null {
  const {
    companyScope,
    skuNetProfit,
    wbUnallocatedAds,
    wbStorage,
    // No default 0: omitted/undefined must stay missing (≠ known zero).
    wbUnallocatedLogistics,
    wbUnallocatedAcceptance,
    wbUnallocatedPenalties,
    ozonPartnerResidual,
    ozonUnallocatedExpenses,
    financeSignedImpact,
    observedAccountMarketplaceProfit = null,
    sourceVersion = null,
    finality = null,
  } = layers;
  // Missing residual metadata ≠ known zero. Reject null/undefined/"" / NaN.
  // Number(null)===0 and Number("")===0 must NOT pass as known zero.
  const isPresentFinite = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n);
  const nums = [
    skuNetProfit,
    wbUnallocatedAds,
    wbStorage,
    wbUnallocatedLogistics,
    wbUnallocatedAcceptance,
    wbUnallocatedPenalties,
    ozonPartnerResidual,
    ozonUnallocatedExpenses,
    financeSignedImpact,
  ];
  if (nums.some((n) => !isPresentFinite(n))) {
    return null;
  }
  const ozonUnalloc = ozonUnallocatedExpenses as number;
  const wbUnallocLog = wbUnallocatedLogistics as number;
  const bridge = buildAccountResidualBridge({
    skuNetProfit: Number(skuNetProfit),
    wbUnallocatedAds: Number(wbUnallocatedAds),
    wbStorage: Number(wbStorage),
    wbUnallocatedLogistics: wbUnallocLog,
    wbUnallocatedAcceptance: Number(wbUnallocatedAcceptance),
    wbUnallocatedPenalties: Number(wbUnallocatedPenalties),
    ozonPartnerResidual: Number(ozonPartnerResidual),
    ozonUnallocatedExpenses: ozonUnalloc,
    financeSignedImpact: Number(financeSignedImpact),
  });
  const observed =
    observedAccountMarketplaceProfit != null &&
    Number.isFinite(Number(observedAccountMarketplaceProfit))
      ? Number(observedAccountMarketplaceProfit)
      : null;
  const accountBridgeResidual =
    observed != null ? bridge.marketplaceProfit - observed : null;
  let status: LiveAccountResidualBridge["status"] = "LIVE";
  if (observed != null && accountBridgeResidual != null) {
    status =
      Math.abs(accountBridgeResidual) <= 0.02 ? "RECONCILED" : "DIVERGED";
  }
  return {
    companyScope,
    status,
    observedAccountMarketplaceProfit: observed,
    accountBridgeResidual,
    sourceVersion,
    finality,
    ...bridge,
  };
}
