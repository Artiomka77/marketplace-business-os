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
  /** vendor base (before first '-') → unit cost when family siblings agree */
  const costByVendorFamily = new Map<string, number>();

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
    if (vendorCode) {
      const base = vendorCode.split("-")[0] || vendorCode;
      if (!costByVendorFamily.has(base)) {
        costByVendorFamily.set(base, costPrice);
      } else if (costByVendorFamily.get(base) !== costPrice) {
        // Divergent family sizes — keep first; exact variant still wins above.
        costByVendorFamily.set(base, costByVendorFamily.get(base)!);
      }
    }
  }

  return { costByVendorCode, costByNmId, costByVendorFamily };
}

export function ozonVendorBaseArticle(vendorCode: unknown) {
  const text = normalizeProductCostKey(vendorCode);
  if (!text) return "";
  return text.split("-")[0] || text;
}

/** Telegram/placeholder: vendorCode=numeric SKU and cost 10 — never beats real variant. */
export function isOzonSkuCostPlaceholder(vendorKey: string, cost: number) {
  return cost === 10 && /^\d+$/.test(vendorKey);
}

/**
 * Canonical Ozon unit cost.
 * CANON_EXPLICIT (sku-keyed, non-placeholder) beats offer vendor when both exist
 * (accepted 2760136185=920 over 371584460-*=970). Placeholder sku cost 10 never
 * beats exact size variant (1237829938-164=920).
 */
export function resolveCanonicalOzonUnitCost(params: {
  vendorCode?: unknown;
  sku?: unknown;
  costByVendorCode: Map<string, number>;
  costByNmId: Map<string, number>;
  costByVendorFamily?: Map<string, number>;
}): { unitCost: number | null; source: string | null } {
  const vendor = normalizeProductCostKey(params.vendorCode);
  const sku = normalizeProductCostKey(params.sku);
  const { costByVendorCode, costByNmId, costByVendorFamily } = params;

  if (sku && costByVendorCode.has(sku)) {
    const skuCost = costByVendorCode.get(sku)!;
    if (!isOzonSkuCostPlaceholder(sku, skuCost)) {
      return { unitCost: skuCost, source: "CANON_EXPLICIT" };
    }
  }
  if (sku && costByNmId.has(sku)) {
    const skuCost = costByNmId.get(sku)!;
    if (!isOzonSkuCostPlaceholder(sku, skuCost)) {
      return { unitCost: skuCost, source: "CANON_EXPLICIT" };
    }
  }

  if (vendor && costByVendorCode.has(vendor)) {
    return {
      unitCost: costByVendorCode.get(vendor)!,
      source: "ProductCost.vendorCode",
    };
  }

  const base = ozonVendorBaseArticle(vendor || sku);
  if (base && costByVendorCode.has(base)) {
    return {
      unitCost: costByVendorCode.get(base)!,
      source: "CANON_BASE_EXPLICIT",
    };
  }
  if (base && costByNmId.has(base)) {
    return { unitCost: costByNmId.get(base)!, source: "CANON_BASE_EXPLICIT" };
  }
  if (base && costByVendorFamily?.has(base)) {
    return {
      unitCost: costByVendorFamily.get(base)!,
      source: "CANON_FAMILY",
    };
  }

  // Placeholder sku cost only as last resort (never preferred above).
  if (sku && costByVendorCode.has(sku)) {
    return {
      unitCost: costByVendorCode.get(sku)!,
      source: "ProductCost.vendorCode",
    };
  }
  if (sku && costByNmId.has(sku)) {
    return { unitCost: costByNmId.get(sku)!, source: "ProductCost.nmId" };
  }

  return { unitCost: null, source: null };
}
