import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  filterOutstandingLoanSchedulePayments,
  isLoanPaymentSuppressedByEarlyRepayment,
  resolveEarlyRepaymentDateByLoanId,
  shouldGenerateRegularLoanFinanceTransactions,
  buildRegularLoanFinanceCreateRows,
} from "../../lib/finance/loanPaymentActuality";
import { mondaySundayWeekContainingDate } from "../../lib/wb/closedWeekFinalizer";

describe("early-repayment suppresses future schedule", () => {
  const early = new Date("2026-07-03T00:00:00.000Z");
  const sellPlusPayment = {
    id: "cmq879wrm005g20i5hqe27pdu",
    loanId: "loan_7e9056bf74",
    paymentDate: new Date("2026-08-21T00:00:00.000Z"),
    paid: true,
    principalAmount: 85948.53,
    interestAmount: 4719.9,
    totalAmount: 90668.43,
    loan: {
      companyName: "ИП Петров",
      bankName: "Sell Plus",
    },
  };

  it("marks Sell Plus 2026-08-21 as SUPPRESSED_BY_EARLY_REPAYMENT even when paid=true", () => {
    assert.equal(
      isLoanPaymentSuppressedByEarlyRepayment({
        paymentDate: sellPlusPayment.paymentDate,
        earlyRepaymentDate: early,
      }),
      true,
    );

    const decision = shouldGenerateRegularLoanFinanceTransactions({
      paymentDate: sellPlusPayment.paymentDate,
      paid: true,
      earlyRepaymentDate: early,
    });
    assert.equal(decision.generate, false);
    assert.equal(decision.reason, "SUPPRESSED_BY_EARLY_REPAYMENT");
    assert.equal(decision.status, null);
  });

  it("bulk/targeted builder emits ZERO regular finance rows for suppressed Sell Plus payment", () => {
    const rows = buildRegularLoanFinanceCreateRows({
      payment: sellPlusPayment,
      earlyRepaymentDate: early,
    });
    assert.equal(rows.length, 0);
  });

  it("preserves active unpaid schedule as PLAN and paid as FACT", () => {
    const unpaid = shouldGenerateRegularLoanFinanceTransactions({
      paymentDate: new Date("2026-08-17T00:00:00.000Z"),
      paid: false,
      earlyRepaymentDate: null,
    });
    assert.deepEqual(
      { generate: unpaid.generate, status: unpaid.status },
      { generate: true, status: "PLAN" },
    );

    const paid = shouldGenerateRegularLoanFinanceTransactions({
      paymentDate: new Date("2026-08-17T00:00:00.000Z"),
      paid: true,
      earlyRepaymentDate: null,
    });
    assert.deepEqual(
      { generate: paid.generate, status: paid.status },
      { generate: true, status: "FACT" },
    );
  });

  it("owner-confirmed WB payment groups generate FACT principal+interest rows", () => {
    const rows = buildRegularLoanFinanceCreateRows({
      payment: {
        id: "loanpay_wbfinance_a476637be3_006",
        loanId: "loan_a476637be3",
        paymentDate: new Date("2026-08-17T00:00:00.000Z"),
        paid: true,
        principalAmount: 20497.2,
        interestAmount: 4371.9,
        totalAmount: 24869.1,
        loan: { companyName: "ИП Лебедева", bankName: "Wb Кредит Лебедева 1,4 млн" },
      },
      earlyRepaymentDate: null,
    });
    assert.equal(rows.length, 2);
    assert.equal(rows.every((row) => row.transactionStatus === "FACT"), true);
    assert.equal(
      rows.some((row) => row.sourceType === "LOAN_PAYMENT_PRINCIPAL" && row.amount === 20497.2),
      true,
    );
    assert.equal(
      rows.some((row) => row.sourceType === "LOAN_PAYMENT_INTEREST" && row.amount === 4371.9),
      true,
    );
  });

  it("forecast outstanding filter hides paid and early-repay-suppressed rows", () => {
    const earlyByLoan = resolveEarlyRepaymentDateByLoanId([
      { loanId: "loan_7e9056bf74", operationDate: early },
    ]);
    const filtered = filterOutstandingLoanSchedulePayments(
      [
        sellPlusPayment,
        {
          id: "open",
          loanId: "loan_open",
          paymentDate: new Date("2026-08-25T00:00:00.000Z"),
          paid: false,
        },
      ],
      earlyByLoan,
    );
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, "open");
  });

  it("LOAN_PAYMENT_PAID_ALONE_IS_ACTUALITY=NO — paid=true still suppressed after early repay", () => {
    const decision = shouldGenerateRegularLoanFinanceTransactions({
      paymentDate: new Date("2026-08-21T00:00:00.000Z"),
      paid: true,
      earlyRepaymentDate: early,
    });
    assert.equal(decision.generate, false);
  });
});

describe("exact-period healer still intact", () => {
  it("WB 2026-08-05 -> 2026-08-03..09", () => {
    assert.deepEqual(mondaySundayWeekContainingDate("2026-08-05"), {
      dateFrom: "2026-08-03",
      dateTo: "2026-08-09",
    });
  });
});
