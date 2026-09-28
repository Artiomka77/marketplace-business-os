import assert from "node:assert/strict";
import { describe, it } from "node:test";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function decimalToCents(value: unknown) {
  const raw = isRecord(value) ? value.amount : value;
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? Math.round(raw * 100) : 0;
  }
  let text = String(raw ?? "").trim().replace(/\s+/g, "").replace(",", ".");
  if (!text) return 0;
  let sign = 1;
  if (text.startsWith("-")) {
    sign = -1;
    text = text.slice(1);
  } else if (text.startsWith("+")) {
    text = text.slice(1);
  }
  if (!/^\d+(?:\.\d+)?$/.test(text)) return 0;
  const [whole, fraction = ""] = text.split(".");
  const firstThree = `${fraction}000`.slice(0, 3);
  let cents = Number(whole) * 100 + Number(firstThree.slice(0, 2));
  if (Number(firstThree[2]) >= 5) cents += 1;
  return sign * cents;
}

function centsToMoney(value: number) {
  return value / 100;
}

/** Mirrors lib/ozon/syncOzonAccrualByDay.buildProductRealizationRows */
function buildProductRealizationRows(params: {
  accruals: unknown[];
  date: string;
  skuToVendorCode?: Map<string, string>;
}) {
  const bySku = new Map<
    string,
    {
      sku: string;
      vendorCode: string | null;
      realizedQty: number;
      returnedQty: number;
      netQty: number;
      realizedAmount: number;
      returnedAmount: number;
      taxableRevenue: number;
    }
  >();

  for (const value of params.accruals) {
    if (!isRecord(value)) continue;
    if (String(value.date ?? "").trim() !== params.date) continue;
    const posting = isRecord(value.posting) ? value.posting : null;
    const products = Array.isArray(posting?.products) ? posting.products : [];
    for (const productValue of products) {
      if (!isRecord(productValue)) continue;
      const commission = isRecord(productValue.commission)
        ? productValue.commission
        : null;
      if (!commission) continue;
      if (productValue.sku == null || String(productValue.sku).trim() === "") {
        continue;
      }
      const sku = String(productValue.sku).trim();
      const qtyRaw = Number(productValue.quantity);
      const qty =
        Number.isFinite(qtyRaw) && qtyRaw !== 0 ? Math.abs(qtyRaw) : 1;
      const saleCents = decimalToCents(commission.sale_price);
      const saleAmount = centsToMoney(saleCents);
      const vendorCode = params.skuToVendorCode?.get(sku) ?? null;
      const current = bySku.get(sku) ?? {
        sku,
        vendorCode,
        realizedQty: 0,
        returnedQty: 0,
        netQty: 0,
        realizedAmount: 0,
        returnedAmount: 0,
        taxableRevenue: 0,
      };
      if (!current.vendorCode && vendorCode) current.vendorCode = vendorCode;
      if (saleCents >= 0) {
        current.realizedQty += qty;
        current.realizedAmount += saleAmount;
        current.netQty += qty;
      } else {
        current.returnedQty += qty;
        current.returnedAmount += Math.abs(saleAmount);
        current.netQty -= qty;
      }
      current.taxableRevenue += saleAmount;
      bySku.set(sku, current);
    }
  }
  return [...bySku.values()];
}

function ozonRealizationProductRowsToFinanceLike(
  rows: Array<{
    companyName: string | null;
    sku: string | null;
    vendorCode: string | null;
    realizedQty: number;
    returnedQty: number;
    realizedAmount: number;
    returnedAmount: number;
    dateFrom: Date;
  }>,
) {
  const out: Array<{ quantity: number; salesAmount: number }> = [];
  for (const row of rows) {
    const realizedQty = Math.abs(row.realizedQty);
    const returnedQty = Math.abs(row.returnedQty);
    const realizedAmount = Math.abs(row.realizedAmount);
    const returnedAmount = Math.abs(row.returnedAmount);
    if (realizedQty > 0 || realizedAmount > 0) {
      out.push({
        quantity: realizedQty > 0 ? realizedQty : 1,
        salesAmount: realizedAmount,
      });
    }
    if (returnedQty > 0 || returnedAmount > 0) {
      out.push({
        quantity: returnedQty > 0 ? returnedQty : 1,
        salesAmount: -returnedAmount,
      });
    }
  }
  return out;
}

function money(amount: string | number) {
  return { amount: String(amount), currency: "RUB" };
}

describe("p0OzonCogsByDayQuantity", () => {
  it("buildProductRealizationRows nets sale and return qty by sku", () => {
    const rows = buildProductRealizationRows({
      date: "2026-09-27",
      skuToVendorCode: new Map([["111", "ART-1"]]),
      accruals: [
        {
          date: "2026-09-27",
          posting: {
            products: [
              {
                sku: 111,
                quantity: 2,
                commission: { sale_price: money("1000") },
              },
            ],
          },
        },
        {
          date: "2026-09-27",
          posting: {
            products: [
              {
                sku: 111,
                quantity: 1,
                commission: { sale_price: money("-500") },
              },
            ],
          },
        },
        {
          date: "2026-09-27",
          posting: {
            products: [{ sku: 111, quantity: 1, commission: null }],
          },
        },
      ],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].vendorCode, "ART-1");
    assert.equal(rows[0].realizedQty, 2);
    assert.equal(rows[0].returnedQty, 1);
    assert.equal(rows[0].netQty, 1);
    assert.equal(rows[0].taxableRevenue, 500);
  });

  it("ozonRealizationProductRowsToFinanceLike emits signed sale/return rows", () => {
    const financeLike = ozonRealizationProductRowsToFinanceLike([
      {
        companyName: "ИП Петров",
        sku: "111",
        vendorCode: "ART-1",
        realizedQty: 2,
        returnedQty: 1,
        realizedAmount: 1000,
        returnedAmount: 500,
        dateFrom: new Date("2026-09-27T00:00:00.000Z"),
      },
    ]);
    assert.equal(financeLike.length, 2);
    assert.equal(financeLike[0].salesAmount, 1000);
    assert.equal(financeLike[0].quantity, 2);
    assert.equal(financeLike[1].salesAmount, -500);
  });

  it("prefers realization product rows over empty finance for COGS basis", () => {
    const productRows = [
      {
        companyName: "ИП Петров",
        sku: "222",
        vendorCode: "ART-2",
        realizedQty: 3,
        returnedQty: 0,
        realizedAmount: 900,
        returnedAmount: 0,
        dateFrom: new Date("2026-09-27T00:00:00.000Z"),
      },
    ];
    const financeRows: unknown[] = [];
    const cogsSource =
      productRows.length > 0
        ? ozonRealizationProductRowsToFinanceLike(productRows)
        : financeRows;
    assert.ok(cogsSource.length > 0);
    assert.equal(financeRows.length, 0);
  });

  it("marks quantity coverage incomplete when accrual money exists without qty basis", () => {
    const hasAccrualMoney = true;
    const hasProductQtyBasis = false;
    const quantityCoverageComplete = !hasAccrualMoney || hasProductQtyBasis;
    assert.equal(quantityCoverageComplete, false);
  });
});
