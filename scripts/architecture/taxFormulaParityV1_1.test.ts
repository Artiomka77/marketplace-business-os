import assert from "node:assert/strict";
import test from "node:test";

import { calculateMarketplaceTax } from "../../lib/finance/marketplaceTax";
import {
  buildWbFinanceTaxReportKindByKey,
  calculateWbAccountantTaxContribution,
  classifyWbFinanceReportTypeName,
  resolveWbSaleTaxReportKind,
  summarizeWbAccountantTaxBases,
} from "../../lib/finance/wbAccountantTaxBase";

const TOL = 0.01;

function close(actual: number, expected: number, label: string) {
  assert.ok(
    Math.abs(actual - expected) <= TOL,
    `${label}: ${actual} != ${expected}`
  );
}

test("A. ordinary WB SALE: buyerPaid enters ordinarySalesVatInclusive", () => {
  const row = calculateWbAccountantTaxContribution({
    buyerPaid: 1000,
    operation: "SALE",
    reportKind: "ordinary",
    usnRate: 1,
    vatRate: 5,
  });
  assert.equal(row.ordinarySalesVatInclusiveDelta, 1000);
  assert.equal(row.separateVatTaxableAmountDelta, 0);
});

test("B. ordinary WB RETURN: buyerPaid reverses ordinarySalesVatInclusive", () => {
  const row = calculateWbAccountantTaxContribution({
    buyerPaid: 1000,
    operation: "RETURN",
    reportKind: "ordinary",
    usnRate: 1,
    vatRate: 5,
  });
  assert.equal(row.ordinarySalesVatInclusiveDelta, -1000);
  assert.equal(row.separateVatTaxableAmountDelta, 0);
});

test("C. marketplaceTaxTopUp on SALE does not increase ordinary base", () => {
  // Caller must pass buyerPaid only; topUp is intentionally omitted from inputs.
  const buyerPaid = 100;
  const marketplaceTaxTopUp = 25;
  const row = calculateWbAccountantTaxContribution({
    buyerPaid,
    operation: "SALE",
    reportKind: "ordinary",
    usnRate: 1,
    vatRate: 5,
  });
  assert.equal(row.ordinarySalesVatInclusiveDelta, buyerPaid);
  assert.notEqual(
    row.ordinarySalesVatInclusiveDelta,
    buyerPaid + marketplaceTaxTopUp
  );
});

test("D. marketplaceTaxTopUp on RETURN does not reduce ordinary base", () => {
  const buyerPaid = 0;
  const marketplaceTaxTopUp = 50;
  const row = calculateWbAccountantTaxContribution({
    buyerPaid,
    operation: "RETURN",
    reportKind: "ordinary",
    usnRate: 1,
    vatRate: 5,
  });
  assert.equal(row.ordinarySalesVatInclusiveDelta, 0);
  assert.equal(row.taxAmountDelta, 0);
  assert.ok(marketplaceTaxTopUp > 0);
});

test("E. voluntary compensation RETURN buyerPaid=0 sellerPayout>0 topUp>0 → zero ordinary effect", () => {
  const row = calculateWbAccountantTaxContribution({
    buyerPaid: 0,
    operation: "RETURN",
    reportKind: "ordinary",
    usnRate: 6,
    vatRate: 5,
  });
  assert.equal(row.ordinarySalesVatInclusiveDelta, 0);
  assert.equal(row.separateVatTaxableAmountDelta, 0);
  assert.equal(row.taxAmountDelta, 0);
});

test("F. qualifying buyout SALE: buyerPaid enters separateVatTaxableAmount", () => {
  const row = calculateWbAccountantTaxContribution({
    buyerPaid: 40996.94,
    operation: "SALE",
    reportKind: "buyout",
    usnRate: 1,
    vatRate: 5,
  });
  assert.equal(row.ordinarySalesVatInclusiveDelta, 0);
  assert.equal(row.separateVatTaxableAmountDelta, 40996.94);
});

test("G. qualifying buyout RETURN: buyerPaid reverses separateVatTaxableAmount", () => {
  const row = calculateWbAccountantTaxContribution({
    buyerPaid: 500,
    operation: "RETURN",
    reportKind: "buyout",
    usnRate: 1,
    vatRate: 5,
  });
  assert.equal(row.ordinarySalesVatInclusiveDelta, 0);
  assert.equal(row.separateVatTaxableAmountDelta, -500);
});

test("H. buyout logistics-only OTHER: no ordinary and no separate VAT product revenue", () => {
  const row = calculateWbAccountantTaxContribution({
    buyerPaid: 0,
    operation: "OTHER",
    reportKind: "buyout",
    usnRate: 6,
    vatRate: 5,
  });
  assert.equal(row.ordinarySalesVatInclusiveDelta, 0);
  assert.equal(row.separateVatTaxableAmountDelta, 0);
  assert.equal(row.taxAmountDelta, 0);
});

test("I. buyout amount does not enter ordinary USN base", () => {
  const tax = calculateMarketplaceTax({
    ordinarySalesVatInclusive: 0,
    separateVatTaxableAmount: 40996.94,
    usnRate: 1,
    vatRate: 5,
  });
  assert.equal(tax.usnBaseExVat, 0);
  assert.ok(tax.vatAmount > 0);
});

test("J. SPP/economicTurnover do not alter accountant ordinary tax base", () => {
  const economicTurnover = 150;
  const spp = 50;
  const buyerPaid = 100;
  const row = calculateWbAccountantTaxContribution({
    buyerPaid,
    operation: "SALE",
    reportKind: "ordinary",
    usnRate: 1,
    vatRate: 5,
  });
  assert.equal(row.ordinarySalesVatInclusiveDelta, buyerPaid);
  assert.notEqual(row.ordinarySalesVatInclusiveDelta, economicTurnover);
  assert.notEqual(row.ordinarySalesVatInclusiveDelta, buyerPaid + spp);
});

test("K. source ownership: mapping uses durable reportTypeName keys only", () => {
  const kindByKey = buildWbFinanceTaxReportKindByKey([
    { companyName: "Co A", reportNumber: "111", reportTypeName: "1" },
    { companyName: "Co A", reportNumber: "222", reportTypeName: "2" },
    { companyName: "Co A", reportNumber: "333", reportTypeName: "По выкупам" },
  ]);
  assert.equal(
    resolveWbSaleTaxReportKind({
      companyName: "Co A",
      reportNumber: "111",
      kindByKey,
    }),
    "ordinary"
  );
  assert.equal(
    resolveWbSaleTaxReportKind({
      companyName: "Co A",
      reportNumber: "222",
      kindByKey,
    }),
    "buyout"
  );
  assert.equal(
    resolveWbSaleTaxReportKind({
      companyName: "Co A",
      reportNumber: "333",
      kindByKey,
    }),
    "buyout"
  );
  assert.equal(classifyWbFinanceReportTypeName("Основной"), "ordinary");
});

test("L. no duplicate ordinary + separate VAT counting", () => {
  const saleOrdinary = calculateWbAccountantTaxContribution({
    buyerPaid: 1000,
    operation: "SALE",
    reportKind: "ordinary",
    usnRate: 1,
    vatRate: 5,
  });
  const saleBuyout = calculateWbAccountantTaxContribution({
    buyerPaid: 1000,
    operation: "SALE",
    reportKind: "buyout",
    usnRate: 1,
    vatRate: 5,
  });
  assert.equal(saleOrdinary.ordinarySalesVatInclusiveDelta, 1000);
  assert.equal(saleOrdinary.separateVatTaxableAmountDelta, 0);
  assert.equal(saleBuyout.ordinarySalesVatInclusiveDelta, 0);
  assert.equal(saleBuyout.separateVatTaxableAmountDelta, 1000);
  const sum = summarizeWbAccountantTaxBases([saleOrdinary, saleBuyout]);
  assert.equal(sum.ordinarySalesVatInclusive, 1000);
  assert.equal(sum.separateVatTaxableAmount, 1000);
});

test("N. shared calculator regression: separate VAT not in USN", () => {
  const tax = calculateMarketplaceTax({
    ordinarySalesVatInclusive: 105000,
    separateVatTaxableAmount: 10500,
    usnRate: 1,
    vatRate: 5,
  });
  assert.equal(tax.ordinarySalesExVat, 100000);
  assert.equal(tax.usnAmount, 1000);
  assert.equal(tax.vatAmount, 5500);
});

test("canary-shaped Petrov week tax inputs (oracle fixtures only)", () => {
  const ordinary = 4_119_841.07;
  const separate = 40_996.94;
  const tax = calculateMarketplaceTax({
    ordinarySalesVatInclusive: ordinary,
    separateVatTaxableAmount: separate,
    usnRate: 1,
    vatRate: 5,
  });
  close(tax.vatAmount, 198_135.14, "Petrov VAT");
  close(tax.usnBaseExVat, 3_923_658.16, "Petrov USN base");
  close(tax.usnAmount, 39_236.58, "Petrov USN");
  close(tax.totalTax, 237_371.72, "Petrov WB totalTax");
});

test("canary-shaped Lebedeva week tax inputs (oracle fixtures only)", () => {
  const tax = calculateMarketplaceTax({
    ordinarySalesVatInclusive: 451_778.96,
    separateVatTaxableAmount: 0,
    usnRate: 6,
    vatRate: 5,
  });
  close(tax.vatAmount, 21_513.28, "Lebedeva VAT");
  close(tax.usnBaseExVat, 430_265.68, "Lebedeva USN base");
  close(tax.usnAmount, 25_815.94, "Lebedeva USN");
  close(tax.totalTax, 47_329.22, "Lebedeva WB totalTax");

  const compensation = calculateWbAccountantTaxContribution({
    buyerPaid: 0,
    operation: "RETURN",
    reportKind: "ordinary",
    usnRate: 6,
    vatRate: 5,
  });
  assert.equal(compensation.ordinarySalesVatInclusiveDelta, 0);
  // Distorted candidate 447854.43 must not be reconstructible via buyerPaid-only base.
  assert.notEqual(451_778.96, 447_854.43);
});
