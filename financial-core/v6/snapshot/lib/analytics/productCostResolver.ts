export type CanonicalProductCostRecord = {
  id?: string | null;
  vendorCode: unknown;
  nmId?: unknown;
  costPrice: unknown;
  costDate?: Date | string | null;
  createdAt?: Date | string | null;
};

/**
 * Documented Ozon SKU→cost exceptions (FIN_PATCH / FIN_GATE accepted).
 * Numeric SKU rows are NOT automatically canonical.
 */
export const DOCUMENTED_OZON_SKU_UNIT_COSTS: ReadonlyMap<string, number> =
  new Map([
    ["2760136185", 920],
  ]);

/** Accepted family bases with unanimous static 2026 cost (offer-* variants). */
export const DOCUMENTED_OZON_FAMILY_UNIT_COSTS: ReadonlyMap<string, number> =
  new Map([
    ["1492430240", 1450],
  ]);

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
  const familyPrices = new Map<string, Set<number>>();

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
    if (vendorCode.includes("-")) {
      const base = vendorCode.split("-")[0] || vendorCode;
      const set = familyPrices.get(base) ?? new Set<number>();
      set.add(costPrice);
      familyPrices.set(base, set);
    }
  }

  /** Only unanimous sibling prices become family fallback. Conflicts → absent. */
  const costByVendorFamily = new Map<string, number>();
  const conflictedFamilies = new Set<string>();
  for (const [base, prices] of familyPrices) {
    if (prices.size === 1) {
      costByVendorFamily.set(base, [...prices][0]!);
    } else {
      conflictedFamilies.add(base);
    }
  }
  for (const [base, price] of DOCUMENTED_OZON_FAMILY_UNIT_COSTS) {
    const key = normalizeProductCostKey(base);
    if (!conflictedFamilies.has(key)) {
      costByVendorFamily.set(key, price);
    }
  }

  return { costByVendorCode, costByNmId, costByVendorFamily, conflictedFamilies };
}

export function ozonVendorBaseArticle(vendorCode: unknown) {
  const text = normalizeProductCostKey(vendorCode);
  if (!text) return "";
  return text.split("-")[0] || text;
}

/** Telegram/placeholder: vendorCode=numeric SKU and cost 10. */
export function isOzonSkuCostPlaceholder(vendorKey: string, cost: number) {
  return cost === 10 && /^\d+$/.test(vendorKey);
}

export type OzonUnitCostResolution = {
  unitCost: number | null;
  source: string | null;
  matchedKey: string | null;
  conflict: string | null;
};

/**
 * Canonical Ozon unit cost priority (FIN_RUN):
 * 1) Documented SKU exception
 * 2) Documented family rule (e.g. 1492430240*=1450) — beats unapproved exact sibling
 * 3) Exact offer/vendorCode (non-placeholder)
 * 4) Unanimous family / base from ProductCost
 * 5) Non-placeholder sku/nmId lookup
 * Placeholder 10 alone → UNKNOWN. Conflicted family → UNKNOWN.
 */
export function resolveCanonicalOzonUnitCost(params: {
  vendorCode?: unknown;
  sku?: unknown;
  costByVendorCode: Map<string, number>;
  costByNmId: Map<string, number>;
  costByVendorFamily?: Map<string, number>;
  conflictedFamilies?: Set<string>;
}): OzonUnitCostResolution {
  const vendor = normalizeProductCostKey(params.vendorCode);
  const sku = normalizeProductCostKey(params.sku);
  const { costByVendorCode, costByNmId, costByVendorFamily, conflictedFamilies } =
    params;

  if (sku && DOCUMENTED_OZON_SKU_UNIT_COSTS.has(sku)) {
    return {
      unitCost: DOCUMENTED_OZON_SKU_UNIT_COSTS.get(sku)!,
      source: "CANON_EXPLICIT",
      matchedKey: sku,
      conflict: null,
    };
  }

  const base = ozonVendorBaseArticle(vendor || sku);
  if (base && DOCUMENTED_OZON_FAMILY_UNIT_COSTS.has(base)) {
    return {
      unitCost: DOCUMENTED_OZON_FAMILY_UNIT_COSTS.get(base)!,
      source: "CANON_FAMILY_DOCUMENTED",
      matchedKey: base,
      conflict: null,
    };
  }

  if (vendor && costByVendorCode.has(vendor)) {
    const exact = costByVendorCode.get(vendor)!;
    if (!isOzonSkuCostPlaceholder(vendor, exact)) {
      return {
        unitCost: exact,
        source: "ProductCost.vendorCode",
        matchedKey: vendor,
        conflict: null,
      };
    }
  }

  if (base && conflictedFamilies?.has(base)) {
    return {
      unitCost: null,
      source: null,
      matchedKey: base,
      conflict: "FAMILY_SIBLING_COST_CONFLICT",
    };
  }
  if (base && costByVendorCode.has(base)) {
    const baseCost = costByVendorCode.get(base)!;
    if (!isOzonSkuCostPlaceholder(base, baseCost)) {
      return {
        unitCost: baseCost,
        source: "CANON_BASE_EXPLICIT",
        matchedKey: base,
        conflict: null,
      };
    }
  }
  if (base && costByVendorFamily?.has(base)) {
    return {
      unitCost: costByVendorFamily.get(base)!,
      source: "CANON_FAMILY",
      matchedKey: base,
      conflict: null,
    };
  }

  if (sku && costByVendorCode.has(sku)) {
    const skuCost = costByVendorCode.get(sku)!;
    if (!isOzonSkuCostPlaceholder(sku, skuCost)) {
      return {
        unitCost: skuCost,
        source: "ProductCost.vendorCode",
        matchedKey: sku,
        conflict: null,
      };
    }
  }
  if (sku && costByNmId.has(sku)) {
    const skuCost = costByNmId.get(sku)!;
    if (!isOzonSkuCostPlaceholder(sku, skuCost)) {
      return {
        unitCost: skuCost,
        source: "ProductCost.nmId",
        matchedKey: sku,
        conflict: null,
      };
    }
  }

  // Placeholder-only matches are UNKNOWN — never promote coverage.
  return { unitCost: null, source: null, matchedKey: null, conflict: null };
}
