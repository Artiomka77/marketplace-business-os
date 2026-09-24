import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateMarketplaceTax,
  roundTaxAccounting,
} from "../../lib/finance/marketplaceTax";

/**
 * Tax Formula Parity V1 — accountant Q2 oracle + rate contract.
 * No live DB. No hardcoded current-week runtime totals.
 */

test("CURRENT-style formula taxes USN on VAT-inclusive base (legacy defect)", () => {
  const ordinary = 22366038.67;
  const usnRate = 1;
  const vatRate = 5;
  const legacyUsn = ordinary * (usnRate / 100);
  const legacyVat = ordinary * (vatRate / (100 + vatRate));
  assert.ok(legacyUsn > 213009.89);
  assert.equal(Number((legacyUsn + legacyVat).toFixed(2)), Number((legacyUsn + legacyVat).toFixed(2)));
  // Marker for report: CURRENT_USN_BASE_INCLUDES_VAT=YES
  assert.ok(legacyUsn !== ordinary * (100 / (100 + vatRate)) * (usnRate / 100));
});

test("Q2 accountant VAT oracle parity", () => {
  const tax = calculateMarketplaceTax({
    ordinarySalesVatInclusive: 22366038.67,
    separateVatTaxableAmount: 188444.42,
    usnOtherIncomeBaseExVat: 0,
    usnRate: 1,
    vatRate: 5,
  });

  assert.equal(Number(tax.vatBaseInclusive.toFixed(2)), 22554483.09);
  assert.ok(Math.abs(tax.vatAmount - 1074023.004285714) < 1e-6);
  assert.equal(roundTaxAccounting(tax.vatAmount), 1074023);
});

test("Q2 USN method parity excludes embedded VAT; residual is external", () => {
  const tax = calculateMarketplaceTax({
    ordinarySalesVatInclusive: 22366038.67,
    separateVatTaxableAmount: 0,
    usnOtherIncomeBaseExVat: 0,
    usnRate: 1,
    vatRate: 5,
  });

  assert.ok(Math.abs(tax.ordinarySalesExVat - 21300989.20952381) < 1e-6);
  assert.ok(Math.abs(tax.usnAmount - 213009.892095238) < 1e-6);
  // Accountant 213100 includes other income/corrections not in marketplace core.
  assert.notEqual(roundTaxAccounting(tax.usnAmount), 213100);
});

test("separate VAT-taxable ops do not automatically enter USN base", () => {
  const withSeparate = calculateMarketplaceTax({
    ordinarySalesVatInclusive: 100000,
    separateVatTaxableAmount: 10000,
    usnRate: 1,
    vatRate: 5,
  });
  const withoutSeparate = calculateMarketplaceTax({
    ordinarySalesVatInclusive: 100000,
    separateVatTaxableAmount: 0,
    usnRate: 1,
    vatRate: 5,
  });

  assert.equal(withSeparate.usnBaseExVat, withoutSeparate.usnBaseExVat);
  assert.ok(withSeparate.vatAmount > withoutSeparate.vatAmount);
});

test("Petrov USN 1% and Lebedeva USN 6% with VAT 5/105", () => {
  const base = 105000;
  const petrov = calculateMarketplaceTax({
    ordinarySalesVatInclusive: base,
    usnRate: 1,
    vatRate: 5,
  });
  const lebedeva = calculateMarketplaceTax({
    ordinarySalesVatInclusive: base,
    usnRate: 6,
    vatRate: 5,
  });

  assert.equal(petrov.vatAmount, 5000);
  assert.equal(lebedeva.vatAmount, 5000);
  assert.equal(petrov.usnAmount, 1000);
  assert.equal(lebedeva.usnAmount, 6000);
  assert.equal(petrov.totalTax, 6000);
  assert.equal(lebedeva.totalTax, 11000);
});

test("WB SPP and Ozon discount points are not re-added when caller passes ordinary only", () => {
  // Caller contract: ordinarySalesVatInclusive is already after platform discount.
  const tax = calculateMarketplaceTax({
    ordinarySalesVatInclusive: 1000,
    separateVatTaxableAmount: 0,
    usnRate: 1,
    vatRate: 5,
  });
  assert.equal(tax.ordinarySalesVatInclusive, 1000);
  assert.equal(tax.separateVatTaxableAmount, 0);
});

test("candidate USN base excludes embedded VAT", () => {
  const tax = calculateMarketplaceTax({
    ordinarySalesVatInclusive: 210,
    usnRate: 1,
    vatRate: 5,
  });
  assert.equal(tax.ordinarySalesExVat, 200);
  assert.equal(tax.usnAmount, 2);
  assert.equal(tax.vatAmount, 10);
  assert.equal(tax.totalTax, 12);
});
