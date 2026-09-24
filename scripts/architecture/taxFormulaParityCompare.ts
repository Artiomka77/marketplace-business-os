/**
 * Deterministic before/after tax comparison helper for Tax Formula Parity V1.
 * Old formula: USN on VAT-inclusive ordinary + VAT 5/105 on ordinary.
 * New formula: shared marketplaceTax calculator (USN on ex-VAT ordinary;
 * separate VAT ops in VAT base only).
 */
import {
  calculateMarketplaceTax,
  type MarketplaceTaxInput,
} from "../../lib/finance/marketplaceTax";

export function legacyTotalTax(input: {
  ordinarySalesVatInclusive: number;
  usnRate: number;
  vatRate: number;
}) {
  const base = Number(input.ordinarySalesVatInclusive) || 0;
  const usn = base * (input.usnRate / 100);
  const vat =
    input.vatRate > 0 ? base * (input.vatRate / (100 + input.vatRate)) : 0;
  return usn + vat;
}

export function compareTaxBeforeAfter(input: MarketplaceTaxInput) {
  const after = calculateMarketplaceTax(input);
  const beforeTotal = legacyTotalTax({
    ordinarySalesVatInclusive: input.ordinarySalesVatInclusive,
    usnRate: input.usnRate,
    vatRate: input.vatRate,
  });
  return {
    before: {
      totalTax: beforeTotal,
      usnOnInclusive:
        (Number(input.ordinarySalesVatInclusive) || 0) *
        ((Number(input.usnRate) || 0) / 100),
    },
    after,
    deltaTotalTax: after.totalTax - beforeTotal,
  };
}
