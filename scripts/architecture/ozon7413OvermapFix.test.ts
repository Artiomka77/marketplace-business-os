import assert from "node:assert/strict";
import test from "node:test";
import { mapOzonAccrualByDay } from "../../lib/ozon/accrualByDay";

function money(amount: number | string) {
  return { amount: String(amount), currency: "RUB" };
}

test("7413 overmap: seller_price understatement vs sale_amount does not inflate grossExpenseDifference", () => {
  // Minimal reproduction of Petrov 2026-09-06 anomalous commission row:
  // seller_price=7413, sale_amount=sale_price+bonus=14826, commission_ratio on sale_amount.
  const mapped = mapOzonAccrualByDay({
    accruals: [
      {
        accrual_id: 900001,
        date: "2026-09-06",
        total_amount: money(6900.6),
        posting: {
          products: [
            {
              sku: 1,
              commission: {
                seller_price: money(7413),
                sale_price: money(5320.98),
                bonus: money(9505.02),
                coinvestment: money(0),
                sale_amount: money(14826),
                commission: money(-7709.52),
                sale_commission: money(-7709.52),
                commission_ratio: 'value:"0.520000"',
              },
              delivery: {
                services: [{ type_id: 29, accrued: money(-215.88) }],
              },
            },
          ],
        },
      },
    ],
  });

  assert.equal(mapped.totals.economicTurnover, 14826);
  assert.equal(mapped.totals.taxableRevenue, 5320.98);
  assert.equal(mapped.totals.discountPointsAmount, 9505.02);
  assert.equal(mapped.totals.grossOzonExpenses, 7925.4);
  assert.ok(Math.abs(mapped.diagnostics.grossExpenseDifference) < 0.01);
  assert.equal(mapped.diagnostics.unknownMeaningfulTypeIds.length, 0);
  assert.equal(mapped.coverageComplete, true);
  // Expense economics unchanged: commission + delivery
  assert.equal(mapped.totals.categoryAmounts.OZON_COMMISSION, 7709.52);
  assert.equal(mapped.totals.categoryAmounts.OZON_DELIVERY, 215.88);
});

test("7413: without sale_amount, turnover reconstructs from sale_price+bonus+coinvestment", () => {
  const mapped = mapOzonAccrualByDay({
    accruals: [
      {
        accrual_id: 900002,
        date: "2026-09-06",
        total_amount: money(80),
        posting: {
          products: [
            {
              sku: 2,
              commission: {
                seller_price: money(50), // intentionally wrong / divergent
                sale_price: money(90),
                bonus: money(10),
                coinvestment: money(0),
                commission: money(-20),
              },
            },
          ],
        },
      },
    ],
  });
  assert.equal(mapped.totals.economicTurnover, 100);
  assert.ok(Math.abs(mapped.diagnostics.grossExpenseDifference) < 0.01);
});

test("7413: normal row where seller_price equals sale_amount stays reconciled", () => {
  const mapped = mapOzonAccrualByDay({
    accruals: [
      {
        accrual_id: 900003,
        date: "2026-09-06",
        total_amount: money(70),
        posting: {
          products: [
            {
              sku: 3,
              commission: {
                seller_price: money(100),
                sale_amount: money(100),
                sale_price: money(80),
                bonus: money(20),
                coinvestment: money(0),
                commission: money(-30),
              },
            },
          ],
        },
      },
    ],
  });
  assert.equal(mapped.totals.economicTurnover, 100);
  assert.equal(mapped.totals.grossOzonExpenses, 30);
  assert.ok(Math.abs(mapped.diagnostics.grossExpenseDifference) < 0.01);
});
