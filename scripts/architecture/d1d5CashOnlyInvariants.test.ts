import assert from "node:assert/strict";
import test from "node:test";

import { calculateFinanceMetricsForRows } from "../../lib/finance/financeMetrics";

const categories = [
  {
    name: "Пришло на счет",
    categoryType: "INCOME",
    profitTreatment: "CASH_ONLY",
  },
  {
    name: "Реклама",
    categoryType: "EXPENSE",
    profitTreatment: "CASH_ONLY",
  },
  {
    name: "Хозрасходы",
    categoryType: "EXPENSE",
    profitTreatment: "INCLUDE_IN_NET_PROFIT",
  },
  {
    name: "Прочие доходы",
    categoryType: "INCOME",
    profitTreatment: "INCLUDE_IN_NET_PROFIT",
  },
  {
    name: "Тело кредита",
    categoryType: "EXPENSE",
    profitTreatment: "CREDIT_PRINCIPAL",
  },
  {
    name: "Проценты по кредиту",
    categoryType: "EXPENSE",
    profitTreatment: "CREDIT_INTEREST",
  },
  {
    name: "Вывод собственника",
    categoryType: "EXPENSE",
    profitTreatment: "OWNER_WITHDRAWAL",
  },
];

test("CASH_ONLY_INCOME_TEST: cash flow yes, net profit no", () => {
  const metrics = calculateFinanceMetricsForRows({
    categories,
    transactions: [
      {
        operationType: "INCOME",
        category: "Пришло на счет",
        amount: 1195913,
      },
    ],
  });
  assert.equal(metrics.cashIncome, 1195913);
  assert.equal(metrics.netCashFlow, 1195913);
  assert.equal(metrics.netProfitImpact, 0);
  assert.equal(metrics.netProfitIncome, 0);
});

test("CASH_ONLY_AD_TEST: bank ads cash flow yes, net profit no", () => {
  const metrics = calculateFinanceMetricsForRows({
    categories,
    transactions: [
      { operationType: "EXPENSE", category: "Реклама", amount: 10000 },
    ],
  });
  assert.equal(metrics.cashOutflow, 10000);
  assert.equal(metrics.netCashFlow, -10000);
  assert.equal(metrics.netProfitImpact, 0);
  assert.equal(metrics.cashOnlyTotal, 10000);
});

test("TRUE_PNL_EXPENSE_TEST: INCLUDE_IN_NET_PROFIT expense decreases net", () => {
  const metrics = calculateFinanceMetricsForRows({
    categories,
    transactions: [
      { operationType: "EXPENSE", category: "Хозрасходы", amount: 2500 },
    ],
  });
  assert.equal(metrics.netProfitExpense, 2500);
  assert.equal(metrics.netProfitImpact, -2500);
  assert.equal(metrics.netCashFlow, -2500);
});

test("TRUE_PNL_INCOME_TEST: INCLUDE_IN_NET_PROFIT income increases net", () => {
  const metrics = calculateFinanceMetricsForRows({
    categories,
    transactions: [
      { operationType: "INCOME", category: "Прочие доходы", amount: 400 },
    ],
  });
  assert.equal(metrics.netProfitIncome, 400);
  assert.equal(metrics.netProfitImpact, 400);
  assert.equal(metrics.netCashFlow, 400);
});

test("LOAN_PRINCIPAL_TEST: principal net impact 0", () => {
  const metrics = calculateFinanceMetricsForRows({
    categories,
    transactions: [
      { operationType: "EXPENSE", category: "Тело кредита", amount: 182610.43 },
    ],
  });
  assert.equal(metrics.creditPrincipal, 182610.43);
  assert.equal(metrics.netProfitImpact, 0);
  assert.equal(metrics.netCashFlow, -182610.43);
});

test("LOAN_INTEREST_TEST: explicit interest remains P&L expense", () => {
  const metrics = calculateFinanceMetricsForRows({
    categories,
    transactions: [
      {
        operationType: "EXPENSE",
        category: "Проценты по кредиту",
        amount: 32869.57,
      },
    ],
  });
  assert.equal(metrics.creditInterest, 32869.57);
  assert.equal(metrics.netProfitExpense, 32869.57);
  assert.equal(metrics.netProfitImpact, -32869.57);
});

test("OWNER_WITHDRAWAL_TEST: net 0, owner withdrawals increase", () => {
  const metrics = calculateFinanceMetricsForRows({
    categories,
    transactions: [
      {
        operationType: "EXPENSE",
        category: "Вывод собственника",
        amount: 13890,
      },
    ],
  });
  assert.equal(metrics.netProfitImpact, 0);
  assert.equal(metrics.ownerWithdrawals, 13890);
  assert.equal(metrics.netCashFlow, -13890);
});

test("TRANSFER_TEST: internal transfer profit impact 0", () => {
  const metrics = calculateFinanceMetricsForRows({
    categories,
    transactions: [
      {
        operationType: "TRANSFER",
        category: "Перевод",
        amount: 50000,
        isInternalTransfer: true,
        transferDirection: "TRANSFER_OUT",
      },
    ],
  });
  assert.equal(metrics.netProfitImpact, 0);
  assert.equal(metrics.netCashFlow, 0);
  assert.equal(metrics.transferTotal, 50000);
});

test("FALLBACK_COMPAT_TEST: null profitTreatment keeps fallback", () => {
  const withField = calculateFinanceMetricsForRows({
    categories: [
      {
        name: "Хозрасходы",
        categoryType: "EXPENSE",
        profitTreatment: null,
      },
    ],
    transactions: [
      { operationType: "EXPENSE", category: "Хозрасходы", amount: 100 },
    ],
  });
  const omitted = calculateFinanceMetricsForRows({
    categories: [{ name: "Хозрасходы", categoryType: "EXPENSE" }],
    transactions: [
      { operationType: "EXPENSE", category: "Хозрасходы", amount: 100 },
    ],
  });
  assert.equal(withField.netProfitImpact, omitted.netProfitImpact);
  assert.equal(withField.netProfitImpact, -100);
});

test("COMPANY_AGGREGATION_TEST: ALL overlay equals sum of companies", () => {
  const petrov = calculateFinanceMetricsForRows({
    categories,
    transactions: [
      { operationType: "INCOME", category: "Пришло на счет", amount: 1000 },
      { operationType: "EXPENSE", category: "Хозрасходы", amount: 200 },
    ],
  });
  const lebedeva = calculateFinanceMetricsForRows({
    categories,
    transactions: [
      { operationType: "EXPENSE", category: "Реклама", amount: 50 },
    ],
  });
  const all = calculateFinanceMetricsForRows({
    categories,
    transactions: [
      { operationType: "INCOME", category: "Пришло на счет", amount: 1000 },
      { operationType: "EXPENSE", category: "Хозрасходы", amount: 200 },
      { operationType: "EXPENSE", category: "Реклама", amount: 50 },
    ],
  });
  assert.equal(all.netCashFlow, petrov.netCashFlow + lebedeva.netCashFlow);
  assert.equal(all.netProfitImpact, petrov.netProfitImpact + lebedeva.netProfitImpact);
  assert.equal(all.cashOnlyTotal, petrov.cashOnlyTotal + lebedeva.cashOnlyTotal);
});

test("fallback diverges for CASH_ONLY income Пришло на счет", () => {
  const explicit = calculateFinanceMetricsForRows({
    categories,
    transactions: [
      { operationType: "INCOME", category: "Пришло на счет", amount: 10 },
    ],
  });
  const fallbackOnly = calculateFinanceMetricsForRows({
    categories: [{ name: "Пришло на счет", categoryType: "INCOME" }],
    transactions: [
      { operationType: "INCOME", category: "Пришло на счет", amount: 10 },
    ],
  });
  assert.equal(explicit.netProfitImpact, 0);
  assert.equal(fallbackOnly.netProfitImpact, 10);
});
