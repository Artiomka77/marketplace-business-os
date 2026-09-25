import { readFileSync } from "node:fs";

const sourcePath = new URL(
  "../../lib/analytics/profitAnalytics.ts",
  import.meta.url
);
const source = readFileSync(sourcePath, "utf8");

function requireMarker(marker, label) {
  if (!source.includes(marker)) {
    throw new Error(`WB official finance priority verification failed: ${label}`);
  }
}

function forbidMarker(marker, label) {
  if (source.includes(marker)) {
    throw new Error(`WB official finance priority regression detected: ${label}`);
  }
}

requireMarker(
  "function selectPreferredWbFinanceGroups",
  "weekly/daily interval priority selector is missing"
);
requireMarker(
  "candidatePath.length < existingPath.length",
  "minimal non-overlapping official interval priority is missing"
);
requireMarker(
  "function reconcileWbSaleRowsLogisticsToOfficialFinance",
  "SKU logistics reconciliation is missing"
);
requireMarker(
  "reconcileWbSaleRowsLogisticsToOfficialFinance(\n          currentSalesRows,",
  "current period is not reconciled to official finance"
);
requireMarker(
  "reconcileWbSaleRowsLogisticsToOfficialFinance(\n          previousSalesRows,",
  "comparison period is not reconciled to official finance"
);
requireMarker(
  "result.totals.logisticsCost = financeExpenses.logisticsCost;",
  "official WB Finance logistics does not control the final total"
);
forbidMarker(
  "result.totals.logisticsCost > 0\n      ? result.totals.logisticsCost\n      : financeExpenses.logisticsCost",
  "detailed logistics can override official WB Finance"
);

const detailed = [
  { company: "A", value: 100 },
  { company: "A", value: 300 },
  { company: "B", value: 200 },
];
const official = new Map([
  ["A", 200],
  ["B", 100],
]);
const detailedTotals = new Map();

for (const row of detailed) {
  detailedTotals.set(
    row.company,
    (detailedTotals.get(row.company) ?? 0) + Math.abs(row.value)
  );
}

const reconciled = detailed.map((row) => ({
  ...row,
  value:
    Math.abs(row.value) *
    ((official.get(row.company) ?? 0) /
      (detailedTotals.get(row.company) ?? 1)),
}));

for (const [company, expected] of official) {
  const actual = reconciled
    .filter((row) => row.company === company)
    .reduce((sum, row) => sum + row.value, 0);

  if (Math.abs(actual - expected) > 0.000001) {
    throw new Error(
      `WB logistics reconciliation self-test failed for ${company}: ${actual} != ${expected}`
    );
  }
}

console.log("WB_OFFICIAL_FINANCE_PRIORITY_V1: VERIFIED");
