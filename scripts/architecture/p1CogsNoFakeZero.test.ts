import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCanonicalPositiveCostLookups,
  toPositiveProductCost,
} from "@/lib/analytics/productCostResolver";

function resolveUnitCost(
  costByVendorCode: Map<string, number>,
  vendorCodeKey: string,
): number | null {
  if (!vendorCodeKey || !costByVendorCode.has(vendorCodeKey)) return null;
  return costByVendorCode.get(vendorCodeKey)!;
}

function resolveCostContribution(
  costByVendorCode: Map<string, number>,
  vendorCodeKey: string,
  quantity: number,
) {
  const unitCost = resolveUnitCost(costByVendorCode, vendorCodeKey);

  return {
    unitCost,
    costResolved: unitCost !== null,
    costCoverageIncomplete: unitCost === null && quantity > 0,
    totalCost: unitCost === null ? 0 : unitCost * quantity,
  };
}

test("missing ProductCost key is incomplete rather than fake zero", () => {
  const result = resolveCostContribution(
    new Map([["known", 125]]),
    "missing",
    2,
  );

  assert.equal(result.unitCost, null);
  assert.equal(result.costResolved, false);
  assert.equal(result.costCoverageIncomplete, true);
  assert.equal(result.totalCost, 0);
});

test("explicit zero ProductCost is UNKNOWN/incomplete under positive-only canonical map", () => {
  assert.equal(toPositiveProductCost(0), null);

  // Positive-only builder skips 0 → key absent → Map.has semantics → incomplete
  const lookups = buildCanonicalPositiveCostLookups([
    { vendorCode: "free-sample", costPrice: 0 },
  ]);
  assert.equal(lookups.costByVendorCode.has("free-sample"), false);

  const result = resolveCostContribution(
    lookups.costByVendorCode,
    "free-sample",
    2,
  );

  assert.equal(result.unitCost, null);
  assert.equal(result.costResolved, false);
  assert.equal(result.costCoverageIncomplete, true);
  assert.equal(result.totalCost, 0);
});

test("known positive ProductCost remains unchanged", () => {
  assert.equal(toPositiveProductCost(349.5), 349.5);

  const lookups = buildCanonicalPositiveCostLookups([
    { vendorCode: "sku-42", costPrice: 349.5 },
  ]);
  const result = resolveCostContribution(
    lookups.costByVendorCode,
    "sku-42",
    2,
  );

  assert.equal(result.unitCost, 349.5);
  assert.equal(result.costResolved, true);
  assert.equal(result.costCoverageIncomplete, false);
  assert.equal(result.totalCost, 699);
});

test("toPositiveProductCost rejects non-positive and missing values", () => {
  assert.equal(toPositiveProductCost(null), null);
  assert.equal(toPositiveProductCost(undefined), null);
  assert.equal(toPositiveProductCost(""), null);
  assert.equal(toPositiveProductCost(-10), null);
  assert.equal(toPositiveProductCost(0), null);
  assert.equal(toPositiveProductCost(12.5), 12.5);
});
