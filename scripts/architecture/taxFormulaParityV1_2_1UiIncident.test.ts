import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateWbAccountantTaxContribution,
  resolveWbSaleTaxReportKind,
  WbTaxReportKindError,
  buildWbFinanceTaxReportKindByKeyForRelevantSales,
} from "../../lib/finance/wbAccountantTaxBase";

test("UI incident: FINAL unresolved taxable kind remains fail-closed (throws at resolver)", () => {
  assert.throws(
    () =>
      resolveWbSaleTaxReportKind({
        companyName: "ИП Петров",
        reportNumber: "WB_DAILY_STATISTICS_2026-08-17",
        kindByKey: new Map(),
        requireResolved: true,
      }),
    (err: unknown) =>
      err instanceof WbTaxReportKindError &&
      err.code === "WB_TAX_REPORT_KIND_UNRESOLVED"
  );
});

test("UI incident: FINAL ordinary taxable row still computes tax", () => {
  const kind = resolveWbSaleTaxReportKind({
    companyName: "Co",
    reportNumber: "R1",
    kindByKey: new Map([["Co__R1", "ordinary"]]),
    requireResolved: true,
  });
  const tax = calculateWbAccountantTaxContribution({
    buyerPaid: 105_000,
    operation: "SALE",
    reportKind: kind,
    usnRate: 1,
    vatRate: 5,
  });
  assert.ok(tax.taxAmountDelta > 0);
  assert.equal(tax.ordinarySalesVatInclusiveDelta, 105_000);
  assert.equal(tax.separateVatTaxableAmountDelta, 0);
});

test("UI incident: FINAL buyout taxable row routes to separate VAT", () => {
  const kind = resolveWbSaleTaxReportKind({
    companyName: "Co",
    reportNumber: "BUY",
    kindByKey: new Map([["Co__BUY", "buyout"]]),
    requireResolved: true,
  });
  const tax = calculateWbAccountantTaxContribution({
    buyerPaid: 10_000,
    operation: "SALE",
    reportKind: kind,
    usnRate: 1,
    vatRate: 5,
  });
  assert.equal(tax.ordinarySalesVatInclusiveDelta, 0);
  assert.equal(tax.separateVatTaxableAmountDelta, 10_000);
  assert.ok(tax.taxAmountDelta > 0);
});

test("UI incident: contradictory kind remains fail-closed ambiguous", () => {
  const map = buildWbFinanceTaxReportKindByKeyForRelevantSales(
    [
      { companyName: "Co", reportNumber: "R1", reportTypeName: "1" },
      { companyName: "Co", reportNumber: "R1", reportTypeName: "2" },
    ],
    [{ companyName: "Co", reportNumber: "R1" }]
  );
  assert.equal(map.get("Co__R1"), "ambiguous");
  assert.throws(
    () =>
      resolveWbSaleTaxReportKind({
        companyName: "Co",
        reportNumber: "R1",
        kindByKey: map,
        requireResolved: true,
      }),
    (err: unknown) =>
      err instanceof WbTaxReportKindError &&
      err.code === "WB_TAX_REPORT_KIND_AMBIGUOUS"
  );
});

test("UI incident: null reportKind never silently becomes ordinary when requireResolvedKind defaults on", () => {
  assert.throws(
    () =>
      calculateWbAccountantTaxContribution({
        buyerPaid: 1_000,
        operation: "SALE",
        reportKind: null,
        usnRate: 6,
        vatRate: 5,
      }),
    (err: unknown) =>
      err instanceof WbTaxReportKindError &&
      err.code === "WB_TAX_REPORT_KIND_UNRESOLVED"
  );
});

test("UI incident: NON-FINAL unresolved must not be solved by ordinary fallback", () => {
  // requireResolved=false only observes absence of mapping; callers must mark
  // unavailable instead of feeding null kind into the calculator with
  // requireResolvedKind=false (that path would otherwise treat as ordinary).
  const kind = resolveWbSaleTaxReportKind({
    companyName: "ИП Лебедева",
    reportNumber: "WB_DAILY_STATISTICS_2026-07-08",
    kindByKey: new Map(),
    requireResolved: false,
  });
  assert.equal(kind, null);
});
