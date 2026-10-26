import assert from "node:assert/strict";
import { partitionInsightSkuRow } from "./insightsSkuPartition.ts";

const gapRows = [
  {
    key: "OZON:5862792889|1585902090-158",
    revenue: -14178.634591581591,
    netQty: -1,
    profit: -13698.244591581592,
  },
  {
    key: "OZON:5954388000|1840938387-158",
    revenue: -16203.444566469314,
    netQty: -1,
    profit: -18054.154566469315,
  },
];

{
  for (const row of gapRows) {
    const part = partitionInsightSkuRow({
      revenue: row.revenue,
      profit: row.profit,
      netQty: row.netQty,
    });
    assert.equal(part.bucket, "adjustment", row.key);
    // Negative revenue is still an adjustment even when anomaly stays NONE
    // (anomalyFor historically treated any non-zero revenue as NONE).
  }
}

{
  const sold = { revenue: 100, profit: 10, netQty: 1 };
  const adjZeroRev = { revenue: 0, profit: -5, netQty: 0 };
  const rows = [
    sold,
    adjZeroRev,
    ...gapRows.map((r) => ({
      revenue: r.revenue,
      profit: r.profit,
      netQty: r.netQty,
    })),
  ];
  let soldSum = 0;
  let adjSum = 0;
  for (const row of rows) {
    const part = partitionInsightSkuRow(row);
    if (part.bucket === "sold") soldSum += row.profit;
    else adjSum += row.profit;
  }
  const sku = rows.reduce((s, r) => s + r.profit, 0);
  assert.equal(Math.round((soldSum + adjSum) * 100) / 100, Math.round(sku * 100) / 100);
}

console.log("insightsSkuPartition.test.ts OK");
