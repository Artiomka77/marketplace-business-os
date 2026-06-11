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

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function getAmount(value: unknown) {
  return Number(value ?? 0);
}

function isCreditLikeCategory(category: string) {
  const text = String(category ?? "").toLowerCase();

  return (
    text.includes("кредит") ||
    text.includes("займ") ||
    text.includes("процент") ||
    text.includes("погашение")
  );
}

function obligationTypeLabel(category: string, operationType: string) {
  const text = `${category} ${operationType}`.toLowerCase();

  if (text.includes("кредит") || text.includes("займ")) return "Кредиты";
  if (text.includes("налог") || text.includes("взнос")) return "Налоги";
  if (text.includes("постав") || text.includes("закуп")) return "Поставщики";
  if (text.includes("зарплат")) return "Зарплата";
  if (text.includes("лич")) return "Личные";
  if (operationType === "INCOME") return "Поступления";

  return "Прочее";
}

function dayKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function buildForecastHref(company: string, days: number) {
  const query = new URLSearchParams();

  query.set("company", company);
  query.set("days", String(days));

  return `/finance/forecast?${query.toString()}`;
}

export default async function FinanceForecastPage({
  searchParams,
}: {
  searchParams?: Promise<{
    company?: string;
    days?: string;
  }>;
}) {
  const params = searchParams ? await searchParams : {};

  const selectedCompany = params.company ?? "ALL";
  const companyName = selectedCompany !== "ALL" ? selectedCompany : null;

  const horizonDays = Number(params.days ?? 60);
  const safeHorizonDays = [30, 60, 90].includes(horizonDays) ? horizonDays : 60;

  const today = startOfDay(new Date());
  const todayEnd = endOfDay(today);
  const sevenDaysEnd = endOfDay(addDays(today, 6));
  const thirtyDaysEnd = endOfDay(addDays(today, 29));
  const horizonEnd = endOfDay(addDays(today, safeHorizonDays - 1));

  const companies = await prisma.company.findMany({
    where: {
      isActive: true,
    },
    orderBy: {
      name: "asc",
    },
  });

  const selectedLoans = companyName
    ? await prisma.loan.findMany({
        where: {
          companyName,
        },
        select: {
          id: true,
        },
      })
    : [];

  const selectedLoanIds = selectedLoans.map((loan) => loan.id);

  const accounts = await prisma.financeAccount.findMany({
    where: {
      isActive: true,
      ...(companyName ? { companyName } : {}),
    },
    orderBy: [{ companyName: "asc" }, { name: "asc" }],
  });

  const loanPayments = await prisma.loanPayment.findMany({
    where: {
      paymentDate: {
        gte: today,
        lte: horizonEnd,
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

  const futureTransactions = await prisma.financeTransaction.findMany({
    where: {
      obligationDate: {
        gte: today,
        lte: horizonEnd,
      },
      ...(companyName ? { companyName } : {}),
      isInternalTransfer: false,
    },
    orderBy: {
      obligationDate: "asc",
    },
  });

  const cleanedFutureTransactions = futureTransactions.filter(
    (operation) => !isCreditLikeCategory(operation.category)
  );

  const totalCash = accounts.reduce(
    (sum, account) => sum + getAmount(account.currentBalance),
    0
  );

  const forecastItems = [
    ...loanPayments.map((payment) => ({
      id: payment.id,
      date: payment.paymentDate,
      companyName: payment.loan.companyName,
      type: "Кредиты",
      title: payment.loan.bankName,
      counterparty: payment.loan.bankName,
      inflow: 0,
      outflow: getAmount(payment.totalAmount),
      source: "LOAN",
    })),

    ...cleanedFutureTransactions.map((operation) => {
      const isIncome = operation.operationType === "INCOME";
      const amount = getAmount(operation.amount);

      return {
        id: operation.id,
        date: operation.obligationDate ?? operation.operationDate,
        companyName: operation.companyName,
        type: obligationTypeLabel(operation.category, operation.operationType),
        title: operation.category,
        counterparty: operation.counterparty ?? "—",
        inflow: isIncome ? amount : 0,
        outflow: isIncome ? 0 : amount,
        source: "OPERATION",
      };
    }),
  ].sort((a, b) => a.date.getTime() - b.date.getTime());

  const incoming7Days = forecastItems
    .filter((item) => item.date <= sevenDaysEnd)
    .reduce((sum, item) => sum + item.inflow, 0);

  const outgoing7Days = forecastItems
    .filter((item) => item.date <= sevenDaysEnd)
    .reduce((sum, item) => sum + item.outflow, 0);

  const incoming30Days = forecastItems
    .filter((item) => item.date <= thirtyDaysEnd)
    .reduce((sum, item) => sum + item.inflow, 0);

  const outgoing30Days = forecastItems
    .filter((item) => item.date <= thirtyDaysEnd)
    .reduce((sum, item) => sum + item.outflow, 0);

  const incomingHorizon = forecastItems.reduce((sum, item) => sum + item.inflow, 0);
  const outgoingHorizon = forecastItems.reduce((sum, item) => sum + item.outflow, 0);

  const balanceAfter7Days = totalCash + incoming7Days - outgoing7Days;
  const balanceAfter30Days = totalCash + incoming30Days - outgoing30Days;
  const balanceAfterHorizon = totalCash + incomingHorizon - outgoingHorizon;

  const dailyMap = new Map<
    string,
    {
      date: Date;
      inflow: number;
      outflow: number;
      itemsCount: number;
      balanceAfterDay: number;
    }
  >();

  for (let day = 0; day < safeHorizonDays; day++) {
    const date = addDays(today, day);
    dailyMap.set(dayKey(date), {
      date,
      inflow: 0,
      outflow: 0,
      itemsCount: 0,
      balanceAfterDay: totalCash,
    });
  }

  for (const item of forecastItems) {
    const key = dayKey(item.date);
    const current = dailyMap.get(key);

    if (!current) continue;

    current.inflow += item.inflow;
    current.outflow += item.outflow;
    current.itemsCount += 1;

    dailyMap.set(key, current);
  }

  let runningBalance = totalCash;
let minBalance = totalCash;

const dailyRows = Array.from(dailyMap.values()).map((row) => {
  runningBalance = runningBalance + row.inflow - row.outflow;
  row.balanceAfterDay = runningBalance;

  if (runningBalance < minBalance) {
    minBalance = runningBalance;
  }

  return row;
});

const firstCashGap =
  dailyRows.find((row) => row.balanceAfterDay < 0) ?? null;

const needToCover = Math.max(0, Math.abs(Math.min(0, minBalance)));

  const typeMap = new Map<
    string,
    {
      type: string;
      inflow: number;
      outflow: number;
      count: number;
    }
  >();

  for (const item of forecastItems) {
    const current =
      typeMap.get(item.type) ??
      {
        type: item.type,
        inflow: 0,
        outflow: 0,
        count: 0,
      };

    current.inflow += item.inflow;
    current.outflow += item.outflow;
    current.count += 1;

    typeMap.set(item.type, current);
  }

  const typeRows = Array.from(typeMap.values()).sort(
    (a, b) => b.outflow - a.outflow
  );

  const nearestPayments = forecastItems.slice(0, 20);

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900">
              Прогноз ликвидности 2.0
            </h1>

            <p className="mt-3 text-slate-500">
              Прогноз остатка денег, будущие платежи и дата возможного кассового разрыва.
            </p>
          </div>

          <div className="flex gap-3">
            <Link
              href="/finance/calendar"
              className="rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white"
            >
              Платёжный календарь
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

            <div className="sm:w-[180px]">
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Горизонт
              </label>

              <select
                name="days"
                defaultValue={String(safeHorizonDays)}
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              >
                <option value="30">30 дней</option>
                <option value="60">60 дней</option>
                <option value="90">90 дней</option>
              </select>
            </div>

            <button className="rounded-xl bg-slate-900 px-6 py-2 font-semibold text-white">
              Применить
            </button>
          </div>
        </form>

        <section className="flex flex-wrap gap-2">
          {[30, 60, 90].map((days) => (
            <Link
              key={days}
              href={buildForecastHref(selectedCompany, days)}
              className={`rounded-xl px-4 py-2 text-sm font-semibold ${
                safeHorizonDays === days
                  ? "bg-slate-900 text-white"
                  : "border border-slate-300 bg-white text-slate-900 hover:bg-slate-50"
              }`}
            >
              {days} дней
            </Link>
          ))}
        </section>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Остаток сегодня</div>
            <div className="mt-2 text-3xl font-bold text-emerald-600">
              {formatMoney(totalCash)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Платежи 7 дней</div>
            <div className="mt-2 text-3xl font-bold text-red-600">
              {formatMoney(outgoing7Days)}
            </div>
            <div
              className={`mt-2 text-sm font-semibold ${
                balanceAfter7Days >= 0 ? "text-emerald-600" : "text-red-600"
              }`}
            >
              Остаток: {formatMoney(balanceAfter7Days)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Платежи 30 дней</div>
            <div className="mt-2 text-3xl font-bold text-red-600">
              {formatMoney(outgoing30Days)}
            </div>
            <div
              className={`mt-2 text-sm font-semibold ${
                balanceAfter30Days >= 0 ? "text-emerald-600" : "text-red-600"
              }`}
            >
              Остаток: {formatMoney(balanceAfter30Days)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">
              Остаток через {safeHorizonDays} дней
            </div>
            <div
              className={`mt-2 text-3xl font-bold ${
                balanceAfterHorizon >= 0 ? "text-emerald-600" : "text-red-600"
              }`}
            >
              {formatMoney(balanceAfterHorizon)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Нужно покрыть</div>
            <div
              className={`mt-2 text-3xl font-bold ${
                needToCover > 0 ? "text-red-600" : "text-emerald-600"
              }`}
            >
              {formatMoney(needToCover)}
            </div>
          </div>
        </section>

        {firstCashGap && (
          <section className="rounded-2xl border border-red-200 bg-red-50 p-6">
            <div className="text-sm font-semibold uppercase text-red-700">
              Первый кассовый разрыв
            </div>

            <div className="mt-2 text-3xl font-bold text-red-700">
              {formatDate(firstCashGap.date)} · {formatMoney(firstCashGap.balanceAfterDay)}
            </div>

            <p className="mt-2 text-sm text-red-700">
              При текущем остатке денег и известных обязательствах денег не хватит.
            </p>
          </section>
        )}

        {!firstCashGap && (
          <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6">
            <div className="text-sm font-semibold uppercase text-emerald-700">
              Кассового разрыва не видно
            </div>

            <div className="mt-2 text-2xl font-bold text-emerald-700">
              В горизонте {safeHorizonDays} дней остаток не уходит ниже нуля.
            </div>
          </section>
        )}

        <section className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
          <section className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-bold text-slate-900">
              Структура будущих платежей
            </h2>

            <div className="mt-5 space-y-3">
              {typeRows.map((row) => (
                <div
                  key={row.type}
                  className="rounded-xl border border-slate-200 p-4"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="font-bold text-slate-900">{row.type}</div>
                      <div className="text-sm text-slate-500">
                        Операций: {row.count}
                      </div>
                    </div>

                    <div className="text-right">
                      {row.inflow > 0 && (
                        <div className="font-bold text-emerald-600">
                          + {formatMoney(row.inflow)}
                        </div>
                      )}

                      {row.outflow > 0 && (
                        <div className="font-bold text-red-600">
                          - {formatMoney(row.outflow)}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {typeRows.length === 0 && (
                <div className="rounded-xl border border-slate-200 p-4 text-slate-500">
                  Будущих платежей нет.
                </div>
              )}
            </div>
          </section>

          <section className="rounded-2xl bg-white p-6 shadow-sm">
            <h2 className="text-2xl font-bold text-slate-900">
              Ближайшие платежи
            </h2>

            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="bg-slate-100 text-left text-slate-700">
                  <tr>
                    <th className="p-3">Дата</th>
                    <th className="p-3">Тип</th>
                    <th className="p-3">Компания</th>
                    <th className="p-3">Статья / кредит</th>
                    <th className="p-3">Контрагент</th>
                    <th className="p-3 text-right">Поступление</th>
                    <th className="p-3 text-right">Платёж</th>
                  </tr>
                </thead>

                <tbody>
                  {nearestPayments.map((item) => (
                    <tr key={`${item.source}-${item.id}`} className="border-t border-slate-100">
                      <td className="p-3">{formatDate(item.date)}</td>
                      <td className="p-3">{item.type}</td>
                      <td className="p-3">{item.companyName}</td>
                      <td className="p-3 font-medium">{item.title}</td>
                      <td className="p-3">{item.counterparty}</td>
                      <td className="p-3 text-right font-bold text-emerald-600">
                        {item.inflow > 0 ? formatMoney(item.inflow) : "—"}
                      </td>
                      <td className="p-3 text-right font-bold text-red-600">
                        {item.outflow > 0 ? formatMoney(item.outflow) : "—"}
                      </td>
                    </tr>
                  ))}

                  {nearestPayments.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-8 text-center text-slate-500">
                        Будущих платежей нет.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-2xl font-bold text-slate-900">
            Прогноз остатка по дням
          </h2>

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-slate-100 text-left text-slate-700">
                <tr>
                  <th className="p-3">Дата</th>
                  <th className="p-3 text-right">Поступления</th>
                  <th className="p-3 text-right">Платежи</th>
                  <th className="p-3 text-right">Остаток после дня</th>
                  <th className="p-3 text-right">Событий</th>
                </tr>
              </thead>

              <tbody>
                {dailyRows.map((row) => (
                  <tr key={dayKey(row.date)} className="border-t border-slate-100">
                    <td className="p-3 font-medium">{formatDate(row.date)}</td>

                    <td className="p-3 text-right font-bold text-emerald-600">
                      {row.inflow > 0 ? formatMoney(row.inflow) : "—"}
                    </td>

                    <td className="p-3 text-right font-bold text-red-600">
                      {row.outflow > 0 ? formatMoney(row.outflow) : "—"}
                    </td>

                    <td
                      className={`p-3 text-right font-bold ${
                        row.balanceAfterDay >= 0
                          ? "text-emerald-600"
                          : "text-red-600"
                      }`}
                    >
                      {formatMoney(row.balanceAfterDay)}
                    </td>

                    <td className="p-3 text-right">{row.itemsCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}