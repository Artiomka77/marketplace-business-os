/**
 * Shared ProductCost lookup used by /stocks and Insights frozen-stock valuation.
 * Mirrors app/stocks/page.tsx helpers — do not invent alternate cost math.
 */

export type CostLookup = {
  bySupplierArticle: Map<string, number>;
  bySupplierArticleCompact: Map<string, number>;
  byNmId: Map<string, number>;
  bySupplierArticleRoot: Map<string, number>;
  bySupplierArticleRootCompact: Map<string, number>;
  supplierArticleByCompanyAndWbArticle: Map<string, string>;
  supplierArticleByWbArticle: Map<string, string>;
};

export function toCostNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export function normalizeCostKey(value: unknown) {
  return String(value ?? "").trim();
}

export function normalizeArticleForMatch(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[\s\-_/\\.]+/g, "")
    .trim();
}

export function getSupplierArticleRoot(value: unknown) {
  const vendorCode = normalizeCostKey(value);
  if (!vendorCode) return "";
  return vendorCode.split("-")[0]?.trim() ?? vendorCode;
}

export function getSupplierArticleCandidates(value: unknown) {
  const vendorCode = normalizeCostKey(value);
  if (!vendorCode) return [];

  const candidates = new Set<string>();
  candidates.add(vendorCode);

  const parts = vendorCode
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length > 1) {
    for (let length = parts.length - 1; length >= 1; length--) {
      candidates.add(parts.slice(0, length).join("-"));
    }
  }

  candidates.add(getSupplierArticleRoot(vendorCode));
  return Array.from(candidates).filter(Boolean);
}

export function getCompanyArticleKey(companyName: unknown, wbArticle: unknown) {
  const company = normalizeCostKey(companyName);
  const article = normalizeCostKey(wbArticle);
  return company && article ? `${company}::${article}` : "";
}

export function getMarketplaceBaseArticle(value: unknown) {
  const article = normalizeCostKey(value);
  if (!article) return "";
  const baseArticle = article.split("-")[0]?.trim() ?? article;
  return /^\d+$/.test(baseArticle) ? baseArticle : "";
}

export function findCostBySupplierArticle(
  value: unknown,
  costs: CostLookup,
): number | undefined {
  const candidates = getSupplierArticleCandidates(value);

  for (const candidate of candidates) {
    const exact = costs.bySupplierArticle.get(candidate);
    if (exact !== undefined) return exact;

    const compact = costs.bySupplierArticleCompact.get(
      normalizeArticleForMatch(candidate),
    );
    if (compact !== undefined) return compact;

    const root = getSupplierArticleRoot(candidate);
    const rootExact = costs.bySupplierArticleRoot.get(root);
    if (rootExact !== undefined) return rootExact;

    const rootCompact = costs.bySupplierArticleRootCompact.get(
      normalizeArticleForMatch(root),
    );
    if (rootCompact !== undefined) return rootCompact;
  }

  return undefined;
}

export function findSupplierArticleByWbArticle(params: {
  companyName?: string | null;
  wbArticle: unknown;
  costs: CostLookup;
}) {
  const wbArticle = normalizeCostKey(params.wbArticle);
  if (!wbArticle) return null;

  const companyKey = getCompanyArticleKey(params.companyName, wbArticle);

  return (
    (companyKey
      ? params.costs.supplierArticleByCompanyAndWbArticle.get(companyKey)
      : undefined) ??
    params.costs.supplierArticleByWbArticle.get(wbArticle) ??
    null
  );
}

export function findCostByMappedWbArticle(params: {
  companyName?: string | null;
  wbArticle: unknown;
  costs: CostLookup;
}) {
  const supplierArticle = findSupplierArticleByWbArticle({
    companyName: params.companyName,
    wbArticle: params.wbArticle,
    costs: params.costs,
  });

  if (!supplierArticle) return undefined;
  return findCostBySupplierArticle(supplierArticle, params.costs);
}

/** Same resolution order as /stocks getCostPrice. Returns null when no cost found. */
export function getStockUnitCost(params: {
  companyName?: string | null;
  vendorCode: string | null | undefined;
  nmId?: string | null;
  sku?: string | null;
  ownCostPrice?: unknown;
  costs: CostLookup;
}): number | null {
  const ownCostPrice = toCostNumber(params.ownCostPrice);
  if (ownCostPrice > 0) return ownCostPrice;

  const supplierArticleCost = findCostBySupplierArticle(
    params.vendorCode,
    params.costs,
  );
  if (supplierArticleCost !== undefined) return supplierArticleCost;

  const nmId = normalizeCostKey(params.nmId);
  const sku = normalizeCostKey(params.sku);
  const marketplaceBaseArticle = getMarketplaceBaseArticle(params.vendorCode);

  const costByNmIdMapping = findCostByMappedWbArticle({
    companyName: params.companyName,
    wbArticle: nmId,
    costs: params.costs,
  });
  if (costByNmIdMapping !== undefined) return costByNmIdMapping;

  const costByOzonBaseMapping = findCostByMappedWbArticle({
    companyName: params.companyName,
    wbArticle: marketplaceBaseArticle,
    costs: params.costs,
  });
  if (costByOzonBaseMapping !== undefined) return costByOzonBaseMapping;

  const resolved =
    (nmId ? params.costs.byNmId.get(nmId) : undefined) ??
    (sku ? params.costs.byNmId.get(sku) : undefined) ??
    findCostBySupplierArticle(nmId, params.costs) ??
    findCostBySupplierArticle(sku, params.costs);

  return resolved !== undefined ? resolved : null;
}

export function buildProductCostLookup(
  productCosts: Array<{
    vendorCode?: string | null;
    nmId?: string | null;
    costPrice?: unknown;
  }>,
  mappings: Array<{
    companyName?: string | null;
    wbArticle?: string | null;
    supplierArticle?: string | null;
  }> = [],
): CostLookup {
  const bySupplierArticle = new Map<string, number>();
  const bySupplierArticleCompact = new Map<string, number>();
  const byNmId = new Map<string, number>();
  const bySupplierArticleRoot = new Map<string, number>();
  const bySupplierArticleRootCompact = new Map<string, number>();
  const supplierArticleByCompanyAndWbArticle = new Map<string, string>();
  const supplierArticleByWbArticle = new Map<string, string>();

  for (const cost of productCosts) {
    const vendorCode = normalizeCostKey(cost.vendorCode);
    const nmId = normalizeCostKey(cost.nmId);
    const costPrice = toCostNumber(cost.costPrice);

    if (vendorCode) {
      for (const candidate of getSupplierArticleCandidates(vendorCode)) {
        if (!bySupplierArticle.has(candidate)) {
          bySupplierArticle.set(candidate, costPrice);
        }
        const compactCandidate = normalizeArticleForMatch(candidate);
        if (compactCandidate && !bySupplierArticleCompact.has(compactCandidate)) {
          bySupplierArticleCompact.set(compactCandidate, costPrice);
        }
      }

      const vendorRoot = getSupplierArticleRoot(vendorCode);
      if (vendorRoot && !bySupplierArticleRoot.has(vendorRoot)) {
        bySupplierArticleRoot.set(vendorRoot, costPrice);
      }
      const compactRoot = normalizeArticleForMatch(vendorRoot);
      if (compactRoot && !bySupplierArticleRootCompact.has(compactRoot)) {
        bySupplierArticleRootCompact.set(compactRoot, costPrice);
      }
    }

    if (nmId && !byNmId.has(nmId)) {
      byNmId.set(nmId, costPrice);
    }
  }

  for (const mapping of mappings) {
    const wbArticle = normalizeCostKey(mapping.wbArticle);
    const supplierArticle = normalizeCostKey(mapping.supplierArticle);
    if (!wbArticle || !supplierArticle) continue;

    const companyKey = getCompanyArticleKey(mapping.companyName, wbArticle);
    if (companyKey && !supplierArticleByCompanyAndWbArticle.has(companyKey)) {
      supplierArticleByCompanyAndWbArticle.set(companyKey, supplierArticle);
    }
    if (!supplierArticleByWbArticle.has(wbArticle)) {
      supplierArticleByWbArticle.set(wbArticle, supplierArticle);
    }
  }

  return {
    bySupplierArticle,
    bySupplierArticleCompact,
    byNmId,
    bySupplierArticleRoot,
    bySupplierArticleRootCompact,
    supplierArticleByCompanyAndWbArticle,
    supplierArticleByWbArticle,
  };
}
