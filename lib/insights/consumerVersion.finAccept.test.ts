import assert from "node:assert/strict";
import test from "node:test";

import { buildLiveAccountResidualBridge } from "@/lib/insights/accountResidualBridge";
import { buildBridgeLayersFromPeriodTotals } from "@/lib/insights/bridgeLayersFromPeriodTotals";
import { selectCompatibleSkuMetrics } from "@/lib/insights/selectCompatibleSkuMetrics";
import {
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
} from "@/lib/profitReadModel/contract";

const basePeriods = [
  {
    marketplace: "WB",
    formulaVersion: FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
    dataMode: "FINAL",
    totals: {
      netProfitAfterTax: 60,
      undistributedAdsCost: 0,
      unallocatedStorageCost: 0,
      unallocatedLogisticsCost: 0,
      unallocatedAcceptanceCost: 0,
      unallocatedPenaltiesAmount: 0,
    },
  },
  {
    marketplace: "OZON",
    formulaVersion: FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
    dataMode: "FINAL",
    totals: {
      netProfitAfterTax: 40,
      unallocatedPartnerResidual: 0,
      unallocatedCommissionCost: 0,
      unallocatedLogisticsCost: 0,
      unallocatedDeductionsCost: 0,
    },
  },
];

test("compatible SKU generation keeps Wave-B rows and drops incompatible formula", () => {
  const rows = [
    {
      id: "a",
      marketplace: "OZON",
      formulaVersion: FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
      productKey: "sku-1",
    },
    {
      id: "b",
      marketplace: "OZON",
      formulaVersion: "INCOMPATIBLE_OLD_FORMULA",
      productKey: "sku-1",
    },
    {
      id: "c",
      marketplace: "WB",
      formulaVersion: FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
      productKey: "sku-2",
    },
  ];
  const { selected, rejectedIncompatible } = selectCompatibleSkuMetrics(rows);
  assert.equal(selected.length, 2);
  assert.equal(rejectedIncompatible, 1);
  assert.ok(selected.every((r) => r.formulaVersion !== "INCOMPATIBLE_OLD_FORMULA"));
});

test("missing account netProfitAfterTax on selected WB → unavailable (not RECONCILED)", () => {
  const periods = structuredClone(basePeriods);
  delete (periods[0].totals as { netProfitAfterTax?: number }).netProfitAfterTax;
  const layers = buildBridgeLayersFromPeriodTotals({
    companyScope: "ИП Петров",
    skuNetProfit: 40,
    periods,
    financeSignedImpact: 0,
    expectedMarketplaces: ["WB", "OZON"],
  });
  assert.equal(layers.rejectedReason, "MISSING_NET_PROFIT_AFTER_TAX_WB");
  assert.equal(layers.observedAccountMarketplaceProfit, null);
  const bridge = buildLiveAccountResidualBridge(layers);
  assert.equal(bridge, null);
});

test("known-zero netProfitAfterTax on both MPs stays RECONCILED/FINAL", () => {
  const periods = structuredClone(basePeriods);
  periods[0].totals.netProfitAfterTax = 0;
  periods[1].totals.netProfitAfterTax = 0;
  const layers = buildBridgeLayersFromPeriodTotals({
    companyScope: "ИП Петров",
    skuNetProfit: 0,
    periods,
    financeSignedImpact: 0,
  });
  assert.equal(layers.rejectedReason, null);
  assert.equal(layers.observedAccountMarketplaceProfit, 0);
  const bridge = buildLiveAccountResidualBridge(layers);
  assert.equal(bridge?.status, "RECONCILED");
  assert.equal(bridge?.finality, "FINAL");
});

test("positive baseline both nets present → RECONCILED observed 100", () => {
  const layers = buildBridgeLayersFromPeriodTotals({
    companyScope: "ИП Петров",
    skuNetProfit: 100,
    periods: basePeriods,
    financeSignedImpact: 0,
  });
  assert.equal(layers.rejectedReason, null);
  assert.equal(layers.observedAccountMarketplaceProfit, 100);
  const bridge = buildLiveAccountResidualBridge(layers);
  assert.equal(bridge?.status, "RECONCILED");
});
