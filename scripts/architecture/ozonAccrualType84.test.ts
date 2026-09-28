import assert from "node:assert/strict";
import test from "node:test";

import { mapOzonAccrualByDay } from "../../lib/ozon/accrualByDay";

const TYPE84_NAME = "ItemPacking";
const TYPE84_DESC = "Дополнительная упаковка на складе Ozon";
const TYPE84_TYPES = [
  {
    id: 84,
    name: TYPE84_NAME,
    description: TYPE84_DESC,
  },
];

function type84Accrual(accrualId: number, date: string, accrued: number) {
  return {
    accrual_id: accrualId,
    date,
    total_amount: accrued,
    non_item_fee: {
      type_id: 84,
      accrued,
    },
  };
}

function canonicalExpense(sourceAccrued: number) {
  return -sourceAccrued;
}

test("typeId 84 maps explicitly to OZON_FBO as ItemPacking warehouse packing", () => {
  const mapped = mapOzonAccrualByDay({
    accruals: [type84Accrual(84001, "2026-07-11", -15)],
    accrualTypes: TYPE84_TYPES,
  });

  const type84 = mapped.facts.filter((fact) => fact.sourceTypeId === 84);
  assert.equal(type84.length, 1);
  assert.equal(type84[0]?.category, "OZON_FBO");
  assert.equal(type84[0]?.sourceTypeName, TYPE84_NAME);
  assert.equal(type84[0]?.includeInProfit, true);
  assert.equal(type84[0]?.isCashFlowOnly, false);
  assert.equal(type84[0]?.isCompensation, false);
  assert.ok(Math.abs((type84[0]?.amount ?? 0) - canonicalExpense(-15)) < 0.011);
  assert.equal(
    mapped.diagnostics.unknownMeaningfulTypeIds.some((item) => item.typeId === 84),
    false
  );
  assert.equal(mapped.mapperComplete, true);
});

test("typeId 84 amount is dynamic source amount for two different charges", () => {
  const a = -15;
  const b = -30;
  const mapped = mapOzonAccrualByDay({
    accruals: [
      type84Accrual(84011, "2026-07-11", a),
      type84Accrual(84006, "2026-07-06", b),
    ],
    accrualTypes: TYPE84_TYPES,
  });

  const facts = mapped.facts.filter((fact) => fact.sourceTypeId === 84);
  assert.equal(facts.length, 2);
  const amounts = facts.map((f) => f.amount).sort((x, y) => x - y);
  assert.ok(Math.abs(amounts[0]! - canonicalExpense(a)) < 0.011);
  assert.ok(Math.abs(amounts[1]! - canonicalExpense(b)) < 0.011);
  assert.notEqual(amounts[0], amounts[1]);
  assert.equal(mapped.mapperComplete, true);
});

test("typeId 84 preserves canonical expense sign from Ozon source amount", () => {
  const sourceAccrued = -15;
  const mapped = mapOzonAccrualByDay({
    accruals: [type84Accrual(84015, "2026-07-14", sourceAccrued)],
    accrualTypes: TYPE84_TYPES,
  });
  const fact = mapped.facts.find((item) => item.sourceTypeId === 84);
  assert.ok(fact);
  assert.ok((fact?.amount ?? 0) > 0, "canonical FBO expense must be a positive P&L reduction");
  assert.equal(Math.sign(fact?.amount ?? 0), -Math.sign(sourceAccrued));
  assert.ok(Math.abs((fact?.amount ?? 0) - canonicalExpense(sourceAccrued)) < 0.011);
});

test("unknown meaningful Ozon typeIds still fail closed after type84 mapping", () => {
  const mapped = mapOzonAccrualByDay({
    accruals: [
      {
        accrual_id: 99084,
        date: "2026-07-11",
        total_amount: -100,
        non_item_fee: {
          type_id: 9999,
          accrued: -100,
        },
      },
    ],
    accrualTypes: [{ id: 9999, name: "Unknown future service", description: null }],
  });

  assert.equal(mapped.mapperComplete, false);
  assert.equal(mapped.facts.some((fact) => fact.sourceTypeId === 9999), false);
  const unknown = mapped.diagnostics.unknownMeaningfulTypeIds.find(
    (item) => item.typeId === 9999
  );
  assert.ok(unknown);
});
