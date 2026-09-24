/**
 * Wave A: selected-company Dashboard identity wiring.
 * Aggregate ALL read stays for company lists; page meta/finality must
 * come from the selected company's own V6 scope — never silently ALL.
 */

export type SelectedScopeIdentityKind = "USE_ALL" | "USE_SELECTED" | "FAIL_CLOSED";

export type SelectedScopeIdentityDecision = {
  kind: SelectedScopeIdentityKind;
  /** True only when ALL is selected; selected company must never reuse ALL meta. */
  usesAllMeta: boolean;
  failClosedReason?: string;
};

export type SelectedScopeLoadStatus =
  | "HIT"
  | "PENDING"
  | "UNAVAILABLE"
  | "MISS"
  | string;

/**
 * Decide which read-model grain owns page-level readiness / dataMode.
 * Does not load DB — callers supply the selected-scope load status.
 */
export function resolveSelectedScopeIdentity(params: {
  selectedCompanyValue: string;
  selectedScopeStatus?: SelectedScopeLoadStatus | null;
  selectedScopeReason?: string | null;
}): SelectedScopeIdentityDecision {
  if (params.selectedCompanyValue === "ALL") {
    return { kind: "USE_ALL", usesAllMeta: true };
  }

  if (params.selectedScopeStatus === "HIT") {
    return { kind: "USE_SELECTED", usesAllMeta: false };
  }

  return {
    kind: "FAIL_CLOSED",
    usesAllMeta: false,
    failClosedReason:
      params.selectedScopeReason ?? "V6_PERIOD_READMODEL_COMPANY_MISSING",
  };
}

/** Page data-mode attribute must follow effective (selected-scope) meta. */
export function pageDataModeFromMeta(meta: { dataMode: string }): string {
  return meta.dataMode;
}
