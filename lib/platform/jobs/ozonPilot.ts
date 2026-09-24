/**
 * Pilot Ozon accrual-type contracts for Stage 1A.
 * Unknown types fail closed. Types 18/20/71 remain known/allowed.
 * Does not alter Financial Core classifiers or syncOzon runtime paths.
 */
export const OZON_KNOWN_ACCRUAL_TYPE_CODES = ["18", "20", "71"] as const;

export type OzonKnownAccrualTypeCode =
  (typeof OZON_KNOWN_ACCRUAL_TYPE_CODES)[number];

export type OzonAccrualTypeDecision =
  | { decision: "KNOWN"; code: OzonKnownAccrualTypeCode }
  | { decision: "FAIL_CLOSED"; code: string; reason: string };

export function normalizeOzonAccrualTypeCode(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^type/i, "")
    .replace(/^тип/i, "")
    .trim();
}

export function classifyOzonAccrualTypeCode(
  value: unknown,
): OzonAccrualTypeDecision {
  const code = normalizeOzonAccrualTypeCode(value);

  if (!code) {
    return {
      decision: "FAIL_CLOSED",
      code: "",
      reason: "missing ozon accrual type code",
    };
  }

  if ((OZON_KNOWN_ACCRUAL_TYPE_CODES as readonly string[]).includes(code)) {
    return {
      decision: "KNOWN",
      code: code as OzonKnownAccrualTypeCode,
    };
  }

  return {
    decision: "FAIL_CLOSED",
    code,
    reason: `unknown ozon accrual type: ${code}`,
  };
}

export function assertOzonAccrualTypeAllowed(value: unknown): string {
  const result = classifyOzonAccrualTypeCode(value);

  if (result.decision === "FAIL_CLOSED") {
    throw new Error(`fail-closed: ${result.reason}`);
  }

  return result.code;
}
