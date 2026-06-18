import Link from "next/link";

import { prisma } from "@/lib/prisma";
import {
  buildFinanceCategoryTreatmentIndex,
  getFinanceTransactionCashEffect,
} from "@/lib/finance/financeMetrics";

const MIN_VISIBLE_BALANCE = 1000;

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
  if (Math.abs(value) < 0.05) return "0.0%";
  return `${value.toFixed(1)}%`;
}

function buildOperationsHref(companyName: string, bankAccount: string) {
  const query = new URLSearchParams();

  query.set("company", companyName);
  query.set("bankAccount", bankAccount);

  return `/finance/operations?${query.toString()}`;
}

function buildCashflowHref(companyName: string, bankAccount: string) {
  const query = new URLSearchParams();

  query.set("company", companyName);
  query.set("category", "ALL");
  query.set("bankAccount", bankAccount);
  query.set("operationType", "ALL");
  query.set("rows", "50");

  return `/finance/cashflow?${query.toString()}`;
}

export default async function FinanceAccountsPage({
  searchParams,
}: {
  searchParams?: Promise<{
    company?: string;
    showSmall?: string;
  }>;
}) {
  const params = searchParams ? await searchParams : {};

  const company = params.company ?? "ALL";
  const companyName = company !== "ALL" ? company : null;
  const showSmall = params.showSmall === "1";

  const [companies, categories, transactions] = await Promise.all([
    prisma.company.findMany({
      where: {
        isActive: true,
      },
      orderBy: {
        name: "asc",
      },
    }),

    prisma.financeCategory.findMany({
      where: {
        isActive: true,
      },
      orderBy: [
        { categoryType: "asc" },
        { sortOrder: "asc" },
        { name: "asc" },
      ],
    }),

    prisma.financeTransaction.findMany({
      where: {
        bankAccount: {
          not: null,
        },
        ...(companyName ? { companyName } : {}),
      },
      orderBy: [
        { companyName: "asc" },
        { bankAccount: "asc" },
        { operationDate: "asc" },
      ],
    }),
  ]);

  const categoryTreatmentIndex = buildFinanceCategoryTreatmentIndex(categories);

  const accountMap = new Map<
    string,
    {
      companyName: string;
      bankAccount: string;
      inflow: number;
      outflow: number;
      balance: number;
      operationsCount: number;
      ignoredCount: number;
    }
  >();

  for (const operation of transactions) {
    const bankAccount = operation.bankAccount ?? "Без счета";
    const key = `${operation.companyName}|||${bankAccount}`;

    const effect = getFinanceTransactionCashEffect(
      operation,
      categoryTreatmentIndex
    );

    const current =
      accountMap.get(key) ??
      {
        companyName: operation.companyName,
        bankAccount,
        inflow: 0,
        outflow: 0,
        balance: 0,
        operationsCount: 0,
        ignoredCount: 0,
      };

    if (effect > 0) {
      current.inflow += effect;
    } else if (effect < 0) {
      current.outflow += Math.abs(effect);
    } else {
      current.ignoredCount += 1;
    }

    current.balance += effect;
    current.operationsCount += 1;

    accountMap.set(key, current);
  }

  const allAccountRows = Array.from(accountMap.values()).sort(
    (a, b) =>
      a.companyName.localeCompare(b.companyName, "ru") ||
      b.balance - a.balance
  );

  const accountRows = showSmall
    ? allAccountRows
    : allAccountRows.filter(
        (row) => Math.abs(row.balance) >= MIN_VISIBLE_BALANCE
      );

  const hiddenAccountsCount = allAccountRows.length - accountRows.length;

  const positiveTotalBalance = accountRows.reduce(
    (sum, row) => sum + Math.max(row.balance, 0),
    0
  );

  const totalAccounts = accountRows.length;
  const totalInflow = accountRows.reduce((sum, row) => sum + row.inflow, 0);
  const totalOutflow = accountRows.reduce((sum, row) => sum + row.outflow, 0);
  const totalBalance = accountRows.reduce((sum, row) => sum + row.balance, 0);
  const totalOperations = accountRows.reduce(
    (sum, row) => sum + row.operationsCount,
    0
  );
  const totalIgnoredOperations = accountRows.reduce(
    (sum, row) => sum + row.ignoredCount,
    0
  );

  const topAccounts = [...accountRows]
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 5);

  function shareOf(row: { balance: number }) {
    return positiveTotalBalance > 0
      ? (Math.max(row.balance, 0) / positiveTotalBalance) * 100
      : 0;
  }

  function accountsHref(nextShowSmall: boolean) {
    const query = new URLSearchParams();

    query.set("company", company);

    if (nextShowSmall) {
      query.set("showSmall", "1");
    }

    return `/finance/accounts?${query.toString()}`;
  }

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900">
              Денежные счета
            </h1>

            <p className="mt-3 text-slate-500">
              Счета автоматически собираются из финансовых операций. Расчёт
              движения идёт через единую модель ДДС: поступления минус выбытия,
              с учётом роли статьи profitTreatment.
            </p>
          </div>

          <div className="flex gap-3">
            <Link
              href="/finance/cashflow"
              className="rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white"
            >
              ОДДС
            </Link>

            <Link
              href="/finance/operations"
              className="rounded-xl border border-slate-300 px-5 py-3 font-semibold"
            >
              Операции
            </Link>
          </div>
        </div>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="sm:w-[280px]">
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

            <input type="hidden" name="showSmall" value={showSmall ? "1" : ""} />

            <button className="rounded-xl bg-slate-900 px-6 py-2 font-semibold text-white">
              Применить
            </button>

            <Link
              href={accountsHref(!showSmall)}
              className="rounded-xl border border-slate-300 px-6 py-2 text-center font-semibold hover:bg-slate-50"
            >
              {showSmall ? "Скрыть мелкие счета" : "Показать мелкие счета"}
            </Link>
          </form>

          {!showSmall && hiddenAccountsCount > 0 && (
            <div className="mt-4 text-sm text-slate-500">
              Скрыто мелких счетов:{" "}
              <span className="font-semibold text-slate-900">
                {hiddenAccountsCount}
              </span>{" "}
              с остатком меньше {formatMoney(MIN_VISIBLE_BALANCE)}.
            </div>
          )}
        </section>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Счетов из операций</div>
            <div className="mt-2 text-3xl font-bold text-slate-900">
              {totalAccounts}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Поступления</div>
            <div className="mt-2 text-3xl font-bold text-emerald-600">
              {formatMoney(totalInflow)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Выбытия</div>
            <div className="mt-2 text-3xl font-bold text-red-600">
              {formatMoney(totalOutflow)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Расчётный остаток</div>
            <div
              className={`mt-2 text-3xl font-bold ${
                totalBalance >= 0 ? "text-emerald-600" : "text-red-600"
              }`}
            >
              {formatMoney(totalBalance)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Операций со счетами</div>
            <div className="mt-2 text-3xl font-bold text-slate-900">
              {totalOperations}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Без влияния на ДДС</div>
            <div className="mt-2 text-3xl font-bold text-slate-900">
              {totalIgnoredOperations}
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[2fr_1fr]">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-bold text-slate-900">
              Структура денежных средств
            </h2>

            <div className="mt-5 space-y-4">
              {accountRows.map((row) => {
                const share = shareOf(row);

                return (
                  <div key={`${row.companyName}-${row.bankAccount}`}>
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="font-semibold text-slate-900">
                          {row.bankAccount}
                        </div>
                        <div className="text-sm text-slate-500">
                          {row.companyName}
                        </div>
                      </div>

                      <div className="text-right">
                        <div
                          className={`font-bold ${
                            row.balance >= 0
                              ? "text-emerald-600"
                              : "text-red-600"
                          }`}
                        >
                          {formatMoney(row.balance)}
                        </div>
                        <div className="text-sm font-semibold text-slate-500">
                          {formatPercent(share)}
                        </div>
                      </div>
                    </div>

                    <div className="mt-2 h-3 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-slate-900"
                        style={{
                          width: `${Math.min(100, Math.max(0, share))}%`,
                        }}
                      />
                    </div>
                  </div>
                );
              })}

              {accountRows.length === 0 && (
                <div className="rounded-xl border border-slate-200 p-4 text-slate-500">
                  Операций со счетами пока нет.
                </div>
              )}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-bold text-slate-900">ТОП счетов</h2>

            <div className="mt-5 space-y-3">
              {topAccounts.map((row, index) => (
                <div
                  key={`${row.companyName}-${row.bankAccount}`}
                  className="rounded-xl border border-slate-200 p-4"
                >
                  <div className="text-sm text-slate-500">#{index + 1}</div>
                  <div className="mt-1 font-bold text-slate-900">
                    {row.bankAccount}
                  </div>
                  <div className="text-sm text-slate-500">{row.companyName}</div>
                  <div
                    className={`mt-2 text-xl font-bold ${
                      row.balance >= 0 ? "text-emerald-600" : "text-red-600"
                    }`}
                  >
                    {formatMoney(row.balance)}
                  </div>
                </div>
              ))}

              {topAccounts.length === 0 && (
                <div className="rounded-xl border border-slate-200 p-4 text-slate-500">
                  Нет данных.
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {accountRows.map((row) => {
            const share = shareOf(row);

            return (
              <div
                key={`${row.companyName}-${row.bankAccount}`}
                className="rounded-2xl bg-white p-6 shadow-sm"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm text-slate-500">
                      {row.companyName}
                    </div>

                    <h2 className="mt-1 text-2xl font-bold text-slate-900">
                      {row.bankAccount}
                    </h2>
                  </div>

                  <div className="rounded-xl bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-700">
                    {formatPercent(share)}
                  </div>
                </div>

                <div
                  className={`mt-5 text-3xl font-bold ${
                    row.balance >= 0 ? "text-emerald-600" : "text-red-600"
                  }`}
                >
                  {formatMoney(row.balance)}
                </div>

                <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-xl border border-slate-200 p-3">
                    <div className="text-slate-500">Поступления</div>
                    <div className="mt-1 font-bold text-emerald-600">
                      {formatMoney(row.inflow)}
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 p-3">
                    <div className="text-slate-500">Выбытия</div>
                    <div className="mt-1 font-bold text-red-600">
                      {formatMoney(row.outflow)}
                    </div>
                  </div>
                </div>

                <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm text-slate-500">
                    Операций:{" "}
                    <span className="font-semibold text-slate-900">
                      {row.operationsCount}
                    </span>
                    {row.ignoredCount > 0 && (
                      <span className="ml-2 text-slate-400">
                        · без ДДС: {row.ignoredCount}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Link
                      href={buildOperationsHref(row.companyName, row.bankAccount)}
                      className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold hover:bg-slate-50"
                    >
                      Движения →
                    </Link>

                    <Link
                      href={buildCashflowHref(row.companyName, row.bankAccount)}
                      className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                    >
                      ОДДС →
                    </Link>
                  </div>
                </div>
              </div>
            );
          })}

          {accountRows.length === 0 && (
            <div className="rounded-2xl bg-white p-8 text-center text-slate-500 shadow-sm lg:col-span-2 xl:col-span-3">
              Операций со счетами пока нет.
            </div>
          )}
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">
              Сводная таблица счетов
            </h2>

            <p className="mt-2 text-slate-500">
              Расчёт строится по единой модели ДДС: поступления − выбытия.
              Внутренние переводы и операции без денежного эффекта не меняют
              расчётный остаток.
            </p>
          </div>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[1150px] text-sm">
              <thead className="bg-slate-100 text-left text-slate-700">
                <tr>
                  <th className="p-3">Компания</th>
                  <th className="p-3">Счёт</th>
                  <th className="p-3 text-right">Поступления</th>
                  <th className="p-3 text-right">Выбытия</th>
                  <th className="p-3 text-right">Расчётный остаток</th>
                  <th className="p-3 text-right">Доля</th>
                  <th className="p-3 text-right">Операций</th>
                  <th className="p-3 text-right">Без ДДС</th>
                  <th className="p-3 text-center">Действия</th>
                </tr>
              </thead>

              <tbody>
                {accountRows.map((row) => {
                  const share = shareOf(row);

                  return (
                    <tr
                      key={`${row.companyName}-${row.bankAccount}`}
                      className="border-t border-slate-100"
                    >
                      <td className="p-3 font-medium">{row.companyName}</td>
                      <td className="p-3">{row.bankAccount}</td>
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
                      <td className="p-3 text-right font-semibold">
                        {formatPercent(share)}
                      </td>
                      <td className="p-3 text-right">{row.operationsCount}</td>
                      <td className="p-3 text-right">{row.ignoredCount}</td>
                      <td className="p-3 text-center">
                        <div className="flex justify-center gap-2">
                          <Link
                            href={buildOperationsHref(
                              row.companyName,
                              row.bankAccount
                            )}
                            className="rounded-lg bg-slate-100 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-200"
                          >
                            Движения
                          </Link>

                          <Link
                            href={buildCashflowHref(
                              row.companyName,
                              row.bankAccount
                            )}
                            className="rounded-lg bg-slate-900 px-3 py-1 text-sm font-medium text-white"
                          >
                            ОДДС
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {accountRows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="p-8 text-center text-slate-500">
                      Операций со счетами пока нет.
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