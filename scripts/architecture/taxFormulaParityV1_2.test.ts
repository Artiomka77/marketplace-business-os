import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  calculateLegalEntityMarketplaceTaxLiability,
  calculateMarketplaceTax,
  calculateMarketplaceTotalTax,
  roundLegalEntityTaxLiability,
  sumRoundedLegalEntityTaxLiabilities,
} from "../../lib/finance/marketplaceTax";
import {
  aggregateRoundedWbTaxLiabilities,
  buildWbFinanceTaxReportKindByKey,
  calculateWbAccountantTaxContribution,
  calculateWbFallbackAccountantTaxLiability,
  classifyWbFinanceReportTypeName,
  resolveWbSaleTaxReportKind,
  WbTaxReportKindError,
} from "../../lib/finance/wbAccountantTaxBase";

const TOL = 0.01;
const close = (actual: number, expected: number, label: string) => {
  assert.ok(
    Math.abs(actual - expected) <= TOL,
    `${label}: ${actual} != ${expected}`
  );
};

test("V1.2 rounding: no row-level rounding inside calculator", () => {
  const tax = calculateMarketplaceTax({
    ordinarySalesVatInclusive: 4119841.07,
    separateVatTaxableAmount: 40996.94,
    usnRate: 1,
    vatRate: 5,
  });
  assert.notEqual(tax.totalTax, Number(tax.totalTax.toFixed(2)));
  assert.ok(Math.abs(tax.totalTax - 237371.72495238093) < 1e-6);
});

test("V1.2 rounding: entity liability rounded once at boundary", () => {
  const raw = calculateMarketplaceTotalTax({
    ordinarySalesVatInclusive: 4119841.07,
    separateVatTaxableAmount: 40996.94,
    usnRate: 1,
    vatRate: 5,
  });
  assert.equal(roundLegalEntityTaxLiability(raw), 237371.72);
  assert.equal(
    calculateLegalEntityMarketplaceTaxLiability({
      ordinarySalesVatInclusive: 4119841.07,
      separateVatTaxableAmount: 40996.94,
      usnRate: 1,
      vatRate: 5,
    }),
    237371.72
  );
});

test("V1.2 rounding: ALL sums rounded entity liabilities (not round of sum)", () => {
  const petrovRaw = calculateMarketplaceTotalTax({
    ordinarySalesVatInclusive: 4119841.07,
    separateVatTaxableAmount: 40996.94,
    usnRate: 1,
    vatRate: 5,
  });
  const lebedevaRaw = calculateMarketplaceTotalTax({
    ordinarySalesVatInclusive: 451778.96,
    separateVatTaxableAmount: 0,
    usnRate: 6,
    vatRate: 5,
  });
  const petrov = roundLegalEntityTaxLiability(petrovRaw);
  const lebedeva = roundLegalEntityTaxLiability(lebedevaRaw);
  assert.equal(petrov, 237371.72);
  assert.equal(lebedeva, 47329.22);
  assert.equal(sumRoundedLegalEntityTaxLiabilities([petrov, lebedeva]), 284700.94);
  assert.equal(aggregateRoundedWbTaxLiabilities([petrovRaw, lebedevaRaw]), 284700.94);
  assert.notEqual(
    roundLegalEntityTaxLiability(petrovRaw + lebedevaRaw),
    284700.94
  );
  assert.equal(
    roundLegalEntityTaxLiability(petrovRaw + lebedevaRaw),
    284700.95
  );
});

test("V1.2 fail-closed A ordinary", () => {
  assert.equal(classifyWbFinanceReportTypeName("1"), "ordinary");
  assert.equal(classifyWbFinanceReportTypeName("Основной"), "ordinary");
});

test("V1.2 fail-closed B buyout", () => {
  assert.equal(classifyWbFinanceReportTypeName("2"), "buyout");
  assert.equal(classifyWbFinanceReportTypeName("По выкупам"), "buyout");
});

test("V1.2 fail-closed C null reportTypeName -> unresolved", () => {
  const kindByKey = buildWbFinanceTaxReportKindByKey([
    { companyName: "Co", reportNumber: "R1", reportTypeName: null },
  ]);
  assert.throws(
    () =>
      resolveWbSaleTaxReportKind({
        companyName: "Co",
        reportNumber: "R1",
        kindByKey,
        requireResolved: true,
      }),
    (err: unknown) =>
      err instanceof WbTaxReportKindError &&
      err.code === "WB_TAX_REPORT_KIND_UNRESOLVED"
  );
});

test("V1.2 fail-closed D unknown reportTypeName -> unresolved", () => {
  const kindByKey = buildWbFinanceTaxReportKindByKey([
    { companyName: "Co", reportNumber: "R1", reportTypeName: "weird" },
  ]);
  assert.throws(
    () =>
      resolveWbSaleTaxReportKind({
        companyName: "Co",
        reportNumber: "R1",
        kindByKey,
        requireResolved: true,
      }),
    (err: unknown) =>
      err instanceof WbTaxReportKindError &&
      err.code === "WB_TAX_REPORT_KIND_UNRESOLVED"
  );
});

test("V1.2 fail-closed E missing map entry -> unresolved", () => {
  const kindByKey = buildWbFinanceTaxReportKindByKey([]);
  assert.throws(
    () =>
      resolveWbSaleTaxReportKind({
        companyName: "Co",
        reportNumber: "R1",
        kindByKey,
        requireResolved: true,
      }),
    (err: unknown) =>
      err instanceof WbTaxReportKindError &&
      err.code === "WB_TAX_REPORT_KIND_UNRESOLVED"
  );
});

test("V1.2 fail-closed F empty reportNumber + taxable buyerPaid", () => {
  assert.throws(
    () =>
      resolveWbSaleTaxReportKind({
        companyName: "Co",
        reportNumber: "",
        kindByKey: new Map(),
        requireResolved: true,
      }),
    (err: unknown) =>
      err instanceof WbTaxReportKindError &&
      err.code === "WB_TAX_REPORT_KIND_UNRESOLVED"
  );
  assert.throws(
    () =>
      calculateWbAccountantTaxContribution({
        buyerPaid: 100,
        operation: "SALE",
        reportKind: null,
        usnRate: 1,
        vatRate: 5,
      }),
    (err: unknown) =>
      err instanceof WbTaxReportKindError &&
      err.code === "WB_TAX_REPORT_KIND_UNRESOLVED"
  );
});

test("V1.2 fail-closed G contradictory map evidence -> ambiguous", () => {
  const kindByKey = buildWbFinanceTaxReportKindByKey([
    { companyName: "Co", reportNumber: "R1", reportTypeName: "1" },
    { companyName: "Co", reportNumber: "R1", reportTypeName: "2" },
  ]);
  assert.equal(kindByKey.get("Co__R1"), "ambiguous");
  assert.throws(
    () =>
      resolveWbSaleTaxReportKind({
        companyName: "Co",
        reportNumber: "R1",
        kindByKey,
        requireResolved: true,
      }),
    (err: unknown) =>
      err instanceof WbTaxReportKindError &&
      err.code === "WB_TAX_REPORT_KIND_AMBIGUOUS"
  );
});

test("V1.2 fail-closed H OTHER / buyerPaid=0 zero without misclassification", () => {
  const row = calculateWbAccountantTaxContribution({
    buyerPaid: 0,
    operation: "OTHER",
    reportKind: null,
    usnRate: 1,
    vatRate: 5,
  });
  assert.equal(row.taxAmountDelta, 0);
  assert.equal(row.ordinarySalesVatInclusiveDelta, 0);
});

test("V1.2 fail-closed I PROBE6 known kinds resolve", () => {
  const kindByKey = buildWbFinanceTaxReportKindByKey([
    { companyName: "ИП Петров", reportNumber: "MAIN", reportTypeName: "1" },
    { companyName: "ИП Петров", reportNumber: "BUYOUT", reportTypeName: "2" },
    {
      companyName: "ИП Лебедева",
      reportNumber: "MAIN",
      reportTypeName: "Основной",
    },
    {
      companyName: "ИП Лебедева",
      reportNumber: "BUYOUT",
      reportTypeName: "По выкупам",
    },
  ]);
  assert.equal(
    resolveWbSaleTaxReportKind({
      companyName: "ИП Петров",
      reportNumber: "MAIN",
      kindByKey,
      requireResolved: true,
    }),
    "ordinary"
  );
  assert.equal(
    resolveWbSaleTaxReportKind({
      companyName: "ИП Петров",
      reportNumber: "BUYOUT",
      kindByKey,
      requireResolved: true,
    }),
    "buyout"
  );
});

test("V1.2 Telegram fallback helper buyout parity + refuse on unresolved", () => {
  const kindByKey = buildWbFinanceTaxReportKindByKey([
    { companyName: "ИП Петров", reportNumber: "MAIN", reportTypeName: "1" },
    { companyName: "ИП Петров", reportNumber: "BUYOUT", reportTypeName: "2" },
  ]);
  const liability = calculateWbFallbackAccountantTaxLiability({
    rows: [
      {
        companyName: "ИП Петров",
        reportNumber: "MAIN",
        paymentReason: "Продажа",
        wbRealizedAmount: 1050,
      },
      {
        companyName: "ИП Петров",
        reportNumber: "BUYOUT",
        paymentReason: "Продажа",
        wbRealizedAmount: 210,
      },
    ],
    kindByKey,
    usnRate: 1,
    vatRate: 5,
  });
  const expected = calculateLegalEntityMarketplaceTaxLiability({
    ordinarySalesVatInclusive: 1050,
    separateVatTaxableAmount: 210,
    usnRate: 1,
    vatRate: 5,
  });
  assert.equal(liability, expected);
  assert.throws(
    () =>
      calculateWbFallbackAccountantTaxLiability({
        rows: [
          {
            companyName: "ИП Петров",
            reportNumber: "MISSING",
            paymentReason: "Продажа",
            wbRealizedAmount: 100,
          },
        ],
        kindByKey,
        usnRate: 1,
        vatRate: 5,
      }),
    (err: unknown) => err instanceof WbTaxReportKindError
  );
});

test("V1.2 unknown+valid kind keeps valid; contradiction fails", () => {
  const mixed = buildWbFinanceTaxReportKindByKey([
    { companyName: "Co", reportNumber: "R1", reportTypeName: "weird" },
    { companyName: "Co", reportNumber: "R1", reportTypeName: "1" },
  ]);
  assert.equal(mixed.get("Co__R1"), "ordinary");
});

test("V1.2 no calculateWbTaxes footgun in clean release sources", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const files = [
    "lib/finance/marketplaceTax.ts",
    "lib/finance/wbAccountantTaxBase.ts",
    "lib/analytics/profitAnalytics.ts",
    "lib/analytics/dashboardDailyAnalytics.ts",
    "lib/telegram/dailyReport.ts",
  ];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(root, rel), "utf8");
    assert.equal(
      text.includes("calculateWbTaxes"),
      false,
      `${rel} must not contain calculateWbTaxes`
    );
  }
});
