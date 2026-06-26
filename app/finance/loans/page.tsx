import Link from "next/link";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function formatMoney(value: unknown) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

function formatPercent(value: unknown) {
  const number = Number(value ?? 0);
  if (!number) return "—";
  return `${number}%`;
}

function formatDate(value: Date | null) {
  if (!value) return "—";
  return value.toLocaleDateString("ru-RU");
}

function frequencyLabel(value: string | null | undefined) {
  if (value === "MONTHLY") return "Ежемесячно";
  if (value === "WEEKLY") return "Еженедельно";
  if (value === "BIWEEKLY") return "Раз в 2 недели";
  if (value === "TWICE_MONTHLY_15_25") return "15 и 25 числа";
  if (value === "CUSTOM") return "Ручной график";
  return "Ежемесячно";
}

function monthLabel(date: Date) {
  return date.toLocaleDateString("ru-RU", {
    month: "long",
    year: "numeric",
  });
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfYear(date: Date) {
  return new Date(date.getFullYear(), 11, 31, 23, 59, 59, 999);
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function getAmount(value: unknown) {
  return Number(value ?? 0);
}

export default async function LoansPage({
  searchParams,
}: {
  searchParams?: Promise<{
    company?: string;
  }>;
}) {
  const now = new Date();
  const from = startOfMonth(now);
  const to = endOfYear(now);

  const companies = await prisma.$queryRaw<{ id: string; name: string }[]>`
    select "id", "name"
    from "Company"
    where "isActive" = true
    order by "name" asc
  `;

  const params = searchParams ? await searchParams : {};

  const companyName =
    params.company && params.company !== "ALL" ? params.company : null;

  const loans = await prisma.loan.findMany({
    where: {
      ...(companyName ? { companyName } : {}),
    },
    include: {
      payments: {
        orderBy: {
          paymentDate: "asc",
        },
      },
    },
    orderBy: [{ companyName: "asc" }, { bankName: "asc" }],
  });

  const paymentsUntilYearEnd = await prisma.loanPayment.findMany({
    where: {
      paymentDate: {
        gte: from,
        lte: to,
      },
      ...(companyName
        ? {
            loan: {
              companyName,
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

  const totalDebt = loans.reduce(
    (sum, loan) => sum + getAmount(loan.currentDebt),
    0
  );

  const totalMonthlyPayment = loans.reduce(
    (sum, loan) => sum + getAmount(loan.monthlyPayment),
    0
  );

  const totalPaymentsUntilYearEnd = paymentsUntilYearEnd.reduce(
    (sum, payment) => sum + getAmount(payment.totalAmount),
    0
  );

  const totalPrincipalUntilYearEnd = paymentsUntilYearEnd.reduce(
    (sum, payment) => sum + getAmount(payment.principalAmount),
    0
  );

  const totalInterestUntilYearEnd = paymentsUntilYearEnd.reduce(
    (sum, payment) => sum + getAmount(payment.interestAmount),
    0
  );

  const averageRate =
    loans.length > 0
      ? loans.reduce((sum, loan) => sum + getAmount(loan.interestRate), 0) /
        loans.length
      : 0;

  const monthlyMap = new Map<
    string,
    {
      monthDate: Date;
      totalAmount: number;
      principalAmount: number;
      interestAmount: number;
      loansCount: Set<string>;
      paymentsCount: number;
    }
  >();

  for (const payment of paymentsUntilYearEnd) {
    const key = monthKey(payment.paymentDate);

    const current =
      monthlyMap.get(key) ??
      {
        monthDate: new Date(
          payment.paymentDate.getFullYear(),
          payment.paymentDate.getMonth(),
          1
        ),
        totalAmount: 0,
        principalAmount: 0,
        interestAmount: 0,
        loansCount: new Set<string>(),
        paymentsCount: 0,
      };

    current.totalAmount += getAmount(payment.totalAmount);
    current.principalAmount += getAmount(payment.principalAmount);
    current.interestAmount += getAmount(payment.interestAmount);
    current.loansCount.add(payment.loanId);
    current.paymentsCount += 1;

    monthlyMap.set(key, current);
  }

  const paymentSchedule = Array.from(monthlyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => ({
      ...row,
      loansCountNumber: row.loansCount.size,
    }));

  const nextPayments = paymentsUntilYearEnd.slice(0, 8);

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900">
              Кредиты и займы
            </h1>

            <p className="mt-3 text-slate-500">
              Учёт кредитов, долговой нагрузки и фактического графика платежей.
            </p>
          </div>

          <div className="flex gap-3">
            <Link
              href="/finance/cashflow"
              className="rounded-xl border border-slate-300 px-5 py-3 font-semibold"
            >
              ОДДС
            </Link>

            <Link
              href="/finance/calendar"
              className="rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white"
            >
              Платёжный календарь
            </Link>

            <Link
              href="/finance/accounts"
              className="rounded-xl border border-slate-300 px-5 py-3 font-semibold"
            >
              Счета
            </Link>
          </div>
        </div>

        <form className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="sm:w-[260px]">
            <label className="mb-2 block text-sm font-medium text-slate-700">
              Компания
            </label>

            <select
              name="company"
              defaultValue={params.company ?? "ALL"}
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
        </form>

        <section className="grid gap-4 md:grid-cols-5">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Общий долг</div>
            <div className="mt-2 text-3xl font-bold text-red-600">
              {formatMoney(totalDebt)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Платеж в месяц</div>
            <div className="mt-2 text-3xl font-bold text-amber-600">
              {formatMoney(totalMonthlyPayment)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">
              До конца года выплатить
            </div>
            <div className="mt-2 text-3xl font-bold text-red-600">
              {formatMoney(totalPaymentsUntilYearEnd)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Кредитов</div>
            <div className="mt-2 text-3xl font-bold text-slate-900">
              {loans.length}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Средняя ставка</div>
            <div className="mt-2 text-3xl font-bold text-blue-600">
              {averageRate.toFixed(1)}%
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">
              Тело кредита до конца года
            </div>
            <div className="mt-2 text-2xl font-bold text-red-600">
              {formatMoney(totalPrincipalUntilYearEnd)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">
              Проценты до конца года
            </div>
            <div className="mt-2 text-2xl font-bold text-amber-600">
              {formatMoney(totalInterestUntilYearEnd)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">
              Платежей в графике до конца года
            </div>
            <div className="mt-2 text-2xl font-bold text-slate-900">
              {paymentsUntilYearEnd.length}
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <section className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-bold text-slate-900">
              График платежей до конца года
            </h2>

            <p className="mt-2 text-sm text-slate-500">
              Расчёт строится по реальному графику платежей LoanPayment:
              тело кредита + проценты.
            </p>

            <div className="mt-6 overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="bg-slate-100 text-left text-slate-700">
                  <tr>
                    <th className="p-3">Месяц</th>
                    <th className="p-3 text-right">Всего платежей</th>
                    <th className="p-3 text-right">Тело</th>
                    <th className="p-3 text-right">Проценты</th>
                    <th className="p-3 text-right">Кредитов</th>
                    <th className="p-3 text-right">Платежей</th>
                  </tr>
                </thead>

                <tbody>
                  {paymentSchedule.map((row) => (
                    <tr
                      key={row.monthDate.toISOString()}
                      className="border-t border-slate-100"
                    >
                      <td className="p-3 font-medium">
                        {monthLabel(row.monthDate)}
                      </td>

                      <td className="p-3 text-right font-bold text-red-600">
                        {formatMoney(row.totalAmount)}
                      </td>

                      <td className="p-3 text-right font-bold text-red-600">
                        {formatMoney(row.principalAmount)}
                      </td>

                      <td className="p-3 text-right font-bold text-amber-600">
                        {formatMoney(row.interestAmount)}
                      </td>

                      <td className="p-3 text-right">
                        {row.loansCountNumber}
                      </td>

                      <td className="p-3 text-right">
                        {row.paymentsCount}
                      </td>
                    </tr>
                  ))}

                  {paymentSchedule.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="p-8 text-center text-slate-500"
                      >
                        Платежей пока нет.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-bold text-slate-900">
              Ближайшие платежи
            </h2>

            <div className="mt-6 space-y-3">
              {nextPayments.map((payment) => (
                <div
                  key={payment.id}
                  className="rounded-xl border border-slate-200 p-4"
                >
                  <div className="text-sm text-slate-500">
                    {formatDate(payment.paymentDate)}
                  </div>

                  <div className="mt-1 font-bold text-slate-900">
                    {payment.loan.bankName}
                  </div>

                  <div className="mt-1 text-2xl font-bold text-red-600">
                    {formatMoney(payment.totalAmount)}
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                    <div className="text-slate-500">
                      Тело:{" "}
                      <span className="font-semibold text-red-600">
                        {formatMoney(payment.principalAmount)}
                      </span>
                    </div>

                    <div className="text-slate-500">
                      Проценты:{" "}
                      <span className="font-semibold text-amber-600">
                        {formatMoney(payment.interestAmount)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}

              {nextPayments.length === 0 && (
                <div className="rounded-xl bg-slate-50 p-6 text-center text-slate-500">
                  Ближайших платежей пока нет.
                </div>
              )}
            </div>
          </section>
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-2xl font-bold text-slate-900">
            Добавить кредит
          </h2>

          <form
            action="/api/finance/loans"
            method="POST"
            className="mt-6 grid gap-4 md:grid-cols-4"
          >
            <select
              name="companyName"
              className="rounded-xl border border-slate-300 px-4 py-2"
              defaultValue={companies[0]?.name ?? ""}
            >
              {companies.map((company) => (
                <option key={company.id} value={company.name}>
                  {company.name}
                </option>
              ))}
            </select>

            <input
              name="bankName"
              required
              placeholder="Банк"
              className="rounded-xl border border-slate-300 px-4 py-2"
            />

            <input
              name="contractNumber"
              placeholder="Номер договора"
              className="rounded-xl border border-slate-300 px-4 py-2"
            />

            <select
              name="paymentFrequency"
              defaultValue="MONTHLY"
              className="rounded-xl border border-slate-300 px-4 py-2"
            >
              <option value="MONTHLY">Ежемесячно</option>
              <option value="WEEKLY">Еженедельно</option>
              <option value="BIWEEKLY">Раз в 2 недели</option>
              <option value="TWICE_MONTHLY_15_25">15 и 25 числа</option>
              <option value="CUSTOM">Ручной график</option>
            </select>

            <input
              name="interestRate"
              placeholder="Ставка %"
              className="rounded-xl border border-slate-300 px-4 py-2"
            />

            <input
              name="creditLimit"
              placeholder="Лимит кредита"
              className="rounded-xl border border-slate-300 px-4 py-2"
            />

            <input
              name="currentDebt"
              placeholder="Текущий долг"
              className="rounded-xl border border-slate-300 px-4 py-2"
            />

            <input
              name="monthlyPayment"
              placeholder="Платеж в месяц"
              className="rounded-xl border border-slate-300 px-4 py-2"
            />

            <input
              type="date"
              name="startDate"
              className="rounded-xl border border-slate-300 px-4 py-2"
            />

            <input
              type="date"
              name="endDate"
              className="rounded-xl border border-slate-300 px-4 py-2"
            />

            <button className="rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white">
              Добавить кредит
            </button>
          </form>

          <p className="mt-3 text-sm text-slate-500">
            Для кредитов с оплатой 15 и 25 числа выбери периодичность
            “15 и 25 числа”. График платежей будем редактировать отдельно на
            странице графика.
          </p>
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-2xl font-bold text-slate-900">
            Список кредитов
          </h2>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[1400px] text-sm">
              <thead className="bg-slate-100 text-left text-slate-700">
                <tr>
                  <th className="p-3">Компания</th>
                  <th className="p-3">Банк</th>
                  <th className="p-3">Договор</th>
                  <th className="p-3 text-right">Долг</th>
                  <th className="p-3 text-right">Платеж</th>
                  <th className="p-3 text-right">Ставка</th>
                  <th className="p-3">Периодичность</th>
                  <th className="p-3">Дата окончания</th>
                  <th className="p-3 text-right">Платежей</th>
                  <th className="p-3 text-center">График</th>
                </tr>
              </thead>

              <tbody>
                {loans.map((loan) => (
                  <tr key={loan.id} className="border-t border-slate-100">
                    <td className="p-3 font-medium">{loan.companyName}</td>

                    <td className="p-3">{loan.bankName}</td>

                    <td className="p-3">{loan.contractNumber || "—"}</td>

                    <td className="p-3 text-right font-bold text-red-600">
                      {formatMoney(loan.currentDebt)}
                    </td>

                    <td className="p-3 text-right font-bold text-amber-600">
                      {formatMoney(loan.monthlyPayment)}
                    </td>

                    <td className="p-3 text-right">
                      {formatPercent(loan.interestRate)}
                    </td>

                    <td className="p-3">
                      {frequencyLabel(loan.paymentFrequency)}
                    </td>

                    <td className="p-3">{formatDate(loan.endDate)}</td>

                    <td className="p-3 text-right">
                      {loan.payments.length}
                    </td>

                    <td className="p-3 text-center">
                      <Link
                        href={`/finance/loans/${loan.id}/schedule`}
                        className="rounded-lg bg-slate-900 px-3 py-1 text-sm font-medium text-white"
                      >
                        График →
                      </Link>
                    </td>
                  </tr>
                ))}

                {loans.length === 0 && (
                  <tr>
                    <td colSpan={10} className="p-8 text-center text-slate-500">
                      Кредиты пока не заведены.
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