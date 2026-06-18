import Link from "next/link";

import { prisma } from "@/lib/prisma";
import {
  buildFinanceCategoryTreatmentIndex,
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

function formatDate(date: Date) {
  return date.toLocaleDateString("ru-RU");
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
    59,
    999
  );
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function getAmount(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
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

function valueClass(value: number) {
  return value >= 0 ? "text-emerald-600" : "text-red-600";
}

function loanPaymentTotal(payment: {
  totalAmount: unknown;
  principalAmount: unknown;
  interestAmount: unknown;
}) {
  return (
    getAmount(payment.totalAmount) ||
    getAmount(payment.principalAmount) + getAmount(payment.interestAmount)
  );
}

function forecastTypeLabel(params: {
  treatment: string;
  category: string;
  operationType: string;
}) {
  const text = `${params.category} ${params.operationType}`.toLowerCase();

  if (params.treatment === "CREDIT_RECEIVED") return "Получение кредита";
  if (params.treatment === "OWNER_WITHDRAWAL") return "Личные";
  if (params.treatment === "CASH_ONLY") return "Только ДДС";

  if (params.treatment === "INCLUDE_IN_NET_PROFIT") {
    if (text.includes("налог") || text.includes("взнос")) return "Налоги";
    if (text.includes("постав") || text.includes("закуп")) return "Поставщики";
    if (text.includes("зарплат")) return "Зарплата";
    if (params.operationType === "INCOME") return "Поступления";
    return "Операционные";
  }

  if (params.operationType === "INCOME") return "Поступления";

  return "Прочее";
}

type ForecastItem = {
  id: string;
  date: Date;
  companyName: string;
  type: string;
  title: string;
  counterparty: string;
  inflow: number;
  outflow: number;
  source: "LOAN" | "OPERATION";
  treatmentLabel: string;
  treatmentClassName: string;
  treatmentDescription: string;
  principal?: number;
  interest?: number;
};

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
  const safeHorizonDays = [30, 60, 90].includes(horizonDays)
    ? horizonDays
    : 60;

  const today = startOfDay(new Date());
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

  const categoryTreatmentIndex = buildFinanceCategoryTreatmentIndex(categories);

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

  const totalCash = accounts.reduce(
    (sum, account) => sum + getAmount(account.currentBalance),
    0
  );

  function shouldUseFutureTransaction(operation: {
    operationType: string;
    category: string;
    amount: unknown;
    subcategory?: string | null;
    isInternalTransfer?: boolean | null;
    transferDirection?: string | null;
  }) {
    const treatment = getFinanceTransactionTreatment(
      operation,
      categoryTreatmentIndex
    );

    const cashEffect = getFinanceTransactionCashEffect(
      operation,
      categoryTreatmentIndex
    );

    if (cashEffect === 0) return false;
    if (treatment.treatment === "IGNORE") return false;

    // Платежи по кредитам берём из LoanPayment, чтобы не задвоить график кредита
    // с будущими финансовыми операциями.
    if (treatment.treatment === "CREDIT_PRINCIPAL") return false;
    if (treatment.treatment === "CREDIT_INTEREST") return false;

    return true;
  }

  const usableFutureTransactions = futureTransactions.filter(
    shouldUseFutureTransaction
  );

  const forecastItems: ForecastItem[] = [
    ...loanPayments.map((payment) => ({
      id: payment.id,
      date: payment.paymentDate,
      companyName: payment.loan.companyName,
      type: "Кредиты",
      title: payment.loan.bankName,
      counterparty: payment.loan.bankName,
      inflow: 0,
      outflow: loanPaymentTotal(payment),
      source: "LOAN" as const,
      treatmentLabel: "График кредита",
      treatmentClassName: "bg-blue-50 text-blue-700 ring-blue-200",
      treatmentDescription:
        "Плановый платёж по кредиту из графика LoanPayment.",
      principal: getAmount(payment.principalAmount),
      interest: getAmount(payment.interestAmount),
    })),

    ...usableFutureTransactions.map((operation) => {
      const cashEffect = getFinanceTransactionCashEffect(
        operation,
        categoryTreatmentIndex
      );

      const treatment = getFinanceTransactionTreatment(
        operation,
        categoryTreatmentIndex
      );

      return {
        id: operation.id,
        date: operation.obligationDate ?? operation.operationDate,
        companyName: operation.companyName,
        type: forecastTypeLabel({
          treatment: treatment.treatment,
          category: operation.category,
          operationType: operation.operationType,
        }),
        title: operation.category,
        counterparty: operation.counterparty ?? "—",
        inflow: cashEffect > 0 ? cashEffect : 0,
        outflow: cashEffect < 0 ? Math.abs(cashEffect) : 0,
        source: "OPERATION" as const,
        treatmentLabel: treatment.label,
        treatmentClassName: treatment.className,
        treatmentDescription: treatment.description,
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

  const incomingHorizon = forecastItems.reduce(
    (sum, item) => sum + item.inflow,
    0
  );

  const outgoingHorizon = forecastItems.reduce(
    (sum, item) => sum + item.outflow,
    0
  );

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
    (a, b) => b.outflow + b.inflow - (a.outflow + a.inflow)
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
              Прогноз остатка денег, будущие платежи и дата возможного кассового
              разрыва. Кредиты берутся из LoanPayment, остальные будущие
              операции — по единой роли статьи.
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
            <div className="text-sm text-slate-500">Поступления 30 дней</div>
            <div className="mt-2 text-3xl font-bold text-emerald-600">
              {formatMoney(incoming30Days)}
            </div>
            <div className="mt-2 text-sm font-semibold text-slate-500">
              7 дней: {formatMoney(incoming7Days)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Платежи 30 дней</div>
            <div className="mt-2 text-3xl font-bold text-red-600">
              {formatMoney(outgoing30Days)}
            </div>
            <div className={`mt-2 text-sm font-semibold ${valueClass(balanceAfter30Days)}`}>
              Остаток: {formatMoney(balanceAfter30Days)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">
              Остаток через {safeHorizonDays} дней
            </div>
            <div className={`mt-2 text-3xl font-bold ${valueClass(balanceAfterHorizon)}`}>
              {formatMoney(balanceAfterHorizon)}
            </div>
            <div className="mt-2 text-sm font-semibold text-slate-500">
              Платежи 7 дней: {formatMoney(outgoing7Days)}
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
              {formatDate(firstCashGap.date)} ·{" "}
              {formatMoney(firstCashGap.balanceAfterDay)}
            </div>

            <p className="mt-2 text-sm text-red-700">
              При текущем остатке денег и известных обязательствах денег не
              хватит.
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
              <table className="w-full min-w-[1050px] text-sm">
                <thead className="bg-slate-100 text-left text-slate-700">
                  <tr>
                    <th className="p-3">Дата</th>
                    <th className="p-3">Тип</th>
                    <th className="p-3">Компания</th>
                    <th className="p-3">Статья / кредит</th>
                    <th className="p-3">Роль</th>
                    <th className="p-3">Контрагент</th>
                    <th className="p-3 text-right">Поступление</th>
                    <th className="p-3 text-right">Платёж</th>
                  </tr>
                </thead>

                <tbody>
                  {nearestPayments.map((item) => (
                    <tr
                      key={`${item.source}-${item.id}`}
                      className="border-t border-slate-100"
                    >
                      <td className="p-3">{formatDate(item.date)}</td>
                      <td className="p-3">{item.type}</td>
                      <td className="p-3">{item.companyName}</td>
                      <td className="p-3 font-medium">{item.title}</td>
                      <td className="p-3">
                        <div
                          className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ${item.treatmentClassName}`}
                          title={item.treatmentDescription}
                        >
                          {item.treatmentLabel}
                        </div>
                      </td>
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
                      <td colSpan={8} className="p-8 text-center text-slate-500">
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

                    <td className={`p-3 text-right font-bold ${valueClass(row.balanceAfterDay)}`}>
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