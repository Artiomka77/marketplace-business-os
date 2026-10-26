import assert from "node:assert/strict";
import {
  buildHybridOzonCogsSourceRows,
  mapOzonProductRowToFinanceLike,
  summarizeOzonCogsCoverage,
} from "./ozonCogsHybridSource.ts";

const day = (iso) => new Date(`${iso}T00:00:00.000Z`);

const productRows = [
  {
    companyName: "ИП Петров",
    sku: "A",
    vendorCode: "variant-A",
    realizedQty: 1,
    returnedQty: 0,
    realizedAmount: 10,
    returnedAmount: 0,
    dateFrom: day("2026-10-19"),
    dateTo: day("2026-10-19"),
    operationDay: "2026-10-19",
    eventId: "evt-A",
    authorityCompleteForDay: true,
    quantityKnown: true,
  },
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
  {
    companyName: "ИП Петров",
    sku: null,
    quantity: 0,
    salesAmount: 0,
    totalAmount: -5,
    accrualDate: day("2026-10-19"),
    operationType: "Оплата за клик",
  },
];

const hybrid = buildHybridOzonCogsSourceRows({ productRows, financeRows });
assert.deepEqual(
  hybrid.map((r) => r.sku).filter(Boolean),
  ["A"],
);
assert.ok(hybrid.some((r) => r.operationType === "Оплата за клик"));

const fabricated = mapOzonProductRowToFinanceLike({
  companyName: "ИП Петров",
  sku: "A",
  vendorCode: "variant-A",
  realizedQty: 0,
  returnedQty: 0,
  realizedAmount: 100,
  returnedAmount: 0,
  dateFrom: day("2026-10-19"),
  dateTo: day("2026-10-19"),
  quantityKnown: true,
});
assert.equal(fabricated[0].quantity, 0);
assert.equal(fabricated[0].quantityUnknown, true);

const coverage = summarizeOzonCogsCoverage({
  productRows: [
    {
      companyName: "ИП Петров",
      sku: "A",
      vendorCode: "v",
      realizedQty: 1,
      returnedQty: 0,
      realizedAmount: 10,
      returnedAmount: 0,
      dateFrom: day("2026-10-19"),
      dateTo: day("2026-10-25"),
      operationDay: null,
      authorityCompleteForDay: true,
    },
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

console.log("ozonCogsHybridSource.node.test.mjs OK");
