import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function getAmount(value: unknown) {
  return Number(value ?? 0);
}

function loanPaymentTransactionData(payment: {
  id: string;
  paymentDate: Date;
  totalAmount: unknown;
  principalAmount: unknown;
  interestAmount: unknown;
  loan: {
    companyName: string;
    bankName: string;
  };
}) {
  return {
    companyName: payment.loan.companyName,
    operationDate: payment.paymentDate,
    obligationDate: payment.paymentDate,
    operationType: "FINANCING",
    category: "Погашение кредита",
    subcategory: payment.loan.bankName,
    counterparty: payment.loan.bankName,
    amount: getAmount(payment.totalAmount),
    bankAccount: null,
    project: "Кредиты",
    comment: `Кредитный платеж: ${payment.loan.bankName}. Тело: ${getAmount(
      payment.principalAmount
    )}, проценты: ${getAmount(payment.interestAmount)}`,
    isInternalTransfer: false,
    transactionStatus: "PLAN",
    sourceType: "LOAN_PAYMENT",
    sourceId: payment.id,
  };
}

export async function GET() {
  const payments = await prisma.loanPayment.findMany({
    include: {
      loan: true,
    },
    orderBy: {
      paymentDate: "asc",
    },
  });

  let created = 0;
  let updated = 0;

  for (const payment of payments) {
    const existing = await prisma.financeTransaction.findFirst({
      where: {
        sourceType: "LOAN_PAYMENT",
        sourceId: payment.id,
      },
    });

    const data = loanPaymentTransactionData(payment);

    if (existing) {
      await prisma.financeTransaction.update({
        where: {
          id: existing.id,
        },
        data,
      });
      updated += 1;
    } else {
      await prisma.financeTransaction.create({
        data,
      });
      created += 1;
    }
  }

  return NextResponse.json({
    ok: true,
    payments: payments.length,
    created,
    updated,
  });
}