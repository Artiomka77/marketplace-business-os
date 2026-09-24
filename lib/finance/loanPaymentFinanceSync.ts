import { prisma } from "@/lib/prisma";
import {
  LOAN_EARLY_REPAYMENT_SOURCE_TYPE,
  LOAN_PAYMENT_FINANCE_SOURCE_TYPES,
  buildRegularLoanFinanceCreateRows,
  resolveEarlyRepaymentDateByLoanId,
  shouldGenerateRegularLoanFinanceTransactions,
  type EarlyRepaymentEvent,
  type LoanPaymentFinanceSeed,
} from "@/lib/finance/loanPaymentActuality";

export async function loadEarlyRepaymentDatesByLoanId(
  loanIds: string[],
): Promise<Map<string, Date>> {
  const ids = [...new Set(loanIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const rows = await prisma.financeTransaction.findMany({
    where: {
      sourceType: LOAN_EARLY_REPAYMENT_SOURCE_TYPE,
      sourceId: { in: ids },
    },
    select: {
      sourceId: true,
      operationDate: true,
    },
    orderBy: { operationDate: "asc" },
  });

  const events: EarlyRepaymentEvent[] = rows
    .filter((row) => Boolean(row.sourceId))
    .map((row) => ({
      loanId: String(row.sourceId),
      operationDate: row.operationDate,
    }));

  return resolveEarlyRepaymentDateByLoanId(events);
}

export async function deleteRegularLoanPaymentFinanceTransactions(
  paymentId: string,
) {
  await prisma.financeTransaction.deleteMany({
    where: {
      sourceId: paymentId,
      sourceType: { in: [...LOAN_PAYMENT_FINANCE_SOURCE_TYPES] },
    },
  });
}

export type LoanPaymentForFinanceSync = LoanPaymentFinanceSeed;

export { buildRegularLoanFinanceCreateRows };

/**
 * Canonical single-payment sync used by targeted and bulk loan routes.
 * Early-repaid schedule rows delete stale regular txs and generate nothing.
 */
export async function syncRegularLoanPaymentFinanceTransactions(paymentId: string) {
  const payment = await prisma.loanPayment.findUnique({
    where: { id: paymentId },
    include: { loan: true },
  });

  if (!payment) {
    return { ok: false as const, reason: "NOT_FOUND" as const };
  }

  const earlyByLoan = await loadEarlyRepaymentDatesByLoanId([payment.loanId]);
  const earlyRepaymentDate = earlyByLoan.get(payment.loanId) ?? null;
  const decision = shouldGenerateRegularLoanFinanceTransactions({
    paymentDate: payment.paymentDate,
    paid: payment.paid,
    earlyRepaymentDate,
  });

  await deleteRegularLoanPaymentFinanceTransactions(payment.id);

  if (!decision.generate) {
    return {
      ok: true as const,
      reason: decision.reason,
      created: 0,
      suppressed: true as const,
    };
  }

  const createData = buildRegularLoanFinanceCreateRows({
    payment: {
      id: payment.id,
      loanId: payment.loanId,
      paymentDate: payment.paymentDate,
      paid: payment.paid,
      principalAmount: payment.principalAmount,
      interestAmount: payment.interestAmount,
      totalAmount: payment.totalAmount,
      loan: {
        companyName: payment.loan.companyName,
        bankName: payment.loan.bankName,
      },
    },
    earlyRepaymentDate,
  });

  if (createData.length > 0) {
    await prisma.financeTransaction.createMany({ data: createData as never });
  }

  return {
    ok: true as const,
    reason: decision.reason,
    created: createData.length,
    suppressed: false as const,
  };
}
