/** Per-company × marketplace presence required before SKU READY. */
export function assessSkuSourceCompleteness(params: {
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

  // ALL READY requires WB+Ozon for every active ИП. ALL-scope rows alone never grant READY.
  // Single-company views still accept that company's per-MP rows (or unambiguous ALL-scope MP).
  if (params.selectedCompany === "ALL") {
    for (const name of companies) {
      const bucket = byCompany.get(name) ?? { wb: false, ozon: false };
      if (!bucket.wb) gaps.push(`${name}:WB_SKU_MISSING`);
      if (!bucket.ozon) gaps.push(`${name}:OZON_SKU_MISSING`);
    }
  } else {
    for (const name of companies) {
      const bucket = byCompany.get(name) ?? { wb: false, ozon: false };
      if (!bucket.wb && !allScopeWb) gaps.push(`${name}:WB_SKU_MISSING`);
      if (!bucket.ozon && !allScopeOzon) gaps.push(`${name}:OZON_SKU_MISSING`);
    }
  }
  return { complete: gaps.length === 0, gaps };
}
