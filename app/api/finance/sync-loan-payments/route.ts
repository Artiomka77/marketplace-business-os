import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import {
  buildRegularLoanFinanceCreateRows,
  deleteRegularLoanPaymentFinanceTransactions,
  loadEarlyRepaymentDatesByLoanId,
} from "@/lib/finance/loanPaymentFinanceSync";
import { LOAN_PAYMENT_FINANCE_SOURCE_TYPES } from "@/lib/finance/loanPaymentActuality";

export async function GET() {
  try {
    const payments = await prisma.loanPayment.findMany({
      include: {
        loan: true,
      },
      orderBy: {
        paymentDate: "asc",
      },
    });

    const deleted = await prisma.financeTransaction.deleteMany({
      where: {
        sourceType: {
          in: [...LOAN_PAYMENT_FINANCE_SOURCE_TYPES],
        },
      },
    });

    const earlyByLoan = await loadEarlyRepaymentDatesByLoanId(
      payments.map((payment) => payment.loanId),
    );

    const createRows = [];
    let suppressed = 0;

    for (const payment of payments) {
      const earlyRepaymentDate = earlyByLoan.get(payment.loanId) ?? null;
      const rows = buildRegularLoanFinanceCreateRows({
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
      if (rows.length === 0) {
        suppressed += 1;
        // Ensure any stale regular rows for this payment stay deleted.
        await deleteRegularLoanPaymentFinanceTransactions(payment.id);
        continue;
      }
      createRows.push(...rows);
    }

    if (createRows.length > 0) {
      await prisma.financeTransaction.createMany({
        data: createRows as never,
      });
    }

    const createdPrincipal = createRows.filter(
      (row) => row.sourceType === "LOAN_PAYMENT_PRINCIPAL",
    ).length;
    const createdInterest = createRows.filter(
      (row) => row.sourceType === "LOAN_PAYMENT_INTEREST",
    ).length;

    return NextResponse.json({
      ok: true,
      payments: payments.length,
      deleted: deleted.count,
      suppressedPayments: suppressed,
      createdPrincipal,
      createdInterest,
      createdTotal: createRows.length,
    });
  } catch (error) {
    console.error("SYNC_LOAN_PAYMENTS_ERROR", error);

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Не удалось синхронизировать платежи по кредитам",
      },
      { status: 500 },
    );
  }
}
