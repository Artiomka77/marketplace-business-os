import assert from "node:assert/strict";
import test from "node:test";

import { mapOzonAccrualByDay } from "@/lib/ozon/accrualByDay";
import { planCanonicalOzonAccrualPersist } from "@/lib/ozon/accrualIngestValidation";
import { isOzonFinanciallyFinalStatus } from "@/lib/ozon/accrualIngestPolicy";

function moneyAccrual(params: {
  accrualId: number;
  date: string;
  typeId: number;
  accrued: number;
  totalAmount?: number;
  saleAmount?: number;
}) {
  return {
    accrual_id: params.accrualId,
    date: params.date,
    total_amount: params.totalAmount ?? 0,
    commission: {
      sale_amount: params.saleAmount ?? 0,
      amount: 0,
    },
    non_item_fee: {
      type_id: params.typeId,
      accrued: params.accrued,
    },
  };
}

test("type92 clear signed amount becomes OZON_OTHER_SERVICES once (FIN_OZON)", () => {
  const mapped = mapOzonAccrualByDay({
    accruals: [
      moneyAccrual({
        accrualId: 1,
        date: "2026-10-12",
        typeId: 92,
        accrued: -266.63,
        totalAmount: -266.63,
      }),
    ],
    accrualTypes: [{ id: 92, name: null, description: null }],
    requestedDates: ["2026-10-12"],
    dayEnvelopes: [
      {
        date: "2026-10-12",
        httpOk: true,
        pages: 1,
        paginationComplete: true,
        rawAccrualCount: 1,
        explicitZeroDayEvidence: false,
      },
    ],
  });

  assert.equal(mapped.diagnostics.unknownMeaningfulTypeIds.length, 0);
  assert.equal(mapped.diagnostics.unclassifiedAdjustments.length, 0);

  const otherFacts = mapped.facts.filter(
    (f) => f.category === "OZON_OTHER_SERVICES",
  );
  assert.equal(otherFacts.length, 1);
  // createFact stores positive expense for negative accrued charge
  assert.equal(otherFacts[0].amount, 266.63);
  assert.equal(otherFacts[0].sourceTypeId, 92);

  const plan = planCanonicalOzonAccrualPersist({
    mapped,
    dateFrom: new Date("2026-10-12T00:00:00.000Z"),
    dateTo: new Date("2026-10-12T00:00:00.000Z"),
    requestedDates: ["2026-10-12"],
  });
  assert.equal(plan.ingestPlan.status, "FINAL");
  assert.equal(plan.ingestPlan.failFinality, false);
  assert.equal(plan.ingestPlan.quarantine.length, 0);
  assert.equal(plan.ingestPlan.unclassifiedAdjustments.length, 0);
  assert.ok(isOzonFinanciallyFinalStatus(plan.ingestPlan.status));
});

test("future unknown typeId=999 negative clear signed => FINAL_WITH_UNCLASSIFIED", () => {
  const mapped = mapOzonAccrualByDay({
    accruals: [
      moneyAccrual({
        accrualId: 9,
        date: "2026-10-12",
        typeId: 999,
        accrued: -500,
        totalAmount: -500,
      }),
    ],
    accrualTypes: [{ id: 999, name: null, description: null }],
    requestedDates: ["2026-10-12"],
    dayEnvelopes: [
      {
        date: "2026-10-12",
        httpOk: true,
        pages: 1,
        paginationComplete: true,
        rawAccrualCount: 1,
        explicitZeroDayEvidence: false,
      },
    ],
  });
  assert.equal(mapped.diagnostics.unknownMeaningfulTypeIds.length, 0);
  assert.equal(mapped.facts.filter((f) => f.category === "OZON_UNCLASSIFIED_ADJUSTMENT").length, 1);
  const plan = planCanonicalOzonAccrualPersist({
    mapped,
    dateFrom: new Date("2026-10-12T00:00:00.000Z"),
    dateTo: new Date("2026-10-12T00:00:00.000Z"),
    requestedDates: ["2026-10-12"],
  });
  assert.equal(plan.ingestPlan.status, "FINAL_WITH_UNCLASSIFIED");
});

test("future unknown positive +500 is signed credit adjustment, not taxable", () => {
  const mapped = mapOzonAccrualByDay({
    accruals: [
      moneyAccrual({
        accrualId: 10,
        date: "2026-10-12",
        typeId: 998,
        accrued: 500,
        totalAmount: 500,
        saleAmount: 0,
      }),
    ],
    accrualTypes: [{ id: 998, name: null, description: null }],
    requestedDates: ["2026-10-12"],
    dayEnvelopes: [
      {
        date: "2026-10-12",
        httpOk: true,
        pages: 1,
        paginationComplete: true,
        rawAccrualCount: 1,
        explicitZeroDayEvidence: false,
      },
    ],
  });
  const fact = mapped.facts.find((f) => f.category === "OZON_UNCLASSIFIED_ADJUSTMENT");
  assert.ok(fact);
  // positive accrued => negative expense (credit) via createFact negation
  assert.equal(fact!.amount, -500);
  assert.equal(mapped.totals.taxableRevenue, 0);
});

test("duplicate unknown row is not double-counted in facts", () => {
  // Use still-unmapped typeId so OZON_UNCLASSIFIED_ADJUSTMENT path remains covered.
  const mapped = mapOzonAccrualByDay({
    accruals: [
      moneyAccrual({
        accrualId: 11,
        date: "2026-10-12",
        typeId: 991,
        accrued: -100,
        totalAmount: -100,
      }),
      moneyAccrual({
        accrualId: 12,
        date: "2026-10-12",
        typeId: 991,
        accrued: -100,
        totalAmount: -100,
      }),
    ],
    accrualTypes: [{ id: 991, name: null, description: null }],
    requestedDates: ["2026-10-12"],
    dayEnvelopes: [
      {
        date: "2026-10-12",
        httpOk: true,
        pages: 1,
        paginationComplete: true,
        rawAccrualCount: 2,
        explicitZeroDayEvidence: false,
      },
    ],
  });
  const facts = mapped.facts.filter((f) => f.category === "OZON_UNCLASSIFIED_ADJUSTMENT");
  assert.equal(facts.length, 2);
  assert.equal(
    Number(facts.reduce((s, f) => s + f.amount, 0).toFixed(2)),
    200,
  );
  assert.equal(mapped.diagnostics.unclassifiedAdjustments[0].rows, 2);
});
