import assert from "node:assert/strict";
import test from "node:test";

import { mapOzonAccrualByDay } from "../../lib/ozon/accrualByDay";

const TYPE76_NAME = "Страхование товара от массовых повреждений";
const TYPE76_TYPES = [
  {
    id: 76,
    name: TYPE76_NAME,
    description: "Страховка товаров / product insurance",
  },
];

function type76Accrual(accrualId: number, date: string, accrued: number) {
  return {
    accrual_id: accrualId,
    date,
    total_amount: accrued,
    non_item_fee: {
      type_id: 76,
      accrued,
    },
  };
}

function canonicalExpense(sourceAccrued: number) {
  return -sourceAccrued;
}

test("typeId 76 maps explicitly to OZON_OTHER_SERVICES as product insurance", () => {
  const mapped = mapOzonAccrualByDay({
    accruals: [type76Accrual(76001, "2026-08-23", -1911.55)],
    accrualTypes: TYPE76_TYPES,
  });

  const type76 = mapped.facts.filter((fact) => fact.sourceTypeId === 76);
  assert.equal(type76.length, 1);
  assert.equal(type76[0]?.category, "OZON_OTHER_SERVICES");
  assert.equal(type76[0]?.sourceTypeName, TYPE76_NAME);
  assert.equal(type76[0]?.includeInProfit, true);
  assert.equal(type76[0]?.isCashFlowOnly, false);
  assert.equal(type76[0]?.isCompensation, false);
  assert.ok(Math.abs((type76[0]?.amount ?? 0) - canonicalExpense(-1911.55)) < 0.011);
  assert.equal(
    mapped.diagnostics.unknownMeaningfulTypeIds.some((item) => item.typeId === 76),
    false
  );
});

test("typeId 76 amount is dynamic source amount, not a hardcoded premium", () => {
  // 23.08 historical raw/API/Excel fixture (UI rounded this day to 1,912 RUB).
  const historicalRaw = -1911.55;
  // Distinct second source amount: 24.08 Insurance page UI premium 1,918 RUB.
  // Used only as a dynamic-handling fixture, not as a formula or hardcoded mapper constant.
  const laterSource = -1918;

  const mapped = mapOzonAccrualByDay({
    accruals: [
      type76Accrual(76023, "2026-08-23", historicalRaw),
      type76Accrual(76024, "2026-08-24", laterSource),
    ],
    accrualTypes: TYPE76_TYPES,
  });

  const byDate = new Map(
    mapped.facts
      .filter((fact) => fact.sourceTypeId === 76)
      .map((fact) => [fact.date, fact])
  );

  assert.equal(byDate.size, 2);

  const first = byDate.get("2026-08-23");
  const second = byDate.get("2026-08-24");
  assert.ok(first);
  assert.ok(second);

  assert.equal(first?.category, "OZON_OTHER_SERVICES");
  assert.equal(second?.category, "OZON_OTHER_SERVICES");
  assert.ok(Math.abs((first?.amount ?? 0) - canonicalExpense(historicalRaw)) < 0.011);
  assert.ok(Math.abs((second?.amount ?? 0) - canonicalExpense(laterSource)) < 0.011);
  assert.notEqual(first?.amount, second?.amount);

  for (const fact of [first, second]) {
    assert.notEqual(fact?.category, "OZON_ADVERTISING");
    assert.notEqual(fact?.category, "OZON_COMMISSION");
    assert.notEqual(fact?.category, "OZON_DELIVERY");
    assert.notEqual(fact?.category, "OZON_FBO");
    assert.equal(fact?.includeInProfit, true);
  }

  const otherServices = mapped.totals.categoryAmounts.OZON_OTHER_SERVICES ?? 0;
  assert.ok(
    Math.abs(
      otherServices -
        (canonicalExpense(historicalRaw) + canonicalExpense(laterSource))
    ) < 0.011
  );
});

test("typeId 76 preserves canonical expense sign from the Ozon source amount", () => {
  const sourceAccrued = -1911.55;
  const mapped = mapOzonAccrualByDay({
    accruals: [type76Accrual(76076, "2026-08-23", sourceAccrued)],
    accrualTypes: TYPE76_TYPES,
  });
  const fact = mapped.facts.find((item) => item.sourceTypeId === 76);
  assert.ok(fact);
  assert.ok((fact?.amount ?? 0) > 0, "canonical OTHER_SERVICES expense must be a positive P&L reduction");
  assert.equal(Math.sign(fact?.amount ?? 0), -Math.sign(sourceAccrued));
  assert.ok(Math.abs((fact?.amount ?? 0) - canonicalExpense(sourceAccrued)) < 0.011);
  assert.notEqual(fact?.amount, sourceAccrued);
});

test("unknown meaningful Ozon typeIds still fail closed", () => {
  const mapped = mapOzonAccrualByDay({
    accruals: [
      {
        accrual_id: 99001,
        date: "2026-08-23",
        total_amount: -100,
        non_item_fee: {
          type_id: 9999,
          accrued: -100,
        },
      },
    ],
    accrualTypes: [{ id: 9999, name: "Unknown future service", description: null }],
  });

  assert.equal(mapped.coverageComplete, false);
  assert.equal(mapped.facts.some((fact) => fact.sourceTypeId === 9999), false);
  const unknown = mapped.diagnostics.unknownMeaningfulTypeIds.find(
    (item) => item.typeId === 9999
  );
  assert.ok(unknown);
  assert.equal(unknown?.name, "Unknown future service");
});
