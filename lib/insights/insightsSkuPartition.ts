export type InsightAnomaly =
  | "NONE"
  | "PROFIT_WITHOUT_REVENUE"
  | "LOSS_WITHOUT_REVENUE";

function anomalyFor(revenue: number, profit: number): InsightAnomaly {
  if (revenue !== 0) return "NONE";
  if (profit > 0) return "PROFIT_WITHOUT_REVENUE";
  if (profit < 0) return "LOSS_WITHOUT_REVENUE";
  return "NONE";
}

/**
 * Partition Insights SKU rows into sold vs adjustments without gaps.
 * Sold: revenue > 0. Adjustments: everything else.
 * sold + adjustments = sku total.
 */
export function partitionInsightSkuRow(row: {
  revenue: number;
  profit: number;
  netQty?: number;
}): { bucket: "sold" | "adjustment"; anomaly: InsightAnomaly } {
  if (row.revenue > 0) {
    return { bucket: "sold", anomaly: "NONE" };
  }
  return {
    bucket: "adjustment",
    anomaly: anomalyFor(row.revenue, row.profit),
  };
}
