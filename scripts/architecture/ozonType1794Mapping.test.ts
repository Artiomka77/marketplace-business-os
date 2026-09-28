import assert from "node:assert/strict";
import test from "node:test";
import { mapOzonAccrualByDay } from "../../lib/ozon/accrualByDay";
import { planCanonicalOzonAccrualPersist } from "../../lib/ozon/accrualIngestValidation";

function money(amount: number) {
  return { amount: String(amount), currency: "RUB" };
}

test("type17 Drop-Off Agent maps to OZON_DELIVERY from posting.delivery.services", () => {
  const mapped = mapOzonAccrualByDay({
    accruals: [
      {
        accrual_id: 1,
        date: "2026-09-06",
        unit_number: "U1",
        posting: {
          delivery_schema: "Fbs",
          products: [
            {
              sku: 100,
              delivery: {
                services: [{ type_id: 17, accrued: money(-10) }],
              },
            },
          ],
        },
      },
    ],
  });
  const fact = mapped.facts.find((f) => f.sourceTypeId === 17);
  assert.ok(fact);
  assert.equal(fact?.category, "OZON_DELIVERY");
  assert.equal(mapped.diagnostics.unknownMeaningfulTypeIds.length, 0);
});

test("type94 DefectFineShipmentDelayRate maps to OZON_OTHER_SERVICES from non_item_fee", () => {
  const mapped = mapOzonAccrualByDay({
    accruals: [
      {
        accrual_id: 2,
        date: "2026-09-06",
        unit_number: "U2",
        non_item_fee: { type_id: 94, accrued: money(-79) },
      },
    ],
  });
  const fact = mapped.facts.find((f) => f.sourceTypeId === 94);
  assert.ok(fact);
  assert.equal(fact?.category, "OZON_OTHER_SERVICES");
  assert.equal(mapped.diagnostics.unknownMeaningfulTypeIds.length, 0);
});

test("future unknown type999999 remains hard fail-closed", () => {
  const mapped = mapOzonAccrualByDay({
    accruals: [
      {
        accrual_id: 3,
        date: "2026-09-06",
        unit_number: "U3",
        non_item_fee: { type_id: 999999, accrued: money(-1) },
      },
    ],
  });
  assert.ok(mapped.diagnostics.unknownMeaningfulTypeIds.some((u) => u.typeId === 999999));
  assert.throws(() =>
    planCanonicalOzonAccrualPersist({
      mapped,
      dateFrom: new Date("2026-09-06T00:00:00.000Z"),
      dateTo: new Date("2026-09-06T00:00:00.000Z"),
      requestedDates: ["2026-09-06"],
    }),
  );
});
