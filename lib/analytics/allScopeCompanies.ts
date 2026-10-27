/**
 * ALL business-scope for WB profit analytics.
 *
 * Include a cabinet when the requested period has any WB finance or sale activity.
 * Empty shells (no finance AND no sales) are excluded.
 * Do not gate on Company.isActive — historical cabinets with period activity stay in.
 * Do not require WbFinance alone — sales without weekly finance stay as preliminary.
 */

export type AllScopeTouchRow = {
  companyName?: string | null;
};

export function selectAllScopeCompanyNames(input: {
  candidateNames: string[];
  financeTouch: AllScopeTouchRow[];
  saleTouch: AllScopeTouchRow[];
}): string[] {
  const active = new Set<string>();
  for (const row of [...input.financeTouch, ...input.saleTouch]) {
    const name = String(row.companyName ?? "").trim();
    if (name) active.add(name);
  }
  return input.candidateNames
    .map((name) => String(name ?? "").trim())
    .filter((name) => name.length > 0 && active.has(name))
    .sort((a, b) => a.localeCompare(b, "ru"));
}
