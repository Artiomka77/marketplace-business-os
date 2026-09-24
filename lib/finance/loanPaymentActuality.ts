/**
 * Loan schedule actuality vs early-repayment suppression.
 *
 * LoanPayment.paid alone is NOT authoritative actuality:
 * early-repayment cleanup may mark future schedule rows paid=true only to
 * suppress outstanding obligations. Those rows must never regenerate regular
 * LOAN_PAYMENT_* FinanceTransactions or enter forecast as live obligations.
 *
 * Authoritative suppression: FinanceTransaction sourceType=LOAN_EARLY_REPAYMENT
 * with sourceId=loanId, using the earliest operationDate.
 */

export const LOAN_EARLY_REPAYMENT_SOURCE_TYPE = "LOAN_EARLY_REPAYMENT";

export const LOAN_PAYMENT_FINANCE_SOURCE_TYPES = [
  "LOAN_PAYMENT",
  "LOAN_PAYMENT_PRINCIPAL",
  "LOAN_PAYMENT_INTEREST",
  "CREDIT_CARD_MIN_PAYMENT",
] as const;

export type EarlyRepaymentEvent = {
  loanId: string;
  operationDate: Date;
};

export type LoanPaymentScheduleRow = {
  id: string;
  loanId: string;
  paymentDate: Date;
  paid: boolean;
};

export function financeStatusForActiveLoanPayment(paid: boolean): "FACT" | "PLAN" {
  return paid ? "FACT" : "PLAN";
}

export function isLoanPaymentSuppressedByEarlyRepayment(input: {
  paymentDate: Date;
  earlyRepaymentDate: Date | null | undefined;
}): boolean {
  if (!input.earlyRepaymentDate) return false;
  return input.paymentDate.getTime() >= input.earlyRepaymentDate.getTime();
}

export function resolveEarlyRepaymentDateByLoanId(
  events: EarlyRepaymentEvent[],
): Map<string, Date> {
  const byLoan = new Map<string, Date>();
  for (const event of events) {
    const existing = byLoan.get(event.loanId);
    if (!existing || event.operationDate.getTime() < existing.getTime()) {
      byLoan.set(event.loanId, event.operationDate);
    }
  }
  return byLoan;
}

export function shouldGenerateRegularLoanFinanceTransactions(input: {
  paymentDate: Date;
  paid: boolean;
  earlyRepaymentDate: Date | null | undefined;
}): { generate: boolean; status: "FACT" | "PLAN" | null; reason: string } {
  if (
    isLoanPaymentSuppressedByEarlyRepayment({
      paymentDate: input.paymentDate,
      earlyRepaymentDate: input.earlyRepaymentDate,
    })
  ) {
    return {
      generate: false,
      status: null,
      reason: "SUPPRESSED_BY_EARLY_REPAYMENT",
    };
  }

  return {
    generate: true,
    status: financeStatusForActiveLoanPayment(input.paid),
    reason: input.paid ? "ACTIVE_PAID_FACT" : "ACTIVE_UNPAID_PLAN",
  };
}

/** Outstanding forecast/calendar obligations: unpaid and not early-repay suppressed. */
export function isOutstandingLoanSchedulePayment(input: {
  paymentDate: Date;
  paid: boolean;
  earlyRepaymentDate: Date | null | undefined;
}): boolean {
  if (input.paid) return false;
  if (
    isLoanPaymentSuppressedByEarlyRepayment({
      paymentDate: input.paymentDate,
      earlyRepaymentDate: input.earlyRepaymentDate,
    })
  ) {
    return false;
  }
  return true;
}

export function filterOutstandingLoanSchedulePayments<
  T extends { paymentDate: Date; paid: boolean; loanId: string },
>(payments: T[], earlyRepaymentByLoanId: Map<string, Date>): T[] {
  return payments.filter((payment) =>
    isOutstandingLoanSchedulePayment({
      paymentDate: payment.paymentDate,
      paid: payment.paid,
      earlyRepaymentDate: earlyRepaymentByLoanId.get(payment.loanId) ?? null,
    }),
  );
}

function toAmount(value: unknown) {
  const number = Number(
    String(value ?? "")
      .replace(/\s/g, "")
      .replace(",", "."),
  );
  return Number.isFinite(number) ? number : 0;
}

export type LoanPaymentFinanceSeed = {
  id: string;
  loanId: string;
  paymentDate: Date;
  paid: boolean;
  principalAmount: unknown;
  interestAmount: unknown;
  totalAmount: unknown;
  loan: {
    companyName: string;
    bankName: string;
  };
};

export function buildRegularLoanFinanceCreateRows(input: {
  payment: LoanPaymentFinanceSeed;
  earlyRepaymentDate: Date | null | undefined;
}): Array<Record<string, unknown>> {
  const decision = shouldGenerateRegularLoanFinanceTransactions({
    paymentDate: input.payment.paymentDate,
    paid: input.payment.paid,
    earlyRepaymentDate: input.earlyRepaymentDate,
  });

  if (!decision.generate || !decision.status) {
    return [];
  }

  const principalAmount = toAmount(input.payment.principalAmount);
  const interestAmount = toAmount(input.payment.interestAmount);
  const totalAmount = toAmount(input.payment.totalAmount);
  const rows: Array<Record<string, unknown>> = [];

  if (principalAmount > 0) {
    rows.push({
      companyName: input.payment.loan.companyName,
      operationDate: input.payment.paymentDate,
      obligationDate: input.payment.paymentDate,
      operationType: "FINANCING",
      category: "Тело кредита",
      subcategory: input.payment.loan.bankName,
      counterparty: input.payment.loan.bankName,
      amount: principalAmount,
      bankAccount: null,
      project: "Кредиты",
      comment: `Тело кредитного платежа: ${input.payment.loan.bankName}. Итого платеж: ${totalAmount}, тело: ${principalAmount}, проценты: ${interestAmount}`,
      isInternalTransfer: false,
      transactionStatus: decision.status,
      sourceType: "LOAN_PAYMENT_PRINCIPAL",
      sourceId: input.payment.id,
    });
  }

  if (interestAmount > 0) {
    rows.push({
      companyName: input.payment.loan.companyName,
      operationDate: input.payment.paymentDate,
      obligationDate: input.payment.paymentDate,
      operationType: "EXPENSE",
      category: "Проценты по кредиту",
      subcategory: input.payment.loan.bankName,
      counterparty: input.payment.loan.bankName,
      amount: interestAmount,
      bankAccount: null,
      project: "Кредиты",
      comment: `Проценты по кредитному платежу: ${input.payment.loan.bankName}. Итого платеж: ${totalAmount}, тело: ${principalAmount}, проценты: ${interestAmount}`,
      isInternalTransfer: false,
      transactionStatus: decision.status,
      sourceType: "LOAN_PAYMENT_INTEREST",
      sourceId: input.payment.id,
    });
  }

  return rows;
}
