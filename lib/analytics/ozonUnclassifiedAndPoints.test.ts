import assert from "node:assert/strict";
import test from "node:test";

import {
  applyOzonFinancialCategoryFactsToTotalsForTest,
  calculateOzonGrossExpensesForTest,
  resolveOzonDiscountPointsAmountForTest,
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
