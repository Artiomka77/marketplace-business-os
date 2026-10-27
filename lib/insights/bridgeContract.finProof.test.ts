import assert from "node:assert/strict";
import test from "node:test";

import {
  FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1,
  FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1,
} from "@/lib/profitReadModel/contract";
import { buildLiveAccountResidualBridge } from "@/lib/insights/accountResidualBridge";
import { buildBridgeLayersFromPeriodTotals } from "@/lib/insights/bridgeLayersFromPeriodTotals";

const WB = FINANCIAL_CORE_V6_PROFIT_WB_READMODEL_V1;
const OZ = FINANCIAL_CORE_V6_PROFIT_OZON_READMODEL_V1;

const base = () => [
  {
    marketplace: "WB",
    formulaVersion: WB,
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
    formulaVersion: OZ,
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

function run(periods: ReturnType<typeof base>, sku = 100) {
  const layers = buildBridgeLayersFromPeriodTotals({
    companyScope: "ИП Петров",
    skuNetProfit: sku,
    periods,
    financeSignedImpact: 0,
    expectedMarketplaces: ["WB", "OZON"],
  });
  return { layers, bridge: buildLiveAccountResidualBridge(layers) };
}

test("known-zero residuals stay RECONCILED", () => {
  const { bridge } = run(base());
  assert.equal(bridge?.status, "RECONCILED");
  assert.equal(bridge?.finality, "FINAL");
});

test("null WB storage / Ozon logistics → unavailable bridge", () => {
  const periods = base();
  periods[0].totals.unallocatedStorageCost = null as never;
  periods[1].totals.unallocatedLogisticsCost = null as never;
  const { bridge, layers } = run(periods);
  assert.equal(layers.wbStorage, null);
  assert.equal(layers.ozonUnallocatedExpenses, null);
  assert.equal(bridge, null);
});

test("partial Ozon residuals (only commission present) → unavailable", () => {
  const periods = base();
  delete (periods[1].totals as { unallocatedLogisticsCost?: number })
    .unallocatedLogisticsCost;
  delete (periods[1].totals as { unallocatedDeductionsCost?: number })
    .unallocatedDeductionsCost;
  const { bridge, layers } = run(periods);
  assert.equal(layers.ozonUnallocatedExpenses, null);
  assert.equal(bridge, null);
});

test("empty-string residual → unavailable", () => {
  const periods = base();
  (periods[0].totals as { unallocatedStorageCost: unknown }).unallocatedStorageCost =
    "";
  const { bridge, layers } = run(periods);
  assert.equal(layers.wbStorage, null);
  assert.equal(bridge, null);
});

test("missing formulaVersion → reject / no FINAL", () => {
  const periods = base();
  for (const p of periods) delete (p as { formulaVersion?: string }).formulaVersion;
  const { layers, bridge } = run(periods);
  assert.ok(layers.rejectedReason);
  assert.equal(bridge, null);
});

test("missing WB dataMode cannot stay FINAL", () => {
  const periods = base();
  delete (periods[0] as { dataMode?: string }).dataMode;
  const { layers } = run(periods);
  assert.equal(layers.finality, "PRELIMINARY");
});

test("missing expected WB period → unavailable (not silent zero)", () => {
  const { layers, bridge } = run([base()[1]], 40);
  assert.equal(layers.wbUnallocatedAds, null);
  assert.equal(layers.wbStorage, null);
  assert.equal(bridge, null);
});
