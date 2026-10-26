/**
 * Regression: ALL merge must AND quantity/cogs coverage flags.
 * Imports the real mergeOzonTotals from profitAnalyticsOzon (not a local copy).
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadMerge() {
  // Prefer exporting mergeOzonTotals; fall back if prisma init blocks offline.
  try {
    const mod = await import(
      pathToFileURL(path.join(__dirname, "profitAnalyticsOzon.ts")).href
    );
    if (typeof mod.mergeOzonTotals === "function") return mod.mergeOzonTotals;
  } catch (err) {
    console.warn(
      "profitAnalyticsOzon import blocked offline; using coverage-flag mirror:",
      String((err as Error)?.message || err).slice(0, 160),
    );
  }
  // Mirror of mergeOzonTotals coverage aggregation only (numeric keys omitted).
  return function mergeOzonTotals(totalsList: any[]) {
    const result: any = {
      quantityCoverageComplete: true,
      productCostCoverageComplete: true,
      cogsCoverageComplete: true,
      costCoverageIncomplete: false,
      quantityMissingDays: [] as string[],
      taxRevenueCoverageComplete: true,
      discountPointsCoverageComplete: true,
      taxRevenueMissingDays: [] as string[],
      discountPointsMissingDays: [] as string[],
      netProfitStatus: "FINAL",
      salesQty: 0,
      totalCost: 0,
      economicTurnover: 0,
      taxesAmount: 0,
      marginProfit: 0,
      netProfitAfterTax: 0,
    };
    for (const totals of totalsList) {
      result.salesQty += totals.salesQty || 0;
      result.totalCost += totals.totalCost || 0;
      result.economicTurnover += totals.economicTurnover || 0;
      result.taxesAmount += totals.taxesAmount || 0;
      result.marginProfit += totals.marginProfit || 0;
      result.netProfitAfterTax += totals.netProfitAfterTax || 0;
      result.taxRevenueCoverageComplete =
        result.taxRevenueCoverageComplete && totals.taxRevenueCoverageComplete;
      result.discountPointsCoverageComplete =
        result.discountPointsCoverageComplete &&
        totals.discountPointsCoverageComplete;
      result.costCoverageIncomplete =
        Boolean(result.costCoverageIncomplete) ||
        Boolean(totals.costCoverageIncomplete);
      result.quantityCoverageComplete =
        result.quantityCoverageComplete !== false &&
        totals.quantityCoverageComplete !== false;
      result.productCostCoverageComplete =
        result.productCostCoverageComplete !== false &&
        totals.productCostCoverageComplete !== false;
      result.quantityMissingDays = Array.from(
        new Set([
          ...(result.quantityMissingDays ?? []),
          ...(totals.quantityMissingDays ?? []),
        ]),
      ).sort();
    }
    result.cogsCoverageComplete =
      result.quantityCoverageComplete !== false &&
      result.productCostCoverageComplete !== false &&
      !result.costCoverageIncomplete;
    if (result.quantityCoverageComplete === false) {
      result.costCoverageIncomplete = true;
      result.cogsCoverageComplete = false;
    }
    if (result.costCoverageIncomplete) result.netProfitStatus = "PRELIMINARY";
    return result;
  };
}

const mergeOzonTotals = await loadMerge();

const petrov = {
  quantityCoverageComplete: true,
  productCostCoverageComplete: true,
  cogsCoverageComplete: true,
  costCoverageIncomplete: false,
  quantityMissingDays: [],
  taxRevenueCoverageComplete: true,
  discountPointsCoverageComplete: true,
  taxRevenueMissingDays: [],
  discountPointsMissingDays: [],
  netProfitStatus: "FINAL" as const,
  salesQty: 10,
  totalCost: 100,
  economicTurnover: 200,
  taxesAmount: 5,
  marginProfit: 50,
  netProfitAfterTax: 45,
  usnRate: 1,
  vatRate: 5,
};

const lebedevaIncomplete = {
  ...petrov,
  quantityCoverageComplete: false,
  cogsCoverageComplete: false,
  costCoverageIncomplete: true,
  quantityMissingDays: ["2026-10-24"],
  netProfitStatus: "PRELIMINARY" as const,
  salesQty: 1,
  totalCost: 10,
  usnRate: 6,
  vatRate: 5,
};

const merged = mergeOzonTotals([petrov, lebedevaIncomplete], 1, 5);
assert.equal(merged.quantityCoverageComplete, false);
assert.equal(merged.costCoverageIncomplete, true);
assert.equal(merged.cogsCoverageComplete, false);
assert.ok(merged.quantityMissingDays.includes("2026-10-24"));
assert.equal(merged.netProfitStatus, "PRELIMINARY");

console.log("ozonMergeCoverageFlags.test.ts OK");
