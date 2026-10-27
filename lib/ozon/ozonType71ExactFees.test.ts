import assert from "node:assert/strict";
import test from "node:test";

import { extractOzonExactSkuFeesFromRaw } from "@/lib/ozon/ozonAccrualExactSkuFees";
import { resolveOzonType71Categories } from "@/lib/ozon/ozonAccrualTypeCategory";

test("TYPE71 pair: lower accrualId → FBO, higher → DELIVERY", () => {
  const map = resolveOzonType71Categories([
    { accrualId: 67019961336, ordinal: 0, groupKey: "2026-10-21\u001fsr01\u001f3764617558" },
    { accrualId: 67019961337, ordinal: 1, groupKey: "2026-10-21\u001fsr01\u001f3764617558" },
  ]);
  assert.equal(map.get("67019961336:0"), "OZON_FBO");
  assert.equal(map.get("67019961337:1"), "OZON_DELIVERY");
});

test("exact fee ledger applies TYPE71 pair to SKU logistics (+64)", () => {
  const ledger = extractOzonExactSkuFeesFromRaw({
    rawAccruals: [
      {
        accrual_id: 67019961336,
        date: "2026-10-21",
        unit_number: "sr01-bx20265479003",
        item_fees: {
          fees: [
            {
              sku: "3764617558",
              fees: [{ type_id: 71, accrued: -28 }],
            },
          ],
        },
      },
      {
        accrual_id: 67019961337,
        date: "2026-10-21",
        unit_number: "sr01-bx20265479003",
        item_fees: {
          fees: [
            {
              sku: "3764617558",
              fees: [{ type_id: 71, accrued: -36 }],
            },
          ],
        },
      },
    ],
  });
  const bucket = ledger.bySku.get("3764617558");
  assert.ok(bucket);
  assert.ok(Math.abs(bucket!.logistics - 64) < 0.02, `logistics=${bucket!.logistics}`);
  assert.ok(Math.abs(ledger.accountResidual.unclassified) < 0.02);
});
