export type CanonicalProductCostRecord = {
  id?: string | null;
  vendorCode: unknown;
  nmId?: unknown;
  costPrice: unknown;
  costDate?: Date | string | null;
  createdAt?: Date | string | null;
};

export function normalizeProductCostKey(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[–—−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function toPositiveProductCost(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }

  const numeric =
    typeof value === "object" && "toNumber" in value
      ? Number((value as { toNumber: () => number }).toNumber())
      : Number(value);

  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function timestamp(value: Date | string | null | undefined) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const date = value instanceof Date ? value : new Date(value);
  const result = date.getTime();
  return Number.isFinite(result) ? result : Number.NEGATIVE_INFINITY;
}

export function compareCanonicalProductCosts(
  left: CanonicalProductCostRecord,
  right: CanonicalProductCostRecord
) {
  return (
    timestamp(right.costDate) - timestamp(left.costDate) ||
    timestamp(right.createdAt) - timestamp(left.createdAt) ||
    String(right.id ?? "").localeCompare(String(left.id ?? ""))
  );
}

export function buildCanonicalPositiveCostLookups(
  costs: CanonicalProductCostRecord[]
) {
  const costByVendorCode = new Map<string, number>();
  const costByNmId = new Map<string, number>();

  for (const cost of [...costs].sort(compareCanonicalProductCosts)) {
    const costPrice = toPositiveProductCost(cost.costPrice);
    if (costPrice === null) continue;

    const vendorCode = normalizeProductCostKey(cost.vendorCode);
    const nmId = normalizeProductCostKey(cost.nmId);

    if (vendorCode && !costByVendorCode.has(vendorCode)) {
      costByVendorCode.set(vendorCode, costPrice);
    }
    if (nmId && !costByNmId.has(nmId)) {
      costByNmId.set(nmId, costPrice);
    }
  }

  return { costByVendorCode, costByNmId };
}

/**
 * Sized marketplace offer/vendor codes like `1492430240-158` encode base nmId + size.
 * Only digit-base forms qualify (never split textual articles like `ади-флис-вчерный`).
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
