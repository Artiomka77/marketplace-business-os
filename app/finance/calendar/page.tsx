import Link from "next/link";

import { prisma } from "@/lib/prisma";
import {
  buildFinanceCategoryTreatmentIndex,
  getFinanceTransactionCashEffect,
  getFinanceTransactionTreatment,
} from "@/lib/finance/financeMetrics";

function formatMoney(value: unknown) {
  const number = Number(value ?? 0);

  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(number) ? number : 0);
}

function formatDate(date: Date) {
  return date.toLocaleDateString("ru-RU");
}

function inputDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function formatMonth(date: Date) {
  return date.toLocaleDateString("ru-RU", {
    month: "long",
    year: "numeric",
  });
}

function toMonthDate(value?: string) {
  if (!value) return new Date();

  const [year, month] = value.split("-").map(Number);
  if (!year || !month) return new Date();

  return new Date(year, month - 1, 1);
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0"
  )}`;
}

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date: Date) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999
  );
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date) {
  return new Date(
    date.getFullYear(),
    date.getMonth() + 1,
    0,
    23,
    59,
    59,
    999
  );
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function addMonths(date: Date, count: number) {
  return new Date(date.getFullYear(), date.getMonth() + count, 1);
}

function getAmount(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function frequencyLabel(value: string | null | undefined) {
  if (value === "WEEKLY") return "Еженедельно";
  if (value === "BIWEEKLY") return "Раз в 2 недели";
  if (value === "CUSTOM") return "Индивидуально";
  return "Ежемесячно";
}

function loanBadge(name: string) {
  const lower = name.toLowerCase();

  if (lower.includes("озон")) return "OZ";
  if (lower.includes("wb")) return "WB";
  if (lower.includes("sell")) return "SP";
  if (lower.includes("альфа")) return "A";
  if (lower.includes("сбер")) return "SB";
  if (lower.includes("урал")) return "UR";

  return "₽";
}

function daysUntil(date: Date, today: Date) {
  const diff = startOfDay(date).getTime() - startOfDay(today).getTime();
  return Math.round(diff / (24 * 60 * 60 * 1000));
}

function paymentStatus(date: Date, today: Date) {
  const days = daysUntil(date, today);

  if (days < 0) {
    return {
      label: "Просрочен",
      className: "bg-red-100 text-red-700",
    };
  }

  if (days === 0) {
    return {
      label: "Сегодня",
      className: "bg-amber-100 text-amber-700",
    };
  }

  if (days === 1) {
    return {
      label: "Завтра",
      className: "bg-blue-100 text-blue-700",
    };
  }

  return {
    label: `Через ${days} дн.`,
    className: "bg-slate-100 text-slate-700",
  };
}

function loanPaymentTotal(payment: {
  totalAmount: unknown;
  principalAmount: unknown;
  interestAmount: unknown;
}) {
  return (
    getAmount(payment.totalAmount) ||
    getAmount(payment.principalAmount) + getAmount(payment.interestAmount)
  );
}

function obligationTypeLabelByTreatment(params: {
  treatment: string;
  category: string;
  operationType: string;
}) {
  const text = `${params.category} ${params.operationType}`.toLowerCase();

  if (params.treatment === "OWNER_WITHDRAWAL") return "Личное";
  if (params.treatment === "CASH_ONLY") return "Только ДДС";
  if (params.treatment === "INCLUDE_IN_NET_PROFIT") {
    if (text.includes("налог") || text.includes("взнос")) return "Налог";
    if (text.includes("постав") || text.includes("закуп")) return "Поставщик";
    if (text.includes("зарплат")) return "Зарплата";
    return "Расход";
  }

  return "Прочее";
}

function buildMonthHref(month: string, company: string) {
  const query = new URLSearchParams();

  query.set("month", month);
  query.set("company", company);

  return `/finance/calendar?${query.toString()}`;
}

type CalendarItem = {
  id: string;
  source: "LOAN" | "OBLIGATION";
  date: Date;
  companyName: string;
  title: string;
  category: string;
  counterparty: string;
  amount: number;
  principal: number;
  interest: number;
  typeLabel: string;
  treatmentLabel: string;
  treatmentClassName: string;

  loanPaymentId?: string;
  loanBankName?: string;
  loanCompanyName?: string;
  loanPaymentFrequency?: string | null;
  loanPaymentDate?: Date;
  loanPrincipalAmount?: number;
  loanInterestAmount?: number;
  loanTotalAmount?: number;
  loanDebtAfterPayment?: number;
};

export default async function FinanceCalendarPage({
  searchParams,
}: {
  searchParams?: Promise<{
    month?: string;
    company?: string;
  }>;
}) {
  const params = searchParams ? await searchParams : {};

  const selectedCompany = params.company ?? "ALL";
  const companyName = selectedCompany !== "ALL" ? selectedCompany : null;

  const today = startOfDay(new Date());
  const todayEnd = endOfDay(today);
  const sevenDaysEnd = endOfDay(addDays(today, 6));
  const thirtyDaysEnd = endOfDay(addDays(today, 29));

  const selectedMonth = toMonthDate(params.month);
  const monthStart = startOfMonth(selectedMonth);
  const monthEnd = endOfMonth(selectedMonth);

  const previousMonth = monthKey(addMonths(selectedMonth, -1));
  const nextMonth = monthKey(addMonths(selectedMonth, 1));

  const companies = await prisma.company.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });

  const categories = await prisma.financeCategory.findMany({
    where: {
      isActive: true,
    },
    orderBy: [
      { categoryType: "asc" },
      { sortOrder: "asc" },
      { name: "asc" },
    ],
  });

  const categoryTreatmentIndex = buildFinanceCategoryTreatmentIndex(categories);

  const selectedLoans = companyName
    ? await prisma.loan.findMany({
        where: { companyName },
        select: { id: true },
      })
    : [];

  const selectedLoanIds = selectedLoans.map((loan) => loan.id);

  const accounts = await prisma.financeAccount.findMany({
    where: {
      isActive: true,
      ...(companyName ? { companyName } : {}),
    },
  });

  const cashOnAccounts = accounts.reduce(
    (sum, account) => sum + getAmount(account.currentBalance),
    0
  );

  const loanPayments = await prisma.loanPayment.findMany({
    where: {
      paymentDate: {
        gte: monthStart,
        lte: monthEnd,
      },
      ...(companyName
        ? {
            loanId: {
              in: selectedLoanIds,
            },
          }
        : {}),
    },
    include: {
      loan: {
        include: {
          payments: {
            orderBy: {
              paymentDate: "asc",
            },
          },
        },
      },
    },
    orderBy: {
      paymentDate: "asc",
    },
  });

  const allFutureLoanPayments = await prisma.loanPayment.findMany({
    where: {
      paymentDate: {
        gte: today,
        lte: thirtyDaysEnd,
      },
      ...(companyName
        ? {
            loanId: {
              in: selectedLoanIds,
            },
          }
        : {}),
    },
    include: {
      loan: true,
    },
    orderBy: {
      paymentDate: "asc",
    },
  });

  const futureObligations = await prisma.financeTransaction.findMany({
    where: {
      obligationDate: {
        gte: monthStart,
        lte: monthEnd,
      },
      ...(companyName ? { companyName } : {}),
      operationType: {
        in: ["EXPENSE", "PERSONAL", "FINANCING"],
      },
      isInternalTransfer: false,
    },
    orderBy: {
      obligationDate: "asc",
    },
  });

  const futureObligations30Days = await prisma.financeTransaction.findMany({
    where: {
      obligationDate: {
        gte: today,
        lte: thirtyDaysEnd,
      },
      ...(companyName ? { companyName } : {}),
      operationType: {
        in: ["EXPENSE", "PERSONAL", "FINANCING"],
      },
      isInternalTransfer: false,
    },
    orderBy: {
      obligationDate: "asc",
    },
  });

  function shouldUseFinanceObligation(operation: {
    operationType: string;
    category: string;
    amount: unknown;
    subcategory?: string | null;
    isInternalTransfer?: boolean | null;
    transferDirection?: string | null;
  }) {
    const treatment = getFinanceTransactionTreatment(
      operation,
      categoryTreatmentIndex
    );

    const cashEffect = getFinanceTransactionCashEffect(
      operation,
      categoryTreatmentIndex
    );

    if (cashEffect >= 0) return false;

    if (treatment.treatment === "IGNORE") return false;
    if (treatment.treatment === "CREDIT_RECEIVED") return false;

    // Кредиты берём из LoanPayment, чтобы не задваивать график кредита
    // с будущими финансовыми операциями.
    if (treatment.treatment === "CREDIT_PRINCIPAL") return false;
    if (treatment.treatment === "CREDIT_INTEREST") return false;

    return true;
  }

  const cleanedFutureObligations = futureObligations.filter(
    shouldUseFinanceObligation
  );

  const cleanedFutureObligations30Days = futureObligations30Days.filter(
    shouldUseFinanceObligation
  );

  function remainingDebtAfterPayment(payment: (typeof loanPayments)[number]) {
    return payment.loan.payments
      .filter((loanPayment) => loanPayment.paymentDate > payment.paymentDate)
      .reduce(
        (sum, loanPayment) => sum + getAmount(loanPayment.principalAmount),
        0
      );
  }

  const calendarItems: CalendarItem[] = [
    ...loanPayments.map((payment) => ({
      id: payment.id,
      source: "LOAN" as const,
      date: payment.paymentDate,
      companyName: payment.loan.companyName,
      title: payment.loan.bankName,
      category: "Погашение кредита",
      counterparty: payment.loan.bankName,
      amount: loanPaymentTotal(payment),
      principal: getAmount(payment.principalAmount),
      interest: getAmount(payment.interestAmount),
      typeLabel: "Кредит",
      treatmentLabel: "График кредита",
      treatmentClassName: "bg-blue-50 text-blue-700 ring-blue-200",

      loanPaymentId: payment.id,
      loanBankName: payment.loan.bankName,
      loanCompanyName: payment.loan.companyName,
      loanPaymentFrequency: payment.loan.paymentFrequency,
      loanPaymentDate: payment.paymentDate,
      loanPrincipalAmount: getAmount(payment.principalAmount),
      loanInterestAmount: getAmount(payment.interestAmount),
      loanTotalAmount: loanPaymentTotal(payment),
      loanDebtAfterPayment: remainingDebtAfterPayment(payment),
    })),

    ...cleanedFutureObligations.map((operation) => {
      const treatment = getFinanceTransactionTreatment(
        operation,
        categoryTreatmentIndex
      );

      return {
        id: operation.id,
        source: "OBLIGATION" as const,
        date: operation.obligationDate ?? operation.operationDate,
        companyName: operation.companyName,
        title: operation.category,
        category: operation.category,
        counterparty: operation.counterparty ?? "—",
        amount: Math.abs(
          getFinanceTransactionCashEffect(operation, categoryTreatmentIndex)
        ),
        principal: 0,
        interest: 0,
        typeLabel: obligationTypeLabelByTreatment({
          treatment: treatment.treatment,
          category: operation.category,
          operationType: operation.operationType,
        }),
        treatmentLabel: treatment.label,
        treatmentClassName: treatment.className,
      };
    }),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());

  const monthItemsTotal = calendarItems.reduce(
    (sum, item) => sum + item.amount,
    0
  );

  const paymentsToday = [
    ...allFutureLoanPayments.filter(
      (payment) => payment.paymentDate <= todayEnd
    ),
    ...cleanedFutureObligations30Days.filter(
      (operation) =>
        operation.obligationDate && operation.obligationDate <= todayEnd
    ),
  ].reduce((sum, item) => {
    if ("totalAmount" in item || "principalAmount" in item) {
      return sum + loanPaymentTotal(item as (typeof allFutureLoanPayments)[number]);
    }

    return (
      sum +
      Math.abs(
        getFinanceTransactionCashEffect(item, categoryTreatmentIndex)
      )
    );
  }, 0);

  const payments7Days = [
    ...allFutureLoanPayments.filter(
      (payment) => payment.paymentDate <= sevenDaysEnd
    ),
    ...cleanedFutureObligations30Days.filter(
      (operation) =>
        operation.obligationDate && operation.obligationDate <= sevenDaysEnd
    ),
  ].reduce((sum, item) => {
    if ("totalAmount" in item || "principalAmount" in item) {
      return sum + loanPaymentTotal(item as (typeof allFutureLoanPayments)[number]);
    }

    return (
      sum +
      Math.abs(
        getFinanceTransactionCashEffect(item, categoryTreatmentIndex)
      )
    );
  }, 0);

  const payments30Days = [
    ...allFutureLoanPayments,
    ...cleanedFutureObligations30Days,
  ].reduce((sum, item) => {
    if ("totalAmount" in item || "principalAmount" in item) {
      return sum + loanPaymentTotal(item as (typeof allFutureLoanPayments)[number]);
    }

    return (
      sum +
      Math.abs(
        getFinanceTransactionCashEffect(item, categoryTreatmentIndex)
      )
    );
  }, 0);

  const cashAfter30Days = cashOnAccounts - payments30Days;

  const forecastItems30Days: CalendarItem[] = [
    ...allFutureLoanPayments.map((payment) => ({
      id: payment.id,
      source: "LOAN" as const,
      date: payment.paymentDate,
      companyName: payment.loan.companyName,
      title: payment.loan.bankName,
      category: "Погашение кредита",
      counterparty: payment.loan.bankName,
      amount: loanPaymentTotal(payment),
      principal: getAmount(payment.principalAmount),
      interest: getAmount(payment.interestAmount),
      typeLabel: "Кредит",
      treatmentLabel: "График кредита",
      treatmentClassName: "bg-blue-50 text-blue-700 ring-blue-200",
      loanPaymentId: payment.id,
      loanBankName: payment.loan.bankName,
      loanCompanyName: payment.loan.companyName,
      loanPaymentFrequency: payment.loan.paymentFrequency,
      loanPaymentDate: payment.paymentDate,
      loanPrincipalAmount: getAmount(payment.principalAmount),
      loanInterestAmount: getAmount(payment.interestAmount),
      loanTotalAmount: loanPaymentTotal(payment),
      loanDebtAfterPayment: 0,
    })),

    ...cleanedFutureObligations30Days.map((operation) => {
      const treatment = getFinanceTransactionTreatment(
        operation,
        categoryTreatmentIndex
      );

      return {
        id: operation.id,
        source: "OBLIGATION" as const,
        date: operation.obligationDate ?? operation.operationDate,
        companyName: operation.companyName,
        title: operation.category,
        category: operation.category,
        counterparty: operation.counterparty ?? "—",
        amount: Math.abs(
          getFinanceTransactionCashEffect(operation, categoryTreatmentIndex)
        ),
        principal: 0,
        interest: 0,
        typeLabel: obligationTypeLabelByTreatment({
          treatment: treatment.treatment,
          category: operation.category,
          operationType: operation.operationType,
        }),
        treatmentLabel: treatment.label,
        treatmentClassName: treatment.className,
      };
    }),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());

  let runningCash = cashOnAccounts;
  let firstCashGap: { date: Date; balance: number } | null = null;

  for (const item of forecastItems30Days) {
    runningCash -= item.amount;

    if (!firstCashGap && runningCash < 0) {
      firstCashGap = {
        date: item.date,
        balance: runningCash,
      };
    }
  }

  const itemsByDay = new Map<string, CalendarItem[]>();

  for (const item of calendarItems) {
    const key = dayKey(item.date);
    const current = itemsByDay.get(key) ?? [];
    current.push(item);
    itemsByDay.set(key, current);
  }

  let runningMonthBalance = cashOnAccounts;

  const dayRows = Array.from(itemsByDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rows]) => {
      const total = rows.reduce((sum, row) => sum + row.amount, 0);
      const loansTotal = rows
        .filter((row) => row.source === "LOAN")
        .reduce((sum, row) => sum + row.amount, 0);
      const obligationsTotal = rows
        .filter((row) => row.source === "OBLIGATION")
        .reduce((sum, row) => sum + row.amount, 0);

      runningMonthBalance -= total;

      return {
        key,
        date: rows[0].date,
        items: rows,
        total,
        loansTotal,
        obligationsTotal,
        balanceAfterDay: runningMonthBalance,
      };
    });

  const weeklyMap = new Map<
    string,
    {
      label: string;
      total: number;
      count: number;
    }
  >();

  for (const item of calendarItems) {
    const weekNumber = Math.ceil(item.date.getDate() / 7);
    const key = `week-${weekNumber}`;

    const current =
      weeklyMap.get(key) ??
      {
        label: `Неделя ${weekNumber}`,
        total: 0,
        count: 0,
      };

    current.total += item.amount;
    current.count += 1;
    weeklyMap.set(key, current);
  }

  const weeklyRows = Array.from(weeklyMap.values());

  const typeMap = new Map<string, number>();

  for (const item of calendarItems) {
    typeMap.set(item.typeLabel, (typeMap.get(item.typeLabel) ?? 0) + item.amount);
  }

  const typeRows = Array.from(typeMap.entries())
    .map(([label, amount]) => ({
      label,
      amount,
    }))
    .sort((a, b) => b.amount - a.amount);

  return (
    <main className="min-h-screen bg-slate-100 p-6">
      <div className="mx-auto max-w-[1500px] space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900">
              Платёжный календарь 2.0
            </h1>

            <p className="mt-2 text-slate-500">
              Кредиты, будущие обязательства, кассовые риски и платежи по дням.
              Кредиты берутся из графика LoanPayment, прочие обязательства — из
              финансовых операций по роли статьи.
            </p>
          </div>

          <div className="flex gap-3">
            <Link
              href="/finance/loans"
              className="rounded-xl border border-slate-300 px-5 py-3 font-semibold"
            >
              Кредиты
            </Link>

            <Link
              href="/finance/cashflow"
              className="rounded-xl border border-slate-300 px-5 py-3 font-semibold"
            >
              ОДДС
            </Link>
          </div>
        </div>

        <form className="rounded-2xl bg-white p-5 shadow-sm">
          <input type="hidden" name="month" value={monthKey(selectedMonth)} />

          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="sm:w-[260px]">
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Компания
              </label>

              <select
                name="company"
                defaultValue={selectedCompany}
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              >
                <option value="ALL">Все компании</option>

                {companies.map((company) => (
                  <option key={company.id} value={company.name}>
                    {company.name}
                  </option>
                ))}
              </select>
            </div>

            <button className="rounded-xl bg-slate-900 px-6 py-2 font-semibold text-white">
              Применить
            </button>
          </div>
        </form>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Денег на счетах</div>
            <div className="mt-2 text-2xl font-bold text-emerald-600">
              {formatMoney(cashOnAccounts)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Обязательства месяца</div>
            <div className="mt-2 text-2xl font-bold text-red-600">
              {formatMoney(monthItemsTotal)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Платежи сегодня</div>
            <div className="mt-2 text-2xl font-bold text-red-600">
              {formatMoney(paymentsToday)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Платежи 7 дней</div>
            <div className="mt-2 text-2xl font-bold text-red-600">
              {formatMoney(payments7Days)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Платежи 30 дней</div>
            <div className="mt-2 text-2xl font-bold text-red-600">
              {formatMoney(payments30Days)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Остаток через 30 дней</div>
            <div
              className={`mt-2 text-2xl font-bold ${
                cashAfter30Days >= 0 ? "text-emerald-600" : "text-red-600"
              }`}
            >
              {formatMoney(cashAfter30Days)}
            </div>
          </div>
        </section>

        {firstCashGap && (
          <section className="rounded-2xl border border-red-200 bg-red-50 p-6">
            <div className="text-sm font-semibold uppercase text-red-700">
              Кассовый разрыв
            </div>

            <div className="mt-2 text-2xl font-bold text-red-700">
              {formatDate(firstCashGap.date)}: {formatMoney(firstCashGap.balance)}
            </div>

            <p className="mt-2 text-sm text-red-700">
              При текущем остатке денег и известных платежах на 30 дней денег не
              хватит.
            </p>
          </section>
        )}

        <section className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <h2 className="text-2xl font-bold text-slate-900">
                  {formatMonth(selectedMonth)}
                </h2>

                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-600">
                  <span>
                    Платежей:{" "}
                    <b className="text-slate-900">{calendarItems.length}</b>
                  </span>

                  <span>
                    Всего:{" "}
                    <b className="text-red-600">
                      {formatMoney(monthItemsTotal)}
                    </b>
                  </span>
                </div>
              </div>

              <div className="flex gap-2">
                <Link
                  href={buildMonthHref(previousMonth, selectedCompany)}
                  className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold"
                >
                  ←
                </Link>

                <Link
                  href={`/finance/calendar?company=${selectedCompany}`}
                  className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                >
                  Текущий
                </Link>

                <Link
                  href={buildMonthHref(nextMonth, selectedCompany)}
                  className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold"
                >
                  →
                </Link>
              </div>
            </div>
          </div>

          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <h2 className="text-xl font-bold text-slate-900">
              Структура обязательств
            </h2>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {typeRows.map((row) => (
                <div
                  key={row.label}
                  className="rounded-xl border border-slate-200 p-4"
                >
                  <div className="text-sm text-slate-500">{row.label}</div>
                  <div className="mt-1 text-xl font-bold text-red-600">
                    {formatMoney(row.amount)}
                  </div>
                </div>
              ))}

              {typeRows.length === 0 && (
                <div className="rounded-xl border border-slate-200 p-4 text-slate-500">
                  Обязательств нет.
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="rounded-2xl bg-white p-5 shadow-sm">
          <h2 className="text-xl font-bold text-slate-900">Итог по неделям</h2>

          <div className="mt-4 grid gap-3 md:grid-cols-4">
            {weeklyRows.map((week) => (
              <div
                key={week.label}
                className="rounded-xl border border-slate-200 p-4"
              >
                <div className="text-sm text-slate-500">{week.label}</div>
                <div className="mt-1 text-xl font-bold text-red-600">
                  {formatMoney(week.total)}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Платежей: {week.count}
                </div>
              </div>
            ))}

            {weeklyRows.length === 0 && (
              <div className="rounded-xl border border-slate-200 p-4 text-slate-500">
                В этом месяце платежей нет.
              </div>
            )}
          </div>
        </section>

        <section className="space-y-4">
          {dayRows.map((day) => {
            const status = paymentStatus(day.date, today);

            return (
              <div
                key={day.key}
                className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"
              >
                <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-5 py-4">
                  <div className="flex items-center gap-4">
                    <div className="w-16 rounded-xl bg-white p-2 text-center shadow-sm">
                      <div className="text-xs font-bold uppercase text-red-600">
                        {day.date.toLocaleDateString("ru-RU", {
                          month: "short",
                        })}
                      </div>

                      <div className="text-2xl font-bold text-slate-900">
                        {day.date.getDate()}
                      </div>

                      <div className="text-xs text-slate-500">
                        {day.date.toLocaleDateString("ru-RU", {
                          weekday: "short",
                        })}
                      </div>
                    </div>

                    <div>
                      <div className="text-lg font-bold text-slate-900">
                        {day.items.length} платежей
                      </div>

                      <div className="mt-1 text-sm text-slate-500">
                        Кредиты {formatMoney(day.loansTotal)} · обязательства{" "}
                        {formatMoney(day.obligationsTotal)}
                      </div>
                    </div>
                  </div>

                  <div className="text-right">
                    <div className="mb-2">
                      <span
                        className={`rounded-full px-3 py-1 text-xs font-bold ${status.className}`}
                      >
                        {status.label}
                      </span>
                    </div>

                    <div className="text-2xl font-bold text-red-600">
                      {formatMoney(day.total)}
                    </div>

                    <div
                      className={`mt-1 text-sm font-bold ${
                        day.balanceAfterDay >= 0
                          ? "text-emerald-600"
                          : "text-red-600"
                      }`}
                    >
                      Остаток после дня: {formatMoney(day.balanceAfterDay)}
                    </div>
                  </div>
                </div>

                <div className="divide-y divide-slate-100">
                  {day.items.map((item) => {
                    if (item.source === "LOAN") {
                      return (
                        <details key={`loan-${item.id}`} className="group">
                          <summary className="grid cursor-pointer list-none grid-cols-[1.4fr_110px_110px_120px_150px_100px] items-center gap-3 px-5 py-3 hover:bg-slate-50">
                            <div className="flex min-w-0 items-center gap-3">
                              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-xs font-bold text-white">
                                {loanBadge(item.loanBankName ?? item.title)}
                              </div>

                              <div className="min-w-0">
                                <div className="truncate font-bold text-slate-900">
                                  {item.loanBankName ?? item.title}
                                </div>

                                <div className="truncate text-sm text-slate-500">
                                  {item.loanCompanyName ?? item.companyName} ·{" "}
                                  {frequencyLabel(item.loanPaymentFrequency)}
                                </div>

                                <div
                                  className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ${item.treatmentClassName}`}
                                >
                                  {item.treatmentLabel}
                                </div>
                              </div>
                            </div>

                            <div className="text-right">
                              <div className="text-xs text-slate-500">Тело</div>
                              <div className="font-semibold text-slate-900">
                                {formatMoney(item.principal)}
                              </div>
                            </div>

                            <div className="text-right">
                              <div className="text-xs text-slate-500">%</div>
                              <div className="font-semibold text-amber-600">
                                {formatMoney(item.interest)}
                              </div>
                            </div>

                            <div className="text-right">
                              <div className="text-xs text-slate-500">
                                Платёж
                              </div>
                              <div className="font-bold text-red-600">
                                {formatMoney(item.amount)}
                              </div>
                            </div>

                            <div className="text-right">
                              <div className="text-xs text-slate-500">
                                Остаток по графику
                              </div>
                              <div className="font-bold text-emerald-700">
                                {formatMoney(item.loanDebtAfterPayment)}
                              </div>
                            </div>

                            <div className="text-right text-sm font-semibold text-slate-500 group-open:text-slate-900">
                              ✏
                            </div>
                          </summary>

                          <div className="border-t border-slate-100 bg-slate-50 px-5 py-4">
                            <form
                              action="/api/finance/loan-payments"
                              method="POST"
                              className="grid gap-3 lg:grid-cols-[150px_130px_130px_130px_160px_180px_120px]"
                            >
                              <input
                                type="hidden"
                                name="paymentId"
                                value={item.loanPaymentId}
                              />

                              <input
                                type="date"
                                name="paymentDate"
                                defaultValue={inputDate(
                                  item.loanPaymentDate ?? item.date
                                )}
                                className="rounded-xl border border-slate-300 px-3 py-2"
                              />

                              <input
                                name="principalAmount"
                                defaultValue={String(item.principal)}
                                inputMode="decimal"
                                className="rounded-xl border border-slate-300 px-3 py-2"
                                placeholder="Тело"
                              />

                              <input
                                name="interestAmount"
                                defaultValue={String(item.interest)}
                                inputMode="decimal"
                                className="rounded-xl border border-slate-300 px-3 py-2"
                                placeholder="Проценты"
                              />

                              <input
                                name="totalAmount"
                                defaultValue={String(item.amount)}
                                inputMode="decimal"
                                className="rounded-xl border border-slate-300 px-3 py-2"
                                placeholder="Итого"
                              />

                              <select
                                name="paymentFrequency"
                                defaultValue={
                                  item.loanPaymentFrequency ?? "MONTHLY"
                                }
                                className="rounded-xl border border-slate-300 px-3 py-2"
                              >
                                <option value="MONTHLY">Ежемесячно</option>
                                <option value="WEEKLY">Еженедельно</option>
                                <option value="BIWEEKLY">Раз в 2 недели</option>
                                <option value="CUSTOM">Индивидуально</option>
                              </select>

                              <select
                                name="applyScope"
                                defaultValue="ONE"
                                className="rounded-xl border border-slate-300 px-3 py-2"
                              >
                                <option value="ONE">Только этот</option>
                                <option value="FUTURE">Этот и будущие</option>
                              </select>

                              <button className="rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white">
                                Сохранить
                              </button>
                            </form>
                          </div>
                        </details>
                      );
                    }

                    return (
                      <div
                        key={`obligation-${item.id}`}
                        className="grid grid-cols-[140px_1.4fr_1fr_140px_130px] items-center gap-3 px-5 py-3 hover:bg-slate-50"
                      >
                        <div>
                          <span className="rounded-full bg-blue-100 px-3 py-1 text-xs font-bold text-blue-700">
                            {item.typeLabel}
                          </span>
                        </div>

                        <div>
                          <div className="font-bold text-slate-900">
                            {item.category}
                          </div>
                          <div className="text-sm text-slate-500">
                            {item.companyName}
                          </div>

                          <div
                            className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ${item.treatmentClassName}`}
                          >
                            {item.treatmentLabel}
                          </div>
                        </div>

                        <div className="text-sm text-slate-600">
                          {item.counterparty}
                        </div>

                        <div className="text-right font-bold text-red-600">
                          {formatMoney(item.amount)}
                        </div>

                        <div className="text-right">
                          <span
                            className={`rounded-full px-3 py-1 text-xs font-bold ${status.className}`}
                          >
                            {status.label}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {dayRows.length === 0 && (
            <div className="rounded-xl bg-white p-8 text-center text-slate-500 shadow-sm">
              В этом месяце платежей нет.
            </div>
          )}
        </section>

        <section className="rounded-2xl bg-white p-5 shadow-sm">
          <h2 className="text-2xl font-bold text-slate-900">
            Ближайшие платежи 30 дней
          </h2>

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[1000px] text-sm">
              <thead className="bg-slate-100 text-left text-slate-700">
                <tr>
                  <th className="p-3">Дата</th>
                  <th className="p-3">Тип</th>
                  <th className="p-3">Компания</th>
                  <th className="p-3">Статья / кредит</th>
                  <th className="p-3">Роль</th>
                  <th className="p-3">Контрагент</th>
                  <th className="p-3 text-right">Сумма</th>
                </tr>
              </thead>

              <tbody>
                {forecastItems30Days.map((item) => (
                  <tr key={`${item.source}-${item.id}`} className="border-t border-slate-100">
                    <td className="p-3">{formatDate(item.date)}</td>
                    <td className="p-3">{item.typeLabel}</td>
                    <td className="p-3">{item.companyName}</td>
                    <td className="p-3 font-medium">{item.title}</td>
                    <td className="p-3">
                      <div
                        className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ${item.treatmentClassName}`}
                      >
                        {item.treatmentLabel}
                      </div>
                    </td>
                    <td className="p-3">{item.counterparty}</td>
                    <td className="p-3 text-right font-bold text-red-600">
                      {formatMoney(item.amount)}
                    </td>
                  </tr>
                ))}

                {forecastItems30Days.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-slate-500">
                      Плановых платежей на 30 дней нет.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}