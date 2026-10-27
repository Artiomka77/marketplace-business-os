import assert from "node:assert/strict";
import {
  isOzonAccrualCoverageProven,
  selectOzonAccrualDayOwners,
} from "./ozonAccrualSessionOwnership.ts";
import {
  buildHybridOzonCogsSourceRows,
  summarizeOzonCogsCoverage,
} from "../analytics/ozonCogsHybridSource.ts";
import {
  extractOzonAccrualProductMovements,
  mapMovementsToCogsProductRows,
} from "./ozonAccrualProductMovements.ts";

// missing raw treated as NOT confirmed zero
{
  const preview = {
    dateFrom: "2026-10-19",
    dateTo: "2026-10-19",
    requestedDates: ["2026-10-19"],
  };
  assert.equal(isOzonAccrualCoverageProven(preview).proven, false);
  const owners = selectOzonAccrualDayOwners({
    sessions: [
      {
        id: "missing-raw",
        companyName: "ИП Петров",
        status: "RAW_PERSISTED",
        createdAt: "2026-10-20",
        previewJson: preview,
      },
    ],
    dateFrom: "2026-10-19",
    dateTo: "2026-10-19",
  });
  const owner = owners.get("ИП Петров|2026-10-19")!;
  assert.equal(owner.complete, false);
  assert.equal(owner.confirmedZeroProductSales, false);
  const hybrid = buildHybridOzonCogsSourceRows({
    productRows: [],
    financeRows: [
      {
        companyName: "ИП Петров",
        sku: "B",
        quantity: 2,
        salesAmount: 20,
        totalAmount: 20,
        accrualDate: new Date("2026-10-19T00:00:00.000Z"),
      },
    ],
    authorityDays: [
      {
        companyName: owner.companyName,
        day: owner.day,
        complete: owner.complete,
        confirmedZeroProductSales: owner.confirmedZeroProductSales,
      },
    ],
  });
  assert.equal(hybrid.length, 1);
  assert.equal(hybrid[0].sku, "B");
}

// explicit partial does not claim complete / does not drop finance B
{
  const preview = {
    dateFrom: "2026-10-19",
    dateTo: "2026-10-19",
    requestedDates: ["2026-10-19"],
    coverageComplete: false,
    rawAccruals: [
      {
        accrual_id: 123,
        date: "2026-10-19",
        posting: {
          products: [
            {
              sku: "A",
              quantity: 1,
              commission: {
                sale_price: { amount: "100" },
                sale_amount: { amount: "100" },
              },
            },
          ],
        },
      },
    ],
  };
  const owners = selectOzonAccrualDayOwners({
    sessions: [
      {
        id: "partial",
        companyName: "ИП Петров",
        status: "SUCCESS",
        createdAt: "2026-10-20",
        previewJson: preview,
      },
    ],
    dateFrom: "2026-10-19",
    dateTo: "2026-10-19",
  });
  const owner = owners.get("ИП Петров|2026-10-19")!;
  assert.equal(owner.complete, false);
  const mov = extractOzonAccrualProductMovements({
    companyName: "ИП Петров",
    sessionId: "partial",
    rawAccruals: preview.rawAccruals,
    dateFrom: "2026-10-19",
    dateTo: "2026-10-19",
  });
  const productRows = mapMovementsToCogsProductRows(mov).map((r) => ({
    ...r,
    vendorCode: "variant-A",
    authorityCompleteForDay: owner.complete,
  }));
  const hybrid = buildHybridOzonCogsSourceRows({
    productRows,
    financeRows: [
      {
        companyName: "ИП Петров",
        sku: "B",
        quantity: 2,
        salesAmount: 20,
        totalAmount: 20,
        accrualDate: new Date("2026-10-19T00:00:00.000Z"),
      },
    ],
    authorityDays: [
      {
        companyName: owner.companyName,
        day: owner.day,
        complete: owner.complete,
      },
    ],
  });
  assert.ok(hybrid.some((r) => r.sku === "A"));
  assert.ok(hybrid.some((r) => r.sku === "B"));
  const cov = summarizeOzonCogsCoverage({
    productRows,
    financeRows: [],
    periodDays: ["2026-10-19"],
    authorityDays: [
      {
        companyName: owner.companyName,
        day: owner.day,
        complete: owner.complete,
      },
    ],
    companyName: "ИП Петров",
  });
  assert.equal(cov.quantityCoverageComplete, false);
}

// newer complete zero replaces older sale
{
  const owners = selectOzonAccrualDayOwners({
    sessions: [
      {
        id: "new-zero",
        companyName: "ИП Петров",
        status: "SUCCESS",
        createdAt: "2026-10-21T12:00:00.000Z",
        previewJson: {
          dateFrom: "2026-10-19",
          dateTo: "2026-10-19",
          requestedDates: ["2026-10-19"],
          coverageComplete: true,
          rawAccruals: [],
        },
      },
      {
        id: "old-sale",
        companyName: "ИП Петров",
        status: "SUCCESS",
        createdAt: "2026-10-20T12:00:00.000Z",
        previewJson: {
          dateFrom: "2026-10-19",
          dateTo: "2026-10-19",
          requestedDates: ["2026-10-19"],
          coverageComplete: true,
          rawAccruals: [
            {
              accrual_id: 123,
              date: "2026-10-19",
              posting: {
                products: [
                  {
                    sku: "A",
                    quantity: 1,
                    commission: {
                      sale_price: { amount: "100" },
                      sale_amount: { amount: "100" },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
    ],
    dateFrom: "2026-10-19",
    dateTo: "2026-10-19",
  });
  const owner = owners.get("ИП Петров|2026-10-19")!;
  assert.equal(owner.sessionId, "new-zero");
  assert.equal(owner.complete, true);
  assert.equal(owner.confirmedZeroProductSales, true);
  const raw = Array.isArray(owner.preview.rawAccruals)
    ? owner.preview.rawAccruals
    : [];
  assert.equal(raw.length, 0);
}

console.log("ozonAccrualSessionOwnership.test.ts OK");
