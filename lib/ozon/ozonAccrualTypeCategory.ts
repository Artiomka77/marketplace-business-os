/**
 * Canonical Ozon accrual typeId → financial category map.
 * Shared by accrualByDay (facts) and ozonAccrualExactSkuFees (SKU ledger)
 * so classifiers cannot diverge.
 */

export type OzonAccrualFinancialCategory =
  | "OZON_ADVERTISING"
  | "OZON_PARTNER_SERVICES"
  | "OZON_OTHER_SERVICES"
  | "OZON_FBO"
  | "OZON_DELIVERY"
  | "OZON_COMPENSATION"
  | "OZON_COMMISSION"
  | "OZON_UNCLASSIFIED_ADJUSTMENT";

export const OZON_ACCRUAL_TYPE_CATEGORY = new Map<
  number,
  OzonAccrualFinancialCategory
>([
  [41, "OZON_ADVERTISING"],
  [48, "OZON_ADVERTISING"],
  [54, "OZON_ADVERTISING"],
  [52, "OZON_ADVERTISING"],
  [1, "OZON_PARTNER_SERVICES"],
  [39, "OZON_PARTNER_SERVICES"],
  [45, "OZON_PARTNER_SERVICES"],
  [74, "OZON_PARTNER_SERVICES"],
  [79, "OZON_PARTNER_SERVICES"],
  [15, "OZON_OTHER_SERVICES"],
  [18, "OZON_OTHER_SERVICES"],
  [20, "OZON_OTHER_SERVICES"],
  [38, "OZON_OTHER_SERVICES"],
  [78, "OZON_OTHER_SERVICES"],
  [76, "OZON_OTHER_SERVICES"],
  [94, "OZON_OTHER_SERVICES"],
  [92, "OZON_OTHER_SERVICES"],
  [12, "OZON_FBO"],
  [46, "OZON_FBO"],
  [77, "OZON_FBO"],
  [29, "OZON_DELIVERY"],
  [32, "OZON_DELIVERY"],
  [59, "OZON_DELIVERY"],
  [98, "OZON_DELIVERY"],
  [17, "OZON_DELIVERY"],
  [16, "OZON_DELIVERY"],
  [25, "OZON_COMPENSATION"],
  // TYPE71 is NOT a static map entry — resolve via resolveOzonType71Categories.
]);

export type OzonType71Component = {
  accrualId: number;
  ordinal: number;
  /** Group key: date + unit + sku (same as accrualByDay). */
  groupKey: string;
};

/**
 * Canonical TYPE71 pair rule (accepted):
 * - single in group → OZON_DELIVERY
 * - exactly two distinct accrualIds → lower accrualId = OZON_FBO (prep),
 *   higher = OZON_DELIVERY
 * - otherwise unresolved (caller keeps unclassified / residual)
 *
 * Amounts 28+36 are the observed fee pair sizes, not type codes.
 */
export function resolveOzonType71Categories(
  components: OzonType71Component[],
): Map<string, OzonAccrualFinancialCategory> {
  const groups = new Map<string, OzonType71Component[]>();
  for (const c of components) {
    const list = groups.get(c.groupKey) ?? [];
    list.push(c);
    groups.set(c.groupKey, list);
  }

  const out = new Map<string, OzonAccrualFinancialCategory>();
  for (const group of groups.values()) {
    if (group.length === 1) {
      const item = group[0];
      out.set(`${item.accrualId}:${item.ordinal}`, "OZON_DELIVERY");
      continue;
    }
    const distinctIds = new Set(group.map((item) => item.accrualId));
    if (group.length === 2 && distinctIds.size === 2) {
      const ordered = [...group].sort((a, b) => a.accrualId - b.accrualId);
      out.set(`${ordered[0].accrualId}:${ordered[0].ordinal}`, "OZON_FBO");
      out.set(`${ordered[1].accrualId}:${ordered[1].ordinal}`, "OZON_DELIVERY");
      continue;
    }
    // unresolved — leave absent from map
  }
  return out;
}

export function ozonType71GroupKey(params: {
  date: string;
  unitNumber?: string | null;
  sku?: string | null;
}): string {
  return `${params.date}\u001f${params.unitNumber ?? ""}\u001f${params.sku ?? ""}`;
}
