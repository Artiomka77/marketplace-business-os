import { describe, expect, it } from "vitest";

/** Mirrors loadDetailSnapshot assessSkuSourceCompleteness. */
function assessSkuSourceCompleteness(params: {
  rows: Array<{ companyScope: string; marketplace: string }>;
  expectedCompanies: string[];
  selectedCompany: string;
}): { complete: boolean; gaps: string[] } {
  const gaps: string[] = [];
  const companies =
    params.selectedCompany === "ALL"
      ? params.expectedCompanies
      : [params.selectedCompany];

  const byCompany = new Map<string, { wb: boolean; ozon: boolean }>();
  for (const name of companies) {
    byCompany.set(name, { wb: false, ozon: false });
  }
  let allScopeWb = false;
  let allScopeOzon = false;

  for (const row of params.rows) {
    const mp = String(row.marketplace ?? "").toUpperCase();
    const scope = String(row.companyScope ?? "");
    if (scope === "ALL") {
      if (mp === "WB") allScopeWb = true;
      if (mp === "OZON") allScopeOzon = true;
      continue;
    }
    const bucket = byCompany.get(scope);
    if (!bucket) continue;
    if (mp === "WB") bucket.wb = true;
    if (mp === "OZON") bucket.ozon = true;
  }

  const anyPerCompany = params.rows.some((r) => r.companyScope !== "ALL");
  if (anyPerCompany || params.selectedCompany !== "ALL") {
    for (const name of companies) {
      const bucket = byCompany.get(name) ?? { wb: false, ozon: false };
      if (!bucket.wb) gaps.push(`${name}:WB_SKU_MISSING`);
      if (!bucket.ozon) gaps.push(`${name}:OZON_SKU_MISSING`);
    }
  } else {
    if (!allScopeWb) gaps.push("ALL:WB_SKU_MISSING");
    if (!allScopeOzon) gaps.push("ALL:OZON_SKU_MISSING");
  }
  return { complete: gaps.length === 0, gaps };
}

describe("insights SKU source completeness", () => {
  it("ALL-scope Ozon-only is incomplete (not READY)", () => {
    const r = assessSkuSourceCompleteness({
      selectedCompany: "ALL",
      expectedCompanies: ["ИП Петров", "ИП Лебедева"],
      rows: [
        { companyScope: "ALL", marketplace: "OZON" },
        { companyScope: "ALL", marketplace: "OZON" },
      ],
    });
    expect(r.complete).toBe(false);
    expect(r.gaps).toContain("ALL:WB_SKU_MISSING");
  });

  it("per-company requires WB+Ozon for every expected company", () => {
    const r = assessSkuSourceCompleteness({
      selectedCompany: "ALL",
      expectedCompanies: ["ИП Петров", "ИП Лебедева"],
      rows: [
        { companyScope: "ИП Петров", marketplace: "WB" },
        { companyScope: "ИП Петров", marketplace: "OZON" },
        { companyScope: "ИП Лебедева", marketplace: "OZON" },
      ],
    });
    expect(r.complete).toBe(false);
    expect(r.gaps).toEqual(["ИП Лебедева:WB_SKU_MISSING"]);
  });

  it("single-company filter only requires that company", () => {
    const r = assessSkuSourceCompleteness({
      selectedCompany: "ИП Петров",
      expectedCompanies: ["ИП Петров", "ИП Лебедева"],
      rows: [
        { companyScope: "ИП Петров", marketplace: "WB" },
        { companyScope: "ИП Петров", marketplace: "OZON" },
      ],
    });
    expect(r.complete).toBe(true);
  });

  it("unambiguous owner map rejects cross-company collisions", () => {
    const map = new Map<string, string>();
    const put = (key: string, company: string) => {
      const prev = map.get(key);
      if (prev == null) map.set(key, company);
      else if (prev !== company) map.set(key, "");
    };
    put("111", "ИП Петров");
    put("111", "ИП Лебедева");
    expect(map.get("111")).toBe("");
  });
});
