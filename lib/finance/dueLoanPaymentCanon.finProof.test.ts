import assert from "node:assert/strict";
import test from "node:test";

import {
  EFFECTIVE_FACT_SOURCE_TYPE_INTEREST,
  INTEREST_CATEGORY,
  hasExplicitFactCovering,
} from "@/lib/finance/effectiveFinanceTransactions";
import { calculateFinanceMetricsForRows } from "@/lib/finance/financeMetrics";

test("due interest without FinanceTransaction still counts via synthetic fact", () => {
  // Synthetic effective interest (paid=false schedule) must enter net profit.
  const synthetic = {
    amount: 3581.77,
    operationType: "FINANCING",
    category: INTEREST_CATEGORY,
    subcategory: null,
    isInternalTransfer: false,
    counterparty: "Wb Кредит",
    comment: "synthetic due LoanPayment interest",
    sourceType: EFFECTIVE_FACT_SOURCE_TYPE_INTEREST,
  };
  const categories = [
    {
      name: INTEREST_CATEGORY,
      categoryType: "EXPENSE",
      parentName: null,
      profitTreatment: "CREDIT_INTEREST",
    },
  ];
  const metrics = calculateFinanceMetricsForRows({
    transactions: [synthetic] as never,
    categories: categories as never,
  });
  assert.ok(Math.abs(metrics.netProfitImpact - -3581.77) < 0.02);
  assert.ok(Math.abs(metrics.creditInterest - 3581.77) < 0.02);
});

test("explicit FACT covering LoanPayment prevents duplicate synthetic interest", () => {
  const covered = hasExplicitFactCovering({
    paymentId: "loanpay_1",
    loanId: "loan_1",
    kind: "interest",
    paymentDate: new Date("2026-10-19T00:00:00.000Z"),
    amount: 3581.77,
    factRows: [
      {
        sourceId: "loanpay_1",
        sourceType: "LOAN_PAYMENT",
        category: INTEREST_CATEGORY,
        amount: 3581.77,
        operationDate: new Date("2026-10-19T00:00:00.000Z"),
        transactionStatus: "FACT",
      },
    ],
  });
  assert.equal(covered, true);
  const uncovered = hasExplicitFactCovering({
    paymentId: "loanpay_missing",
    loanId: "loan_1",
    kind: "interest",
    paymentDate: new Date("2026-10-19T00:00:00.000Z"),
    amount: 3581.77,
    factRows: [],
  });
  assert.equal(uncovered, false);
});
