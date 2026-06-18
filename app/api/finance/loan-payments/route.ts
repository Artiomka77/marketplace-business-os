import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

function toNumber(value: unknown) {
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

  if (frequency === "TWICE_MONTHLY_15_25") {
    const baseMonth = new Date(
      baseDate.getFullYear(),
      baseDate.getMonth(),
      1,
      12
    );

    const monthOffset = Math.floor(index / 2);
    const day = index % 2 === 0 ? 15 : 25;

    return new Date(
      baseMonth.getFullYear(),
      baseMonth.getMonth() + monthOffset,
      day,
      12,
      0,
      0,
      0
    );
  }

  return addDays(baseDate, fallbackDaysDelta * index);
}

type LoanPaymentWithLoan = {
  id: string;
  paymentDate: Date;
  totalAmount: unknown;
  principalAmount: unknown;
  interestAmount: unknown;
  loan: {
    companyName: string;
    bankName: string;
  };
};

function getLoanPaymentAmounts(payment: LoanPaymentWithLoan) {
  const totalAmount = toNumber(payment.totalAmount);
  const principalAmount = toNumber(payment.principalAmount);
  const interestAmount = toNumber(payment.interestAmount);

  return {
    totalAmount,
    principalAmount,
    interestAmount,
  };
}

function principalTransactionData(payment: LoanPaymentWithLoan) {
  const amounts = getLoanPaymentAmounts(payment);

  return {
    companyName: payment.loan.companyName,
    operationDate: payment.paymentDate,
    obligationDate: payment.paymentDate,
    operationType: "FINANCING",
    category: "Тело кредита",
    subcategory: payment.loan.bankName,
    counterparty: payment.loan.bankName,
    amount: amounts.principalAmount,
    bankAccount: null,
    project: "Кредиты",
    comment: `Тело кредитного платежа: ${payment.loan.bankName}. Итого платеж: ${amounts.totalAmount}, тело: ${amounts.principalAmount}, проценты: ${amounts.interestAmount}`,
    isInternalTransfer: false,
    transactionStatus: "PLAN",
    sourceType: "LOAN_PAYMENT_PRINCIPAL",
    sourceId: payment.id,
  };
}

function interestTransactionData(payment: LoanPaymentWithLoan) {
  const amounts = getLoanPaymentAmounts(payment);

  return {
    companyName: payment.loan.companyName,
    operationDate: payment.paymentDate,
    obligationDate: payment.paymentDate,
    operationType: "EXPENSE",
    category: "Проценты по кредиту",
    subcategory: payment.loan.bankName,
    counterparty: payment.loan.bankName,
    amount: amounts.interestAmount,
    bankAccount: null,
    project: "Кредиты",
    comment: `Проценты по кредитному платежу: ${payment.loan.bankName}. Итого платеж: ${amounts.totalAmount}, тело: ${amounts.principalAmount}, проценты: ${amounts.interestAmount}`,
    isInternalTransfer: false,
    transactionStatus: "PLAN",
    sourceType: "LOAN_PAYMENT_INTEREST",
    sourceId: payment.id,
  };
}

function legacyLoanPaymentSourceTypes() {
  return [
    "LOAN_PAYMENT",
    "LOAN_PAYMENT_PRINCIPAL",
    "LOAN_PAYMENT_INTEREST",
  ];
}

async function deleteFinanceTransactionsForLoanPayment(paymentId: string) {
  await prisma.financeTransaction.deleteMany({
    where: {
      sourceId: paymentId,
      sourceType: {
        in: legacyLoanPaymentSourceTypes(),
      },
    },
  });
}

async function syncFinanceTransactionsForLoanPayment(paymentId: string) {
  const payment = await prisma.loanPayment.findUnique({
    where: { id: paymentId },
    include: { loan: true },
  });

  if (!payment) return;

  const amounts = getLoanPaymentAmounts(payment);

  await deleteFinanceTransactionsForLoanPayment(payment.id);

  const createData = [];

  if (amounts.principalAmount > 0) {
    createData.push(principalTransactionData(payment));
  }

  if (amounts.interestAmount > 0) {
    createData.push(interestTransactionData(payment));
  }

  if (createData.length === 0) return;

  await prisma.financeTransaction.createMany({
    data: createData,
  });
}

async function deleteFinanceTransactionsForLoanPayments(paymentIds: string[]) {
  if (paymentIds.length === 0) return;

  await prisma.financeTransaction.deleteMany({
    where: {
      sourceId: {
        in: paymentIds,
      },
      sourceType: {
        in: legacyLoanPaymentSourceTypes(),
      },
    },
  });
}

async function syncLoanPaymentTransactions(paymentIds: string[]) {
  for (const id of paymentIds) {
    await syncFinanceTransactionsForLoanPayment(id);
  }
}

export async function POST(req: Request) {
  const formData = await req.formData();

  const action = String(formData.get("action") ?? "UPDATE");
  const loanId = String(formData.get("loanId") ?? "").trim();
  const paymentId = String(formData.get("paymentId") ?? "").trim();
  const redirectTo = String(formData.get("redirectTo") ?? "/finance/calendar");

  const paymentDate = toDate(formData.get("paymentDate"));
  const applyScope = String(formData.get("applyScope") ?? "ONE");
  const paymentFrequency = String(formData.get("paymentFrequency") ?? "MONTHLY");

  const principalAmount = toNumber(formData.get("principalAmount"));
  const interestAmount = toNumber(formData.get("interestAmount"));
  const totalAmount = toNumber(formData.get("totalAmount"));

  if (action === "DELETE") {
    if (!paymentId) {
      return NextResponse.json(
        { error: "ID платежа обязателен" },
        { status: 400 }
      );
    }

    await deleteFinanceTransactionsForLoanPayment(paymentId);

    await prisma.loanPayment.delete({
      where: { id: paymentId },
    });

    return NextResponse.redirect(new URL(redirectTo, req.url));
  }

  if (action === "CREATE") {
    if (!loanId || !paymentDate || totalAmount <= 0) {
      return NextResponse.json(
        { error: "Кредит, дата и сумма обязательны" },
        { status: 400 }
      );
    }

    const payment = await prisma.loanPayment.create({
      data: {
        loanId,
        paymentDate,
        principalAmount,
        interestAmount,
        totalAmount,
      },
    });

    await syncFinanceTransactionsForLoanPayment(payment.id);

    return NextResponse.redirect(new URL(redirectTo, req.url));
  }

  if (action === "REBUILD") {
    if (!loanId || !paymentDate || totalAmount <= 0) {
      return NextResponse.json(
        { error: "Кредит, дата первого платежа и сумма обязательны" },
        { status: 400 }
      );
    }

    const loan = await prisma.loan.findUnique({
      where: { id: loanId },
      include: {
        payments: {
          orderBy: {
            paymentDate: "asc",
          },
        },
      },
    });

    if (!loan) {
      return NextResponse.json({ error: "Кредит не найден" }, { status: 404 });
    }

    const paymentsCountRaw = Number(formData.get("paymentsCount") ?? 0);
    const paymentsCount =
      paymentsCountRaw > 0 ? paymentsCountRaw : loan.payments.length;

    if (paymentsCount <= 0) {
      return NextResponse.json(
        { error: "Нет платежей для перестроения" },
        { status: 400 }
      );
    }

    const existingPaymentIds = loan.payments.map((payment) => payment.id);

    await prisma.$transaction([
      prisma.financeTransaction.deleteMany({
        where: {
          sourceId: {
            in: existingPaymentIds,
          },
          sourceType: {
            in: legacyLoanPaymentSourceTypes(),
          },
        },
      }),

      prisma.loanPayment.deleteMany({
        where: {
          loanId,
        },
      }),

      prisma.loan.update({
        where: {
          id: loanId,
        },
        data: {
          paymentFrequency,
          monthlyPayment: totalAmount,
        },
      }),
    ]);

    const createdPayments = [];

    for (let index = 0; index < paymentsCount; index++) {
      const newPayment = await prisma.loanPayment.create({
        data: {
          loanId,
          paymentDate: buildFutureDate(paymentDate, index, paymentFrequency, 30),
          principalAmount,
          interestAmount,
          totalAmount,
        },
      });

      createdPayments.push(newPayment);
    }

    await syncLoanPaymentTransactions(
      createdPayments.map((payment) => payment.id)
    );

    return NextResponse.redirect(new URL(redirectTo, req.url));
  }

  if (!paymentId || !paymentDate || totalAmount <= 0) {
    return NextResponse.json(
      { error: "Платёж, дата и сумма обязательны" },
      { status: 400 }
    );
  }

  const currentPayment = await prisma.loanPayment.findUnique({
    where: { id: paymentId },
    include: { loan: true },
  });

  if (!currentPayment) {
    return NextResponse.json({ error: "Платёж не найден" }, { status: 404 });
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
          monthlyPayment: totalAmount,
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

    await syncLoanPaymentTransactions(updatedPaymentIds);
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

    await syncFinanceTransactionsForLoanPayment(paymentId);
  }

  return NextResponse.redirect(new URL(redirectTo, req.url));
}