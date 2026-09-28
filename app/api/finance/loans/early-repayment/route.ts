import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type ScheduleStrategy = "REDUCE_PAYMENT" | "SHORTEN_TERM";

type GeneratedPayment = {
  paymentDate: Date;
  principalAmount: number;
  interestAmount: number;
  totalAmount: number;
};

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

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addMonths(date: Date, months: number) {
  const result = new Date(date);
  const day = result.getDate();

  result.setMonth(result.getMonth() + months, 1);

  const lastDay = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  result.setDate(Math.min(day, lastDay));

  return result;
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function getPaymentsPerYear(paymentFrequency: string | null | undefined) {
  if (paymentFrequency === "WEEKLY") return 52;
  if (paymentFrequency === "BIWEEKLY") return 26;
  if (paymentFrequency === "TWICE_MONTHLY_15_25") return 24;
  return 12;
}

function getNextPaymentDate(date: Date, paymentFrequency: string | null | undefined) {
  if (paymentFrequency === "WEEKLY") return addDays(date, 7);
  if (paymentFrequency === "BIWEEKLY") return addDays(date, 14);

  if (paymentFrequency === "TWICE_MONTHLY_15_25") {
    const day = date.getDate();

    if (day < 15) {
      return new Date(date.getFullYear(), date.getMonth(), 15);
    }

    if (day < 25) {
      return new Date(date.getFullYear(), date.getMonth(), 25);
    }

    return new Date(date.getFullYear(), date.getMonth() + 1, 15);
  }

  return addMonths(date, 1);
}

function buildPaymentDates(params: {
  firstPaymentDate: Date;
  endDate: Date;
  paymentFrequency: string | null | undefined;
}) {
  const dates: Date[] = [];
  let current = startOfDay(params.firstPaymentDate);
  const end = startOfDay(params.endDate);

  for (let index = 0; index < 600; index += 1) {
    if (current > end) break;
    dates.push(current);
    current = getNextPaymentDate(current, params.paymentFrequency);
  }

  return dates;
}

function buildReducedPaymentSchedule(params: {
  debt: number;
  annualRate: number;
  firstPaymentDate: Date;
  endDate: Date;
  paymentFrequency: string | null | undefined;
}) {
  const dates = buildPaymentDates({
    firstPaymentDate: params.firstPaymentDate,
    endDate: params.endDate,
    paymentFrequency: params.paymentFrequency,
  });

  if (dates.length === 0) {
    throw new Error("Для нового графика нет будущих дат платежей.");
  }

  const paymentsPerYear = getPaymentsPerYear(params.paymentFrequency);
  const periodRate = params.annualRate > 0 ? params.annualRate / 100 / paymentsPerYear : 0;
  const paymentAmount =
    periodRate > 0
      ? params.debt * (periodRate / (1 - Math.pow(1 + periodRate, -dates.length)))
      : params.debt / dates.length;

  let remainingDebt = params.debt;
  const schedule: GeneratedPayment[] = [];

  for (const paymentDate of dates) {
    if (remainingDebt <= 0.01) break;

    const interestAmount = roundMoney(remainingDebt * periodRate);
    const isLastPayment = paymentDate.getTime() === dates[dates.length - 1].getTime();
    const principalAmount = isLastPayment
      ? roundMoney(remainingDebt)
      : roundMoney(Math.min(remainingDebt, Math.max(0, paymentAmount - interestAmount)));
    const totalAmount = roundMoney(principalAmount + interestAmount);

    if (principalAmount <= 0 && remainingDebt > 0) {
      throw new Error("Новый платёж не покрывает проценты. Увеличь платёж или проверь ставку.");
    }

    schedule.push({
      paymentDate,
      principalAmount,
      interestAmount,
      totalAmount,
    });

    remainingDebt = roundMoney(remainingDebt - principalAmount);
  }

  return schedule;
}

function buildShortenedTermSchedule(params: {
  debt: number;
  annualRate: number;
  firstPaymentDate: Date;
  regularPayment: number;
  paymentFrequency: string | null | undefined;
}) {
  const paymentsPerYear = getPaymentsPerYear(params.paymentFrequency);
  const periodRate = params.annualRate > 0 ? params.annualRate / 100 / paymentsPerYear : 0;
  const firstInterest = roundMoney(params.debt * periodRate);

  if (params.regularPayment <= firstInterest) {
    throw new Error(
      "Новый регулярный платёж не покрывает проценты. Увеличь платёж или проверь ставку."
    );
  }

  let paymentDate = startOfDay(params.firstPaymentDate);
  let remainingDebt = params.debt;
  const schedule: GeneratedPayment[] = [];

  for (let index = 0; index < 600; index += 1) {
    if (remainingDebt <= 0.01) break;

    const interestAmount = roundMoney(remainingDebt * periodRate);
    const principalAmount = roundMoney(
      Math.min(remainingDebt, Math.max(0, params.regularPayment - interestAmount))
    );
    const totalAmount = roundMoney(principalAmount + interestAmount);

    if (principalAmount <= 0 && remainingDebt > 0) {
      throw new Error("Новый платёж не уменьшает тело кредита. Увеличь платёж.");
    }

    schedule.push({
      paymentDate,
      principalAmount,
      interestAmount,
      totalAmount,
    });

    remainingDebt = roundMoney(remainingDebt - principalAmount);
    paymentDate = getNextPaymentDate(paymentDate, params.paymentFrequency);
  }

  if (remainingDebt > 1) {
    throw new Error("Не удалось построить новый график: слишком много будущих платежей.");
  }

  return schedule;
}

function buildPartialSchedule(params: {
  strategy: ScheduleStrategy;
  debt: number;
  annualRate: number;
  firstPaymentDate: Date;
  endDate: Date | null;
  regularPayment: number;
  paymentFrequency: string | null | undefined;
}) {
  if (params.debt <= 0) return [];

  if (params.annualRate < 0 || params.annualRate > 300) {
    throw new Error("Проверь ставку для пересчёта графика.");
  }

  if (params.strategy === "REDUCE_PAYMENT") {
    if (!params.endDate) {
      throw new Error("Для варианта уменьшения платежа укажи дату окончания кредита.");
    }

    return buildReducedPaymentSchedule({
      debt: params.debt,
      annualRate: params.annualRate,
      firstPaymentDate: params.firstPaymentDate,
      endDate: params.endDate,
      paymentFrequency: params.paymentFrequency,
    });
  }

  if (params.regularPayment <= 0) {
    throw new Error("Для сокращения срока укажи новый регулярный платёж.");
  }

  return buildShortenedTermSchedule({
    debt: params.debt,
    annualRate: params.annualRate,
    firstPaymentDate: params.firstPaymentDate,
    regularPayment: params.regularPayment,
    paymentFrequency: params.paymentFrequency,
  });
}

function estimateMonthlyPayment(schedule: GeneratedPayment[], paymentFrequency: string | null | undefined) {
  if (schedule.length === 0) return 0;

  const regularPayment = schedule[0]?.totalAmount ?? 0;
  return roundMoney((regularPayment * getPaymentsPerYear(paymentFrequency)) / 12);
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
    const scheduleStrategy =
      getString(formData, "scheduleStrategy") === "SHORTEN_TERM"
        ? "SHORTEN_TERM"
        : "REDUCE_PAYMENT";
    const operationDate = parseDate(formData.get("operationDate"));
    const principalAmount = parseMoney(formData.get("principalAmount"));
    const interestAmount = parseMoney(formData.get("interestAmount"));
    const firstNewPaymentDate = parseDate(formData.get("firstNewPaymentDate"));
    const scheduleEndDate = parseDate(formData.get("scheduleEndDate"));
    const scheduleAnnualRate = parseMoney(formData.get("scheduleAnnualRate"));
    const newRegularPayment = parseMoney(formData.get("newRegularPayment"));
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

    await ensureFinanceCategory({
      name: "Тело кредита",
      categoryType: "FINANCING",
      profitTreatment: "CREDIT_PRINCIPAL",
      sortOrder: 805,
    });

    await ensureFinanceCategory({
      name: "Проценты по кредиту",
      categoryType: "EXPENSE",
      profitTreatment: "CREDIT_INTEREST",
      sortOrder: 815,
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

      if (repaymentMode === "PARTIAL" && isFullRepayment) {
        throw new Error(
          "Для полного закрытия выбери тип 'Полное погашение'. Для частичного погашения сумма тела должна быть меньше текущего долга."
        );
      }

      const newDebt = isFullRepayment
        ? 0
        : roundMoney(Math.max(0, currentDebt - principalAmount));

      const baseComment = comment || `Досрочное погашение ${loan.bankName}`;

      const futurePayments = await tx.loanPayment.findMany({
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
      });

      const futurePaymentIds = futurePayments.map((payment) => payment.id);

      if (isFullRepayment || repaymentMode === "PARTIAL") {
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

      let generatedSchedule: GeneratedPayment[] = [];

      if (!isFullRepayment) {
        if (!firstNewPaymentDate) {
          throw new Error("Для частичного погашения укажи дату первого платежа нового графика.");
        }

        if (firstNewPaymentDate < operationDate) {
          throw new Error("Дата первого платежа нового графика не может быть раньше даты погашения.");
        }

        generatedSchedule = buildPartialSchedule({
          strategy: scheduleStrategy,
          debt: newDebt,
          annualRate: scheduleAnnualRate,
          firstPaymentDate: firstNewPaymentDate,
          endDate: scheduleEndDate,
          regularPayment: newRegularPayment,
          paymentFrequency: loan.paymentFrequency,
        });

        if (generatedSchedule.length === 0) {
          throw new Error("Новый график платежей пустой.");
        }
      }

      if (isFullRepayment || repaymentMode === "PARTIAL") {
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

      for (const payment of generatedSchedule) {
        const createdPayment = await tx.loanPayment.create({
          data: {
            loanId: loan.id,
            paymentDate: payment.paymentDate,
            principalAmount: payment.principalAmount,
            interestAmount: payment.interestAmount,
            totalAmount: payment.totalAmount,
            paid: false,
          },
          select: {
            id: true,
          },
        });

        if (payment.principalAmount > 0) {
          await tx.financeTransaction.create({
            data: {
              companyId: loan.companyId,
              companyName: loan.companyName,
              operationDate: payment.paymentDate,
              obligationDate: payment.paymentDate,
              operationType: "FINANCING",
              category: "Тело кредита",
              subcategory: loan.bankName,
              counterparty: loan.bankName,
              amount: payment.principalAmount,
              bankAccount: null,
              comment: `Новый график после частичного досрочного погашения: ${loan.bankName}. Итого платеж: ${payment.totalAmount}, тело: ${payment.principalAmount}, проценты: ${payment.interestAmount}`,
              sourceType: "LOAN_PAYMENT_PRINCIPAL",
              sourceId: createdPayment.id,
            },
          });
        }

        if (payment.interestAmount > 0) {
          await tx.financeTransaction.create({
            data: {
              companyId: loan.companyId,
              companyName: loan.companyName,
              operationDate: payment.paymentDate,
              obligationDate: payment.paymentDate,
              operationType: "EXPENSE",
              category: "Проценты по кредиту",
              subcategory: loan.bankName,
              counterparty: loan.bankName,
              amount: payment.interestAmount,
              bankAccount: null,
              comment: `Новый график после частичного досрочного погашения: ${loan.bankName}. Итого платеж: ${payment.totalAmount}, тело: ${payment.principalAmount}, проценты: ${payment.interestAmount}`,
              sourceType: "LOAN_PAYMENT_INTEREST",
              sourceId: createdPayment.id,
            },
          });
        }
      }

      const lastGeneratedPayment = generatedSchedule[generatedSchedule.length - 1] ?? null;
      const estimatedMonthly = generatedSchedule.length > 0
        ? estimateMonthlyPayment(generatedSchedule, loan.paymentFrequency)
        : 0;

      await tx.loan.update({
        where: {
          id: loan.id,
        },
        data: {
          currentDebt: newDebt,
          monthlyPayment: isFullRepayment ? 0 : estimatedMonthly,
          endDate: isFullRepayment
            ? operationDate
            : lastGeneratedPayment?.paymentDate ?? loan.endDate,
        },
      });
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
