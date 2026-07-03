import Link from "next/link";

import { prisma } from "@/lib/prisma";
import {
  buildFinanceCategoryTreatmentIndex,
  calculateFinanceMetricsForRows,
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

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "—";

  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatDateInput(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
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
    59
  );
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59);
}

function startOfQuarter(date: Date) {
  const quarterStartMonth = Math.floor(date.getMonth() / 3) * 3;
  return new Date(date.getFullYear(), quarterStartMonth, 1);
}

function startOfYear(date: Date) {
  return new Date(date.getFullYear(), 0, 1);
}

function buildFinanceHref(company: string, dateFrom?: string, dateTo?: string) {
  const query = new URLSearchParams();

  query.set("company", company);

  if (dateFrom) query.set("dateFrom", dateFrom);
  if (dateTo) query.set("dateTo", dateTo);

  return `/finance?${query.toString()}`;
}

function calcDelta(current: number, previous: number) {
  const absolute = current - previous;
  const percent = previous === 0 ? null : (absolute / Math.abs(previous)) * 100;

  return {
    absolute,
    percent,
  };
}

function parentLabel(value: string | null | undefined) {
  if (!value) return "Без группы";
  if (value === "FINANCING") return "Кредиты и займы";
  return value;
}

function valueClass(value: number) {
  return value >= 0 ? "text-emerald-600" : "text-red-600";
}

function deltaClass(value: number, goodWhen: "up" | "down") {
  if (value === 0) return "text-slate-500";

  if (goodWhen === "up") {
    return value > 0 ? "text-emerald-600" : "text-red-600";
  }

  return value < 0 ? "text-emerald-600" : "text-red-600";
}

function treatmentGroupLabel(treatment: string, parentName?: string | null) {
  if (treatment === "CREDIT_RECEIVED") return "Финансовая деятельность";
  if (treatment === "CREDIT_PRINCIPAL") return "Финансовая деятельность";
  if (treatment === "CREDIT_INTEREST") return "Финансовая деятельность";
  if (treatment === "OWNER_WITHDRAWAL") return "Собственник";
  if (treatment === "CASH_ONLY") return parentLabel(parentName);
  if (treatment === "INCLUDE_IN_NET_PROFIT") return parentLabel(parentName);
  if (treatment === "IGNORE") return "Не учитывается";

  return parentLabel(parentName);
}

function buildCategoryRows(params: {
  transactions: {
    operationType: string;
    category: string;
    amount: unknown;
    subcategory?: string | null;
    isInternalTransfer?: boolean | null;
    transferDirection?: string | null;
  }[];
  categories: {
    name: string;
    categoryType: string;
    parentName?: string | null;
    profitTreatment?: string | null;
  }[];
}) {
  const categoryTreatmentIndex = buildFinanceCategoryTreatmentIndex(
    params.categories
  );

  const categoryMap = new Map(
    params.categories.map((category) => [category.name, category])
  );

  const incomeMap = new Map<
    string,
    {
      category: string;
      amount: number;
      treatmentLabel: string;
      treatmentClassName: string;
    }
  >();

  const outflowMap = new Map<
    string,
    {
      group: string;
      category: string;
      amount: number;
      treatmentLabel: string;
      treatmentClassName: string;
    }
  >();

  for (const row of params.transactions) {
    const effect = getFinanceTransactionCashEffect(
      row,
      categoryTreatmentIndex
    );

    if (effect === 0) continue;

    const treatment = getFinanceTransactionTreatment(
      row,
      categoryTreatmentIndex
    );

    const category = categoryMap.get(row.category);
    const group = treatmentGroupLabel(treatment.treatment, category?.parentName);

    if (effect > 0) {
      const current =
        incomeMap.get(row.category) ??
        {
          category: row.category,
          amount: 0,
          treatmentLabel: treatment.label,
          treatmentClassName: treatment.className,
        };

      current.amount += effect;
      incomeMap.set(row.category, current);

      continue;
    }

    const key = `${group}|||${row.category}`;

    const current =
      outflowMap.get(key) ??
      {
        group,
        category: row.category,
        amount: 0,
        treatmentLabel: treatment.label,
        treatmentClassName: treatment.className,
      };

    current.amount += Math.abs(effect);
    outflowMap.set(key, current);
  }

  return {
    incomeRows: Array.from(incomeMap.values()).sort(
      (a, b) => b.amount - a.amount
    ),
    outflowRows: Array.from(outflowMap.values()).sort(
      (a, b) => a.group.localeCompare(b.group, "ru") || b.amount - a.amount
    ),
  };
}

const items = [
  { title: "Финансовые операции", href: "/finance/operations" },
  { title: "ОДДС", href: "/finance/cashflow" },
  { title: "Денежные счета", href: "/finance/accounts" },
  { title: "Кредиты и займы", href: "/finance/loans" },
  { title: "Платёжный календарь", href: "/finance/calendar" },
  { title: "Прогноз ликвидности", href: "/finance/forecast" },
  { title: "Справочник статей", href: "/finance/categories" },
];

export default async function FinancePage({
  searchParams,
}: {
  searchParams?: Promise<{
    company?: string;
    dateFrom?: string;
    dateTo?: string;
  }>;
}) {
  const params = searchParams ? await searchParams : {};

  const company = params.company ?? "ALL";
  const companyName = company !== "ALL" ? company : null;

  const dateFrom = params.dateFrom ?? "";
  const dateTo = params.dateTo ?? "";

  const today = startOfDay(new Date());
  const in30Days = endOfDay(addDays(today, 30));

  const defaultPeriodStart = startOfMonth(today);
  const defaultPeriodEnd = endOfMonth(today);

  const periodStart = dateFrom
    ? new Date(`${dateFrom}T00:00:00`)
    : defaultPeriodStart;

  const periodEnd = dateTo
    ? new Date(`${dateTo}T23:59:59`)
    : defaultPeriodEnd;

  const periodDays = Math.max(
    1,
    Math.ceil(
      (endOfDay(periodEnd).getTime() - startOfDay(periodStart).getTime()) /
        (24 * 60 * 60 * 1000)
    ) + 1
  );

  const previousPeriodEnd = endOfDay(addDays(periodStart, -1));
  const previousPeriodStart = startOfDay(
    addDays(previousPeriodEnd, -periodDays + 1)
  );

  const companies = await prisma.company.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });

  const accounts = await prisma.financeAccount.findMany({
    where: {
      isActive: true,
      ...(companyName ? { companyName } : {}),
    },
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

  const periodTransactions = await prisma.financeTransaction.findMany({
    where: {
      operationDate: {
        gte: periodStart,
        lte: periodEnd,
      },
      ...(companyName ? { companyName } : {}),
    },
  });

  const previousPeriodTransactions = await prisma.financeTransaction.findMany({
    where: {
      operationDate: {
        gte: previousPeriodStart,
        lte: previousPeriodEnd,
      },
      ...(companyName ? { companyName } : {}),
    },
  });

  const currentMetrics = calculateFinanceMetricsForRows({
    transactions: periodTransactions,
    categories,
  });

  const previousMetrics = calculateFinanceMetricsForRows({
    transactions: previousPeriodTransactions,
    categories,
  });

  const loans = await prisma.loan.findMany({
    where: {
      ...(companyName ? { companyName } : {}),
    },
  });

  const activeLoans = loans.filter(
    (loan) => Number(loan.currentDebt ?? 0) > 0
  );

  const selectedLoanIds = activeLoans.map((loan) => loan.id);

  const loanPayments30Days =
    selectedLoanIds.length > 0
      ? await prisma.loanPayment.findMany({
          where: {
            paid: false,
            loanId: {
              in: selectedLoanIds,
            },
            paymentDate: {
              gte: today,
              lte: in30Days,
            },
          },
        })
      : [];

  const totalCash = accounts.reduce(
    (sum, account) => sum + Number(account.currentBalance ?? 0),
    0
  );

  const incomePeriod = currentMetrics.cashIncome;
  const expensePeriod = currentMetrics.cashOutflow;
  const netCashFlowPeriod = currentMetrics.netCashFlow;

  const incomePreviousPeriod = previousMetrics.cashIncome;
  const expensePreviousPeriod = previousMetrics.cashOutflow;
  const netCashFlowPreviousPeriod = previousMetrics.netCashFlow;

  const incomeDelta = calcDelta(incomePeriod, incomePreviousPeriod);
  const expenseDelta = calcDelta(expensePeriod, expensePreviousPeriod);
  const netCashFlowDelta = calcDelta(
    netCashFlowPeriod,
    netCashFlowPreviousPeriod
  );

  const totalDebt = activeLoans.reduce(
    (sum, loan) => sum + Number(loan.currentDebt ?? 0),
    0
  );

  const payments30Days = loanPayments30Days.reduce((sum, payment) => {
    const total =
      Number(payment.totalAmount ?? 0) ||
      Number(payment.principalAmount ?? 0) +
        Number(payment.interestAmount ?? 0);

    return sum + total;
  }, 0);

  const cashAfter30Days = totalCash - payments30Days;

  const averageDailyExpense = expensePeriod / periodDays;
  const liquidityDays =
    averageDailyExpense > 0 ? Math.floor(totalCash / averageDailyExpense) : null;

  const { incomeRows, outflowRows } = buildCategoryRows({
    transactions: periodTransactions,
    categories,
  });

  const todayText = formatDateInput(today);
  const weekStartText = formatDateInput(addDays(today, -6));
  const days30StartText = formatDateInput(addDays(today, -29));
  const monthStartText = formatDateInput(startOfMonth(today));
  const quarterStartText = formatDateInput(startOfQuarter(today));
  const yearStartText = formatDateInput(startOfYear(today));

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900">
              Финансовый Dashboard
            </h1>

            <p className="mt-3 text-slate-500">
              Деньги, долги, платежи и прогноз ликвидности бизнеса. Расчёты
              используют единую финансовую модель по ролям статей.
            </p>
          </div>

          <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[260px_180px_180px_150px] lg:items-end">
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Компания
              </label>

              <select
                name="company"
                defaultValue={company}
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              >
                <option value="ALL">Все компании</option>

                {companies.map((item) => (
                  <option key={item.id} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Дата от
              </label>

              <input
                type="date"
                name="dateFrom"
                defaultValue={dateFrom}
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Дата до
              </label>

              <input
                type="date"
                name="dateTo"
                defaultValue={dateTo}
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              />
            </div>

            <button className="rounded-xl bg-slate-900 px-6 py-2 font-semibold text-white">
              Применить
            </button>
          </form>
        </div>

        <section className="rounded-2xl bg-white p-5 shadow-sm">
          <div className="flex flex-wrap gap-2">
            <Link
              href={buildFinanceHref(company, todayText, todayText)}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50"
            >
              Сегодня
            </Link>

            <Link
              href={buildFinanceHref(company, weekStartText, todayText)}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50"
            >
              7 дней
            </Link>

            <Link
              href={buildFinanceHref(company, days30StartText, todayText)}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50"
            >
              30 дней
            </Link>

            <Link
              href={buildFinanceHref(company, monthStartText, todayText)}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50"
            >
              Месяц
            </Link>

            <Link
              href={buildFinanceHref(company, quarterStartText, todayText)}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50"
            >
              Квартал
            </Link>

            <Link
              href={buildFinanceHref(company, yearStartText, todayText)}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50"
            >
              Год
            </Link>

            <Link
              href={buildFinanceHref(company)}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50"
            >
              Текущий месяц
            </Link>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Денег на счетах</div>
            <div className="mt-2 text-3xl font-bold text-emerald-600">
              {formatMoney(totalCash)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Поступления ДДС</div>
            <div className="mt-2 text-3xl font-bold text-emerald-600">
              {formatMoney(incomePeriod)}
            </div>
            <div
              className={`mt-2 text-sm font-semibold ${deltaClass(
                incomeDelta.absolute,
                "up"
              )}`}
            >
              {formatMoney(incomeDelta.absolute)} /{" "}
              {incomeDelta.percent === null
                ? "—"
                : formatPercent(incomeDelta.percent)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Выплаты ДДС</div>
            <div className="mt-2 text-3xl font-bold text-red-600">
              {formatMoney(expensePeriod)}
            </div>
            <div
              className={`mt-2 text-sm font-semibold ${deltaClass(
                expenseDelta.absolute,
                "down"
              )}`}
            >
              {formatMoney(expenseDelta.absolute)} /{" "}
              {expenseDelta.percent === null
                ? "—"
                : formatPercent(expenseDelta.percent)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Чистый ДДС за период</div>
            <div className={`mt-2 text-3xl font-bold ${valueClass(netCashFlowPeriod)}`}>
              {formatMoney(netCashFlowPeriod)}
            </div>
            <div
              className={`mt-2 text-sm font-semibold ${deltaClass(
                netCashFlowDelta.absolute,
                "up"
              )}`}
            >
              {formatMoney(netCashFlowDelta.absolute)} /{" "}
              {netCashFlowDelta.percent === null
                ? "—"
                : formatPercent(netCashFlowDelta.percent)}
            </div>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl bg-cyan-50 p-6 shadow-sm ring-1 ring-cyan-100">
            <div className="text-sm font-semibold text-cyan-700">
              Только ДДС
            </div>
            <div className="mt-2 text-3xl font-black text-cyan-800">
              {formatMoney(currentMetrics.cashOnlyTotal)}
            </div>
            <p className="mt-2 text-sm leading-6 text-cyan-700">
              Фулфилмент, закупки, упаковка и расходы, уже сидящие в
              себестоимости.
            </p>
          </div>

          <div className="rounded-2xl bg-blue-50 p-6 shadow-sm ring-1 ring-blue-100">
            <div className="text-sm font-semibold text-blue-700">
              Получено кредитов / займов
            </div>
            <div className="mt-2 text-3xl font-black text-blue-800">
              {formatMoney(currentMetrics.creditReceived)}
            </div>
            <p className="mt-2 text-sm leading-6 text-blue-700">
              Увеличивает ДДС, но не является прибылью.
            </p>
          </div>

          <div className="rounded-2xl bg-violet-50 p-6 shadow-sm ring-1 ring-violet-100">
            <div className="text-sm font-semibold text-violet-700">
              Проценты кредита
            </div>
            <div className="mt-2 text-3xl font-black text-violet-800">
              {formatMoney(currentMetrics.creditInterest)}
            </div>
            <p className="mt-2 text-sm leading-6 text-violet-700">
              Уменьшают и ДДС, и чистую прибыль.
            </p>
          </div>

          <div className="rounded-2xl bg-amber-50 p-6 shadow-sm ring-1 ring-amber-100">
            <div className="text-sm font-semibold text-amber-700">
              Вывод собственника
            </div>
            <div className="mt-2 text-3xl font-black text-amber-800">
              {formatMoney(currentMetrics.ownerWithdrawals)}
            </div>
            <p className="mt-2 text-sm leading-6 text-amber-700">
              Уменьшает ДДС и показатель после вывода собственника.
            </p>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-4">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Общий долг</div>
            <div className="mt-2 text-3xl font-bold text-red-600">
              {formatMoney(totalDebt)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">
              Платежи по кредитам 30 дней
            </div>
            <div className="mt-2 text-3xl font-bold text-red-600">
              {formatMoney(payments30Days)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">
              Остаток после платежей 30 дней
            </div>
            <div
              className={`mt-2 text-3xl font-bold ${valueClass(
                cashAfter30Days
              )}`}
            >
              {formatMoney(cashAfter30Days)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Запас ликвидности</div>
            <div
              className={`mt-2 text-3xl font-bold ${
                liquidityDays === null || liquidityDays >= 30
                  ? "text-emerald-600"
                  : liquidityDays >= 14
                    ? "text-amber-600"
                    : "text-red-600"
              }`}
            >
              {liquidityDays === null ? "∞" : `${liquidityDays} дн.`}
            </div>
            <div className="mt-2 text-sm text-slate-500">
              По средним выплатам ДДС за выбранный период
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-bold text-slate-900">
              Поступления по статьям
            </h2>

            <div className="mt-5 space-y-3">
              {incomeRows.slice(0, 8).map((item) => (
                <div
                  key={item.category}
                  className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 p-4"
                >
                  <div>
                    <div className="font-semibold text-slate-900">
                      {item.category}
                    </div>

                    <div
                      className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ${item.treatmentClassName}`}
                    >
                      {item.treatmentLabel}
                    </div>
                  </div>

                  <div className="font-bold text-emerald-600">
                    {formatMoney(item.amount)}
                  </div>
                </div>
              ))}

              {incomeRows.length === 0 && (
                <div className="rounded-xl border border-slate-200 p-4 text-slate-500">
                  Поступлений за период нет.
                </div>
              )}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-bold text-slate-900">
              Выплаты по статьям
            </h2>

            <div className="mt-5 space-y-3">
              {outflowRows.slice(0, 8).map((item) => (
                <div
                  key={`${item.group}-${item.category}`}
                  className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 p-4"
                >
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">
                      {item.group}
                    </div>

                    <div className="mt-1 font-semibold text-slate-900">
                      {item.category}
                    </div>

                    <div
                      className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ${item.treatmentClassName}`}
                    >
                      {item.treatmentLabel}
                    </div>
                  </div>

                  <div className="text-right">
                    <div className="font-bold text-red-600">
                      {formatMoney(item.amount)}
                    </div>

                    <div className="mt-1 text-sm font-semibold text-slate-500">
                      {expensePeriod > 0
                        ? `${((item.amount / expensePeriod) * 100).toFixed(1)}%`
                        : "—"}
                    </div>
                  </div>
                </div>
              ))}

              {outflowRows.length === 0 && (
                <div className="rounded-xl border border-slate-200 p-4 text-slate-500">
                  Выплат за период нет.
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-2xl font-bold text-slate-900">
            Быстрые разделы
          </h2>

          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-2xl border border-slate-200 p-5 transition hover:border-slate-300 hover:bg-slate-50"
              >
                <div className="font-bold text-slate-900">{item.title}</div>
                <div className="mt-3 text-sm font-semibold text-slate-700">
                  Открыть →
                </div>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}