import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

function parseMoney(value: FormDataEntryValue | null) {
  const text = String(value ?? "")
    .replace(/\s/g, "")
    .replace(",", ".")
    .trim();

  const number = Number(text);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function parseDate(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }

  return new Date(`${text}T00:00:00`);
}

function getString(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function toNumber(value: unknown) {
  if (value === null || value === undefined) return 0;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "object" && "toNumber" in value) {
    const decimalValue = value as { toNumber: () => number };
    const number = decimalValue.toNumber();
    return Number.isFinite(number) ? number : 0;
  }

  const number = Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(number) ? number : 0;
}

async function ensureFinanceCategory(params: {
  name: string;
  categoryType: string;
  profitTreatment: string;
  sortOrder: number;
}) {
  const existing = await prisma.financeCategory.findFirst({
    where: {
      name: params.name,
      categoryType: params.categoryType,
    },
  });

  if (existing) return existing;

  return prisma.financeCategory.create({
    data: {
      name: params.name,
      categoryType: params.categoryType,
      profitTreatment: params.profitTreatment,
      sortOrder: params.sortOrder,
      isActive: true,
    },
  });
}

function buildRedirectPath(params: {
  company: string;
  period: string;
  status: "created" | "error";
  message?: string;
}) {
  const searchParams = new URLSearchParams();

  searchParams.set("company", params.company || "ALL");
  if (params.period) searchParams.set("period", params.period);
  searchParams.set("repayment", params.status);
  if (params.message) {
    searchParams.set("message", params.message.slice(0, 220));
  }

  const hash = params.status === "created" ? "all-loans" : "early-repayment";

  return `/finance/loans?${searchParams.toString()}#${hash}`;
}

function redirectToLoans(params: {
  company: string;
  period: string;
  status: "created" | "error";
  message?: string;
}) {
  return new NextResponse(null, {
    status: 303,
    headers: {
      Location: buildRedirectPath(params),
    },
  });
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();

  const loanId = getString(formData, "loanId");
  const returnCompany = getString(formData, "returnCompany") || "ALL";
  const returnPeriod = getString(formData, "returnPeriod");

  try {
    const repaymentMode = getString(formData, "repaymentMode") || "FULL";
    const operationDate = parseDate(formData.get("operationDate"));
    const principalAmount = parseMoney(formData.get("principalAmount"));
    const interestAmount = parseMoney(formData.get("interestAmount"));
    const bankAccount = getString(formData, "bankAccount") || null;
    const comment = getString(formData, "comment") || null;

    if (!loanId) {
      throw new Error("Кредит не выбран.");
    }

    if (!operationDate) {
      throw new Error("Укажи дату операции.");
    }

    if (principalAmount <= 0 && interestAmount <= 0) {
      throw new Error("Сумма погашения должна быть больше нуля.");
    }

    await ensureFinanceCategory({
      name: "Погашение кредита",
      categoryType: "EXPENSE",
      profitTreatment: "CREDIT_PRINCIPAL",
      sortOrder: 800,
    });

    await ensureFinanceCategory({
      name: "Проценты кредита",
      categoryType: "EXPENSE",
      profitTreatment: "CREDIT_INTEREST",
      sortOrder: 810,
    });

    await prisma.$transaction(async (tx) => {
      const loan = await tx.loan.findUnique({
        where: {
          id: loanId,
        },
      });

      if (!loan) {
        throw new Error("Кредит не найден.");
      }

      const currentDebt = toNumber(loan.currentDebt);

      if (currentDebt <= 0 && principalAmount > 0) {
        throw new Error("Кредит уже закрыт: текущий долг равен 0 ₽.");
      }

      if (principalAmount > currentDebt + 1) {
        throw new Error(
          `Сумма тела больше текущего долга: ${Math.round(currentDebt)} ₽.`
        );
      }

      const isFullRepayment =
        repaymentMode === "FULL" || principalAmount >= Math.max(0, currentDebt - 1);

      const newDebt = isFullRepayment
        ? 0
        : Math.max(0, currentDebt - principalAmount);

      const baseComment = comment || `Досрочное погашение ${loan.bankName}`;

      const futurePayments = isFullRepayment
        ? await tx.loanPayment.findMany({
            where: {
              loanId: loan.id,
              paymentDate: {
                gte: operationDate,
              },
              paid: false,
            },
            select: {
              id: true,
            },
          })
        : [];

      const futurePaymentIds = futurePayments.map((payment) => payment.id);

      if (isFullRepayment) {
        await tx.financeTransaction.deleteMany({
          where: {
            companyName: loan.companyName,
            operationDate: {
              gte: operationDate,
            },
            sourceType: {
              in: ["LOAN_PAYMENT_PRINCIPAL", "LOAN_PAYMENT_INTEREST"],
            },
            OR: [
              ...(futurePaymentIds.length > 0
                ? [
                    {
                      sourceId: {
                        in: futurePaymentIds,
                      },
                    },
                  ]
                : []),
              { sourceId: loan.id },
              { counterparty: loan.bankName },
              { bankAccount: loan.bankName },
              {
                comment: {
                  contains: loan.bankName,
                  mode: "insensitive",
                },
              },
            ],
          },
        });
      }

      if (principalAmount > 0) {
        await tx.financeTransaction.create({
          data: {
            companyId: loan.companyId,
            companyName: loan.companyName,
            operationDate,
            operationType: "EXPENSE",
            category: "Погашение кредита",
            subcategory: "Тело кредита",
            counterparty: loan.bankName,
            amount: principalAmount,
            bankAccount,
            comment: `${baseComment}. Тело кредита.`,
            sourceType: "LOAN_EARLY_REPAYMENT",
            sourceId: loan.id,
          },
        });
      }

      if (interestAmount > 0) {
        await tx.financeTransaction.create({
          data: {
            companyId: loan.companyId,
            companyName: loan.companyName,
            operationDate,
            operationType: "EXPENSE",
            category: "Проценты кредита",
            subcategory: "Проценты",
            counterparty: loan.bankName,
            amount: interestAmount,
            bankAccount,
            comment: `${baseComment}. Проценты кредита.`,
            sourceType: "LOAN_EARLY_REPAYMENT",
            sourceId: loan.id,
          },
        });
      }

      await tx.loan.update({
        where: {
          id: loan.id,
        },
        data: {
          currentDebt: newDebt,
          monthlyPayment: isFullRepayment ? 0 : loan.monthlyPayment,
          endDate: isFullRepayment ? operationDate : loan.endDate,
        },
      });

      if (isFullRepayment) {
        await tx.loanPayment.updateMany({
          where: {
            loanId: loan.id,
            paymentDate: {
              gte: operationDate,
            },
            paid: false,
          },
          data: {
            paid: true,
          },
        });
      }
    });

    revalidatePath("/finance/loans");
    revalidatePath("/finance/operations");
    revalidatePath("/finance");
    revalidatePath("/");

    return redirectToLoans({
      company: returnCompany,
      period: returnPeriod,
      status: "created",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Неизвестная ошибка";

    return redirectToLoans({
      company: returnCompany,
      period: returnPeriod,
      status: "error",
      message,
    });
  }
}
