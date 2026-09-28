/**
 * Canonical marketplace tax calculator (Tax Formula Parity V1 / V1.2).
 *
 * VAT and USN bases are semantically distinct:
 * - VAT applies to ordinary realized sales (VAT-inclusive) + separately proven VAT-taxable ops
 * - USN applies to ordinary sales EXCLUDING embedded VAT (+ explicit USN-other income only)
 *
 * V1.2 legal-entity liability rounding:
 * keep full precision inside the calculator; round payable tax once per legal entity
 * at the entity boundary (2 decimal RUB). Cross-company totals sum those rounded liabilities.
 */

export type MarketplaceTaxInput = {
  ordinarySalesVatInclusive: number;
  separateVatTaxableAmount?: number;
  usnOtherIncomeBaseExVat?: number;
  usnRate: number;
  vatRate: number;
};

export type MarketplaceTaxBreakdown = {
  ordinarySalesVatInclusive: number;
  separateVatTaxableAmount: number;
  vatBaseInclusive: number;
  vatAmount: number;
  ordinarySalesExVat: number;
  usnOtherIncomeBaseExVat: number;
  usnBaseExVat: number;
  usnAmount: number;
  totalTax: number;
  usnRate: number;
  vatRate: number;
};

function toFiniteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function nonNegative(value: number): number {
  return value > 0 ? value : 0;
}

/**
 * Presentation helper (integer RUB). Not the legal-entity payable-tax boundary.
 */
export function roundTaxAccounting(amount: number): number {
  return Math.round(amount);
}

/**
 * Legal-entity tax liability boundary (V1.2):
 * round payable tax for one company/taxpayer to 2 decimal RUB (half away from zero).
 * Do not use for row-level amounts or tax bases.
 */
export function roundLegalEntityTaxLiability(amount: number): number {
  const n = toFiniteNumber(amount);
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(n) * 100)) / 100;
}

/**
 * Cross-company / ALL aggregator: sum already-rounded legal-entity liabilities.
 */
export function sumRoundedLegalEntityTaxLiabilities(
  roundedEntityLiabilities: number[]
): number {
  return roundedEntityLiabilities.reduce(
    (sum, value) => sum + roundLegalEntityTaxLiability(value),
    0
  );
}

export function calculateMarketplaceTax(
  input: MarketplaceTaxInput
): MarketplaceTaxBreakdown {
  const usnRate = toFiniteNumber(input.usnRate);
  const vatRate = toFiniteNumber(input.vatRate);
  const ordinarySalesVatInclusive = toFiniteNumber(
    input.ordinarySalesVatInclusive
  );
  const separateVatTaxableAmount = nonNegative(
    toFiniteNumber(input.separateVatTaxableAmount ?? 0)
  );
  const usnOtherIncomeBaseExVat = toFiniteNumber(
    input.usnOtherIncomeBaseExVat ?? 0
  );

  const vatBaseInclusive = ordinarySalesVatInclusive + separateVatTaxableAmount;

  const vatAmount =
    vatRate > 0 && vatBaseInclusive !== 0
      ? vatBaseInclusive * (vatRate / (100 + vatRate))
      : 0;

  const ordinarySalesExVat =
    vatRate > 0
      ? ordinarySalesVatInclusive * (100 / (100 + vatRate))
      : ordinarySalesVatInclusive;

  const usnBaseExVat = ordinarySalesExVat + usnOtherIncomeBaseExVat;

  const usnAmount =
    usnRate !== 0 && usnBaseExVat !== 0 ? usnBaseExVat * (usnRate / 100) : 0;

  return {
    ordinarySalesVatInclusive,
    separateVatTaxableAmount,
    vatBaseInclusive,
    vatAmount,
    ordinarySalesExVat,
    usnOtherIncomeBaseExVat,
    usnBaseExVat,
    usnAmount,
    totalTax: vatAmount + usnAmount,
    usnRate,
    vatRate,
  };
}

/** Full-precision total tax (shared calculator entrypoint). */
export function calculateMarketplaceTotalTax(input: MarketplaceTaxInput): number {
  return calculateMarketplaceTax(input).totalTax;
}

/** Entity-boundary payable tax for one legal entity from shared calculator inputs. */
export function calculateLegalEntityMarketplaceTaxLiability(
  input: MarketplaceTaxInput
): number {
  return roundLegalEntityTaxLiability(calculateMarketplaceTotalTax(input));
}
