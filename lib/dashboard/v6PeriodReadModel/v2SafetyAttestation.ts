import { createHash } from "node:crypto";

import {
  FINANCIAL_CORE_V6_PERIOD_READMODEL_V2,
  type ReadinessFinalityMeta,
} from "./contract";
import {
  isCalendarMonthSpan,
  isCalendarQuarterSpan,
  isYtdStyleSpan,
  shouldUseLiveD1D5EligibilityGate,
  type D1D5SafetyPlanEvidence,
} from "./d1d5Eligibility";

export const V2_SAFETY_STRATEGY = "A_V2_BOUNDED_SAFE_PERIOD_ELIGIBILITY" as const;

export const V2_SAFE_ATTESTATION_REASONS = [
  "D1D5_V2_SAFE_FINANCIALLY_FINAL_COVER",
  "D1D5_V2_SAFE_PRELIMINARY_SHORT_DAILY_WINDOW",
] as const;

export type V2SafeAttestationReason = (typeof V2_SAFE_ATTESTATION_REASONS)[number];

export type V2SafetyAttestationSource =
  | "LIVE_ELIGIBILITY"
  | "SYNTHETIC_SAFE_FIXTURE";

export type V2SafetyAttestationBinding = {
  dateFrom: string;
  dateTo: string;
  companyScope: string;
};

export type V2SafetyAttestation = {
  strategy: typeof V2_SAFETY_STRATEGY;
  eligible: boolean;
  reason: string;
  source: V2SafetyAttestationSource;
  dateFrom: string;
  dateTo: string;
  companyScope: string;
  safetyPlanDigest: string;
};

export type V2SafetyAttestationTemplate = {
  strategy: typeof V2_SAFETY_STRATEGY;
  eligible: boolean;
  reason: string;
  source: V2SafetyAttestationSource;
  dateFrom?: string;
  dateTo?: string;
  companyScope?: string;
  safetyPlanDigest?: string;
};

export class D1D5V2PersistForbiddenError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`D1D5_V2_PERSIST_FORBIDDEN:${reason}`);
    this.name = "D1D5V2PersistForbiddenError";
    this.reason = reason;
  }
}

function isoDay(value: string): string {
  return value.slice(0, 10);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function computeSafetyPlanDigest(
  evidence: D1D5SafetyPlanEvidence | Record<string, unknown>
): string {
  return createHash("sha256").update(canonicalJson(evidence)).digest("hex");
}

function syntheticPlanEvidence(params: {
  reason: string;
  source: V2SafetyAttestationSource;
  dateFrom: string;
  dateTo: string;
  companyScope: string;
}): D1D5SafetyPlanEvidence {
  return {
    dateFrom: isoDay(params.dateFrom),
    dateTo: isoDay(params.dateTo),
    companyScope: params.companyScope,
    isFinanciallyFinal: params.reason === "D1D5_V2_SAFE_FINANCIALLY_FINAL_COVER",
    selectedSessionIds: [`synthetic:${params.source}`],
    intervals: [],
    syntheticReason: params.reason,
  };
}

export function isV2SafetyAttestationTemplate(
  value: unknown
): value is V2SafetyAttestationTemplate {
  if (!value || typeof value !== "object") return false;
  const row = value as V2SafetyAttestationTemplate;
  if (row.strategy !== V2_SAFETY_STRATEGY) return false;
  if (row.eligible !== true) return false;
  if (
    row.source !== "LIVE_ELIGIBILITY" &&
    row.source !== "SYNTHETIC_SAFE_FIXTURE"
  ) {
    return false;
  }
  return (V2_SAFE_ATTESTATION_REASONS as readonly string[]).includes(row.reason);
}

export function isTrustedV2SafetyAttestation(
  value: unknown
): value is V2SafetyAttestation {
  if (!isV2SafetyAttestationTemplate(value)) return false;
  const row = value as V2SafetyAttestation;
  if (!row.dateFrom || !row.dateTo || !row.companyScope) return false;
  if (!/^[0-9a-f]{64}$/.test(row.safetyPlanDigest ?? "")) return false;
  return true;
}

export function attestationMatchesRow(
  attestation: V2SafetyAttestation,
  row: V2SafetyAttestationBinding
): boolean {
  return (
    isoDay(attestation.dateFrom) === isoDay(row.dateFrom) &&
    isoDay(attestation.dateTo) === isoDay(row.dateTo) &&
    attestation.companyScope === row.companyScope
  );
}

export function liveV2SafetyAttestation(params: {
  reason: string;
  dateFrom: string;
  dateTo: string;
  companyScope: string;
  planEvidence: D1D5SafetyPlanEvidence;
}): V2SafetyAttestation {
  const dateFrom = isoDay(params.dateFrom);
  const dateTo = isoDay(params.dateTo);
  return {
    strategy: V2_SAFETY_STRATEGY,
    eligible: true,
    reason: params.reason,
    source: "LIVE_ELIGIBILITY",
    dateFrom,
    dateTo,
    companyScope: params.companyScope,
    safetyPlanDigest: computeSafetyPlanDigest(params.planEvidence),
  };
}

export function syntheticSafeV2Attestation(
  reason: V2SafeAttestationReason = "D1D5_V2_SAFE_FINANCIALLY_FINAL_COVER",
  binding?: V2SafetyAttestationBinding
): V2SafetyAttestationTemplate | V2SafetyAttestation {
  const template: V2SafetyAttestationTemplate = {
    strategy: V2_SAFETY_STRATEGY,
    eligible: true,
    reason,
    source: "SYNTHETIC_SAFE_FIXTURE",
  };
  if (!binding) return template;
  return bindV2SafetyAttestationToRow({
    template,
    dateFrom: binding.dateFrom,
    dateTo: binding.dateTo,
    companyScope: binding.companyScope,
  });
}

export function bindV2SafetyAttestationToRow(params: {
  template: V2SafetyAttestationTemplate;
  dateFrom: string;
  dateTo: string;
  companyScope: string;
  planEvidence?: D1D5SafetyPlanEvidence | null;
}): V2SafetyAttestation {
  if (!isV2SafetyAttestationTemplate(params.template)) {
    throw new D1D5V2PersistForbiddenError("V2_SAFETY_ATTESTATION_REQUIRED");
  }
  const dateFrom = isoDay(params.dateFrom);
  const dateTo = isoDay(params.dateTo);
  const companyScope = params.companyScope;
  const alreadyBound =
    Boolean(params.template.dateFrom) ||
    Boolean(params.template.dateTo) ||
    Boolean(params.template.companyScope) ||
    Boolean(params.template.safetyPlanDigest);
  if (alreadyBound) {
    if (
      !isTrustedV2SafetyAttestation(params.template) ||
      !attestationMatchesRow(params.template, {
        dateFrom,
        dateTo,
        companyScope,
      })
    ) {
      throw new D1D5V2PersistForbiddenError(
        "V2_SAFETY_ATTESTATION_ROW_IDENTITY_MISMATCH"
      );
    }
    return params.template;
  }
  const evidence =
    params.planEvidence ??
    syntheticPlanEvidence({
      reason: params.template.reason,
      source: params.template.source,
      dateFrom,
      dateTo,
      companyScope,
    });
  return {
    strategy: V2_SAFETY_STRATEGY,
    eligible: true,
    reason: params.template.reason,
    source: params.template.source,
    dateFrom,
    dateTo,
    companyScope,
    safetyPlanDigest: computeSafetyPlanDigest(evidence),
  };
}

export function syntheticAttestationForbiddenForDateSpan(
  dateFrom: string,
  dateTo: string
): boolean {
  return (
    isCalendarMonthSpan(dateFrom, dateTo) ||
    isCalendarQuarterSpan(dateFrom, dateTo) ||
    isYtdStyleSpan(dateFrom, dateTo)
  );
}

/** Production/candidate runtime: only LIVE_ELIGIBILITY may be trusted. */
export function liveRuntimeForbidsSyntheticFixture(): boolean {
  return shouldUseLiveD1D5EligibilityGate();
}

function assertSyntheticAllowedForPersist(source: string): void {
  if (source === "SYNTHETIC_SAFE_FIXTURE" && liveRuntimeForbidsSyntheticFixture()) {
    throw new D1D5V2PersistForbiddenError(
      "V2_SYNTHETIC_ATTESTATION_FORBIDDEN_IN_LIVE_RUNTIME"
    );
  }
}

export function assertPersistableV2SafetyAttestation(params: {
  attestation: unknown;
  dateFrom: string;
  dateTo: string;
  companyScope: string;
}): V2SafetyAttestation {
  if (!isV2SafetyAttestationTemplate(params.attestation)) {
    throw new D1D5V2PersistForbiddenError("V2_SAFETY_ATTESTATION_REQUIRED");
  }
  assertSyntheticAllowedForPersist(params.attestation.source);
  if (
    params.attestation.source === "SYNTHETIC_SAFE_FIXTURE" &&
    syntheticAttestationForbiddenForDateSpan(params.dateFrom, params.dateTo)
  ) {
    throw new D1D5V2PersistForbiddenError(
      "V2_SYNTHETIC_ATTESTATION_FORBIDDEN_FOR_D6_UNSAFE_DATE_SHAPE"
    );
  }
  return bindV2SafetyAttestationToRow({
    template: params.attestation,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    companyScope: params.companyScope,
  });
}

export function isTrustedV2HitAttestation(params: {
  meta: ReadinessFinalityMeta | null | undefined;
  dateFrom: string;
  dateTo: string;
  companyScope: string;
}): boolean {
  const attestation = params.meta?.v2SafetyAttestation;
  if (!isTrustedV2SafetyAttestation(attestation)) return false;
  if (!attestationMatchesRow(attestation, params)) return false;
  if (
    attestation.source === "SYNTHETIC_SAFE_FIXTURE" &&
    liveRuntimeForbidsSyntheticFixture()
  ) {
    return false;
  }
  if (
    attestation.source === "SYNTHETIC_SAFE_FIXTURE" &&
    syntheticAttestationForbiddenForDateSpan(params.dateFrom, params.dateTo)
  ) {
    return false;
  }
  return true;
}

export function assertTrustedV2PeriodPersist(row: {
  formulaVersion: string;
  dateFrom: string;
  dateTo: string;
  companyScope: string;
  meta?: ReadinessFinalityMeta | null;
}): void {
  if (row.formulaVersion !== FINANCIAL_CORE_V6_PERIOD_READMODEL_V2) return;
  const attestation = row.meta?.v2SafetyAttestation;
  if (!isTrustedV2SafetyAttestation(attestation)) {
    throw new D1D5V2PersistForbiddenError("V2_SAFETY_ATTESTATION_REQUIRED");
  }
  assertSyntheticAllowedForPersist(attestation.source);
  if (
    !attestationMatchesRow(attestation, {
      dateFrom: row.dateFrom,
      dateTo: row.dateTo,
      companyScope: row.companyScope,
    })
  ) {
    throw new D1D5V2PersistForbiddenError(
      "V2_SAFETY_ATTESTATION_ROW_IDENTITY_MISMATCH"
    );
  }
}
