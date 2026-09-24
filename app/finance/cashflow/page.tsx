import Link from "next/link";

import { prisma } from "@/lib/prisma";
import { getDefaultCurrentMonthRange } from "@/lib/date/defaultPeriod";
import {
  buildFinanceCategoryTreatmentIndex,
  calculateFinanceMetricsForRows,
  getFinanceTransactionAccountEffect,
  getFinanceTransactionCashEffect,
  getFinanceTransactionTreatment,
} from "@/lib/finance/financeMetrics";

function formatMoney(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatDate(value?: Date | null) {
  if (!value) return "—";
  return value.toLocaleDateString("ru-RU");
}

function formatMonth(date: Date) {
  return date.toLocaleDateString("ru-RU", {
    month: "long",
    year: "numeric",
  });
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
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

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function startOfQuarter(date: Date) {
  const quarterStartMonth = Math.floor(date.getMonth() / 3) * 3;
  return new Date(date.getFullYear(), quarterStartMonth, 1);
}

function startOfYear(date: Date) {
  return new Date(date.getFullYear(), 0, 1);
}

function toDate(value?: string) {
  if (!value) return null;

  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateEnd(value?: string) {
  if (!value) return null;

  const date = new Date(`${value}T23:59:59`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
    2,
    "0"
  )}`;
}

function getAmount(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function parentLabel(value: string | null | undefined) {
  if (!value) return "Без группы";
  if (value === "FINANCING") return "Кредиты и займы";
  return value;
}

function operationLabel(type: string) {
  if (type === "INCOME") return "Поступление";
  if (type === "EXPENSE") return "Расход";
  if (type === "TRANSFER") return "Перевод";
  if (type === "FINANCING") return "Финансирование";
  if (type === "PERSONAL") return "Личные";
  return type || "—";
}

function operationClass(type: string) {
  if (type === "INCOME") return "text-emerald-600";
  if (type === "EXPENSE") return "text-red-600";
  if (type === "TRANSFER") return "text-slate-500";
  if (type === "FINANCING") return "text-blue-600";
  if (type === "PERSONAL") return "text-amber-600";
  return "text-slate-700";
}

function valueClass(value: number) {
  return value >= 0 ? "text-emerald-600" : "text-red-600";
}

function buildHref(params: {
  company: string;
  category: string;
  bankAccount: string;
  operationType: string;
  dateFrom: string;
  dateTo: string;
  rows: number;
}) {
  const query = new URLSearchParams();

  query.set("company", params.company);
  query.set("category", params.category);
  query.set("bankAccount", params.bankAccount);
  query.set("operationType", params.operationType);
  query.set("rows", String(params.rows));

  if (params.dateFrom) query.set("dateFrom", params.dateFrom);
  if (params.dateTo) query.set("dateTo", params.dateTo);

  return `/finance/cashflow?${query.toString()}`;
}

function treatmentGroupLabel(treatment: string, parentName?: string | null) {
  if (treatment === "CREDIT_RECEIVED") return "Финансовая деятельность";
  if (treatment === "CREDIT_PRINCIPAL") return "Финансовая деятельность";
  if (treatment === "CREDIT_INTEREST") return "Финансовая деятельность";
  if (treatment === "OWNER_WITHDRAWAL") return "Собственник";
  if (treatment === "CASH_ONLY") return parentLabel(parentName) || "Только ДДС";
  if (treatment === "INCLUDE_IN_NET_PROFIT") return parentLabel(parentName);
  if (treatment === "IGNORE") return "Не учитывается";

  return parentLabel(parentName);
}

export default async function CashFlowPage({
  searchParams,
}: {
  searchParams?: Promise<{
    company?: string;
    category?: string;
    bankAccount?: string;
    operationType?: string;
    dateFrom?: string;
    dateTo?: string;
    rows?: string;
  }>;
}) {
  const params = searchParams ? await searchParams : {};

  const company = params.company ?? "ALL";
  const selectedCategory = params.category ?? "ALL";
  const bankAccount = params.bankAccount ?? "ALL";
  const operationType = params.operationType ?? "ALL";
  const defaultPeriod = getDefaultCurrentMonthRange();
  const dateFrom = params.dateFrom ?? defaultPeriod.dateFrom;
  const dateTo = params.dateTo ?? defaultPeriod.dateTo;
  const rowsLimit = Number(params.rows ?? 25);

  const safeRowsLimit = [25, 50, 100, 250, 500].includes(rowsLimit)
    ? rowsLimit
    : 25;

  const today = startOfDay(new Date());
  const todayText = formatDateInput(today);

  const weekStartText = formatDateInput(addDays(today, -6));
  const days30StartText = formatDateInput(addDays(today, -29));
  const monthStartText = formatDateInput(startOfMonth(today));
  const quarterStartText = formatDateInput(startOfQuarter(today));
  const yearStartText = formatDateInput(startOfYear(today));

  const startDate = toDate(dateFrom);
  const endDate = toDateEnd(dateTo);

  const companies = await prisma.company.findMany({
    where: {
      isActive: true,
    },
    orderBy: {
      name: "asc",
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

  const accounts = await prisma.financeAccount.findMany({
    where: {
      isActive: true,
    },
    orderBy: [{ companyName: "asc" }, { name: "asc" }],
  });

  const categoryTreatmentIndex = buildFinanceCategoryTreatmentIndex(categories);

  const categoryMap = new Map(
    categories.map((category) => [category.name, category])
  );

  const where: any = {
    ...(company !== "ALL" ? { companyName: company } : {}),
    ...(selectedCategory !== "ALL" ? { category: selectedCategory } : {}),
    ...(bankAccount !== "ALL" ? { bankAccount } : {}),
    ...(operationType !== "ALL" ? { operationType } : {}),
    ...(startDate || endDate
      ? {
          operationDate: {
            ...(startDate ? { gte: startDate } : {}),
            ...(endDate ? { lte: endDate } : {}),
          },
        }
      : {}),
  };

  const transactions = await prisma.financeTransaction.findMany({
    where,
    orderBy: {
      operationDate: "asc",
    },
  });

  const beforeWhere: any = {
    ...(company !== "ALL" ? { companyName: company } : {}),
    ...(selectedCategory !== "ALL" ? { category: selectedCategory } : {}),
    ...(bankAccount !== "ALL" ? { bankAccount } : {}),
    ...(operationType !== "ALL" ? { operationType } : {}),
    ...(startDate
      ? {
          operationDate: {
            lt: startDate,
          },
        }
      : {
          id: "__never__",
        }),
  };

  const beforeTransactions = await prisma.financeTransaction.findMany({
    where: beforeWhere,
  });

  const metrics = calculateFinanceMetricsForRows({
    transactions,
    categories,
  });

  const openingBalance = beforeTransactions.reduce((sum, row) => {
    const effect =
      bankAccount === "ALL"
        ? getFinanceTransactionCashEffect(row, categoryTreatmentIndex)
        : getFinanceTransactionAccountEffect(row, categoryTreatmentIndex);

    return sum + effect;
  }, 0);

  const closingBalance = openingBalance + metrics.netCashFlow;

  const cashFlowMargin =
    metrics.cashIncome > 0
      ? (metrics.netCashFlow / metrics.cashIncome) * 100
      : null;

  const operatingIncome = metrics.cashIncome - metrics.creditReceived;
  const operatingExpense =
    metrics.cashOutflow -
    metrics.creditPrincipal -
    metrics.creditInterest -
    metrics.ownerWithdrawals;

  const operatingFlow = operatingIncome - operatingExpense;

  const financialFlow =
    metrics.creditReceived - metrics.creditPrincipal - metrics.creditInterest;

  const ownerFlow = -metrics.ownerWithdrawals;

  const incomeRowsMap = new Map<
    string,
    {
      categoryName: string;
      amount: number;
      treatment: string;
      treatmentLabel: string;
      treatmentClassName: string;
    }
  >();

  const expenseRowsMap = new Map<
    string,
    {
      parentName: string;
      categoryName: string;
      amount: number;
      treatment: string;
      treatmentLabel: string;
      treatmentClassName: string;
    }
  >();

  for (const row of transactions) {
    if (row.isInternalTransfer || row.operationType === "TRANSFER") {
      continue;
    }

    const effect = getFinanceTransactionCashEffect(row, categoryTreatmentIndex);
    if (effect === 0) continue;

    const treatment = getFinanceTransactionTreatment(
      row,
      categoryTreatmentIndex
    );

    const category = categoryMap.get(row.category);
    const groupName = treatmentGroupLabel(
      treatment.treatment,
      category?.parentName
    );

    if (effect > 0) {
      const current =
        incomeRowsMap.get(row.category) ??
        {
          categoryName: row.category,
          amount: 0,
          treatment: treatment.treatment,
          treatmentLabel: treatment.label,
          treatmentClassName: treatment.className,
        };

      current.amount += effect;
      incomeRowsMap.set(row.category, current);
      continue;
    }

    const key = `${groupName}|||${row.category}`;

    const current =
      expenseRowsMap.get(key) ??
      {
        parentName: groupName,
        categoryName: row.category,
        amount: 0,
        treatment: treatment.treatment,
        treatmentLabel: treatment.label,
        treatmentClassName: treatment.className,
      };

    current.amount += Math.abs(effect);
    expenseRowsMap.set(key, current);
  }

  const incomeRows = Array.from(incomeRowsMap.values()).sort(
    (a, b) => b.amount - a.amount
  );

  const categoryExpenseRows = Array.from(expenseRowsMap.values()).sort(
    (a, b) =>
      a.parentName.localeCompare(b.parentName, "ru") || b.amount - a.amount
  );

  const groupedCategoryRows = categoryExpenseRows.reduce<
    Record<string, typeof categoryExpenseRows>
  >((acc, row) => {
    acc[row.parentName] = acc[row.parentName] ?? [];
    acc[row.parentName].push(row);
    return acc;
  }, {});

  const monthlyMap = new Map<
    string,
    {
      date: Date;
      inflow: number;
      outflow: number;
      net: number;
    }
  >();

  for (const row of transactions) {
    const key = monthKey(row.operationDate);

    const current =
      monthlyMap.get(key) ??
      {
        date: row.operationDate,
        inflow: 0,
        outflow: 0,
        net: 0,
      };

    const effect = getFinanceTransactionCashEffect(row, categoryTreatmentIndex);

    if (effect >= 0) {
      current.inflow += effect;
    } else {
      current.outflow += Math.abs(effect);
    }

    current.net = current.inflow - current.outflow;
    monthlyMap.set(key, current);
  }

  const monthlyRows = Array.from(monthlyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value);

  const allFilteredOperations = [...transactions].sort(
    (a, b) => b.operationDate.getTime() - a.operationDate.getTime()
  );

  const visibleOperations = allFilteredOperations.slice(0, safeRowsLimit);

  const visibleAccounts =
    bankAccount === "ALL"
      ? accounts
      : accounts.filter((account) => account.name === bankAccount);

  const accountBalanceRows = visibleAccounts.map((account) => {
    const accountTransactions = transactions.filter(
      (operation) =>
        operation.companyName === account.companyName &&
        operation.bankAccount === account.name
    );

    const inflow = accountTransactions
      .filter(
        (operation) =>
          getFinanceTransactionAccountEffect(operation, categoryTreatmentIndex) >
          0
      )
      .reduce(
        (sum, operation) =>
          sum +
          getFinanceTransactionAccountEffect(operation, categoryTreatmentIndex),
        0
      );

    const outflow = accountTransactions
      .filter(
        (operation) =>
          getFinanceTransactionAccountEffect(operation, categoryTreatmentIndex) <
          0
      )
      .reduce(
        (sum, operation) =>
          sum +
          Math.abs(
            getFinanceTransactionAccountEffect(
              operation,
              categoryTreatmentIndex
            )
          ),
        0
      );

    const balance = Number(account.openingBalance ?? 0) + inflow - outflow;

    return {
      account,
      inflow,
      outflow,
      balance,
      operationsCount: accountTransactions.length,
    };
  });

  const quickLinks = [
    {
      label: "Сегодня",
      dateFrom: todayText,
      dateTo: todayText,
    },
    {
      label: "7 дней",
      dateFrom: weekStartText,
      dateTo: todayText,
    },
    {
      label: "30 дней",
      dateFrom: days30StartText,
      dateTo: todayText,
    },
    {
      label: "Месяц",
      dateFrom: monthStartText,
      dateTo: todayText,
    },
    {
      label: "Квартал",
      dateFrom: quarterStartText,
      dateTo: todayText,
    },
    {
      label: "Год",
      dateFrom: yearStartText,
      dateTo: todayText,
    },
  ];

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900">ОДДС</h1>
            <p className="mt-3 text-slate-500">
              Отчёт о движении денежных средств. Расчёты используют единую
              финансовую модель по ролям статей.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/finance/accounts"
              className="rounded-xl border border-slate-300 px-5 py-3 font-semibold"
            >
              Счета
            </Link>

            <Link
              href="/finance/operations"
              className="rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white"
            >
              Операции
            </Link>

            <Link
              href="/finance/categories"
              className="rounded-xl border border-slate-300 px-5 py-3 font-semibold"
            >
              Справочник статей
            </Link>
          </div>
        </div>

        <form className="rounded-2xl bg-white p-6 shadow-sm">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_180px_160px_160px_120px]">
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Компания
              </label>

              <select
                name="company"
                defaultValue={company}
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              >
                <option value="ALL">Все</option>

                {companies.map((item) => (
                  <option key={item.id} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Статья
              </label>

              <select
                name="category"
                defaultValue={selectedCategory}
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              >
                <option value="ALL">Все статьи</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.name}>
                    {parentLabel(category.parentName)} — {category.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Счёт
              </label>

              <select
                name="bankAccount"
                defaultValue={bankAccount}
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              >
                <option value="ALL">Все счета</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.name}>
                    {account.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Тип
              </label>

              <select
                name="operationType"
                defaultValue={operationType}
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              >
                <option value="ALL">Все</option>
                <option value="INCOME">Поступления</option>
                <option value="EXPENSE">Расходы</option>
                <option value="PERSONAL">Личные</option>
                <option value="FINANCING">Финансирование</option>
                <option value="TRANSFER">Переводы</option>
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

            <div className="flex items-end">
              <button className="w-full rounded-xl bg-slate-900 px-4 py-2 font-medium text-white">
                Применить
              </button>
            </div>
          </div>

          <input type="hidden" name="rows" value={safeRowsLimit} />
        </form>

        <section className="rounded-2xl bg-white p-5 shadow-sm">
          <div className="flex flex-wrap gap-2">
            {quickLinks.map((link) => (
              <Link
                key={link.label}
                href={buildHref({
                  company,
                  category: selectedCategory,
                  bankAccount,
                  operationType,
                  dateFrom: link.dateFrom,
                  dateTo: link.dateTo,
                  rows: safeRowsLimit,
                })}
                className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50"
              >
                {link.label}
              </Link>
            ))}

            <Link
              href={buildHref({
                company,
                category: selectedCategory,
                bankAccount,
                operationType,
                dateFrom: "",
                dateTo: "",
                rows: safeRowsLimit,
              })}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50"
            >
              Все
            </Link>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Начальный остаток</div>
            <div className="mt-2 text-2xl font-bold text-slate-900">
              {formatMoney(openingBalance)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Поступления ДДС</div>
            <div className="mt-2 text-2xl font-bold text-emerald-600">
              {formatMoney(metrics.cashIncome)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Выплаты ДДС</div>
            <div className="mt-2 text-2xl font-bold text-red-600">
              {formatMoney(metrics.cashOutflow)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Чистый ДДС</div>
            <div
              className={`mt-2 text-2xl font-bold ${valueClass(
                metrics.netCashFlow
              )}`}
            >
              {formatMoney(metrics.netCashFlow)}
            </div>

            <div className="mt-2 text-sm text-slate-500">
              Рентабельность ДДС:{" "}
              <span className="font-semibold text-slate-900">
                {cashFlowMargin === null ? "—" : formatPercent(cashFlowMargin)}
              </span>
            </div>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl bg-cyan-50 p-6 shadow-sm ring-1 ring-cyan-100">
            <div className="text-sm font-semibold text-cyan-700">Только ДДС</div>
            <div className="mt-2 text-2xl font-black text-cyan-800">
              {formatMoney(metrics.cashOnlyTotal)}
            </div>
            <p className="mt-2 text-sm leading-6 text-cyan-700">
              Фулфилмент, закупки, упаковка и расходы, уже сидящие в
              себестоимости.
            </p>
          </div>

          <div className="rounded-2xl bg-blue-50 p-6 shadow-sm ring-1 ring-blue-100">
            <div className="text-sm font-semibold text-blue-700">
              Тело кредита
            </div>
            <div className="mt-2 text-2xl font-black text-blue-800">
              {formatMoney(metrics.creditPrincipal)}
            </div>
            <p className="mt-2 text-sm leading-6 text-blue-700">
              Уменьшает деньги, но не чистую прибыль.
            </p>
          </div>

          <div className="rounded-2xl bg-violet-50 p-6 shadow-sm ring-1 ring-violet-100">
            <div className="text-sm font-semibold text-violet-700">
              Проценты кредита
            </div>
            <div className="mt-2 text-2xl font-black text-violet-800">
              {formatMoney(metrics.creditInterest)}
            </div>
            <p className="mt-2 text-sm leading-6 text-violet-700">
              Уменьшают и ДДС, и чистую прибыль.
            </p>
          </div>

          <div className="rounded-2xl bg-amber-50 p-6 shadow-sm ring-1 ring-amber-100">
            <div className="text-sm font-semibold text-amber-700">
              Вывод собственника
            </div>
            <div className="mt-2 text-2xl font-black text-amber-800">
              {formatMoney(metrics.ownerWithdrawals)}
            </div>
            <p className="mt-2 text-sm leading-6 text-amber-700">
              Уменьшает ДДС и показатель после вывода собственника.
            </p>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-xl font-bold text-slate-900">
              Операционная деятельность
            </h2>

            <div className="mt-5 space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Поступления без кредитов</span>
                <span className="font-bold text-emerald-600">
                  {formatMoney(operatingIncome)}
                </span>
              </div>

              <div className="flex justify-between">
                <span className="text-slate-500">Операционные выплаты</span>
                <span className="font-bold text-red-600">
                  {formatMoney(operatingExpense)}
                </span>
              </div>

              <div className="border-t border-slate-200 pt-3">
                <div className="flex justify-between">
                  <span className="font-semibold text-slate-900">
                    Операционный поток
                  </span>
                  <span className={`font-bold ${valueClass(operatingFlow)}`}>
                    {formatMoney(operatingFlow)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-xl font-bold text-slate-900">
              Кредиты и займы
            </h2>

            <div className="mt-5 space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Получено кредитов / займов</span>
                <span className="font-bold text-blue-600">
                  {formatMoney(metrics.creditReceived)}
                </span>
              </div>

              <div className="flex justify-between">
                <span className="text-slate-500">Тело кредита</span>
                <span className="font-bold text-red-600">
                  {formatMoney(metrics.creditPrincipal)}
                </span>
              </div>

              <div className="flex justify-between">
                <span className="text-slate-500">Проценты</span>
                <span className="font-bold text-red-600">
                  {formatMoney(metrics.creditInterest)}
                </span>
              </div>

              <div className="border-t border-slate-200 pt-3">
                <div className="flex justify-between">
                  <span className="font-semibold text-slate-900">
                    Финансовый поток
                  </span>
                  <span className={`font-bold ${valueClass(financialFlow)}`}>
                    {formatMoney(financialFlow)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-xl font-bold text-slate-900">Итог</h2>

            <div className="mt-5 space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Начальный остаток</span>
                <span className="font-bold text-slate-900">
                  {formatMoney(openingBalance)}
                </span>
              </div>

              <div className="flex justify-between">
                <span className="text-slate-500">Вывод собственника</span>
                <span className="font-bold text-amber-600">
                  {formatMoney(Math.abs(ownerFlow))}
                </span>
              </div>

              <div className="flex justify-between">
                <span className="text-slate-500">Чистый денежный поток</span>
                <span className={`font-bold ${valueClass(metrics.netCashFlow)}`}>
                  {formatMoney(metrics.netCashFlow)}
                </span>
              </div>

              <div className="border-t border-slate-200 pt-3">
                <div className="flex justify-between">
                  <span className="font-semibold text-slate-900">
                    Конечный остаток
                  </span>
                  <span className={`font-bold ${valueClass(closingBalance)}`}>
                    {formatMoney(closingBalance)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-xl font-bold text-slate-900">
              Поступления по статьям
            </h2>

            <div className="mt-5 space-y-3">
              {incomeRows.map((row) => (
                <div
                  key={row.categoryName}
                  className="flex items-center justify-between gap-4 rounded-xl border border-slate-200 p-4"
                >
                  <div>
                    <div className="font-semibold text-slate-900">
                      {row.categoryName}
                    </div>

                    <div
                      className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ${row.treatmentClassName}`}
                    >
                      {row.treatmentLabel}
                    </div>
                  </div>

                  <div className="text-right">
                    <div className="font-bold text-emerald-600">
                      {formatMoney(row.amount)}
                    </div>

                    <div className="mt-1 text-sm font-semibold text-slate-500">
                      {metrics.cashIncome > 0
                        ? formatPercent((row.amount / metrics.cashIncome) * 100)
                        : "—"}
                    </div>
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
            <h2 className="text-xl font-bold text-slate-900">
              Расшифровка выплат по статьям
            </h2>

            <div className="mt-5 space-y-6">
              {Object.entries(groupedCategoryRows).map(([group, rows]) => {
                const groupTotal = rows.reduce((sum, row) => sum + row.amount, 0);

                return (
                  <div key={group}>
                    <div className="flex items-center justify-between">
                      <h3 className="font-bold text-slate-900">{group}</h3>
                      <div className="text-right">
                        <div className="font-bold text-red-600">
                          {formatMoney(groupTotal)}
                        </div>
                        <div className="mt-1 text-sm font-semibold text-slate-500">
                          {metrics.cashOutflow > 0
                            ? formatPercent(
                                (groupTotal / metrics.cashOutflow) * 100
                              )
                            : "—"}
                        </div>
                      </div>
                    </div>

                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-sm">
                        <tbody>
                          {rows.map((row) => (
                            <tr
                              key={`${row.parentName}-${row.categoryName}`}
                              className="border-t border-slate-100"
                            >
                              <td className="p-3 font-medium">
                                <div>├ {row.categoryName}</div>
                                <div
                                  className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ${row.treatmentClassName}`}
                                >
                                  {row.treatmentLabel}
                                </div>
                              </td>

                              <td className="p-3 text-right">
                                <div className="font-bold text-red-600">
                                  {formatMoney(row.amount)}
                                </div>

                                <div className="mt-1 text-sm font-semibold text-slate-500">
                                  {metrics.cashOutflow > 0
                                    ? formatPercent(
                                        (row.amount / metrics.cashOutflow) * 100
                                      )
                                    : "—"}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}

              {categoryExpenseRows.length === 0 && (
                <div className="p-6 text-center text-slate-500">Нет данных.</div>
              )}
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-xl font-bold text-slate-900">
              Денежные средства по счетам
            </h2>

            <p className="mt-2 text-sm text-slate-500">
              Внутренние переводы меняют остатки счетов, но не меняют общий ОДДС.
            </p>

            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="bg-slate-100 text-left text-slate-700">
                  <tr>
                    <th className="p-3">Компания</th>
                    <th className="p-3">Счёт</th>
                    <th className="p-3 text-right">Поступления</th>
                    <th className="p-3 text-right">Выбытия</th>
                    <th className="p-3 text-right">Расчётный остаток</th>
                    <th className="p-3 text-right">Операций</th>
                  </tr>
                </thead>

                <tbody>
                  {accountBalanceRows.map((row) => (
                    <tr key={row.account.id} className="border-t border-slate-100">
                      <td className="p-3 font-medium">
                        {row.account.companyName}
                      </td>

                      <td className="p-3">{row.account.name}</td>

                      <td className="p-3 text-right font-bold text-emerald-600">
                        {formatMoney(row.inflow)}
                      </td>

                      <td className="p-3 text-right font-bold text-red-600">
                        {formatMoney(row.outflow)}
                      </td>

                      <td
                        className={`p-3 text-right font-bold ${valueClass(
                          row.balance
                        )}`}
                      >
                        {formatMoney(row.balance)}
                      </td>

                      <td className="p-3 text-right">{row.operationsCount}</td>
                    </tr>
                  ))}

                  {accountBalanceRows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="p-6 text-center text-slate-500">
                        Денежные счета пока не заведены.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-xl font-bold text-slate-900">ДДС по месяцам</h2>

            <div className="mt-5 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-100 text-left text-slate-700">
                  <tr>
                    <th className="p-3">Месяц</th>
                    <th className="p-3 text-right">Поступления</th>
                    <th className="p-3 text-right">Выбытия</th>
                    <th className="p-3 text-right">Чистый ДДС</th>
                  </tr>
                </thead>

                <tbody>
                  {monthlyRows.map((row) => (
                    <tr
                      key={row.date.toISOString()}
                      className="border-t border-slate-100"
                    >
                      <td className="p-3 font-medium">{formatMonth(row.date)}</td>
                      <td className="p-3 text-right font-bold text-emerald-600">
                        {formatMoney(row.inflow)}
                      </td>
                      <td className="p-3 text-right font-bold text-red-600">
                        {formatMoney(row.outflow)}
                      </td>
                      <td className={`p-3 text-right font-bold ${valueClass(row.net)}`}>
                        {formatMoney(row.net)}
                      </td>
                    </tr>
                  ))}

                  {monthlyRows.length === 0 && (
                    <tr>
                      <td colSpan={4} className="p-6 text-center text-slate-500">
                        Нет данных.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-xl font-bold text-slate-900">
                Операции по выбранному фильтру
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                Показано {visibleOperations.length} из{" "}
                {allFilteredOperations.length} операций.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-slate-500">Показать:</span>
              {[25, 50, 100, 250].map((limit) => (
                <Link
                  key={limit}
                  href={buildHref({
                    company,
                    category: selectedCategory,
                    bankAccount,
                    operationType,
                    dateFrom,
                    dateTo,
                    rows: limit,
                  })}
                  className={`rounded-lg px-3 py-1 font-medium ${
                    safeRowsLimit === limit
                      ? "bg-slate-900 text-white"
                      : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                  }`}
                >
                  {limit}
                </Link>
              ))}
            </div>
          </div>

          <div className="mt-5 max-h-[720px] overflow-auto">
            <table className="w-full min-w-[1250px] text-sm">
              <thead className="sticky top-0 z-10 bg-slate-100 text-left text-slate-700">
                <tr>
                  <th className="p-3">Дата</th>
                  <th className="p-3">Компания</th>
                  <th className="p-3">Тип</th>
                  <th className="p-3">Статья</th>
                  <th className="p-3">Роль</th>
                  <th className="p-3">Счёт</th>
                  <th className="p-3 text-right">Сумма</th>
                  <th className="p-3">Комментарий</th>
                </tr>
              </thead>

              <tbody>
                {visibleOperations.map((row) => {
                  const accountEffect = getFinanceTransactionAccountEffect(
                    row,
                    categoryTreatmentIndex
                  );
                  const cashflowEffect = getFinanceTransactionCashEffect(
                    row,
                    categoryTreatmentIndex
                  );
                  const treatment = getFinanceTransactionTreatment(
                    row,
                    categoryTreatmentIndex
                  );

                  return (
                    <tr key={row.id} className="border-t border-slate-100">
                      <td className="p-3">{formatDate(row.operationDate)}</td>
                      <td className="p-3">{row.companyName}</td>
                      <td
                        className={`p-3 font-semibold ${operationClass(
                          row.operationType
                        )}`}
                      >
                        {operationLabel(row.operationType)}
                      </td>
                      <td className="p-3 font-medium">{row.category}</td>
                      <td className="p-3">
                        <div
                          className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ${treatment.className}`}
                          title={treatment.description}
                        >
                          {treatment.label}
                        </div>
                      </td>
                      <td className="p-3">{row.bankAccount || "—"}</td>
                      <td
                        className={`p-3 text-right font-bold ${
                          accountEffect >= 0
                            ? "text-emerald-600"
                            : "text-red-600"
                        }`}
                      >
                        {accountEffect < 0 ? "-" : ""}
                        {formatMoney(getAmount(row.amount))}
                      </td>
                      <td className="p-3">
                        {row.isInternalTransfer
                          ? `Внутренний перевод, эффект для ОДДС: ${formatMoney(
                              cashflowEffect
                            )}. ${row.comment || ""}`
                          : row.comment || "—"}
                      </td>
                    </tr>
                  );
                })}

                {visibleOperations.length === 0 && (
                  <tr>
                    <td colSpan={8} className="p-6 text-center text-slate-500">
                      Нет операций.
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