import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

function getAmount(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function legacyLoanPaymentSourceTypes() {
  return [
    "LOAN_PAYMENT",
    "LOAN_PAYMENT_PRINCIPAL",
    "LOAN_PAYMENT_INTEREST",
  ];
}

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
          in: legacyLoanPaymentSourceTypes(),
        },
      },
    });

    const principalRows = payments
      .map((payment) => {
        const principalAmount = getAmount(payment.principalAmount);
        const interestAmount = getAmount(payment.interestAmount);
        const totalAmount = getAmount(payment.totalAmount);

        if (principalAmount <= 0) return null;

        return {
          companyName: payment.loan.companyName,
          operationDate: payment.paymentDate,
          obligationDate: payment.paymentDate,
          operationType: "FINANCING",
          category: "Тело кредита",
          subcategory: payment.loan.bankName,
          counterparty: payment.loan.bankName,
          amount: principalAmount,
          bankAccount: null,
          project: "Кредиты",
          comment: `Тело кредитного платежа: ${payment.loan.bankName}. Итого платеж: ${totalAmount}, тело: ${principalAmount}, проценты: ${interestAmount}`,
          isInternalTransfer: false,
          transactionStatus: "PLAN",
          sourceType: "LOAN_PAYMENT_PRINCIPAL",
          sourceId: payment.id,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    const interestRows = payments
      .map((payment) => {
        const principalAmount = getAmount(payment.principalAmount);
        const interestAmount = getAmount(payment.interestAmount);
        const totalAmount = getAmount(payment.totalAmount);

        if (interestAmount <= 0) return null;

        return {
          companyName: payment.loan.companyName,
          operationDate: payment.paymentDate,
          obligationDate: payment.paymentDate,
          operationType: "EXPENSE",
          category: "Проценты по кредиту",
          subcategory: payment.loan.bankName,
          counterparty: payment.loan.bankName,
          amount: interestAmount,
          bankAccount: null,
          project: "Кредиты",
          comment: `Проценты по кредитному платежу: ${payment.loan.bankName}. Итого платеж: ${totalAmount}, тело: ${principalAmount}, проценты: ${interestAmount}`,
          isInternalTransfer: false,
          transactionStatus: "PLAN",
          sourceType: "LOAN_PAYMENT_INTEREST",
          sourceId: payment.id,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (principalRows.length > 0) {
      await prisma.financeTransaction.createMany({
        data: principalRows,
      });
    }

    if (interestRows.length > 0) {
      await prisma.financeTransaction.createMany({
        data: interestRows,
      });
    }

    return NextResponse.json({
      ok: true,
      payments: payments.length,
      deleted: deleted.count,
      createdPrincipal: principalRows.length,
      createdInterest: interestRows.length,
      createdTotal: principalRows.length + interestRows.length,
    });
  } catch (error) {
    console.error("SYNC_LOAN_PAYMENTS_ERROR", error);

    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Ошибка синхронизации графика кредитов",
      },
      { status: 500 }
    );
  }
}