import Link from "next/link";
import { prisma } from "@/lib/prisma";

function formatMoney(value: unknown) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function startOfMonth(year: number, month: number) {
  return new Date(year, month - 1, 1, 0, 0, 0);
}

function endOfMonth(year: number, month: number) {
  return new Date(year, month, 0, 23, 59, 59);
}

function getAmount(value: unknown) {
  return Number(value ?? 0);
}

function getExecution(plan: number, fact: number) {
  if (!plan) return 0;
  return (fact / plan) * 100;
}

function diffClass(value: number, lowerIsBetter = false) {
  if (value === 0) return "text-slate-900";

  if (lowerIsBetter) {
    return value <= 0 ? "text-emerald-600" : "text-red-600";
  }

  return value >= 0 ? "text-emerald-600" : "text-red-600";
}

function normalize(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .trim();
}

function isAdsCategory(category: string) {
  const text = normalize(category);
  return text.includes("реклам") || text.includes("продвиж");
}

function isLogisticsCategory(category: string) {
  const text = normalize(category);
  return (
    text.includes("логист") ||
    text.includes("достав") ||
    text.includes("фулфилмент") ||
    text.includes("хранен")
  );
}

function isTaxCategory(category: string) {
  const text = normalize(category);
  return text.includes("налог") || text.includes("взнос");
}

function isSalaryCategory(category: string) {
  const text = normalize(category);
  return text.includes("зарп") || text.includes("зп") || text.includes("сотруд");
}

const months = [
  { value: 1, label: "Январь" },
  { value: 2, label: "Февраль" },
  { value: 3, label: "Март" },
  { value: 4, label: "Апрель" },
  { value: 5, label: "Май" },
  { value: 6, label: "Июнь" },
  { value: 7, label: "Июль" },
  { value: 8, label: "Август" },
  { value: 9, label: "Сентябрь" },
  { value: 10, label: "Октябрь" },
  { value: 11, label: "Ноябрь" },
  { value: 12, label: "Декабрь" },
];

function MetricCard({
  title,
  value,
  subValue,
  className = "text-slate-900",
}: {
  title: string;
  value: string;
  subValue?: string;
  className?: string;
}) {
  return (
    <div className="min-w-0 rounded-2xl bg-white p-5 shadow-sm">
      <div className="text-sm text-slate-500">{title}</div>

      <div
        className={`mt-2 break-words text-2xl font-bold tabular-nums leading-tight sm:text-3xl ${className}`}
      >
        {value}
      </div>

      {subValue && (
        <div className="mt-2 text-sm font-semibold text-slate-500">
          {subValue}
        </div>
      )}
    </div>
  );
}

export default async function PlanFactPage({
  searchParams,
}: {
  searchParams?: Promise<{
    company?: string;
    year?: string;
    month?: string;
  }>;
}) {
  const now = new Date();
  const params = searchParams ? await searchParams : {};

  const selectedCompany = params.company ?? "ALL";
  const selectedYear = Number(params.year ?? now.getFullYear());
  const selectedMonth = Number(params.month ?? now.getMonth() + 1);

  const dateFrom = startOfMonth(selectedYear, selectedMonth);
  const dateTo = endOfMonth(selectedYear, selectedMonth);

  const companies = await prisma.company.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });

  const plans = await prisma.budgetPlan.findMany({
    where: {
      periodYear: selectedYear,
      periodMonth: selectedMonth,
      ...(selectedCompany !== "ALL" ? { companyName: selectedCompany } : {}),
    },
  });

  const transactions = await prisma.financeTransaction.findMany({
    where: {
      operationDate: {
        gte: dateFrom,
        lte: dateTo,
      },
      isInternalTransfer: false,
      ...(selectedCompany !== "ALL" ? { companyName: selectedCompany } : {}),
    },
  });

  const planRevenue = plans.reduce(
    (sum, plan) => sum + getAmount(plan.revenuePlan),
    0
  );

  const planProfit = plans.reduce(
    (sum, plan) => sum + getAmount(plan.profitPlan),
    0
  );

  const planAds = plans.reduce((sum, plan) => sum + getAmount(plan.adsPlan), 0);

  const planLogistics = plans.reduce(
    (sum, plan) => sum + getAmount(plan.logisticsPlan),
    0
  );

  const planTax = plans.reduce((sum, plan) => sum + getAmount(plan.taxPlan), 0);

  const planSalary = plans.reduce(
    (sum, plan) => sum + getAmount(plan.salaryPlan),
    0
  );

  const planOther = plans.reduce(
    (sum, plan) => sum + getAmount(plan.otherPlan),
    0
  );

  const factRevenue = transactions
    .filter((row) => row.operationType === "INCOME")
    .reduce((sum, row) => sum + getAmount(row.amount), 0);

  const expenseTransactions = transactions.filter(
    (row) => row.operationType === "EXPENSE"
  );

  const financingTransactions = transactions.filter(
    (row) => row.operationType === "FINANCING"
  );

  const factExpenses = expenseTransactions.reduce(
    (sum, row) => sum + getAmount(row.amount),
    0
  );

  const factFinancing = financingTransactions.reduce(
    (sum, row) => sum + getAmount(row.amount),
    0
  );

  const factProfit = factRevenue - factExpenses;
  const cashFlowMonth = factRevenue - factExpenses - factFinancing;

  const factAds = expenseTransactions
    .filter((row) => isAdsCategory(row.category))
    .reduce((sum, row) => sum + getAmount(row.amount), 0);

  const factLogistics = expenseTransactions
    .filter((row) => isLogisticsCategory(row.category))
    .reduce((sum, row) => sum + getAmount(row.amount), 0);

  const factTax = expenseTransactions
    .filter((row) => isTaxCategory(row.category))
    .reduce((sum, row) => sum + getAmount(row.amount), 0);

  const factSalary = expenseTransactions
    .filter((row) => isSalaryCategory(row.category))
    .reduce((sum, row) => sum + getAmount(row.amount), 0);

  const knownExpenseIds = new Set(
    expenseTransactions
      .filter(
        (row) =>
          isAdsCategory(row.category) ||
          isLogisticsCategory(row.category) ||
          isTaxCategory(row.category) ||
          isSalaryCategory(row.category)
      )
      .map((row) => row.id)
  );

  const factOther = expenseTransactions
    .filter((row) => !knownExpenseIds.has(row.id))
    .reduce((sum, row) => sum + getAmount(row.amount), 0);

  const revenueExecution = getExecution(planRevenue, factRevenue);
  const profitExecution = getExecution(planProfit, factProfit);

  const rows = [
    {
      title: "Выручка",
      plan: planRevenue,
      fact: factRevenue,
      lowerIsBetter: false,
    },
    {
      title: "Прибыль",
      plan: planProfit,
      fact: factProfit,
      lowerIsBetter: false,
    },
    {
      title: "Реклама",
      plan: planAds,
      fact: factAds,
      lowerIsBetter: true,
    },
    {
      title: "Логистика",
      plan: planLogistics,
      fact: factLogistics,
      lowerIsBetter: true,
    },
    {
      title: "Налоги",
      plan: planTax,
      fact: factTax,
      lowerIsBetter: true,
    },
    {
      title: "Зарплата",
      plan: planSalary,
      fact: factSalary,
      lowerIsBetter: true,
    },
    {
      title: "Прочие расходы",
      plan: planOther,
      fact: factOther,
      lowerIsBetter: true,
    },
    {
      title: "Кредиты и займы",
      plan: 0,
      fact: factFinancing,
      lowerIsBetter: true,
    },
  ];

  return (
    <main className="min-h-screen bg-slate-100 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1700px] space-y-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <h1 className="break-words text-3xl font-bold text-slate-900 sm:text-4xl">
              План-Факт анализ 2.0
            </h1>

            <p className="mt-3 text-slate-500">
              Сравнение плановых бюджетов с фактическими финансовыми операциями.
            </p>
          </div>

          <Link
            href="/finance/budget"
            className="w-full rounded-xl bg-slate-900 px-5 py-3 text-center font-semibold text-white sm:w-auto"
          >
            Планирование бюджета
          </Link>
        </div>

        <form className="rounded-2xl bg-white p-5 shadow-sm sm:p-6">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <div>
              <label className="mb-1 block text-sm text-slate-500">
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

            <div>
              <label className="mb-1 block text-sm text-slate-500">Год</label>

              <input
                name="year"
                defaultValue={selectedYear}
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm text-slate-500">
                Месяц
              </label>

              <select
                name="month"
                defaultValue={selectedMonth}
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              >
                {months.map((month) => (
                  <option key={month.value} value={month.value}>
                    {month.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-end">
              <button className="w-full rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white">
                Применить
              </button>
            </div>
          </div>
        </form>

        {plans.length === 0 && (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-800 sm:p-6">
            На выбранный период бюджет не найден. Сначала создай бюджет в разделе
            “Планирование бюджета”.
          </div>
        )}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <MetricCard title="План выручки" value={formatMoney(planRevenue)} />

          <MetricCard
            title="Факт выручки"
            value={formatMoney(factRevenue)}
            subValue={formatPercent(revenueExecution)}
            className="text-emerald-600"
          />

          <MetricCard title="План прибыли" value={formatMoney(planProfit)} />

          <MetricCard
            title="Факт прибыли"
            value={formatMoney(factProfit)}
            subValue={formatPercent(profitExecution)}
            className={factProfit >= 0 ? "text-emerald-600" : "text-red-600"}
          />

          <MetricCard
            title="Отклонение прибыли"
            value={formatMoney(factProfit - planProfit)}
            className={diffClass(factProfit - planProfit)}
          />
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          <MetricCard
            title="Операционные расходы"
            value={formatMoney(factExpenses)}
            className="text-red-600"
          />

          <MetricCard
            title="Кредиты и займы"
            value={formatMoney(factFinancing)}
            subValue="Не входит в операционную прибыль"
            className="text-red-600"
          />

          <MetricCard
            title="Денежный поток месяца"
            value={formatMoney(cashFlowMonth)}
            className={cashFlowMonth >= 0 ? "text-emerald-600" : "text-red-600"}
          />
        </section>

        <section className="rounded-2xl bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-2xl font-bold text-slate-900">
            План-Факт по статьям
          </h2>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-slate-100 text-left text-slate-700">
                <tr>
                  <th className="p-3">Статья</th>
                  <th className="p-3 text-right">План</th>
                  <th className="p-3 text-right">Факт</th>
                  <th className="p-3 text-right">Отклонение ₽</th>
                  <th className="p-3 text-right">Отклонение %</th>
                </tr>
              </thead>

              <tbody>
                {rows.map((row) => {
                  const diff = row.fact - row.plan;
                  const diffPercent = row.plan ? (diff / row.plan) * 100 : 0;

                  return (
                    <tr key={row.title} className="border-t border-slate-100">
                      <td className="p-3 font-semibold">{row.title}</td>

                      <td className="p-3 text-right">
                        {formatMoney(row.plan)}
                      </td>

                      <td className="p-3 text-right font-semibold">
                        {formatMoney(row.fact)}
                      </td>

                      <td
                        className={`p-3 text-right font-bold ${diffClass(
                          diff,
                          row.lowerIsBetter
                        )}`}
                      >
                        {formatMoney(diff)}
                      </td>

                      <td
                        className={`p-3 text-right font-bold ${diffClass(
                          diff,
                          row.lowerIsBetter
                        )}`}
                      >
                        {formatPercent(diffPercent)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-2xl bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-2xl font-bold text-slate-900">
            Источник факта
          </h2>

          <p className="mt-3 text-slate-500">
            Сейчас операционный факт считается по финансовым операциям за выбранный месяц:
            поступления = выручка, операционные расходы = выбытия. Кредиты и займы
            вынесены отдельно и не входят в операционную прибыль. Следующим шагом можно
            отдельно подключить фактическую выручку WB/Ozon, рекламу WB/Ozon и логистику
            из маркетплейс-отчётов.
          </p>
        </section>
      </div>
    </main>
  );
}