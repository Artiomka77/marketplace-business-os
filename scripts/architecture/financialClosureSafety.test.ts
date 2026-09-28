import assert from "node:assert/strict";
import test from "node:test";

import {
  financialDynamicsMayShowNumericClaim,
  marketplaceManagementRevenue,
  rollUpPlanFactMarketplace,
  sanitizeLegacyCompanyFinancialRow,
  snapshotCombinedProfit,
} from "../../lib/dashboard/managementRevenue";

test("missing marketplace metrics are unavailable, not zero", () => {
  assert.equal(marketplaceManagementRevenue(undefined), null);
  assert.equal(marketplaceManagementRevenue(null), null);
  assert.equal(
    marketplaceManagementRevenue({ financialUnavailable: true, salesAmount: 0 }),
    null
  );
  assert.equal(
    marketplaceManagementRevenue({ economicTurnover: 0, salesAmount: 0 }),
    0
  );
  assert.equal(
    marketplaceManagementRevenue({ economicTurnover: 64190278.77, salesAmount: 64190278.77 }),
    64190278.77
  );
});

test("legacy July/August V2 company row does not present Ozon zero or WB-only profit", () => {
  const row = sanitizeLegacyCompanyFinancialRow({
    ozonCoverageComplete: false,
    ozonRevenue: 0,
    wbRevenue: 27671470.17,
    totalRevenue: 27671470.17,
    operatingProfitAfterTax: 4801169.37,
    netProfit: 4236043.3,
    profitAfterOwnerWithdrawal: 3570786.3,
    drr: 31.7,
    ordersAmount: 218825497,
    cashFlowResult: -1240135.07,
  });
  assert.equal(row.ozonRevenue, null);
  assert.equal(row.totalRevenue, null);
  assert.equal(row.operatingProfitAfterTax, null);
  assert.equal(row.netProfit, null);
  assert.equal(row.profitAfterOwnerWithdrawal, null);
  assert.equal(row.drr, null);
  assert.equal(row.ordersAmount, 218825497);
  assert.equal(row.cashFlowResult, -1240135.07);
  assert.equal(
    financialDynamicsMayShowNumericClaim({
      marketplaceTotalIncomplete: true,
      totalRevenue: row.totalRevenue,
    }),
    false
  );
});

test("complete zero is kept when coverage is complete", () => {
  const row = sanitizeLegacyCompanyFinancialRow({
    ozonCoverageComplete: true,
    ozonRevenue: 0,
    wbRevenue: 100,
    totalRevenue: 100,
    operatingProfitAfterTax: 10,
    netProfit: 8,
    profitAfterOwnerWithdrawal: 8,
    drr: 1,
  });
  assert.equal(row.ozonRevenue, 0);
  assert.equal(row.totalRevenue, 100);
});

test("plan-fact keeps null Ozon and null profit instead of a WB-only total", () => {
  const rolled = rollUpPlanFactMarketplace({
    periodUnavailable: false,
    wbRevenue: 27671470.17,
    ozonRevenue: null,
    totalRevenue: null,
    operatingProfitAfterTax: null,
  });
  assert.equal(rolled.wbRevenue, 27671470.17);
  assert.equal(rolled.ozonRevenue, null);
  assert.equal(rolled.marketplaceRevenue, null);
  assert.equal(rolled.operatingProfit, null);
});

test("dashboard snapshot does not add unavailable Ozon zero profit into the business total", () => {
  const profit = snapshotCombinedProfit({
    ozonFinancialUnavailable: true,
    wbNet: 4236043.3,
    ozonNet: 0,
    financeImpact: -5500,
    ownerWithdrawals: 1440,
  });
  assert.equal(profit.operatingProfitAfterTax, null);
  assert.equal(profit.netProfit, null);
  assert.equal(profit.profitAfterOwnerWithdrawal, null);
});
