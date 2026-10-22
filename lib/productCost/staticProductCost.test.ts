import { describe, expect, it } from "vitest";
import {
  buildStaticCostByVendorCode,
  collapseProductCostsByNormalizedVendor,
  normalizeProductCostVendor,
  resolveStaticCostPrice,
} from "@/lib/productCost/staticProductCost";

describe("static ProductCost contract", () => {
  it("normalizes vendorCode case/ё consistently", () => {
    expect(normalizeProductCostVendor("ДетКосGR")).toBe("деткосgr");
    expect(normalizeProductCostVendor("деткосgr")).toBe("деткосgr");
    expect(normalizeProductCostVendor("2760136185")).toBe("2760136185");
  });

  it("resolves 2760136185 to canonical 920 from costDate-desc rows", () => {
    const costs = [
      { vendorCode: "2760136185", costPrice: 920, costDate: "2026-07-29T10:16:17Z" },
      { vendorCode: "2760136185", costPrice: 920, costDate: "2026-07-29T10:15:12Z" },
    ];
    const map = buildStaticCostByVendorCode(costs);
    expect(resolveStaticCostPrice(map, "2760136185")).toBe(920);
  });

  it("resolves деткосgr / ДетКосGR to canonical 850", () => {
    const costs = [
      { vendorCode: "ДетКосGR", costPrice: 850, costDate: "2026-01-01" },
      { vendorCode: "деткосgr", costPrice: 850, costDate: "2026-01-01" },
    ];
    const map = buildStaticCostByVendorCode(costs);
    expect(resolveStaticCostPrice(map, "деткосgr")).toBe(850);
    expect(resolveStaticCostPrice(map, "ДетКосGR")).toBe(850);
  });

  it("does not filter historical sales by costDate (static map)", () => {
    const map = buildStaticCostByVendorCode([
      { vendorCode: "sku-a", costPrice: 100, costDate: "2026-05-22" },
    ]);
    // sale in 2025 still gets the static canonical cost
    expect(resolveStaticCostPrice(map, "sku-a")).toBe(100);
  });

  it("collapse keeps one price per normalized vendor (last wins)", () => {
    const collapsed = collapseProductCostsByNormalizedVendor([
      { vendorCode: "деткосgr", costPrice: 835 },
      { vendorCode: "ДетКосGR", costPrice: 850 },
    ]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].costPrice).toBe(850);
    expect(normalizeProductCostVendor(collapsed[0].vendorCode)).toBe("деткосgr");
  });

  it("missing cost returns 0 under existing contract", () => {
    const map = buildStaticCostByVendorCode([]);
    expect(resolveStaticCostPrice(map, "unknown-sku")).toBe(0);
  });
});
