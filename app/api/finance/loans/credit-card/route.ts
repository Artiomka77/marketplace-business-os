import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

function parseMoney(value: FormDataEntryValue | null) {
  if (value === null || value === undefined) return 0;

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace("₽", "")
    .replace(",", ".")
    .trim();

  const number = Number(normalized);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function parsePercent(value: FormDataEntryValue | null) {
  const number = parseMoney(value);
  return number > 0 ? number : 0;
}

function parseOptionalDate(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  const date = new Date(`${raw}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function redirectBack(request: Request, params: URLSearchParams) {
  const url = new URL("/finance/loans", request.url);
  url.search = params.toString();
  url.hash = "credit-card-editor";

  return NextResponse.redirect(url);
}

export async function POST(request: Request) {
  const formData = await request.formData();

  const loanId = String(formData.get("loanId") ?? "").trim();
  const returnCompany =
    String(formData.get("returnCompany") ?? "ALL").trim() || "ALL";
  const returnPeriod = String(formData.get("returnPeriod") ?? "").trim();

  const backParams = new URLSearchParams();
  backParams.set("company", returnCompany);
  if (returnPeriod) backParams.set("period", returnPeriod);
  if (loanId) backParams.set("card", loanId);

  if (!loanId) {
    return redirectBack(request, backParams);
  }

  const loan = await prisma.loan.findUnique({
    where: { id: loanId },
  });

  if (!loan) {
    return redirectBack(request, backParams);
  }

  const currentDebt = parseMoney(formData.get("currentDebt"));
  const creditLimit = parseMoney(formData.get("creditLimit"));
  const minimumPaymentInput = parseMoney(formData.get("minimumPayment"));
  const minimumPaymentPercent = parsePercent(
    formData.get("minimumPaymentPercent"),
  );
  const minimumPaymentDate = parseOptionalDate(
    formData.get("minimumPaymentDate"),
  );
  const gracePeriodDate = parseOptionalDate(formData.get("gracePeriodDate"));
  const interestRate = parsePercent(formData.get("interestRate"));
  const paymentFrequencyRaw = String(
    formData.get("paymentFrequency") ?? "MONTHLY",
  ).trim();
  const paymentFrequency =
    paymentFrequencyRaw === "CUSTOM" ? "CUSTOM" : "MONTHLY";

  const minimumPayment =
    minimumPaymentInput > 0
      ? minimumPaymentInput
      : currentDebt > 0 && minimumPaymentPercent > 0
        ? Math.round(currentDebt * minimumPaymentPercent) / 100
        : 0;

  await prisma.$transaction(async (tx) => {
    const oldFuturePayments = await tx.loanPayment.findMany({
      where: {
        loanId,
        paid: false,
      },
      select: { id: true },
    });

    const oldPaymentIds = oldFuturePayments.map((payment) => payment.id);

    await tx.financeTransaction.deleteMany({
      where: {
        companyName: loan.companyName,
        transactionStatus: "PLAN",
        OR: [
          { sourceId: loanId },
          ...(oldPaymentIds.length > 0
            ? [{ sourceId: { in: oldPaymentIds } }]
            : []),
        ],
      },
    });

    await tx.loanPayment.deleteMany({
      where: {
        loanId,
        paid: false,
      },
    });

    const updatedLoan = await tx.loan.update({
      where: { id: loanId },
      data: {
        currentDebt,
        creditLimit,
        monthlyPayment: minimumPayment,
        interestRate,
        endDate: gracePeriodDate,
        paymentFrequency,
      },
    });

    if (minimumPayment > 0 && minimumPaymentDate) {
      const payment = await tx.loanPayment.create({
        data: {
          loanId,
          paymentDate: minimumPaymentDate,
          principalAmount: minimumPayment,
          interestAmount: 0,
          totalAmount: minimumPayment,
          paid: false,
        },
      });

      await tx.financeTransaction.create({
        data: {
          companyId: updatedLoan.companyId,
          companyName: updatedLoan.companyName,
          operationDate: minimumPaymentDate,
          obligationDate: minimumPaymentDate,
          operationType: "FINANCING",
          category: "Кредитные карты",
          subcategory: "Минимальный платёж",
          counterparty: updatedLoan.bankName,
          amount: minimumPayment,
          comment: `Минимальный платёж по кредитной карте: ${updatedLoan.bankName}`,
          transactionStatus: "PLAN",
          sourceType: "CREDIT_CARD_MIN_PAYMENT",
          sourceId: payment.id,
        },
      });
    }
  });

  return redirectBack(request, backParams);
}
