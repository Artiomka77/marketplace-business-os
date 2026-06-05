import Link from "next/link";
import { prisma } from "@/lib/prisma";

function formatMoney(value: unknown) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
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
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function dayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

function addMonths(date: Date, count: number) {
  return new Date(date.getFullYear(), date.getMonth() + count, 1);
}

function getAmount(value: unknown) {
  return Number(value ?? 0);
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

export default async function FinanceCalendarPage({
  searchParams,
}: {
  searchParams?: {
    month?: string;
  };
}) {
  const selectedMonth = toMonthDate(searchParams?.month);
  const monthStart = startOfMonth(selectedMonth);
  const monthEnd = endOfMonth(selectedMonth);

  const payments = await prisma.loanPayment.findMany({
    where: {
      paymentDate: {
        gte: monthStart,
        lte: monthEnd,
      },
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

  const futurePayments = await prisma.loanPayment.findMany({
    where: {
      paymentDate: {
        gte: new Date(),
      },
    },
    include: {
      loan: true,
    },
    orderBy: {
      paymentDate: "asc",
    },
    take: 20,
  });

function remainingDebtAfterPayment(payment: (typeof payments)[number]) {
  return payment.loan.payments
    .filter((loanPayment) => loanPayment.paymentDate > payment.paymentDate)
    .reduce(
      (sum, loanPayment) => sum + getAmount(loanPayment.principalAmount),
      0
    );
}

  const paymentsByDay = new Map<string, typeof payments>();

  for (const payment of payments) {
    const key = dayKey(payment.paymentDate);
    const current = paymentsByDay.get(key) ?? [];
    current.push(payment);
    paymentsByDay.set(key, current);
  }

  const dayRows = Array.from(paymentsByDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rows]) => {
      const total = rows.reduce(
        (sum, payment) => sum + getAmount(payment.totalAmount),
        0
      );

      const principal = rows.reduce(
        (sum, payment) => sum + getAmount(payment.principalAmount),
        0
      );

      const interest = rows.reduce(
        (sum, payment) => sum + getAmount(payment.interestAmount),
        0
      );

      return {
        key,
        date: rows[0].paymentDate,
        payments: rows,
        total,
        principal,
        interest,
      };
    });

  const totalMonthPayments = payments.reduce(
    (sum, payment) => sum + getAmount(payment.totalAmount),
    0
  );

  const totalMonthPrincipal = payments.reduce(
    (sum, payment) => sum + getAmount(payment.principalAmount),
    0
  );

  const totalMonthInterest = payments.reduce(
    (sum, payment) => sum + getAmount(payment.interestAmount),
    0
  );

  const totalDebtBeforeMonth = payments.reduce((sum, payment) => {
    return sum + getAmount(payment.loan.currentDebt);
  }, 0);

  const uniqueLoanIds = new Set(payments.map((payment) => payment.loanId));
  const uniqueLoans = Array.from(uniqueLoanIds)
    .map((loanId) => payments.find((payment) => payment.loanId === loanId)?.loan)
    .filter(Boolean);

  const debtBeforeMonth = uniqueLoans.reduce(
    (sum, loan) => sum + getAmount(loan?.currentDebt),
    0
  );

  const debtAfterMonth = Math.max(debtBeforeMonth - totalMonthPrincipal, 0);

  const next30DaysTotal = futurePayments
    .slice(0, 30)
    .reduce((sum, payment) => sum + getAmount(payment.totalAmount), 0);

  const previousMonth = monthKey(addMonths(selectedMonth, -1));
  const nextMonth = monthKey(addMonths(selectedMonth, 1));

  return (
    <main className="min-h-screen bg-slate-100 p-6">
      <div className="mx-auto max-w-[1320px] space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900">
              Платёжный календарь
            </h1>

            <p className="mt-2 text-slate-500">
              Платежи по кредитам, остаток после оплаты и редактирование графика.
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
                    <b className="text-slate-900">{payments.length}</b>
                  </span>

                  <span>
                    Всего:{" "}
                    <b className="text-red-600">
                      {formatMoney(totalMonthPayments)}
                    </b>
                  </span>

                  <span>
                    Тело:{" "}
                    <b className="text-red-600">
                      {formatMoney(totalMonthPrincipal)}
                    </b>
                  </span>

                  <span>
                    Проценты:{" "}
                    <b className="text-amber-600">
                      {formatMoney(totalMonthInterest)}
                    </b>
                  </span>
                </div>
              </div>

              <div className="flex gap-2">
                <Link
                  href={`/finance/calendar?month=${previousMonth}`}
                  className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold"
                >
                  ←
                </Link>

                <Link
                  href="/finance/calendar"
                  className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white"
                >
                  Текущий
                </Link>

                <Link
                  href={`/finance/calendar?month=${nextMonth}`}
                  className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold"
                >
                  →
                </Link>
              </div>
            </div>
          </div>

          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <div className="text-sm text-slate-500">Было долга</div>
                <div className="mt-1 text-xl font-bold text-slate-900">
                  {formatMoney(debtBeforeMonth)}
                </div>
              </div>

              <div>
                <div className="text-sm text-slate-500">После месяца</div>
                <div className="mt-1 text-xl font-bold text-emerald-600">
                  {formatMoney(debtAfterMonth)}
                </div>
              </div>

              <div>
                <div className="text-sm text-slate-500">Ближайшие 30 дней</div>
                <div className="mt-1 text-xl font-bold text-red-600">
                  {formatMoney(next30DaysTotal)}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="space-y-4">
          {dayRows.map((day) => (
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
                      {day.payments.length}{" "}
                      {day.payments.length === 1 ? "платёж" : "платежа"}
                    </div>

                    <div className="mt-1 text-sm text-slate-500">
                      Тело {formatMoney(day.principal)} · проценты{" "}
                      {formatMoney(day.interest)}
                    </div>
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-2xl font-bold text-red-600">
                    {formatMoney(day.total)}
                  </div>
                  <div className="text-sm text-slate-500">всего за день</div>
                </div>
              </div>

              <div className="divide-y divide-slate-100">
                {day.payments.map((payment) => {
                  const debtAfterPayment = remainingDebtAfterPayment(payment);

                  return (
                    <details key={payment.id} className="group">
                      <summary className="grid cursor-pointer list-none grid-cols-[1.4fr_110px_110px_120px_150px_100px] items-center gap-3 px-5 py-3 hover:bg-slate-50">
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-900 text-xs font-bold text-white">
                            {loanBadge(payment.loan.bankName)}
                          </div>

                          <div className="min-w-0">
                            <div className="truncate font-bold text-slate-900">
                              {payment.loan.bankName}
                            </div>

                            <div className="truncate text-sm text-slate-500">
                              {payment.loan.companyName} ·{" "}
                              {frequencyLabel(payment.loan.paymentFrequency)}
                            </div>
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="text-xs text-slate-500">Тело</div>
                          <div className="font-semibold text-slate-900">
                            {formatMoney(payment.principalAmount)}
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="text-xs text-slate-500">%</div>
                          <div className="font-semibold text-amber-600">
                            {formatMoney(payment.interestAmount)}
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="text-xs text-slate-500">Платёж</div>
                          <div className="font-bold text-red-600">
                            {formatMoney(payment.totalAmount)}
                          </div>
                        </div>

                        <div className="text-right">
                          <div className="text-xs text-slate-500">
                            Остаток по графику
                          </div>
                          <div className="font-bold text-emerald-700">
                            {formatMoney(debtAfterPayment)}
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
                            value={payment.id}
                          />

                          <input
                            type="date"
                            name="paymentDate"
                            defaultValue={inputDate(payment.paymentDate)}
                            className="rounded-xl border border-slate-300 px-3 py-2"
                          />

                          <input
                            name="principalAmount"
                            defaultValue={String(
                              Number(payment.principalAmount ?? 0)
                            )}
                            inputMode="decimal"
                            className="rounded-xl border border-slate-300 px-3 py-2"
                            placeholder="Тело"
                          />

                          <input
                            name="interestAmount"
                            defaultValue={String(
                              Number(payment.interestAmount ?? 0)
                            )}
                            inputMode="decimal"
                            className="rounded-xl border border-slate-300 px-3 py-2"
                            placeholder="Проценты"
                          />

                          <input
                            name="totalAmount"
                            defaultValue={String(Number(payment.totalAmount ?? 0))}
                            inputMode="decimal"
                            className="rounded-xl border border-slate-300 px-3 py-2"
                            placeholder="Итого"
                          />

                          <select
                            name="paymentFrequency"
                            defaultValue={
                              payment.loan.paymentFrequency ?? "MONTHLY"
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

                        <div className="mt-3 rounded-xl bg-white p-3 text-xs text-slate-500">
                          <b className="text-slate-700">Важно:</b> если выбрать
                          “Этот и будущие”, дата будущих платежей перестроится
                          по выбранной частоте, а суммы применятся ко всем
                          будущим платежам этого кредита.
                        </div>
                      </div>
                    </details>
                  );
                })}
              </div>
            </div>
          ))}

          {dayRows.length === 0 && (
            <div className="rounded-xl bg-white p-8 text-center text-slate-500 shadow-sm">
              В этом месяце платежей нет.
            </div>
          )}
        </section>

        <section className="rounded-2xl bg-white p-5 shadow-sm">
          <h2 className="text-2xl font-bold text-slate-900">
            Ближайшие платежи
          </h2>

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
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
                {futurePayments.map((payment) => (
                  <tr key={payment.id} className="border-t border-slate-100">
                    <td className="p-3">{formatDate(payment.paymentDate)}</td>
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

                {futurePayments.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-slate-500">
                      Плановых платежей пока нет.
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