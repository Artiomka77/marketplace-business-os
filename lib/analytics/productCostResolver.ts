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
