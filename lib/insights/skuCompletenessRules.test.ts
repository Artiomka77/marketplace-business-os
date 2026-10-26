import { describe, expect, it } from "vitest";

import { assessSkuSourceCompleteness } from "@/lib/insights/skuSourceCompleteness";

describe("insights SKU source completeness (real gate)", () => {
  const companies = ["ИП Петров", "ИП Лебедева"];

  it("ALL-scope WB+Ozon alone never grants READY", () => {
    const r = assessSkuSourceCompleteness({
      selectedCompany: "ALL",
      expectedCompanies: companies,
      rows: [
        { companyScope: "ALL", marketplace: "WB" },
        { companyScope: "ALL", marketplace: "OZON" },
      ],
    });
    expect(r.complete).toBe(false);
    expect(r.gaps).toEqual([
      "ИП Петров:WB_SKU_MISSING",
      "ИП Петров:OZON_SKU_MISSING",
      "ИП Лебедева:WB_SKU_MISSING",
      "ИП Лебедева:OZON_SKU_MISSING",
    ]);
  });

  it("missing any of four company/marketplace scopes blocks READY", () => {
    const r = assessSkuSourceCompleteness({
      selectedCompany: "ALL",
      expectedCompanies: companies,
      rows: [
        { companyScope: "ИП Петров", marketplace: "WB" },
        { companyScope: "ИП Петров", marketplace: "OZON" },
        { companyScope: "ИП Лебедева", marketplace: "OZON" },
      ],
    });
    expect(r.complete).toBe(false);
    expect(r.gaps).toEqual(["ИП Лебедева:WB_SKU_MISSING"]);
  });

  it("all four per-company scopes grant complete", () => {
    const r = assessSkuSourceCompleteness({
      selectedCompany: "ALL",
      expectedCompanies: companies,
      rows: [
        { companyScope: "ИП Петров", marketplace: "WB" },
        { companyScope: "ИП Петров", marketplace: "OZON" },
        { companyScope: "ИП Лебедева", marketplace: "WB" },
        { companyScope: "ИП Лебедева", marketplace: "OZON" },
      ],
    });
    expect(r.complete).toBe(true);
    expect(r.gaps).toEqual([]);
  });

  it("single-company filter only requires that company WB+Ozon", () => {
    const r = assessSkuSourceCompleteness({
      selectedCompany: "ИП Петров",
      expectedCompanies: companies,
      rows: [
        { companyScope: "ИП Петров", marketplace: "WB" },
        { companyScope: "ИП Петров", marketplace: "OZON" },
      ],
    });
    expect(r.complete).toBe(true);
  });
});
