import Link from "next/link";
import { prisma } from "@/lib/prisma";

type CompanyRow = {
  id: string;
  name: string;
  legalName: string | null;
  inn: string | null;
  ogrnIp: string | null;
  taxSystem: string;
  incomeTaxRate: unknown;
  vatRate: unknown;
  isActive: boolean;
};

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

function SettingsTabs() {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap gap-3">
        <Link
          href="/settings/companies"
          className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-black text-white shadow-sm transition active:scale-95"
        >
          Компании
        </Link>

        <Link
          href="/settings/api-connections"
          className="rounded-2xl border border-slate-200 bg-slate-50 px-5 py-3 text-sm font-black text-slate-700 transition hover:bg-white active:scale-95"
        >
          API-подключения и историческая загрузка
        </Link>
      </div>
    </section>
  );
}

export default async function FinanceCompaniesPage() {
  const companies = await prisma.$queryRaw<CompanyRow[]>`
    select
      "id",
      "name",
      "legalName",
      "inn",
      "ogrnIp",
      "taxSystem",
      "incomeTaxRate",
      "vatRate",
      "isActive"
    from "Company"
    order by "name" asc
  `;

  const accounts = await prisma.financeAccount.findMany({
    where: { isActive: true },
    orderBy: [{ companyName: "asc" }, { name: "asc" }],
  });

  const loans = await prisma.loan.findMany({
    include: { payments: true },
    orderBy: [{ companyName: "asc" }, { bankName: "asc" }],
  });

  const transactions = await prisma.financeTransaction.findMany({
    orderBy: { operationDate: "desc" },
  });

  const rows = companies.map((company) => {
    const companyAccounts = accounts.filter(
      (account) => account.companyName === company.name
    );

    const companyLoans = loans.filter((loan) => loan.companyName === company.name);

    const companyTransactions = transactions.filter(
      (transaction) => transaction.companyName === company.name
    );

    const totalOpeningBalance = companyAccounts.reduce(
      (sum, account) => sum + getAmount(account.openingBalance),
      0
    );

    const totalDebt = companyLoans.reduce(
      (sum, loan) => sum + getAmount(loan.currentDebt),
      0
    );

    const monthlyPayment = companyLoans.reduce(
      (sum, loan) => sum + getAmount(loan.monthlyPayment),
      0
    );

    const income = companyTransactions
      .filter((transaction) => transaction.operationType === "INCOME")
      .reduce((sum, transaction) => sum + getAmount(transaction.amount), 0);

    const expense = companyTransactions
      .filter(
        (transaction) =>
          transaction.operationType === "EXPENSE" ||
          transaction.operationType === "PERSONAL"
      )
      .reduce((sum, transaction) => sum + getAmount(transaction.amount), 0);

    return {
      company,
      accounts: companyAccounts,
      loans: companyLoans,
      transactionsCount: companyTransactions.length,
      totalOpeningBalance,
      totalDebt,
      monthlyPayment,
      income,
      expense,
    };
  });

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <div className="inline-flex rounded-full bg-slate-950 px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] text-white">
                Настройки
              </div>

              <h1 className="mt-5 text-4xl font-black tracking-tight text-slate-950">
                Настройки компаний
              </h1>

              <p className="mt-3 max-w-3xl text-slate-500">
                Реквизиты, налоговые настройки, счета, кредиты и финансовая
                сводка по компаниям.
              </p>
            </div>

            <Link
              href="/settings/api-connections"
              className="inline-flex w-fit items-center justify-center rounded-2xl bg-blue-600 px-5 py-3 text-sm font-black text-white shadow-sm transition hover:bg-blue-700 active:scale-95"
            >
              API-синхронизация →
            </Link>
          </div>
        </div>

        <SettingsTabs />

        <section className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200">
          <div>
            <h2 className="text-2xl font-black text-slate-950">
              Добавить компанию
            </h2>

            <p className="mt-2 text-slate-500">
              Новая компания появится в настройках и в формах финансового блока.
            </p>
          </div>

          <form
            action="/api/finance/companies"
            method="POST"
            className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4"
          >
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Название в системе
              </label>
              <input
                name="name"
                required
                placeholder="Например: ООО Маркет"
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Юридическое название
              </label>
              <input
                name="legalName"
                placeholder="Полное юр. название"
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                ИНН
              </label>
              <input
                name="inn"
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                ОГРНИП / ОГРН
              </label>
              <input
                name="ogrnIp"
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Налоговый режим
              </label>
              <select
                name="taxSystem"
                defaultValue="УСН Доходы"
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              >
                <option value="УСН Доходы">УСН Доходы</option>
                <option value="УСН Доходы-Расходы">УСН Доходы-Расходы</option>
                <option value="ОСНО">ОСНО</option>
                <option value="Патент">Патент</option>
                <option value="НПД">НПД</option>
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Налог, %
              </label>
              <input
                name="incomeTaxRate"
                inputMode="decimal"
                defaultValue="1"
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                НДС, %
              </label>
              <input
                name="vatRate"
                inputMode="decimal"
                defaultValue="5"
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              />
            </div>

            <label className="flex items-end gap-3 pb-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                name="isActive"
                defaultChecked
                className="h-4 w-4"
              />
              Активна
            </label>

            <div className="md:col-span-2 xl:col-span-4">
              <button className="rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white">
                Добавить компанию
              </button>
            </div>
          </form>
        </section>

        <section className="grid gap-6 xl:grid-cols-2">
          {rows.map((row) => (
            <div
              key={row.company.id}
              className="rounded-3xl bg-white p-6 shadow-sm ring-1 ring-slate-200"
            >
              <form action="/api/finance/companies" method="POST">
                <input type="hidden" name="id" value={row.company.id} />
                <input type="hidden" name="oldName" value={row.company.name} />

                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-2xl font-black text-slate-950">
                      {row.company.name}
                    </h2>

                    <p className="mt-2 text-sm text-slate-500">
                      Карточка компании в финансовом модуле.
                    </p>
                  </div>

                  <label className="flex items-center gap-2 rounded-full bg-slate-100 px-4 py-2 text-sm font-semibold text-slate-700">
                    <input
                      type="checkbox"
                      name="isActive"
                      defaultChecked={row.company.isActive}
                      className="h-4 w-4"
                    />
                    Активна
                  </label>
                </div>

                <div className="mt-6 grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-700">
                      Название в системе
                    </label>
                    <input
                      name="name"
                      required
                      defaultValue={row.company.name}
                      className="w-full rounded-xl border border-slate-300 px-4 py-2"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-700">
                      Юридическое название
                    </label>
                    <input
                      name="legalName"
                      defaultValue={row.company.legalName ?? ""}
                      placeholder="Например: ИП Петров Иван Иванович"
                      className="w-full rounded-xl border border-slate-300 px-4 py-2"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-700">
                      ИНН
                    </label>
                    <input
                      name="inn"
                      defaultValue={row.company.inn ?? ""}
                      className="w-full rounded-xl border border-slate-300 px-4 py-2"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-700">
                      ОГРНИП
                    </label>
                    <input
                      name="ogrnIp"
                      defaultValue={row.company.ogrnIp ?? ""}
                      className="w-full rounded-xl border border-slate-300 px-4 py-2"
                    />
                  </div>

                  <div>
                    <label className="mb-2 block text-sm font-medium text-slate-700">
                      Налоговый режим
                    </label>
                    <select
                      name="taxSystem"
                      defaultValue={row.company.taxSystem}
                      className="w-full rounded-xl border border-slate-300 px-4 py-2"
                    >
                      <option value="УСН Доходы">УСН Доходы</option>
                      <option value="УСН Доходы-Расходы">
                        УСН Доходы-Расходы
                      </option>
                      <option value="ОСНО">ОСНО</option>
                      <option value="Патент">Патент</option>
                      <option value="НПД">НПД</option>
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-2 block text-sm font-medium text-slate-700">
                        Налог, %
                      </label>
                      <input
                        name="incomeTaxRate"
                        inputMode="decimal"
                        defaultValue={String(row.company.incomeTaxRate ?? 1)}
                        className="w-full rounded-xl border border-slate-300 px-4 py-2"
                      />
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-medium text-slate-700">
                        НДС, %
                      </label>
                      <input
                        name="vatRate"
                        inputMode="decimal"
                        defaultValue={String(row.company.vatRate ?? 5)}
                        className="w-full rounded-xl border border-slate-300 px-4 py-2"
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-6">
                  <button className="rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white">
                    Сохранить настройки
                  </button>
                </div>
              </form>

              <div className="mt-6 grid gap-4 md:grid-cols-3">
                <div className="rounded-xl bg-slate-50 p-4">
                  <div className="text-sm text-slate-500">Счетов</div>
                  <div className="mt-1 text-2xl font-bold text-slate-900">
                    {row.accounts.length}
                  </div>
                </div>

                <div className="rounded-xl bg-slate-50 p-4">
                  <div className="text-sm text-slate-500">Кредитов</div>
                  <div className="mt-1 text-2xl font-bold text-slate-900">
                    {row.loans.length}
                  </div>
                </div>

                <div className="rounded-xl bg-slate-50 p-4">
                  <div className="text-sm text-slate-500">Операций</div>
                  <div className="mt-1 text-2xl font-bold text-slate-900">
                    {row.transactionsCount}
                  </div>
                </div>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-slate-200 p-4">
                  <div className="text-sm text-slate-500">
                    Начальные остатки
                  </div>
                  <div className="mt-1 text-xl font-bold text-blue-600">
                    {formatMoney(row.totalOpeningBalance)}
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 p-4">
                  <div className="text-sm text-slate-500">Текущий долг</div>
                  <div className="mt-1 text-xl font-bold text-red-600">
                    {formatMoney(row.totalDebt)}
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 p-4">
                  <div className="text-sm text-slate-500">
                    Платёж по кредитам
                  </div>
                  <div className="mt-1 text-xl font-bold text-amber-600">
                    {formatMoney(row.monthlyPayment)}
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 p-4">
                  <div className="text-sm text-slate-500">
                    Доходы / расходы
                  </div>
                  <div className="mt-1 text-xl font-bold text-slate-900">
                    {formatMoney(row.income)} / {formatMoney(row.expense)}
                  </div>
                </div>
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <Link
                  href="/finance/accounts"
                  className="rounded-xl border border-slate-300 px-4 py-2 font-semibold text-slate-700"
                >
                  Счета
                </Link>

                <Link
                  href="/finance/loans"
                  className="rounded-xl border border-slate-300 px-4 py-2 font-semibold text-slate-700"
                >
                  Кредиты
                </Link>

                <Link
                  href="/finance/operations"
                  className="rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white"
                >
                  Операции
                </Link>

                <Link
                  href="/settings/api-connections"
                  className="rounded-xl bg-blue-600 px-4 py-2 font-semibold text-white"
                >
                  API-подключения
                </Link>
              </div>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}