/** Thin re-exports for node:test (keeps production import surface stable). */
export {
  applyOzonFinancialCategoryFactsToTotals as applyOzonFinancialCategoryFactsToTotalsForTest,
  calculateOzonGrossExpenses as calculateOzonGrossExpensesForTest,
  calculateOzonNetExpensesAfterDiscountPoints as calculateOzonNetExpensesAfterDiscountPointsForTest,
  resolveOzonNetExpensesForDisplay as resolveOzonNetExpensesForDisplayForTest,
  resolveOzonNetExpensesForDisplayDetailed as resolveOzonNetExpensesForDisplayDetailedForTest,
  resolveOzonDiscountPointsAmount as resolveOzonDiscountPointsAmountForTest,
  OZON_NET_EXPENSES_REPRESENTATION_G_MINUS_B_MINUS_A as OZON_NET_EXPENSES_REPRESENTATION_G_MINUS_B_MINUS_A_FOR_TEST,
  OZON_NET_EXPENSES_REPRESENTATION_G_MINUS_B as OZON_NET_EXPENSES_REPRESENTATION_G_MINUS_B_FOR_TEST,
} from "@/lib/analytics/profitAnalyticsOzon";
