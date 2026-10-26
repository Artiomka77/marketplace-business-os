import assert from "node:assert/strict";
import {
  buildHybridOzonCogsSourceRows,
  mapOzonProductRowToFinanceLike,
  summarizeOzonCogsCoverage,
  type OzonCogsProductRow,
} from "./ozonCogsHybridSource.ts";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function product(
  overrides: Partial<OzonCogsProductRow> &
    Pick<OzonCogsProductRow, "sku" | "companyName">,
): OzonCogsProductRow {
  return {
    vendorCode: `variant-${overrides.sku}`,
    realizedQty: 0,
    returnedQty: 0,
    realizedAmount: 0,
    returnedAmount: 0,
    dateFrom: day("2026-10-19"),
    dateTo: day("2026-10-19"),
    operationDay: "2026-10-19",
    authorityCompleteForDay: true,
    quantityKnown: true,
    eventId: overrides.eventId ?? `evt-${overrides.sku}`,
    ...overrides,
  };
}

// A: product A day-complete must NOT drop finance B same day for another SKU
// when authority is only claimed with metadata — with complete authority for
// company+day, finance product sales ARE suppressed; service rows kept.
{
  const productRows = [
    product({
      companyName: "ИП Петров",
      sku: "A",
      realizedQty: 1,
      realizedAmount: 10,
      authorityCompleteForDay: true,
    }),
  ];
  const financeRows = [
    {
      companyName: "ИП Петров",
      sku: "B",
      vendorCode: "variant-B",
      quantity: 3,
      salesAmount: 30,
      totalAmount: 30,
      accrualDate: day("2026-10-19"),
      operationType: "Sale",
    },
    {
      companyName: "ИП Петров",
      sku: null,
      vendorCode: null,
      quantity: 0,
      salesAmount: 0,
      totalAmount: -50,
      accrualDate: day("2026-10-19"),
      operationType: "Оплата за клик",
    },
  ];
  const hybrid = buildHybridOzonCogsSourceRows({ productRows, financeRows });
  const skus = hybrid.map((r) => r.sku).filter(Boolean);
  assert.deepEqual(skus, ["A"]);
  assert.ok(
    hybrid.some((r) => r.operationType === "Оплата за клик"),
    "ads/service finance row must survive",
  );
}

// Without authorityCompleteForDay, finance B must survive alongside product A
{
  const productRows = [
    product({
      companyName: "ИП Петров",
      sku: "A",
      realizedQty: 1,
      realizedAmount: 10,
      authorityCompleteForDay: false,
      operationDay: "2026-10-19",
    }),
  ];
  const financeRows = [
    {
      companyName: "ИП Петров",
      sku: "B",
      quantity: 3,
      salesAmount: 30,
      totalAmount: 30,
      accrualDate: day("2026-10-19"),
    },
  ];
  const hybrid = buildHybridOzonCogsSourceRows({ productRows, financeRows });
  assert.deepEqual(
    hybrid.map((r) => r.sku).sort(),
    ["A", "B"],
  );
}

// Duplicate product event identity → quantity not doubled
{
  const row = product({
    companyName: "ИП Петров",
    sku: "A",
    realizedQty: 1,
    realizedAmount: 10,
    eventId: "same-event",
  });
  const hybrid = buildHybridOzonCogsSourceRows({
    productRows: [row, { ...row }],
    financeRows: [],
  });
  assert.equal(hybrid.length, 1);
  assert.equal(hybrid[0].quantity, 1);
}

// Distinct events same SKU/amount kept
{
  const hybrid = buildHybridOzonCogsSourceRows({
    productRows: [
      product({
        companyName: "ИП Петров",
        sku: "A",
        realizedQty: 1,
        realizedAmount: 10,
        eventId: "e1",
      }),
      product({
        companyName: "ИП Петров",
        sku: "A",
        realizedQty: 1,
        realizedAmount: 10,
        eventId: "e2",
      }),
    ],
    financeRows: [],
  });
  assert.equal(hybrid.length, 2);
}

// No fabricated qty/money
{
  const zeroQty = mapOzonProductRowToFinanceLike(
    product({
      companyName: "ИП Петров",
      sku: "A",
      realizedQty: 0,
      realizedAmount: 100,
      quantityKnown: true,
    }),
  );
  assert.equal(zeroQty.length, 1);
  assert.equal(zeroQty[0].quantity, 0);
  assert.equal(zeroQty[0].quantityUnknown, true);
  assert.equal(zeroQty[0].salesAmount, 100);

  const zeroMoney = mapOzonProductRowToFinanceLike(
    product({
      companyName: "ИП Петров",
      sku: "A",
      realizedQty: 2,
      realizedAmount: 0,
      quantityKnown: true,
    }),
  );
  assert.equal(zeroMoney.length, 1);
  assert.equal(zeroMoney[0].quantity, 2);
  assert.equal(zeroMoney[0].salesAmount, 0);
  assert.equal(zeroMoney[0].physicalMovement, "SALE");
}

// Interval alone does not claim complete week
{
  const coverage = summarizeOzonCogsCoverage({
    productRows: [
      product({
        companyName: "ИП Петров",
        sku: "A",
        realizedQty: 1,
        realizedAmount: 10,
        dateFrom: day("2026-10-19"),
        dateTo: day("2026-10-25"),
        operationDay: null,
        authorityCompleteForDay: true,
      }),
    ],
    financeRows: [],
    periodDays: [
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
    ],
  });
  assert.equal(coverage.quantityCoverageComplete, false);
  assert.ok(coverage.missingProductDays.length >= 6);
}

// Authority days mark complete week including confirmed-zero days
{
  const coverage = summarizeOzonCogsCoverage({
    productRows: [],
    financeRows: [],
    periodDays: ["2026-10-19", "2026-10-20"],
    authorityDays: [
      {
        companyName: "ИП Петров",
        day: "2026-10-19",
        complete: true,
        confirmedZeroProductSales: true,
      },
      {
        companyName: "ИП Петров",
        day: "2026-10-20",
        complete: true,
        confirmedZeroProductSales: true,
      },
    ],
    companyName: "ИП Петров",
  });
  assert.equal(coverage.quantityCoverageComplete, true);
  assert.equal(coverage.authorityEmpty, false);
}

// Other company finance not suppressed by Petrov product
{
  const hybrid = buildHybridOzonCogsSourceRows({
    productRows: [
      product({
        companyName: "ИП Петров",
        sku: "A",
        realizedQty: 1,
        realizedAmount: 10,
      }),
    ],
    financeRows: [
      {
        companyName: "ИП Лебедева",
        sku: "L",
        quantity: 1,
        salesAmount: 100,
        totalAmount: 100,
        accrualDate: day("2026-10-19"),
      },
    ],
  });
  assert.ok(hybrid.some((r) => r.sku === "L"));
  assert.ok(hybrid.some((r) => r.sku === "A"));
}

console.log("ozonCogsHybridSource.test.ts OK");
