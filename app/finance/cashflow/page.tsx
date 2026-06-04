import Link from "next/link";
import { prisma } from "@/lib/prisma";

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

function toDate(value?: string) {
  if (!value) return null;

  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateEnd(value?: string) {
  if (!value) return null;

  const date = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function getAmount(value: unknown) {
  return Number(value ?? 0);
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

export default async function CashFlowPage({
  searchParams,
}: {
  searchParams?: {
    company?: string;
    category?: string;
    bankAccount?: string;
    operationType?: string;
    dateFrom?: string;
    dateTo?: string;
    rows?: string;
  };
}) {
  const company = searchParams?.company ?? "ALL";
  const selectedCategory = searchParams?.category ?? "ALL";
  const bankAccount = searchParams?.bankAccount ?? "ALL";
  const operationType = searchParams?.operationType ?? "ALL";
  const dateFrom = searchParams?.dateFrom ?? "";
  const dateTo = searchParams?.dateTo ?? "";
  const rowsLimit = Number(searchParams?.rows ?? 25);

  const startDate = toDate(dateFrom);
  const endDate = toDateEnd(dateTo);

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

  function categoryTypeOf(row: { category: string; operationType: string }) {
    return categoryMap.get(row.category)?.categoryType ?? row.operationType;
  }

  function cashEffectForCashflow(row: {
    category: string;
    operationType: string;
    amount: unknown;
    isInternalTransfer: boolean;
  }) {
    if (row.isInternalTransfer) return 0;

    const amount = getAmount(row.amount);
    const categoryType = categoryTypeOf(row);

    if (categoryType === "INCOME") return amount;
    if (categoryType === "EXPENSE") return -amount;
    if (categoryType === "PERSONAL") return -amount;

    if (categoryType === "FINANCING") {
      return row.category === "Получение кредита" ? amount : -amount;
    }

    if (row.operationType === "INCOME") return amount;
    if (row.operationType === "EXPENSE") return -amount;

    return 0;
  }

  function cashEffectForAccount(row: {
    category: string;
    operationType: string;
    amount: unknown;
    isInternalTransfer: boolean;
    transferDirection?: string | null;
  }) {
    const amount = getAmount(row.amount);

    if (row.isInternalTransfer) {
      if (row.transferDirection === "TRANSFER_IN") return amount;
      if (row.transferDirection === "TRANSFER_OUT") return -amount;
      return 0;
    }

    return cashEffectForCashflow(row);
  }

  const openingBalance = beforeTransactions.reduce(
    (sum, row) => sum + cashEffectForCashflow(row),
    0
  );

  const income = transactions
    .filter((row) => categoryTypeOf(row) === "INCOME" && !row.isInternalTransfer)
    .reduce((sum, row) => sum + getAmount(row.amount), 0);

  const expense = transactions
    .filter((row) => categoryTypeOf(row) === "EXPENSE" && !row.isInternalTransfer)
    .reduce((sum, row) => sum + getAmount(row.amount), 0);

  const personalExpense = transactions
    .filter((row) => categoryTypeOf(row) === "PERSONAL" && !row.isInternalTransfer)
    .reduce((sum, row) => sum + getAmount(row.amount), 0);

  const financingIncome = transactions
    .filter(
      (row) =>
        categoryTypeOf(row) === "FINANCING" &&
        !row.isInternalTransfer &&
        row.category === "Получение кредита"
    )
    .reduce((sum, row) => sum + getAmount(row.amount), 0);

  const financingExpense = transactions
    .filter(
      (row) =>
        categoryTypeOf(row) === "FINANCING" &&
        !row.isInternalTransfer &&
        row.category !== "Получение кредита"
    )
    .reduce((sum, row) => sum + getAmount(row.amount), 0);

  const transferIn = transactions
    .filter(
      (row) =>
        row.isInternalTransfer && row.transferDirection === "TRANSFER_IN"
    )
    .reduce((sum, row) => sum + getAmount(row.amount), 0);

  const transferOut = transactions
    .filter(
      (row) =>
        row.isInternalTransfer && row.transferDirection === "TRANSFER_OUT"
    )
    .reduce((sum, row) => sum + getAmount(row.amount), 0);

  const totalInflow = income + financingIncome;
  const totalOutflow = expense + personalExpense + financingExpense;
  const netCashFlow = totalInflow - totalOutflow;
  const closingBalance = openingBalance + netCashFlow;
  const financialFlow = financingIncome - financingExpense;

  const categoryRowsMap = new Map<
    string,
    {
      parentName: string;
      categoryName: string;
      amount: number;
    }
  >();

  for (const row of transactions) {
    if (row.isInternalTransfer) continue;

    const category = categoryMap.get(row.category);
    const categoryType = categoryTypeOf(row);

    if (categoryType === "INCOME") continue;
    if (categoryType === "FINANCING" && row.category === "Получение кредита") {
      continue;
    }

    const parentName = parentLabel(category?.parentName);
    const key = `${parentName}|||${row.category}`;

    const current =
      categoryRowsMap.get(key) ??
      {
        parentName,
        categoryName: row.category,
        amount: 0,
      };

    current.amount += getAmount(row.amount);
    categoryRowsMap.set(key, current);
  }

  const categoryExpenseRows = Array.from(categoryRowsMap.values()).sort(
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

    const effect = cashEffectForCashflow(row);

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

  const visibleOperations = allFilteredOperations.slice(0, rowsLimit);

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
      .filter((operation) => cashEffectForAccount(operation) > 0)
      .reduce((sum, operation) => sum + cashEffectForAccount(operation), 0);

    const outflow = accountTransactions
      .filter((operation) => cashEffectForAccount(operation) < 0)
      .reduce(
        (sum, operation) => sum + Math.abs(cashEffectForAccount(operation)),
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

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900">ОДДС</h1>
            <p className="mt-3 text-slate-500">
              Отчёт о движении денежных средств по операциям компании.
            </p>
          </div>

          <div className="flex gap-3">
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
          <div className="grid gap-4 md:grid-cols-[1fr_1fr_1fr_180px_160px_160px_120px]">
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
                <option value="ИП Петров">ИП Петров</option>
                <option value="ИП Лебедева">ИП Лебедева</option>
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

          <input type="hidden" name="rows" value={rowsLimit} />
        </form>

        <section className="grid gap-4 md:grid-cols-5">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Начальный остаток</div>
            <div className="mt-2 text-2xl font-bold text-slate-900">
              {formatMoney(openingBalance)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Поступления</div>
            <div className="mt-2 text-2xl font-bold text-emerald-600">
              {formatMoney(totalInflow)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Выбытия</div>
            <div className="mt-2 text-2xl font-bold text-red-600">
              {formatMoney(totalOutflow)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Чистый ДДС</div>
            <div
              className={`mt-2 text-2xl font-bold ${
                netCashFlow >= 0 ? "text-emerald-600" : "text-red-600"
              }`}
            >
              {formatMoney(netCashFlow)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Конечный остаток</div>
            <div
              className={`mt-2 text-2xl font-bold ${
                closingBalance >= 0 ? "text-emerald-600" : "text-red-600"
              }`}
            >
              {formatMoney(closingBalance)}
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-6">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Опер. поступления</div>
            <div className="mt-2 text-xl font-bold text-emerald-600">
              {formatMoney(income)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Опер. расходы</div>
            <div className="mt-2 text-xl font-bold text-red-600">
              {formatMoney(expense)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Личные расходы</div>
            <div className="mt-2 text-xl font-bold text-amber-600">
              {formatMoney(personalExpense)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Получено кредитов</div>
            <div className="mt-2 text-xl font-bold text-blue-600">
              {formatMoney(financingIncome)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Платежи по кредитам</div>
            <div className="mt-2 text-xl font-bold text-red-600">
              {formatMoney(financingExpense)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Фин. поток</div>
            <div
              className={`mt-2 text-xl font-bold ${
                financialFlow >= 0 ? "text-blue-600" : "text-red-600"
              }`}
            >
              {formatMoney(financialFlow)}
            </div>
          </div>
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold text-slate-900">
                Денежные средства по счетам
              </h2>

              <p className="mt-2 text-sm text-slate-500">
                Внутренние переводы меняют остатки счетов, но не меняют общий ОДДС.
              </p>
            </div>

            <Link
              href="/finance/accounts"
              className="rounded-xl border border-slate-300 px-4 py-2 font-semibold"
            >
              Управлять счетами
            </Link>
          </div>

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[1000px] text-sm">
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
                      className={`p-3 text-right font-bold ${
                        row.balance >= 0 ? "text-emerald-600" : "text-red-600"
                      }`}
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
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-xl font-bold text-slate-900">
              Расшифровка расходов по статьям
            </h2>

            <div className="mt-5 space-y-6">
              {Object.entries(groupedCategoryRows).map(([group, rows]) => {
                const groupTotal = rows.reduce((sum, row) => sum + row.amount, 0);

                return (
                  <div key={group}>
                    <div className="flex items-center justify-between">
                      <h3 className="font-bold text-slate-900">{group}</h3>
                      <div className="font-bold text-red-600">
                        {formatMoney(groupTotal)}
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
                                ├ {row.categoryName}
                              </td>
                              <td className="p-3 text-right font-bold text-red-600">
                                {formatMoney(row.amount)}
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

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-xl font-bold text-slate-900">
              ДДС по месяцам
            </h2>

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
                      <td className="p-3 font-medium">
                        {formatMonth(row.date)}
                      </td>
                      <td className="p-3 text-right font-bold text-emerald-600">
                        {formatMoney(row.inflow)}
                      </td>
                      <td className="p-3 text-right font-bold text-red-600">
                        {formatMoney(row.outflow)}
                      </td>
                      <td
                        className={`p-3 text-right font-bold ${
                          row.net >= 0 ? "text-emerald-600" : "text-red-600"
                        }`}
                      >
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
                    rowsLimit === limit
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
            <table className="w-full min-w-[1100px] text-sm">
              <thead className="sticky top-0 z-10 bg-slate-100 text-left text-slate-700">
                <tr>
                  <th className="p-3">Дата</th>
                  <th className="p-3">Компания</th>
                  <th className="p-3">Тип</th>
                  <th className="p-3">Статья</th>
                  <th className="p-3">Счёт</th>
                  <th className="p-3 text-right">Сумма</th>
                  <th className="p-3">Комментарий</th>
                </tr>
              </thead>

              <tbody>
                {visibleOperations.map((row) => {
                  const accountEffect = cashEffectForAccount(row);
                  const cashflowEffect = cashEffectForCashflow(row);

                  return (
                    <tr key={row.id} className="border-t border-slate-100">
                      <td className="p-3">{formatDate(row.operationDate)}</td>
                      <td className="p-3">{row.companyName}</td>
                      <td
                        className={`p-3 font-semibold ${operationClass(
                          categoryTypeOf(row)
                        )}`}
                      >
                        {operationLabel(categoryTypeOf(row))}
                      </td>
                      <td className="p-3 font-medium">{row.category}</td>
                      <td className="p-3">{row.bankAccount || "—"}</td>
                      <td
                        className={`p-3 text-right font-bold ${
                          accountEffect >= 0
                            ? "text-emerald-600"
                            : "text-red-600"
                        }`}
                      >
                        {row.isInternalTransfer &&
                        row.transferDirection === "TRANSFER_OUT"
                          ? "-"
                          : ""}
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
                    <td colSpan={7} className="p-6 text-center text-slate-500">
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