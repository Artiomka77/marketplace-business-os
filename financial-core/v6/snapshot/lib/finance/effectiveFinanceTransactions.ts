/**
 * Canonical loan schedule → effective factual finance transactions (V2).
 *
 * Does NOT mutate DB rows. Synthesizes in-memory principal/interest facts for
 * due amortizing schedule payments missing an explicit FACT duplicate.
 *
 * V2 corrections vs rejected preprod helper:
 * - sequential DB reads only (no Promise.all fanout)
 * - strict dedupe (no same-date+category+amount fuzzy match across loans)
 * - residual fee guard (fail closed if total ≠ principal+interest)
 *
 * Reuses early-repayment suppression and credit-card detection from existing
 * loan helpers — do not fork those rules.
 */

import {
  LOAN_EARLY_REPAYMENT_SOURCE_TYPE,
  LOAN_PAYMENT_FINANCE_SOURCE_TYPES,
  isLoanPaymentSuppressedByEarlyRepayment,
  resolveEarlyRepaymentDateByLoanId,
} from "@/lib/finance/loanPaymentActuality";
import {
  getPaymentInterest,
  getPaymentPrincipal,
  getPaymentTotal,
  isCreditCardLoan,
} from "@/lib/finance/loanState";
import { toMoscowDateKey } from "@/lib/finance/loanBusinessDate";

export const EFFECTIVE_FACT_SOURCE_TYPE_PRINCIPAL = "LOAN_PAYMENT_PRINCIPAL";
export const EFFECTIVE_FACT_SOURCE_TYPE_INTEREST = "LOAN_PAYMENT_INTEREST";

export const PRINCIPAL_CATEGORY = "Тело кредита";
export const INTEREST_CATEGORY = "Проценты по кредиту";

export const EFFECTIVE_FACT_RESIDUAL_TOLERANCE = 0.05;

export type EffectiveFinanceTransactionRow = {
  id: string;
  companyName: string;
  operationDate: Date;
  obligationDate: Date | null;
  operationType: string;
  category: string;
  subcategory: string | null;
  counterparty: string | null;
  amount: number;
  bankAccount: string | null;
  project: string | null;
  comment: string | null;
  isInternalTransfer: boolean;
  transferGroupId: string | null;
  transferDirection: string | null;
  transactionStatus: "FACT";
  sourceType: string | null;
  sourceId: string | null;
  /** Marker for synthetic schedule-derived rows (never persisted by this helper). */
  __effectiveFactSynthetic?: boolean;
  __loanPaymentId?: string;
  __loanId?: string;
};

export type GetEffectiveFinanceTransactionsInput = {
  // Accept the live Prisma client without coupling to generated typings in every runtime image.
  prisma: any;
  companyName?: string | null;
  dateFrom: Date;
  dateToExclusive: Date;
  asOfDate: Date;
};

export type EffectiveFactUnsupportedResidual = {
  paymentId: string;
  loanId: string;
  companyName: string;
  paymentDate: string;
  principal: number;
  interest: number;
  total: number;
  residual: number;
};

export class EffectiveFactResidualError extends Error {
  readonly code = "EFFECTIVE_FACT_UNSUPPORTED_RESIDUAL";
  readonly residuals: EffectiveFactUnsupportedResidual[];

  constructor(residuals: EffectiveFactUnsupportedResidual[]) {
    super(
      `LoanPayment residual unsupported for effective-fact synthesis: ${residuals.length} payment(s)`,
    );
    this.name = "EffectiveFactResidualError";
    this.residuals = residuals;
  }
}

function toAmount(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "object" && value && "toNumber" in value) {
    const n = Number((value as { toNumber: () => number }).toNumber());
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function dateKey(d: Date): string {
  return toMoscowDateKey(d);
}

/**
 * Producer ranges use UTC-midnight half-open [from, toExclusive).
 * LoanPayment.paymentDate is stored as UTC midnight of the calendar day.
 * Never derive inclusive end/asOf Moscow keys from (toExclusive-1ms) directly —
 * that instant is still "next calendar morning" in Europe/Moscow and leaks +1 day.
 */
function utcCalendarNoon(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0),
  );
}

function rangeMoscowKeys(dateFrom: Date, dateToExclusive: Date, asOfDate: Date) {
  const lastIncluded = new Date(dateToExclusive.getTime() - 1);
  return {
    fromKey: dateKey(utcCalendarNoon(dateFrom)),
    toKeyInclusive: dateKey(utcCalendarNoon(lastIncluded)),
    asOfKey: dateKey(utcCalendarNoon(asOfDate)),
  };
}

function normalizeCompany(companyName?: string | null): string | null {
  if (!companyName) return null;
  const t = String(companyName).trim();
  if (!t || t.toUpperCase() === "ALL") return null;
  return t;
}

function isLoanLinkedSourceType(sourceType: string | null | undefined): boolean {
  if (!sourceType) return false;
  return (LOAN_PAYMENT_FINANCE_SOURCE_TYPES as readonly string[]).includes(
    sourceType,
  );
}

function isPrincipalCategory(category: string): boolean {
  const c = category.toLowerCase();
  return c.includes("тело кредита") || category === PRINCIPAL_CATEGORY;
}

function isInterestCategory(category: string): boolean {
  const c = category.toLowerCase();
  return (
    (c.includes("процент") &&
      (c.includes("кредит") || c.includes("займ") || c.includes("заем"))) ||
    category === INTEREST_CATEGORY
  );
}

function matchesKind(
  row: { category: string; sourceType: string | null },
  kind: "principal" | "interest",
): boolean {
  if (kind === "principal") {
    return (
      isPrincipalCategory(row.category) ||
      row.sourceType === "LOAN_PAYMENT_PRINCIPAL" ||
      row.sourceType === "LOAN_PAYMENT"
    );
  }
  return (
    isInterestCategory(row.category) ||
    row.sourceType === "LOAN_PAYMENT_INTEREST" ||
    row.sourceType === "LOAN_PAYMENT"
  );
}

/**
 * Derive normal schedule close boundary: last payment date when balance is ~0
 * and no early-repayment event exists.
 */
export function deriveScheduleCloseDate(input: {
  currentDebt: unknown;
  payments: Array<{ paymentDate: Date }>;
  earlyRepaymentDate: Date | null | undefined;
}): Date | null {
  if (input.earlyRepaymentDate) return null;
  if (toAmount(input.currentDebt) > 0.01) return null;
  if (!input.payments.length) return null;
  let max = input.payments[0].paymentDate;
  for (const p of input.payments) {
    if (p.paymentDate.getTime() > max.getTime()) max = p.paymentDate;
  }
  return max;
}

export function isPostCloseSuppressed(input: {
  paymentDate: Date;
  earlyRepaymentDate: Date | null | undefined;
  scheduleCloseDate: Date | null | undefined;
}): boolean {
  if (
    isLoanPaymentSuppressedByEarlyRepayment({
      paymentDate: input.paymentDate,
      earlyRepaymentDate: input.earlyRepaymentDate,
    })
  ) {
    return true;
  }
  if (input.scheduleCloseDate) {
    // After normal close boundary — never restore ghosts.
    return input.paymentDate.getTime() > input.scheduleCloseDate.getTime();
  }
  return false;
}

/**
 * Strict explicit-FACT coverage.
 *
 * Accepted linkages only:
 * 1) sourceId === LoanPayment.id (+ matching kind)
 * 2) sourceId === loanId AND same Moscow date (+ matching kind + amount)
 *    — only when sourceType is an exact loan-linked finance source type
 *
 * NOT accepted: same date + category + amount alone (cross-loan false dedupe).
 */
export function hasExplicitFactCovering(input: {
  paymentId: string;
  loanId: string;
  paymentDate: Date;
  kind: "principal" | "interest";
  amount: number;
  factRows: Array<{
    sourceId: string | null;
    sourceType: string | null;
    category: string;
    amount: unknown;
    operationDate: Date;
    transactionStatus: string;
  }>;
}): boolean {
  const amount = roundMoney(input.amount);
  if (amount <= 0) return true;
  const payKey = dateKey(input.paymentDate);

  // Path 1: deterministic payment linkage via sourceId === paymentId
  for (const row of input.factRows) {
    if ((row.transactionStatus || "").toUpperCase() !== "FACT") continue;
    if (row.sourceId !== input.paymentId) continue;
    if (!matchesKind(row, input.kind)) continue;
    return true;
  }

  // Path 2: loanId as sourceId + same day + kind + amount, only for loan-linked sourceType
  for (const row of input.factRows) {
    if ((row.transactionStatus || "").toUpperCase() !== "FACT") continue;
    if (row.sourceId !== input.loanId) continue;
    if (!isLoanLinkedSourceType(row.sourceType)) continue;
    if (dateKey(row.operationDate) !== payKey) continue;
    if (!matchesKind(row, input.kind)) continue;
    if (Math.abs(roundMoney(toAmount(row.amount)) - amount) > 0.05) continue;
    return true;
  }

  return false;
}

export function computePaymentResidual(payment: {
  principalAmount?: unknown;
  interestAmount?: unknown;
  totalAmount?: unknown;
}): { principal: number; interest: number; total: number; residual: number } {
  const principal = roundMoney(getPaymentPrincipal(payment as any));
  const interest = roundMoney(getPaymentInterest(payment as any));
  const total = roundMoney(getPaymentTotal(payment as any));
  const residual = roundMoney(total - principal - interest);
  return { principal, interest, total, residual };
}

export async function getEffectiveFinanceTransactions(
  input: GetEffectiveFinanceTransactionsInput,
): Promise<EffectiveFinanceTransactionRow[]> {
  const company = normalizeCompany(input.companyName);
  const companyWhere = company ? { companyName: company } : {};

  // Sequential DB reads only — protected pool max=1.
  const factRows = await input.prisma.financeTransaction.findMany({
    where: {
      ...companyWhere,
      transactionStatus: "FACT",
      operationDate: {
        gte: input.dateFrom,
        lt: input.dateToExclusive,
      },
    },
  });

  const earlyRows = await input.prisma.financeTransaction.findMany({
    where: {
      sourceType: LOAN_EARLY_REPAYMENT_SOURCE_TYPE,
      ...(company ? { companyName: company } : {}),
    },
    select: {
      sourceId: true,
      operationDate: true,
      companyName: true,
    },
  });

  const loans = await input.prisma.loan.findMany({
    where: companyWhere,
    include: {
      payments: {
        orderBy: { paymentDate: "asc" },
      },
    },
  });

  const earlyByLoan = resolveEarlyRepaymentDateByLoanId(
    (
      earlyRows as Array<{
        sourceId: string | null;
        operationDate: Date;
        companyName?: string;
      }>
    )
      .filter((r) => Boolean(r.sourceId))
      .map((r) => ({
        loanId: String(r.sourceId),
        operationDate: r.operationDate as Date,
      })),
  );

  const { fromKey, toKeyInclusive, asOfKey } = rangeMoscowKeys(
    input.dateFrom,
    input.dateToExclusive,
    input.asOfDate,
  );

  const synthetic: EffectiveFinanceTransactionRow[] = [];
  const unsupportedResiduals: EffectiveFactUnsupportedResidual[] = [];

  for (const loan of loans as any[]) {
    if (isCreditCardLoan(loan)) continue;

    const early = earlyByLoan.get(loan.id) ?? null;
    const payments = (loan.payments || []) as Array<{
      id: string;
      loanId: string;
      paymentDate: Date;
      paid: boolean;
      principalAmount: unknown;
      interestAmount: unknown;
      totalAmount: unknown;
    }>;

    const scheduleClose = deriveScheduleCloseDate({
      currentDebt: loan.currentDebt,
      payments,
      earlyRepaymentDate: early,
    });

    for (const payment of payments) {
      const payKey = dateKey(payment.paymentDate);
      if (payKey < fromKey || payKey > toKeyInclusive) continue;
      if (payKey > asOfKey) continue;

      if (
        isPostCloseSuppressed({
          paymentDate: payment.paymentDate,
          earlyRepaymentDate: early,
          scheduleCloseDate: scheduleClose,
        })
      ) {
        continue;
      }

      const { principal, interest, total, residual } =
        computePaymentResidual(payment);

      // Only enforce residual when this payment would contribute synthetic facts.
      // Still audit residual for any due in-range payment that is not post-close.
      if (Math.abs(residual) > EFFECTIVE_FACT_RESIDUAL_TOLERANCE) {
        unsupportedResiduals.push({
          paymentId: payment.id,
          loanId: loan.id,
          companyName: loan.companyName,
          paymentDate: payKey,
          principal,
          interest,
          total,
          residual,
        });
        continue;
      }

      if (principal > 0) {
        const covered = hasExplicitFactCovering({
          paymentId: payment.id,
          loanId: loan.id,
          paymentDate: payment.paymentDate,
          kind: "principal",
          amount: principal,
          factRows,
        });
        if (!covered) {
          synthetic.push({
            id: `effective:${payment.id}:principal`,
            companyName: loan.companyName,
            operationDate: payment.paymentDate,
            obligationDate: payment.paymentDate,
            operationType: "FINANCING",
            category: PRINCIPAL_CATEGORY,
            subcategory: loan.bankName,
            counterparty: loan.bankName,
            amount: principal,
            bankAccount: null,
            project: "Кредиты",
            comment: `Effective fact (schedule): тело. Итого=${total}`,
            isInternalTransfer: false,
            transferGroupId: null,
            transferDirection: null,
            transactionStatus: "FACT",
            sourceType: EFFECTIVE_FACT_SOURCE_TYPE_PRINCIPAL,
            sourceId: payment.id,
            __effectiveFactSynthetic: true,
            __loanPaymentId: payment.id,
            __loanId: loan.id,
          });
        }
      }

      if (interest > 0) {
        const covered = hasExplicitFactCovering({
          paymentId: payment.id,
          loanId: loan.id,
          paymentDate: payment.paymentDate,
          kind: "interest",
          amount: interest,
          factRows,
        });
        if (!covered) {
          synthetic.push({
            id: `effective:${payment.id}:interest`,
            companyName: loan.companyName,
            operationDate: payment.paymentDate,
            obligationDate: payment.paymentDate,
            operationType: "EXPENSE",
            category: INTEREST_CATEGORY,
            subcategory: loan.bankName,
            counterparty: loan.bankName,
            amount: interest,
            bankAccount: null,
            project: "Кредиты",
            comment: `Effective fact (schedule): проценты. Итого=${total}`,
            isInternalTransfer: false,
            transferGroupId: null,
            transferDirection: null,
            transactionStatus: "FACT",
            sourceType: EFFECTIVE_FACT_SOURCE_TYPE_INTEREST,
            sourceId: payment.id,
            __effectiveFactSynthetic: true,
            __loanPaymentId: payment.id,
            __loanId: loan.id,
          });
        }
      }
    }
  }

  if (unsupportedResiduals.length > 0) {
    throw new EffectiveFactResidualError(unsupportedResiduals);
  }

  const normalizedFacts: EffectiveFinanceTransactionRow[] = (
    factRows as any[]
  ).map((row: any) => ({
    id: row.id,
    companyName: row.companyName,
    operationDate: row.operationDate,
    obligationDate: row.obligationDate ?? null,
    operationType: row.operationType,
    category: row.category,
    subcategory: row.subcategory ?? null,
    counterparty: row.counterparty ?? null,
    amount: toAmount(row.amount),
    bankAccount: row.bankAccount ?? null,
    project: row.project ?? null,
    comment: row.comment ?? null,
    isInternalTransfer: Boolean(row.isInternalTransfer),
    transferGroupId: row.transferGroupId ?? null,
    transferDirection: row.transferDirection ?? null,
    transactionStatus: "FACT" as const,
    sourceType: row.sourceType ?? null,
    sourceId: row.sourceId ?? null,
  }));

  return [...normalizedFacts, ...synthetic];
}
