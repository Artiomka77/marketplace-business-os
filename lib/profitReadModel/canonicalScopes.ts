export const CANONICAL_PROFIT_COMPANY_SCOPES = [
  "ALL",
  "ИП Петров",
  "ИП Лебедева",
] as const;

export type CanonicalProfitCompanyScope =
  (typeof CANONICAL_PROFIT_COMPANY_SCOPES)[number];

/**
 * Expand invalidation/enqueue scopes.
 * ALL → full canonical matrix (ALL + each company).
 * Specific company → ALL + that company (preserve prior non-ALL behavior).
 */
export function expandProfitCompanyScopes(
  companyScope?: string | null,
): string[] {
  if (!companyScope || companyScope === "ALL") {
    return [...CANONICAL_PROFIT_COMPANY_SCOPES];
  }
  return Array.from(new Set(["ALL", companyScope]));
}
