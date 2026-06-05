import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function toNumber(value: FormDataEntryValue | null) {
  const number = Number(
    String(value ?? "")
      .replace(/\s/g, "")
      .replace(",", ".")
  );

  return Number.isFinite(number) ? number : 0;
}

function toDate(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!text) return null;

  const date = new Date(`${text}T12:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date: Date, months: number) {
  return new Date(
    date.getFullYear(),
    date.getMonth() + months,
    date.getDate(),
    12,
    0,
    0,
    0
  );
}

function buildFutureDate(
  baseDate: Date,
  index: number,
  frequency: string,
  fallbackDaysDelta: number
) {
  if (frequency === "WEEKLY") return addDays(baseDate, index * 7);
  if (frequency === "BIWEEKLY") return addDays(baseDate, index * 14);
  if (frequency === "MONTHLY") return addMonths(baseDate, index);

  return addDays(baseDate, fallbackDaysDelta * index);
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
    amount: toNumber(payment.totalAmount as FormDataEntryValue | null),
    bankAccount: null,
    project: "Кредиты",
    comment: `Кредитный платеж: ${payment.loan.bankName}. Тело: ${toNumber(
      payment.principalAmount as FormDataEntryValue | null
    )}, проценты: ${toNumber(payment.interestAmount as FormDataEntryValue | null)}`,
    isInternalTransfer: false,
    transactionStatus: "PLAN",
    sourceType: "LOAN_PAYMENT",
    sourceId: payment.id,
  };
}

async function upsertFinanceTransactionForLoanPayment(paymentId: string) {
  const payment = await prisma.loanPayment.findUnique({
    where: {
      id: paymentId,
    },
    include: {
      loan: true,
    },
  });

  if (!payment) return;

  const existingTransaction = await prisma.financeTransaction.findFirst({
    where: {
      sourceType: "LOAN_PAYMENT",
      sourceId: payment.id,
    },
  });

  const data = loanPaymentTransactionData(payment);

  if (existingTransaction) {
    await prisma.financeTransaction.update({
      where: {
        id: existingTransaction.id,
      },
      data,
    });
    return;
  }

  await prisma.financeTransaction.create({
    data,
  });
}

export async function POST(req: Request) {
  const formData = await req.formData();

  const paymentId = String(formData.get("paymentId") ?? "").trim();
  const paymentDate = toDate(formData.get("paymentDate"));
  const applyScope = String(formData.get("applyScope") ?? "ONE");
  const paymentFrequency = String(
    formData.get("paymentFrequency") ?? "MONTHLY"
  );

  const principalAmount = toNumber(formData.get("principalAmount"));
  const interestAmount = toNumber(formData.get("interestAmount"));
  const totalAmount = toNumber(formData.get("totalAmount"));

  if (!paymentId || !paymentDate || totalAmount <= 0) {
    return NextResponse.json(
      { error: "Платёж, дата и сумма обязательны" },
      { status: 400 }
    );
  }

  const currentPayment = await prisma.loanPayment.findUnique({
    where: { id: paymentId },
    include: {
      loan: true,
    },
  });

  if (!currentPayment) {
    return NextResponse.json(
      { error: "Платёж не найден" },
      { status: 404 }
    );
  }

  if (applyScope === "FUTURE") {
    const futurePayments = await prisma.loanPayment.findMany({
      where: {
        loanId: currentPayment.loanId,
        paymentDate: {
          gte: currentPayment.paymentDate,
        },
      },
      orderBy: {
        paymentDate: "asc",
      },
    });

    const oldSecondDate = futurePayments[1]?.paymentDate;
    const fallbackDaysDelta = oldSecondDate
      ? Math.max(
          1,
          Math.round(
            (oldSecondDate.getTime() - currentPayment.paymentDate.getTime()) /
              (24 * 60 * 60 * 1000)
          )
        )
      : 30;

    const updatedPaymentIds = futurePayments.map((payment) => payment.id);

    await prisma.$transaction([
      prisma.loan.update({
        where: {
          id: currentPayment.loanId,
        },
        data: {
          paymentFrequency,
        },
      }),

      ...futurePayments.map((payment, index) =>
        prisma.loanPayment.update({
          where: {
            id: payment.id,
          },
          data: {
            paymentDate: buildFutureDate(
              paymentDate,
              index,
              paymentFrequency,
              fallbackDaysDelta
            ),
            principalAmount,
            interestAmount,
            totalAmount,
          },
        })
      ),
    ]);

    for (const id of updatedPaymentIds) {
      await upsertFinanceTransactionForLoanPayment(id);
    }
  } else {
    await prisma.loanPayment.update({
      where: {
        id: paymentId,
      },
      data: {
        paymentDate,
        principalAmount,
        interestAmount,
        totalAmount,
      },
    });

    await upsertFinanceTransactionForLoanPayment(paymentId);
  }

  return NextResponse.redirect(new URL("/finance/calendar", req.url));
}