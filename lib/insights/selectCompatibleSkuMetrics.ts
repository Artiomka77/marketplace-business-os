/**
 * Insights SKU load must pick one Wave-B formula generation per marketplace
 * before summing / ranking — same generation contract as period bridge.
 * Legacy / incompatible formulaVersion rows must not enter READY rankings.
 */

import {
  formulaForMarketplace,
  WAVE_B_PROFIT_FORMULAS,
  type ProfitMarketplace,
} from "@/lib/profitReadModel/contract";

export const WAVE_B_SKU_FORMULA_FILTER: { in: string[] } = {
  in: [...WAVE_B_PROFIT_FORMULAS],
};

export type SkuFormulaRow = {
  marketplace?: string | null;
  formulaVersion?: string | null;
  generatedAt?: Date | string | null;
};

/**
 * Keep only SKU rows whose formulaVersion matches formulaForMarketplace(mp).
 * Does not collapse distinct productKeys / companies — only generation filter.
 */
export function selectCompatibleSkuMetrics<T extends SkuFormulaRow>(
  rows: T[],
): {
  selected: T[];
  rejectedIncompatible: number;
  byMarketplace: Record<string, number>;
} {
  const selected: T[] = [];
  let rejectedIncompatible = 0;
  const byMarketplace: Record<string, number> = { WB: 0, OZON: 0 };
  for (const row of rows) {
    const mp = String(row.marketplace || "").toUpperCase();
    if (mp !== "WB" && mp !== "OZON") {
      rejectedIncompatible += 1;
      continue;
    }
    const expected = formulaForMarketplace(mp as ProfitMarketplace);
    const fv = row.formulaVersion == null ? "" : String(row.formulaVersion).trim();
    if (fv !== expected) {
      rejectedIncompatible += 1;
      continue;
    }
    selected.push(row);
    byMarketplace[mp] = (byMarketplace[mp] ?? 0) + 1;
  }
  return { selected, rejectedIncompatible, byMarketplace };
}
