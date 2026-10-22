import { describe, expect, it } from "vitest";
import { hasExplicitFactCovering } from "./effectiveFinanceTransactions";

describe("credit-card effective FACT coverage", () => {
  const paymentId = "cmraoqpy5000001l6woq2uk0p";
  const loanId = "loan_8b7bd0c6f9";
  const paymentDate = new Date("2026-08-09T00:00:00.000Z");

  it("dedupes CREDIT_CARD_MIN_PAYMENT FACT linked by sourceId=LoanPayment.id as principal", () => {
    const covered = hasExplicitFactCovering({
      paymentId,
      loanId,
      paymentDate,
      kind: "principal",
      amount: 67852.9,
      factRows: [
        {
          sourceId: paymentId,
          sourceType: "CREDIT_CARD_MIN_PAYMENT",
          category: "Кредитные карты",
          amount: 67852.9,
          operationDate: paymentDate,
          transactionStatus: "FACT",
        },
      ],
    });
    expect(covered).toBe(true);
  });

  it("does not treat credit-card FACT as interest coverage", () => {
    const covered = hasExplicitFactCovering({
      paymentId,
      loanId,
      paymentDate,
      kind: "interest",
      amount: 100,
      factRows: [
        {
          sourceId: paymentId,
          sourceType: "CREDIT_CARD_MIN_PAYMENT",
          category: "Кредитные карты",
          amount: 67852.9,
          operationDate: paymentDate,
          transactionStatus: "FACT",
        },
      ],
    });
    expect(covered).toBe(false);
  });

  it("ignores PLAN credit-card rows for coverage", () => {
    const covered = hasExplicitFactCovering({
      paymentId,
      loanId,
      paymentDate,
      kind: "principal",
      amount: 67852.9,
      factRows: [
        {
          sourceId: paymentId,
          sourceType: "CREDIT_CARD_MIN_PAYMENT",
          category: "Кредитные карты",
          amount: 67852.9,
          operationDate: paymentDate,
          transactionStatus: "PLAN",
        },
      ],
    });
    expect(covered).toBe(false);
  });
});
