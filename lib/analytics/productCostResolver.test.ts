import assert from "node:assert/strict";
import {
  buildCanonicalPositiveCostLookups,
  resolveCanonicalOzonUnitCost,
} from "./productCostResolver.ts";

{
  const lookups = buildCanonicalPositiveCostLookups([
    { vendorCode: "exact-158", costPrice: 920 },
    { vendorCode: "888", nmId: "888", costPrice: 500 },
  ]);
  const resolved = resolveCanonicalOzonUnitCost({
    vendorCode: "exact-158",
    sku: "888",
    ...lookups,
  });
  assert.equal(resolved.unitCost, 920);
  assert.equal(resolved.source, "ProductCost.vendorCode");
}

{
  const lookups = buildCanonicalPositiveCostLookups([
    { vendorCode: "family-134", costPrice: 900 },
    { vendorCode: "family-164", costPrice: 1200 },
  ]);
  const resolved = resolveCanonicalOzonUnitCost({
    vendorCode: "family-158",
    sku: null,
    ...lookups,
  });
  assert.equal(resolved.unitCost, null);
  assert.equal(resolved.conflict, "FAMILY_SIBLING_COST_CONFLICT");
}

{
  const lookups = buildCanonicalPositiveCostLookups([
    { vendorCode: "371584460-146", costPrice: 970 },
    { vendorCode: "2760136185", nmId: "2760136185", costPrice: 920 },
  ]);
  const resolved = resolveCanonicalOzonUnitCost({
    vendorCode: "371584460-146",
    sku: "2760136185",
    ...lookups,
  });
  assert.equal(resolved.unitCost, 920);
  assert.equal(resolved.source, "CANON_EXPLICIT");
}

{
  const lookups = buildCanonicalPositiveCostLookups([
    { vendorCode: "1237829938-164", costPrice: 920 },
    { vendorCode: "4974518616", nmId: "4974518616", costPrice: 10 },
  ]);
  const resolved = resolveCanonicalOzonUnitCost({
    vendorCode: "1237829938-164",
    sku: "4974518616",
    ...lookups,
  });
  assert.equal(resolved.unitCost, 920);
  assert.equal(resolved.source, "ProductCost.vendorCode");
}

{
  const lookups = buildCanonicalPositiveCostLookups([
    { vendorCode: "1492430240-134", costPrice: 500 },
    { vendorCode: "1492430240-164", costPrice: 1450 },
  ]);
  const resolved = resolveCanonicalOzonUnitCost({
    vendorCode: "1492430240-134",
    sku: "x",
    ...lookups,
  });
  assert.equal(resolved.unitCost, 1450);
  assert.equal(resolved.source, "CANON_FAMILY_DOCUMENTED");
}

{
  const lookups = buildCanonicalPositiveCostLookups([
    { vendorCode: "999", nmId: "999", costPrice: 10 },
  ]);
  const resolved = resolveCanonicalOzonUnitCost({
    vendorCode: "missing-158",
    sku: "999",
    ...lookups,
  });
  assert.equal(resolved.unitCost, null);
}

console.log("productCostResolver.test.ts OK");
