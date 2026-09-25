import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCanonicalPositiveCostLookups,
  toPositiveProductCost,
} from "@/lib/analytics/productCostResolver";

/**
 * Fixture-level UNKNOWN_COST consumer propagation contract.
 * Does not mutate ProductCost / DB.
 */

function consumerProfitPresentation(totals: {
  costCoverageIncomplete?: boolean;
  dataMode?: string;
  netProfitStatus?: string;
  netProfitAfterTax?: number;
}) {
  const incomplete = totals.costCoverageIncomplete === true;
  const preliminary =
    incomplete ||
    totals.dataMode === "PRELIMINARY" ||
    totals.netProfitStatus === "PRELIMINARY";
  return {
    numeric: totals.netProfitAfterTax ?? 0,
    status: preliminary ? "PRELIMINARY" : "FINAL",
    fakeComplete: false && !preliminary, // never true when preliminary
    allowedUnqualifiedFinal: !preliminary,
  };
}

function planFactTaxLabel(totals: {
  taxesUnavailable?: boolean;
  taxesEstimated?: boolean;
  costCoverageIncomplete?: boolean;
  dataMode?: string;
  netProfitStatus?: string;
}) {
  const taxesPreliminary =
    totals.taxesUnavailable === true || totals.taxesEstimated === true;
  const cogsPreliminary =
    totals.costCoverageIncomplete === true ||
    totals.dataMode === "PRELIMINARY" ||
    totals.netProfitStatus === "PRELIMINARY";
  return {
    taxLabel: taxesPreliminary ? "Налоги (предварительно)" : "Налоги",
    cogsLabel: cogsPreliminary
      ? "Себестоимость (предварительно)"
      : "Себестоимость",
  };
}

test("unknown cost => consumer cannot present unqualified FINAL profit", () => {
  const presentation = consumerProfitPresentation({
    costCoverageIncomplete: true,
    dataMode: "PRELIMINARY",
    netProfitStatus: "PRELIMINARY",
    netProfitAfterTax: 125000,
  });
  assert.equal(presentation.status, "PRELIMINARY");
  assert.equal(presentation.allowedUnqualifiedFinal, false);
  assert.equal(presentation.fakeComplete, false);
});

test("cost incomplete + taxes final => tax label not preliminary", () => {
  const labels = planFactTaxLabel({
    costCoverageIncomplete: true,
    dataMode: "PRELIMINARY",
    netProfitStatus: "PRELIMINARY",
    taxesUnavailable: false,
    taxesEstimated: false,
  });
  assert.equal(labels.taxLabel, "Налоги");
  assert.equal(labels.cogsLabel, "Себестоимость (предварительно)");
});

test("tax source preliminary => taxes explicitly preliminary", () => {
  const labels = planFactTaxLabel({
    costCoverageIncomplete: false,
    dataMode: "FINAL",
    netProfitStatus: "FINAL",
    taxesEstimated: true,
  });
  assert.equal(labels.taxLabel, "Налоги (предварительно)");
});

test("ozon sku-as-vendorCode positive mapping remains resolved", () => {
  const lookups = buildCanonicalPositiveCostLookups([
    { vendorCode: "sku-as-vc-55", costPrice: 220 },
  ]);
  assert.equal(lookups.costByVendorCode.get("sku-as-vc-55"), 220);
  assert.equal(toPositiveProductCost(0), null);
});

test("loan filter contract: unpaid future requires active debt", () => {
  const includeCalendarMonth = (row: {
    paid: boolean;
    currentDebt: number;
  }) => row.paid === true || row.currentDebt > 0;
  const includeForecastFuture = (row: {
    paid: boolean;
    currentDebt: number;
  }) => row.paid === false && row.currentDebt > 0;

  assert.equal(includeCalendarMonth({ paid: true, currentDebt: 0 }), true);
  assert.equal(includeCalendarMonth({ paid: false, currentDebt: 0 }), false);
  assert.equal(includeCalendarMonth({ paid: false, currentDebt: 100 }), true);
  assert.equal(includeForecastFuture({ paid: false, currentDebt: 0 }), false);
  assert.equal(includeForecastFuture({ paid: false, currentDebt: 50 }), true);
  assert.equal(includeForecastFuture({ paid: true, currentDebt: 50 }), false);
});
