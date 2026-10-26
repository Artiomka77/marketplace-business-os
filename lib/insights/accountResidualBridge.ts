/**
 * Explicit SKU → marketplace account residual bridge.
 * Documents unallocated WB ads/storage and Ozon partner residual.
 * Does NOT allocate onto SKUs or double-count into account profit.
 */

export type AccountResidualBridgeInput = {
  skuNetProfit: number;
  wbUnallocatedAds: number;
  wbStorage: number;
  ozonPartnerResidual: number;
  financeSignedImpact: number;
};

export type AccountResidualBridge = {
  skuNetProfit: number;
  wbUnallocatedAds: number;
  wbStorage: number;
  ozonPartnerResidual: number;
  /** SKU − WB ads − WB storage + Ozon partner residual */
  marketplaceProfit: number;
  financeSignedImpact: number;
  /** marketplace + financeSignedImpact (finance is typically negative) */
  businessProfit: number;
  /** sku − marketplace = WB ads + storage − partner residual */
  skuToMarketplaceGap: number;
  formula: string;
};

export function buildAccountResidualBridge(
  input: AccountResidualBridgeInput,
): AccountResidualBridge {
  const marketplaceProfit =
    input.skuNetProfit -
    input.wbUnallocatedAds -
    input.wbStorage +
    input.ozonPartnerResidual;
  const businessProfit = marketplaceProfit + input.financeSignedImpact;
  const skuToMarketplaceGap = input.skuNetProfit - marketplaceProfit;
  return {
    ...input,
    marketplaceProfit,
    businessProfit,
    skuToMarketplaceGap,
    formula:
      "SKU − WB_ads − WB_storage + Ozon_partner_residual = MP; MP + Finance = business",
  };
}

/** Accepted week 19–25.10.2026 bridge (STORE_ACTUAL). */
export const WEEK_2026_10_19_25_ACCEPTED_BRIDGE: AccountResidualBridgeInput = {
  skuNetProfit: 2068397.96,
  wbUnallocatedAds: 157139,
  wbStorage: 8175.3,
  ozonPartnerResidual: 21393.12,
  financeSignedImpact: -37512.87,
};
