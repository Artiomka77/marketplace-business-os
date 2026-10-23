import { describe, expect, it } from "vitest";

/** Mirrors loadFinanceSnapshot total ET rule — FULL only. */
function totalEconomicTurnover(params: {
  coverage: "FULL" | "PARTIAL_WB" | "PARTIAL_OZON" | "NONE";
  wb: number | null;
  ozon: number | null;
}): number | null {
  const { coverage, wb, ozon } = params;
  if (coverage !== "FULL") return null;
  if (wb == null && ozon == null) return null;
  return (wb ?? 0) + (ozon ?? 0);
}

function marginOrNull(
  revenue: number | null,
  profit: number | null,
): number | null {
  if (revenue == null || profit == null) return null;
  if (!(revenue > 0)) return null;
  return (profit / revenue) * 100;
}

describe("insights finance coverage rules", () => {
  it("does not present partial WB as full WB+Ozon total", () => {
    expect(
      totalEconomicTurnover({
        coverage: "PARTIAL_WB",
        wb: 10_000_000,
        ozon: null,
      }),
    ).toBeNull();
  });

  it("does not present partial Ozon as full WB+Ozon total", () => {
    expect(
      totalEconomicTurnover({
        coverage: "PARTIAL_OZON",
        wb: null,
        ozon: 5_000_000,
      }),
    ).toBeNull();
  });

  it("FULL coverage sums trusted components", () => {
    expect(
      totalEconomicTurnover({
        coverage: "FULL",
        wb: 10_000_000,
        ozon: 5_000_000,
      }),
    ).toBe(15_000_000);
  });

  it("NONE yields null total (null ≠ 0)", () => {
    expect(
      totalEconomicTurnover({ coverage: "NONE", wb: null, ozon: null }),
    ).toBeNull();
  });

  it("margin is null when revenue unknown (never invent 0%)", () => {
    expect(marginOrNull(null, 100)).toBeNull();
    expect(marginOrNull(0, 100)).toBeNull();
    expect(marginOrNull(200, 50)).toBe(25);
  });
});
