import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOzonFinancialCategoryFactsToTotalsForTest,
  calculateOzonGrossExpensesForTest,
  calculateOzonNetExpensesAfterDiscountPointsForTest,
  resolveOzonNetExpensesForDisplayForTest,
  resolveOzonDiscountPointsAmountForTest,
  OZON_NET_EXPENSES_REPRESENTATION_G_MINUS_B_FOR_TEST,
} from "@/lib/analytics/profitAnalyticsOzon.testExports";

test("known zero net points stays zero (no fallback to accrued/writtenOff)", () => {
  const b = resolveOzonDiscountPointsAmountForTest({
    pointsAccrued: 10,
    pointsWrittenOff: 10,
    totalPaidByPoints: 0,
  });
  assert.equal(b, 0);
});

test("absent net falls back to accrued − writtenOff only when both present", () => {
  const b = resolveOzonDiscountPointsAmountForTest({
    pointsAccrued: 100,
    pointsWrittenOff: 40,
  });
  assert.equal(b, 60);
});

test("lone pointsAccrued without returns/net is missing not gross", () => {
  const b = resolveOzonDiscountPointsAmountForTest({
    pointsAccrued: 100,
  });
  assert.equal(Number.isFinite(b), false);
});

test("negative net points preserved", () => {
  const b = resolveOzonDiscountPointsAmountForTest({
    totalPaidByPoints: -25.5,
    pointsAccrued: 10,
    pointsWrittenOff: 0,
  });
  assert.equal(b, -25.5);
});

test("four unclassified Petrov facts enter G exactly once (+893)", () => {
  // Named categories only (FIN_MATCH candidate G); compensation fact is signed
  // expense representation (−4348.5 → deductions += 4348.5 via partner+other−comp).
  const factsNamed = [
    { category: "OZON_COMMISSION", amount: 4_382_028.7, sourceOperationCode: "SaleCommission" },
    { category: "OZON_DELIVERY", amount: 437_198.74, sourceOperationCode: "TYPE_59" },
    { category: "OZON_FBO", amount: 89_928.95, sourceOperationCode: "TYPE_12" },
    {
      category: "OZON_ADVERTISING",
      amount: 1_322_951.24,
      sourceOperationCode: "OperationMarketplaceCostPerClick",
    },
    {
      category: "OZON_PARTNER_SERVICES",
      amount: 201_562.49,
      sourceOperationCode: "TYPE_45",
    },
    { category: "OZON_OTHER_SERVICES", amount: 2_955.0, sourceOperationCode: "TYPE_15" },
    { category: "OZON_COMPENSATION", amount: -4_348.5, sourceOperationCode: "TYPE_25" },
  ];
  const lost = [
    {
      category: "OZON_UNCLASSIFIED_ADJUSTMENT",
      amount: 450,
      sourceOperationCode: "TYPE_92",
      sourceServiceName: "66877530425:NON_ITEM_FEE:92:0",
    },
    {
      category: "OZON_UNCLASSIFIED_ADJUSTMENT",
      amount: 423,
      sourceOperationCode: "TYPE_92",
      sourceServiceName: "67491750476:NON_ITEM_FEE:92:0",
    },
    {
      category: "OZON_UNCLASSIFIED_ADJUSTMENT",
      amount: 10,
      sourceOperationCode: "TYPE_16",
      sourceServiceName: "67243203479:POSTING_DELIVERY:16:1:5954387889",
    },
    {
      category: "OZON_UNCLASSIFIED_ADJUSTMENT",
      amount: 10,
      sourceOperationCode: "TYPE_16",
      sourceServiceName: "67401702566:POSTING_DELIVERY:16:1:1967224708",
    },
  ];

  const empty = {
    wbCommission: 0,
    logisticsCost: 0,
    deliveryCost: 0,
    fboCost: 0,
    adsCost: 0,
    penaltiesAmount: 0,
    deductions: 0,
    partnerServicesCost: 0,
    otherServicesCost: 0,
    compensationAmount: 0,
    excludedLoansFactoringAmount: 0,
    clickAdsCost: 0,
    orderAdsCost: 0,
    otherAdsCost: 0,
  };

  const base = { ...empty };
  assert.equal(applyOzonFinancialCategoryFactsToTotalsForTest(base, factsNamed), true);
  const gBefore = calculateOzonGrossExpensesForTest(base);

  const withLost = { ...empty };
  assert.equal(
    applyOzonFinancialCategoryFactsToTotalsForTest(withLost, [...factsNamed, ...lost]),
    true,
  );
  const gAfter = calculateOzonGrossExpensesForTest(withLost);

  assert.ok(
    Math.abs(gAfter - gBefore - 893) < 0.02,
    `expected G delta +893, got ${gAfter - gBefore}`,
  );
  assert.ok(
    Math.abs(gAfter - 6_441_866.62) < 0.02,
    `expected G 6441866.62, got ${gAfter}`,
  );
  assert.equal(
    (withLost as { unclassifiedAdjustmentCost?: number }).unclassifiedAdjustmentCost,
    893,
  );
});

test("excluded / empty category does not invent expense", () => {
  const totals = {
    wbCommission: 100,
    logisticsCost: 0,
    deliveryCost: 0,
    fboCost: 0,
    adsCost: 0,
    penaltiesAmount: 0,
    deductions: 0,
    partnerServicesCost: 0,
    otherServicesCost: 0,
    compensationAmount: 0,
    excludedLoansFactoringAmount: 0,
    clickAdsCost: 0,
    orderAdsCost: 0,
    otherAdsCost: 0,
  };
  const before = calculateOzonGrossExpensesForTest(totals);
  applyOzonFinancialCategoryFactsToTotalsForTest(totals, [
    {
      category: "EXCLUDED_LOANS_FACTORING",
      amount: 999,
      sourceOperationCode: "LOAN",
    },
    { category: "", amount: 50, sourceOperationCode: "X" },
  ]);
  const after = calculateOzonGrossExpensesForTest(totals);
  assert.equal(after, before);
});

test("N = G − B − A for Petrov week control; profit identity holds", () => {
  const G = 6_441_866.62;
  const B = 6_247_655.76;
  const A = 23_352.69;
  const R = 2_310_201.55;
  const K = 1_141_195.0;
  const T = 132_011.52;
  const E = R + B + A;
  const N = calculateOzonNetExpensesAfterDiscountPointsForTest({
    grossOzonExpenses: G,
    discountPointsCompensation: B,
    partnerProgramsAmount: A,
  });
  assert.equal(Number(N.toFixed(2)), 170_858.17);
  const profitViaEG = E - G - K - T;
  const profitViaRN = R - N - K - T;
  assert.equal(Number(profitViaEG.toFixed(2)), 866_136.86);
  assert.equal(Number(profitViaRN.toFixed(2)), 866_136.86);
  // Forbidden double-count forms must differ from accepted profit
  assert.notEqual(Number((R + A - N - K - T).toFixed(2)), 866_136.86);
  assert.notEqual(Number((E - N - K - T).toFixed(2)), 866_136.86);
});

test("ALL N = G − B − A control", () => {
  const N = calculateOzonNetExpensesAfterDiscountPointsForTest({
    grossOzonExpenses: 6_515_114.7,
    discountPointsCompensation: 6_317_501.64,
    partnerProgramsAmount: 23_664.42,
  });
  assert.equal(Number(N.toFixed(2)), 173_948.64);
});

test("legacy stored G−B net is not silently treated as G−B−A", () => {
  const legacyNet = 194_210.86; // G−B only
  const A = 23_352.69;
  const fromLegacy = resolveOzonNetExpensesForDisplayForTest({
    netOzonExpenses: legacyNet,
    partnerProgramsAmount: A,
    netOzonExpensesRepresentation: OZON_NET_EXPENSES_REPRESENTATION_G_MINUS_B_FOR_TEST,
  });
  assert.equal(Number(fromLegacy.toFixed(2)), 170_858.17);
  const fromComponents = resolveOzonNetExpensesForDisplayForTest({
    grossOzonExpenses: 6_441_866.62,
    discountPointsCompensation: 6_247_655.76,
    partnerProgramsAmount: A,
    netOzonExpenses: legacyNet,
    netOzonExpensesRepresentation: OZON_NET_EXPENSES_REPRESENTATION_G_MINUS_B_FOR_TEST,
  });
  assert.equal(Number(fromComponents.toFixed(2)), 170_858.17);
});

test("zero and negative A/B preserved in N", () => {
  assert.equal(
    calculateOzonNetExpensesAfterDiscountPointsForTest({
      grossOzonExpenses: 100,
      discountPointsCompensation: 0,
      partnerProgramsAmount: 0,
    }),
    100,
  );
  assert.equal(
    calculateOzonNetExpensesAfterDiscountPointsForTest({
      grossOzonExpenses: 100,
      discountPointsCompensation: -10,
      partnerProgramsAmount: -5,
    }),
    115,
  );
});
