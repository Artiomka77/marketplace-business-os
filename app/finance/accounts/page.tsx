import Link from "next/link";
import { prisma } from "@/lib/prisma";

function formatMoney(value: unknown) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

function getAmount(value: unknown) {
  return Number(value ?? 0);
}

function getCashEffect(operation: {
  operationType: string;
  category: string;
  amount: unknown;
  isInternalTransfer: boolean;
}) {
  if (operation.isInternalTransfer) return 0;

  const amount = getAmount(operation.amount);

  if (operation.operationType === "INCOME") return amount;
  if (operation.operationType === "EXPENSE") return -amount;
  if (operation.operationType === "PERSONAL") return -amount;

  if (operation.operationType === "FINANCING") {
    return operation.category === "Получение кредита" ? amount : -amount;
  }

  return 0;
}

export default async function FinanceAccountsPage() {
const companies = await prisma.$queryRaw<{ id: string; name: string }[]>`
  select "id", "name"
  from "Company"
  where "isActive" = true
  order by "name" asc
`;
  const accounts = await prisma.financeAccount.findMany({
    where: {
      isActive: true,
    },
    orderBy: [{ companyName: "asc" }, { name: "asc" }],
  });

  const transactions = await prisma.financeTransaction.findMany({
    where: {
      bankAccount: {
        not: null,
      },
    },
  });

  const accountRows = accounts.map((account) => {
    const accountTransactions = transactions.filter(
      (operation) =>
        operation.companyName === account.companyName &&
        operation.bankAccount === account.name
    );

    const inflow = accountTransactions
      .filter((operation) => getCashEffect(operation) > 0)
      .reduce((sum, operation) => sum + getCashEffect(operation), 0);

    const outflow = accountTransactions
      .filter((operation) => getCashEffect(operation) < 0)
      .reduce((sum, operation) => sum + Math.abs(getCashEffect(operation)), 0);

    const calculatedBalance =
      getAmount(account.openingBalance) + inflow - outflow;

    return {
      account,
      inflow,
      outflow,
      calculatedBalance,
      operationsCount: accountTransactions.length,
    };
  });

  const totalOpeningBalance = accountRows.reduce(
    (sum, row) => sum + Number(row.account.openingBalance),
    0
  );

  const totalCurrentBalance = accountRows.reduce(
    (sum, row) => sum + row.calculatedBalance,
    0
  );

  const totalInflow = accountRows.reduce((sum, row) => sum + row.inflow, 0);
  const totalOutflow = accountRows.reduce((sum, row) => sum + row.outflow, 0);

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900">
              Денежные счета
            </h1>

            <p className="mt-3 text-slate-500">
              Банковские счета, карты и наличные денежные средства.
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

        <section className="grid gap-4 md:grid-cols-5">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Всего счетов</div>
            <div className="mt-2 text-3xl font-bold text-slate-900">
              {accounts.length}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Начальный остаток</div>
            <div className="mt-2 text-3xl font-bold text-blue-600">
              {formatMoney(totalOpeningBalance)}
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
                totalCurrentBalance >= 0 ? "text-emerald-600" : "text-red-600"
              }`}
            >
              {formatMoney(totalCurrentBalance)}
            </div>
          </div>
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">
              Добавить счёт
            </h2>

            <p className="mt-2 text-slate-500">
              Создавай любые денежные счета: карты, расчётные счета, наличные.
            </p>
          </div>

          <form
            action="/api/finance/accounts"
            method="POST"
            className="mt-6 grid gap-4 md:grid-cols-[1fr_1fr_1fr_180px_150px]"
          >
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Компания
              </label>

              <select
                name="companyName"
                defaultValue={companies[0]?.name ?? ""}
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              >
                {companies.map((company) => (
  <option key={company.id} value={company.name}>
    {company.name}
  </option>
))}
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Название счёта
              </label>

              <input
                name="name"
                required
                placeholder="Например: Точка расчетный"
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Тип счёта
              </label>

              <select
                name="accountType"
                defaultValue="Банковская карта"
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              >
                <option value="Банковская карта">Банковская карта</option>
                <option value="Расчетный счет">Расчетный счет</option>
                <option value="Наличные">Наличные</option>
                <option value="Депозит">Депозит</option>
                <option value="Кредитный счет">Кредитный счет</option>
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Начальный остаток
              </label>

              <input
                name="openingBalance"
                inputMode="decimal"
                placeholder="0"
                defaultValue="0"
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              />
            </div>

            <div className="flex items-end">
              <button className="w-full rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white">
                Создать
              </button>
            </div>
          </form>
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">
              Список счетов
            </h2>

            <p className="mt-2 text-slate-500">
              Остатки считаются автоматически: начальный остаток + поступления − выбытия.
            </p>
          </div>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[1300px] text-sm">
              <thead className="bg-slate-100 text-left text-slate-700">
                <tr>
                  <th className="p-3">Компания</th>
                  <th className="p-3">Счёт</th>
                  <th className="p-3">Тип</th>
                  <th className="p-3 text-right">Начальный остаток</th>
                  <th className="p-3 text-right">Поступления</th>
                  <th className="p-3 text-right">Выбытия</th>
                  <th className="p-3 text-right">Расчётный остаток</th>
                  <th className="p-3 text-right">Операций</th>
                  <th className="p-3 text-center">Активен</th>
                </tr>
              </thead>

              <tbody>
                {accountRows.map((row) => (
                  <tr key={row.account.id} className="border-t border-slate-100">
                    <td className="p-3 font-medium">{row.account.companyName}</td>
                    <td className="p-3">{row.account.name}</td>
                    <td className="p-3">{row.account.accountType}</td>
                    <td className="p-3 text-right font-bold text-blue-600">
                      {formatMoney(row.account.openingBalance)}
                    </td>
                    <td className="p-3 text-right font-bold text-emerald-600">
                      {formatMoney(row.inflow)}
                    </td>
                    <td className="p-3 text-right font-bold text-red-600">
                      {formatMoney(row.outflow)}
                    </td>
                    <td
                      className={`p-3 text-right font-bold ${
                        row.calculatedBalance >= 0
                          ? "text-emerald-600"
                          : "text-red-600"
                      }`}
                    >
                      {formatMoney(row.calculatedBalance)}
                    </td>
                    <td className="p-3 text-right">{row.operationsCount}</td>
                    <td className="p-3 text-center">
                      {row.account.isActive ? "Да" : "Нет"}
                    </td>
                  </tr>
                ))}

                {accountRows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="p-8 text-center text-slate-500">
                      Денежные счета пока не заведены.
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