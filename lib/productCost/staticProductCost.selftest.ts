import {
  buildStaticCostByVendorCode,
  collapseProductCostsByNormalizedVendor,
  normalizeProductCostVendor,
  resolveStaticCostPrice,
} from "./staticProductCost";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

assert(normalizeProductCostVendor("ДетКосGR") === "деткосgr", "norm case");
assert(normalizeProductCostVendor("2760136185") === "2760136185", "norm sku");

const map920 = buildStaticCostByVendorCode([
  { vendorCode: "2760136185", costPrice: 920 },
  { vendorCode: "2760136185", costPrice: 920 },
]);
assert(resolveStaticCostPrice(map920, "2760136185") === 920, "920");

const map850 = buildStaticCostByVendorCode([
  { vendorCode: "ДетКосGR", costPrice: 850 },
  { vendorCode: "деткосgr", costPrice: 850 },
]);
assert(resolveStaticCostPrice(map850, "деткосgr") === 850, "850");
assert(resolveStaticCostPrice(map850, "ДетКосGR") === 850, "850 case");

const mapStatic = buildStaticCostByVendorCode([
  { vendorCode: "sku-a", costPrice: 100 },
]);
assert(resolveStaticCostPrice(mapStatic, "sku-a") === 100, "static");

const collapsed = collapseProductCostsByNormalizedVendor([
  { vendorCode: "деткосgr", costPrice: 835 },
  { vendorCode: "ДетКосGR", costPrice: 850 },
]);
assert(collapsed.length === 1, "collapse len");
assert(collapsed[0].costPrice === 850, "collapse price");

assert(resolveStaticCostPrice(buildStaticCostByVendorCode([]), "x") === 0, "missing");

console.log("STATIC_COGS_CONTRACT_SELFTEST_PASS");
