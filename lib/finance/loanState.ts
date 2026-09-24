/**
 * Canonical loan-state read model for /finance/loans and related surfaces.
 *
 * Owner-facing amortizing balances are schedule-projected (Europe/Moscow),
 * not raw Loan.currentDebt. Early-repayment suppression is reused from
 * loanPaymentActuality (PATCH 2) — do not duplicate that rule.
 */

import {
  isLoanPaymentSuppressedByEarlyRepayment,
  isOutstandingLoanSchedulePayment,
} from "@/lib/finance/loanPaymentActuality";
import {
  addDaysToMoscowDateKey,
  compareMoscowDateKeys,
  endOfMoscowMonthKey,
  startOfMoscowMonthKey,
  toMoscowDateKey,
  toMoscowMonthKey,
} from "@/lib/finance/loanBusinessDate";

export const SCHEDULE_PRINCIPAL_TOLERANCE = 0.05;

export type LoanObligationType = "AMORTIZING" | "CREDIT_CARD";

export type LoanCanonicalStatus =
  | "ACTIVE"
  | "CLOSED_EARLY"
  | "CLOSED_SCHEDULE"
  | "CREDIT_CARD_ACTIVE"
  | "CREDIT_CARD_ZERO"
  | "DATA_INCOMPLETE";

export type LoanBalanceSource =
  | "SCHEDULE_PROJECTION"
  | "EARLY_REPAYMENT"
  | "CREDIT_CARD_MANUAL"
  | "STORED_FALLBACK";

export type LoanStatePayment = {
  id: string;
  loanId: string;
  paymentDate: Date;
  paid: boolean;
  principalAmount: unknown;
  interestAmount: unknown;
  totalAmount: unknown;
};

export type LoanStateLoan = {
  id: string;
  bankName: string;
  currentDebt: unknown;
  monthlyPayment?: unknown;
  endDate?: Date | null;
  creditLimit?: unknown;
  paymentFrequency?: string | null;
};

export type LoanStatePaymentActuality = {
  /**
   * Payment ids proven actual on the schedule (FACT), excluding early-repay
   * suppression masquerading as paid=true.
   */
  provenActualPaymentIds?: ReadonlySet<string>;
};

export type LoanStateAtDate = {
  loanId: string;
  obligationType: LoanObligationType;
  status: LoanCanonicalStatus;
  balance: number;
  balanceSource: LoanBalanceSource;
  closedAt: string | null;
  nextOutstandingPayment: LoanStatePayment | null;
  selectedMonthPlanPrincipal: number;
  selectedMonthPlanInterest: number;
  selectedMonthPlanTotal: number;
  selectedMonthPaymentCount: number;
  selectedMonthRemainingPrincipal: number;
  selectedMonthRemainingInterest: number;
  selectedMonthRemainingTotal: number;
  remainingPrincipal: number;
  remainingInterest: number;
  remainingPaymentCount: number;
  /** Remaining principal with paymentDate through selected calendar year-end only. */
  principalUntilSelectedYearEnd: number;
  /** Remaining interest with paymentDate through selected calendar year-end only. */
  interestUntilSelectedYearEnd: number;
  remainingTermEndDate: Date | null;
  scheduleComplete: boolean;
  dataQualityReason: string | null;
  isActiveObligation: boolean;
};

function toAmount(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "object" && value && "toNumber" in value) {
    const n = (value as { toNumber: () => number }).toNumber();
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function getPaymentPrincipal(payment: {
  principalAmount: unknown;
  totalAmount?: unknown;
  interestAmount?: unknown;
}): number {
  const principal = toAmount(payment.principalAmount);
  if (principal) return roundMoney(principal);
  const total = toAmount(payment.totalAmount);
  const interest = toAmount(payment.interestAmount);
  return roundMoney(Math.max(0, total - interest));
}

export function getPaymentInterest(payment: {
  interestAmount: unknown;
}): number {
  return roundMoney(toAmount(payment.interestAmount));
}

export function getPaymentTotal(payment: {
  totalAmount: unknown;
  principalAmount: unknown;
  interestAmount: unknown;
}): number {
  const total = toAmount(payment.totalAmount);
  if (total) return roundMoney(total);
  return roundMoney(
    getPaymentPrincipal(payment) + getPaymentInterest(payment),
  );
}

export function isCreditCardLoan(loan: {
  bankName?: string | null;
}): boolean {
  const name = String(loan.bankName ?? "").toLowerCase();
  return name.includes("кредитка") || name.includes("кредитная карта");
}

export function isCanonicalActiveStatus(status: LoanCanonicalStatus): boolean {
  return (
    status === "ACTIVE" ||
    status === "CREDIT_CARD_ACTIVE" ||
    status === "DATA_INCOMPLETE"
  );
}

/**
 * Same-day actuality: paid=true counts only when NOT early-repay suppressed.
 * Optionally honor an explicit proven-actual id set from FACT rows.
 */
export function isPaymentProvenActual(input: {
  payment: LoanStatePayment;
  earlyRepaymentDate: Date | null | undefined;
  paymentActuality?: LoanStatePaymentActuality | null;
}): boolean {
  if (
    isLoanPaymentSuppressedByEarlyRepayment({
      paymentDate: input.payment.paymentDate,
      earlyRepaymentDate: input.earlyRepaymentDate,
    })
  ) {
    return false;
  }

  if (input.paymentActuality?.provenActualPaymentIds?.has(input.payment.id)) {
    return true;
  }

  return Boolean(input.payment.paid);
}

/**
 * Remaining under schedule projection as of business date D (Moscow key):
 * - paymentDate < D: elapsed
 * - paymentDate > D: remaining
 * - paymentDate == D: remaining unless proven actual
 */
export function isPaymentInProjectedRemaining(input: {
  payment: LoanStatePayment;
  asOfDateKey: string;
  earlyRepaymentDate: Date | null | undefined;
  paymentActuality?: LoanStatePaymentActuality | null;
}): boolean {
  if (
    isLoanPaymentSuppressedByEarlyRepayment({
      paymentDate: input.payment.paymentDate,
      earlyRepaymentDate: input.earlyRepaymentDate,
    })
  ) {
    return false;
  }

  const paymentKey = toMoscowDateKey(input.payment.paymentDate);
  const cmp = compareMoscowDateKeys(paymentKey, input.asOfDateKey);

  if (cmp < 0) return false;
  if (cmp > 0) return true;

  return !isPaymentProvenActual({
    payment: input.payment,
    earlyRepaymentDate: input.earlyRepaymentDate,
    paymentActuality: input.paymentActuality,
  });
}

export function assessScheduleCompleteness(input: {
  payments: LoanStatePayment[];
  storedCurrentDebt: number;
}): { complete: boolean; reason: string | null; schedulePrincipal: number } {
  const payments = input.payments;
  if (payments.length === 0) {
    if (input.storedCurrentDebt > SCHEDULE_PRINCIPAL_TOLERANCE) {
      return {
        complete: false,
        reason: "EMPTY_SCHEDULE_WITH_STORED_DEBT",
        schedulePrincipal: 0,
      };
    }
    return { complete: true, reason: null, schedulePrincipal: 0 };
  }

  const ids = new Set<string>();
  const dateKeys = new Set<string>();
  let schedulePrincipal = 0;

  for (const payment of payments) {
    if (ids.has(payment.id)) {
      return {
        complete: false,
        reason: "DUPLICATE_PAYMENT_ID",
        schedulePrincipal: 0,
      };
    }
    ids.add(payment.id);

    const key = toMoscowDateKey(payment.paymentDate);
    if (dateKeys.has(key)) {
      return {
        complete: false,
        reason: "DUPLICATE_PAYMENT_DATE",
        schedulePrincipal: 0,
      };
    }
    dateKeys.add(key);

    const principal = getPaymentPrincipal(payment);
    if (principal < -SCHEDULE_PRINCIPAL_TOLERANCE) {
      return {
        complete: false,
        reason: "NEGATIVE_PRINCIPAL",
        schedulePrincipal: 0,
      };
    }
    schedulePrincipal = roundMoney(schedulePrincipal + principal);
  }

  if (
    Math.abs(schedulePrincipal - input.storedCurrentDebt) >
    SCHEDULE_PRINCIPAL_TOLERANCE
  ) {
    return {
      complete: false,
      reason: "SCHEDULE_PRINCIPAL_MISMATCH_STORED_DEBT",
      schedulePrincipal,
    };
  }

  return { complete: true, reason: null, schedulePrincipal };
}

function emptyMonthAmounts() {
  return {
    selectedMonthPlanPrincipal: 0,
    selectedMonthPlanInterest: 0,
    selectedMonthPlanTotal: 0,
    selectedMonthPaymentCount: 0,
    selectedMonthRemainingPrincipal: 0,
    selectedMonthRemainingInterest: 0,
    selectedMonthRemainingTotal: 0,
  };
}

function emptyYearEndAmounts() {
  return {
    principalUntilSelectedYearEnd: 0,
    interestUntilSelectedYearEnd: 0,
  };
}

export function getLoanStateAtDate(input: {
  loan: LoanStateLoan;
  payments: LoanStatePayment[];
  earlyRepaymentDate?: Date | null;
  paymentActuality?: LoanStatePaymentActuality | null;
  asOfDate: Date | string;
  selectedMonth?: string | null;
}): LoanStateAtDate {
  const asOfDateKey =
    typeof input.asOfDate === "string"
      ? input.asOfDate
      : toMoscowDateKey(input.asOfDate);
  const selectedMonthKey =
    input.selectedMonth && /^\d{4}-\d{2}$/.test(input.selectedMonth)
      ? input.selectedMonth
      : asOfDateKey.slice(0, 7);
  const monthStart = startOfMoscowMonthKey(selectedMonthKey);
  const monthEnd = endOfMoscowMonthKey(selectedMonthKey);

  const earlyRepaymentDate = input.earlyRepaymentDate ?? null;
  const storedDebt = roundMoney(toAmount(input.loan.currentDebt));
  const payments = [...input.payments].sort(
    (a, b) => a.paymentDate.getTime() - b.paymentDate.getTime(),
  );

  if (isCreditCardLoan(input.loan)) {
    const balance = Math.max(0, storedDebt);
    const status: LoanCanonicalStatus =
      balance > SCHEDULE_PRINCIPAL_TOLERANCE
        ? "CREDIT_CARD_ACTIVE"
        : "CREDIT_CARD_ZERO";
    return {
      loanId: input.loan.id,
      obligationType: "CREDIT_CARD",
      status,
      balance,
      balanceSource: "CREDIT_CARD_MANUAL",
      closedAt: null,
      nextOutstandingPayment: null,
      ...emptyMonthAmounts(),
      ...emptyYearEndAmounts(),
      remainingPrincipal: balance,
      remainingInterest: 0,
      remainingPaymentCount: 0,
      remainingTermEndDate: input.loan.endDate ?? null,
      scheduleComplete: true,
      dataQualityReason: null,
      isActiveObligation: status === "CREDIT_CARD_ACTIVE",
    };
  }

  if (earlyRepaymentDate) {
    const closedAt = toMoscowDateKey(earlyRepaymentDate);
    if (compareMoscowDateKeys(closedAt, asOfDateKey) <= 0) {
      return {
        loanId: input.loan.id,
        obligationType: "AMORTIZING",
        status: "CLOSED_EARLY",
        balance: 0,
        balanceSource: "EARLY_REPAYMENT",
        closedAt,
        nextOutstandingPayment: null,
        ...emptyMonthAmounts(),
        ...emptyYearEndAmounts(),
        remainingPrincipal: 0,
        remainingInterest: 0,
        remainingPaymentCount: 0,
        remainingTermEndDate: earlyRepaymentDate,
        scheduleComplete: true,
        dataQualityReason: null,
        isActiveObligation: false,
      };
    }
  }

  const completeness = assessScheduleCompleteness({
    payments,
    storedCurrentDebt: storedDebt,
  });

  if (!completeness.complete) {
    const balance = Math.max(0, storedDebt);
    return {
      loanId: input.loan.id,
      obligationType: "AMORTIZING",
      status: "DATA_INCOMPLETE",
      balance,
      balanceSource: "STORED_FALLBACK",
      closedAt: null,
      nextOutstandingPayment: null,
      ...emptyMonthAmounts(),
      ...emptyYearEndAmounts(),
      remainingPrincipal: balance,
      remainingInterest: 0,
      remainingPaymentCount: 0,
      remainingTermEndDate: input.loan.endDate ?? null,
      scheduleComplete: false,
      dataQualityReason: completeness.reason,
      isActiveObligation: balance > SCHEDULE_PRINCIPAL_TOLERANCE,
    };
  }

  const remainingPayments = payments.filter((payment) =>
    isPaymentInProjectedRemaining({
      payment,
      asOfDateKey,
      earlyRepaymentDate,
      paymentActuality: input.paymentActuality,
    }),
  );

  const remainingPrincipal = roundMoney(
    remainingPayments.reduce(
      (sum, payment) => sum + getPaymentPrincipal(payment),
      0,
    ),
  );
  const remainingInterest = roundMoney(
    remainingPayments.reduce(
      (sum, payment) => sum + getPaymentInterest(payment),
      0,
    ),
  );

  const yearEndKey = `${selectedMonthKey.slice(0, 4)}-12-31`;
  const untilYearEndPayments = remainingPayments.filter(
    (payment) =>
      compareMoscowDateKeys(toMoscowDateKey(payment.paymentDate), yearEndKey) <=
      0,
  );
  const principalUntilSelectedYearEnd = roundMoney(
    untilYearEndPayments.reduce(
      (sum, payment) => sum + getPaymentPrincipal(payment),
      0,
    ),
  );
  const interestUntilSelectedYearEnd = roundMoney(
    untilYearEndPayments.reduce(
      (sum, payment) => sum + getPaymentInterest(payment),
      0,
    ),
  );

  const monthPlanPayments = payments.filter((payment) => {
    if (
      isLoanPaymentSuppressedByEarlyRepayment({
        paymentDate: payment.paymentDate,
        earlyRepaymentDate,
      })
    ) {
      return false;
    }
    const key = toMoscowDateKey(payment.paymentDate);
    return (
      compareMoscowDateKeys(key, monthStart) >= 0 &&
      compareMoscowDateKeys(key, monthEnd) <= 0
    );
  });

  const monthRemainingPayments = remainingPayments.filter((payment) => {
    const key = toMoscowDateKey(payment.paymentDate);
    return (
      compareMoscowDateKeys(key, monthStart) >= 0 &&
      compareMoscowDateKeys(key, monthEnd) <= 0
    );
  });

  const selectedMonthPlanPrincipal = roundMoney(
    monthPlanPayments.reduce(
      (sum, payment) => sum + getPaymentPrincipal(payment),
      0,
    ),
  );
  const selectedMonthPlanInterest = roundMoney(
    monthPlanPayments.reduce(
      (sum, payment) => sum + getPaymentInterest(payment),
      0,
    ),
  );
  const selectedMonthPlanTotal = roundMoney(
    selectedMonthPlanPrincipal + selectedMonthPlanInterest,
  );

  const selectedMonthRemainingPrincipal = roundMoney(
    monthRemainingPayments.reduce(
      (sum, payment) => sum + getPaymentPrincipal(payment),
      0,
    ),
  );
  const selectedMonthRemainingInterest = roundMoney(
    monthRemainingPayments.reduce(
      (sum, payment) => sum + getPaymentInterest(payment),
      0,
    ),
  );
  const selectedMonthRemainingTotal = roundMoney(
    selectedMonthRemainingPrincipal + selectedMonthRemainingInterest,
  );

  // Never surface a proven-actual payment as "next outstanding".
  // Early-repay-suppressed paid=true is not treated as actual (PATCH2).
  const nearestOutstanding =
    [...remainingPayments]
      .filter(
        (payment) =>
          !isPaymentProvenActual({
            payment,
            earlyRepaymentDate,
            paymentActuality: input.paymentActuality,
          }) &&
          isOutstandingLoanSchedulePayment({
            paymentDate: payment.paymentDate,
            paid: payment.paid,
            earlyRepaymentDate,
          }),
      )
      .sort((a, b) => a.paymentDate.getTime() - b.paymentDate.getTime())[0] ??
    null;

  if (remainingPrincipal <= SCHEDULE_PRINCIPAL_TOLERANCE) {
    const lastPayment = payments[payments.length - 1] ?? null;
    const closedAt = lastPayment
      ? toMoscowDateKey(lastPayment.paymentDate)
      : input.loan.endDate
        ? toMoscowDateKey(input.loan.endDate)
        : asOfDateKey;

    return {
      loanId: input.loan.id,
      obligationType: "AMORTIZING",
      status: "CLOSED_SCHEDULE",
      balance: 0,
      balanceSource: "SCHEDULE_PROJECTION",
      closedAt,
      nextOutstandingPayment: null,
      selectedMonthPlanPrincipal,
      selectedMonthPlanInterest,
      selectedMonthPlanTotal,
      selectedMonthPaymentCount: monthPlanPayments.length,
      selectedMonthRemainingPrincipal: 0,
      selectedMonthRemainingInterest: 0,
      selectedMonthRemainingTotal: 0,
      remainingPrincipal: 0,
      remainingInterest: 0,
      remainingPaymentCount: 0,
      principalUntilSelectedYearEnd: 0,
      interestUntilSelectedYearEnd: 0,
      remainingTermEndDate: lastPayment?.paymentDate ?? input.loan.endDate ?? null,
      scheduleComplete: true,
      dataQualityReason: null,
      isActiveObligation: false,
    };
  }

  return {
    loanId: input.loan.id,
    obligationType: "AMORTIZING",
    status: "ACTIVE",
    balance: remainingPrincipal,
    balanceSource: "SCHEDULE_PROJECTION",
    closedAt: null,
    nextOutstandingPayment: nearestOutstanding,
    selectedMonthPlanPrincipal,
    selectedMonthPlanInterest,
    selectedMonthPlanTotal,
    selectedMonthPaymentCount: monthPlanPayments.length,
    selectedMonthRemainingPrincipal,
    selectedMonthRemainingInterest,
    selectedMonthRemainingTotal,
    remainingPrincipal,
    remainingInterest,
    remainingPaymentCount: remainingPayments.length,
    principalUntilSelectedYearEnd,
    interestUntilSelectedYearEnd,
    remainingTermEndDate:
      remainingPayments[remainingPayments.length - 1]?.paymentDate ??
      input.loan.endDate ??
      null,
    scheduleComplete: true,
    dataQualityReason: null,
    isActiveObligation: true,
  };
}

/** Outstanding schedule rows for calendar/forecast after early-repay + closed state. */
export function filterOperationalLoanSchedulePayments<
  T extends {
    id: string;
    loanId: string;
    paymentDate: Date;
    paid: boolean;
  },
>(input: {
  payments: T[];
  loanStatesById: Map<string, LoanStateAtDate>;
  earlyRepaymentByLoanId: Map<string, Date>;
}): T[] {
  return input.payments.filter((payment) => {
    const state = input.loanStatesById.get(payment.loanId);
    if (!state) {
      return isOutstandingLoanSchedulePayment({
        paymentDate: payment.paymentDate,
        paid: payment.paid,
        earlyRepaymentDate:
          input.earlyRepaymentByLoanId.get(payment.loanId) ?? null,
      });
    }
    // Conservative: incomplete amortizing schedules never appear as operational
    // obligations on calendar/forecast (loans page also shows plan=0).
    if (state.status === "DATA_INCOMPLETE" || !state.scheduleComplete) {
      if (state.obligationType === "AMORTIZING") return false;
    }
    if (!state.isActiveObligation) {
      return false;
    }
    return isOutstandingLoanSchedulePayment({
      paymentDate: payment.paymentDate,
      paid: payment.paid,
      earlyRepaymentDate:
        input.earlyRepaymentByLoanId.get(payment.loanId) ?? null,
    });
  });
}

export function paymentsInMoscowDateWindow<T extends { paymentDate: Date }>(
  payments: T[],
  fromDateKey: string,
  toDateKeyInclusive: string,
): T[] {
  return payments.filter((payment) => {
    const key = toMoscowDateKey(payment.paymentDate);
    return (
      compareMoscowDateKeys(key, fromDateKey) >= 0 &&
      compareMoscowDateKeys(key, toDateKeyInclusive) <= 0
    );
  });
}

export function moscowWindowEnd(fromDateKey: string, dayCountInclusive: number) {
  return addDaysToMoscowDateKey(fromDateKey, Math.max(0, dayCountInclusive - 1));
}

export { toMoscowDateKey, toMoscowMonthKey };
