import { normalizeProductCostKey } from "@/lib/analytics/productCostResolver";

/**
 * Presentation/COGS helpers kept outside sealed productCostResolver.ts.
 */
export function extractSizedOfferBaseNmId(vendorCode: unknown): string | null {
  const key = normalizeProductCostKey(vendorCode);
  const match = key.match(/^(\d{6,})-(\d{2,4})$/);
  return match ? match[1] : null;
}

/**
 * Canonical Ozon/WB unit-cost resolution:
 * 1) exact vendorCode key
 * 2) exact nmId key
 * 3) sized-offer base nmId → costByNmId / costByVendorCode
 * 4) optional WB supplier article for that base nmId → costByVendorCode
 */
export function resolveCanonicalUnitCost(params: {
  costByVendorCode: Map<string, number>;
  costByNmId: Map<string, number>;
  vendorCodeKey: string;
  wbSupplierArticleByNmId?: Map<string, string>;
}): number | null {
  const key = normalizeProductCostKey(params.vendorCodeKey);
  if (!key) return null;

  if (params.costByVendorCode.has(key)) return params.costByVendorCode.get(key)!;
  if (params.costByNmId.has(key)) return params.costByNmId.get(key)!;

  const baseNmId = extractSizedOfferBaseNmId(key);
  if (baseNmId) {
    if (params.costByNmId.has(baseNmId)) return params.costByNmId.get(baseNmId)!;
    if (params.costByVendorCode.has(baseNmId)) {
      return params.costByVendorCode.get(baseNmId)!;
    }
    const wbArticle = params.wbSupplierArticleByNmId?.get(baseNmId);
    if (wbArticle && params.costByVendorCode.has(wbArticle)) {
      return params.costByVendorCode.get(wbArticle)!;
    }
  }

  return null;
}
