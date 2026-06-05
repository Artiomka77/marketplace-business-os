import Link from "next/link";
import { prisma } from "@/lib/prisma";

function formatMoney(value: unknown) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

function startOfToday() {
  const date = new Date();
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

export default async function FinanceForecastPage() {
  const today = startOfToday();
  const in30Days = addDays(today, 30);
  const monthEnd = endOfMonth(today);

  const accounts = await prisma.financeAccount.findMany({
    where: {
      isActive: true,
    },
    orderBy: [{ companyName: "asc" }, { name: "asc" }],
  });

  const loanPayments30Days = await prisma.loanPayment.findMany({
    where: {
      paymentDate: {
        gte: today,
        lte: in30Days,
      },
    },
    include: {
      loan: true,
    },
    orderBy: {
      paymentDate: "asc",
    },
  });

  const loanPaymentsUntilMonthEnd = await prisma.loanPayment.findMany({
    where: {
      paymentDate: {
        gte: today,
        lte: monthEnd,
      },
    },
    include: {
      loan: true,
    },
    orderBy: {
      paymentDate: "asc",
    },
  });

  const futureTransactions30Days = await prisma.financeTransaction.findMany({
    where: {
      operationDate: {
        gte: today,
        lte: in30Days,
      },
      isInternalTransfer: false,
    },
    orderBy: {
      operationDate: "asc",
    },
  });

  const totalCash = accounts.reduce(
    (sum, account) => sum + Number(account.currentBalance ?? 0),
    0
  );

  const plannedLoanPayments30Days = loanPayments30Days.reduce(
    (sum, payment) => sum + Number(payment.totalAmount ?? 0),
    0
  );

  const plannedLoanPaymentsUntilMonthEnd = loanPaymentsUntilMonthEnd.reduce(
    (sum, payment) => sum + Number(payment.totalAmount ?? 0),
    0
  );

  const plannedIncome30Days = futureTransactions30Days
    .filter((operation) => operation.operationType === "INCOME")
    .reduce((sum, operation) => sum + Number(operation.amount ?? 0), 0);

  const plannedExpense30Days = futureTransactions30Days
    .filter(
      (operation) =>
        operation.operationType === "EXPENSE" ||
        operation.operationType === "PERSONAL" ||
        operation.operationType === "FINANCING"
    )
    .reduce((sum, operation) => sum + Number(operation.amount ?? 0), 0);

  const totalPlannedOutflow30Days =
    plannedLoanPayments30Days + plannedExpense30Days;

  const freeCashAfter30Days =
    totalCash + plannedIncome30Days - totalPlannedOutflow30Days;

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900">
              Прогноз ликвидности
            </h1>

            <p className="mt-3 text-slate-500">
              Остатки денег, будущие платежи и предварительный риск кассового
              разрыва.
            </p>
          </div>

          <div className="flex gap-3">
            <Link
              href="/finance"
              className="rounded-xl border border-slate-300 px-5 py-3 font-semibold"
            >
              Финансы
            </Link>

            <Link
              href="/finance/calendar"
              className="rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white"
            >
              Платёжный календарь
            </Link>
          </div>
        </div>

        <section className="grid gap-4 md:grid-cols-4">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Денег на счетах</div>
            <div className="mt-2 text-3xl font-bold text-emerald-600">
              {formatMoney(totalCash)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">
              Поступления 30 дней
            </div>
            <div className="mt-2 text-3xl font-bold text-emerald-600">
              {formatMoney(plannedIncome30Days)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Платежи 30 дней</div>
            <div className="mt-2 text-3xl font-bold text-red-600">
              {formatMoney(totalPlannedOutflow30Days)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">
              Остаток через 30 дней
            </div>
            <div
              className={`mt-2 text-3xl font-bold ${
                freeCashAfter30Days >= 0 ? "text-emerald-600" : "text-red-600"
              }`}
            >
              {formatMoney(freeCashAfter30Days)}
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
          <section className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-bold text-slate-900">
              Остатки по счетам
            </h2>

            <div className="mt-5 space-y-3">
              {accounts.map((account) => (
                <div
                  key={account.id}
                  className="flex items-center justify-between rounded-xl border border-slate-200 p-4"
                >
                  <div>
                    <div className="font-bold text-slate-900">
                      {account.name}
                    </div>
                    <div className="text-sm text-slate-500">
                      {account.companyName} · {account.accountType}
                    </div>
                  </div>

                  <div
                    className={`text-xl font-bold ${
                      Number(account.currentBalance ?? 0) >= 0
                        ? "text-emerald-600"
                        : "text-red-600"
                    }`}
                  >
                    {formatMoney(account.currentBalance)}
                  </div>
                </div>
              ))}

              {accounts.length === 0 && (
                <div className="rounded-xl bg-slate-50 p-8 text-center text-slate-500">
                  Денежные счета пока не заведены.
                </div>
              )}
            </div>
          </section>

          <section className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-bold text-slate-900">
              До конца месяца выплатить
            </h2>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-slate-200 p-5">
                <div className="text-sm text-slate-500">
                  Кредиты до конца месяца
                </div>
                <div className="mt-2 text-3xl font-bold text-red-600">
                  {formatMoney(plannedLoanPaymentsUntilMonthEnd)}
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 p-5">
                <div className="text-sm text-slate-500">
                  Кредиты за 30 дней
                </div>
                <div className="mt-2 text-3xl font-bold text-red-600">
                  {formatMoney(plannedLoanPayments30Days)}
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 p-5">
                <div className="text-sm text-slate-500">
                  Плановые расходы за 30 дней
                </div>
                <div className="mt-2 text-3xl font-bold text-red-600">
                  {formatMoney(plannedExpense30Days)}
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 p-5">
                <div className="text-sm text-slate-500">
                  Общие выбытия за 30 дней
                </div>
                <div className="mt-2 text-3xl font-bold text-red-600">
                  {formatMoney(totalPlannedOutflow30Days)}
                </div>
              </div>
            </div>
          </section>
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-2xl font-bold text-slate-900">
            Ближайшие кредитные платежи
          </h2>

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[1000px] text-sm">
              <thead className="bg-slate-100 text-left text-slate-700">
                <tr>
                  <th className="p-3">Дата</th>
                  <th className="p-3">Компания</th>
                  <th className="p-3">Кредит</th>
                  <th className="p-3 text-right">Тело</th>
                  <th className="p-3 text-right">Проценты</th>
                  <th className="p-3 text-right">Платёж</th>
                </tr>
              </thead>

              <tbody>
                {loanPayments30Days.map((payment) => (
                  <tr key={payment.id} className="border-t border-slate-100">
                    <td className="p-3">
                      {payment.paymentDate.toLocaleDateString("ru-RU")}
                    </td>

                    <td className="p-3">{payment.loan.companyName}</td>

                    <td className="p-3 font-medium">{payment.loan.bankName}</td>

                    <td className="p-3 text-right font-bold text-slate-900">
                      {formatMoney(payment.principalAmount)}
                    </td>

                    <td className="p-3 text-right font-bold text-amber-600">
                      {formatMoney(payment.interestAmount)}
                    </td>

                    <td className="p-3 text-right font-bold text-red-600">
                      {formatMoney(payment.totalAmount)}
                    </td>
                  </tr>
                ))}

                {loanPayments30Days.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-slate-500">
                      В ближайшие 30 дней кредитных платежей нет.
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