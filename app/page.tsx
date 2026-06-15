import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";

type Props = {
  searchParams?: Promise<{
    period?: string;
    companyName?: string;
  }>;
};

type PeriodOption = {
  key: string;
  label: string;
  dateFrom: string;
  dateTo: string;
};

type CompanyDashboardRow = {
  companyName: string;
  wbRevenue: number;
  ozonRevenue: number;
  totalRevenue: number;
  wbOperatingProfitAfterTax: number;
  ozonOperatingProfitAfterTax: number;
  operatingProfitAfterTax: number;
  adsCost: number;
  drr: number | null;
  freeCashResult: number;
  loanPayments: number;
  wbStockQty: number;
  ozonStockQty: number;
  wbAbcA: number;
  wbAbcB: number;
  wbAbcC: number;
  ozonAbcA: number;
  ozonAbcB: number;
  ozonAbcC: number;
};

const quickLinks = [
  {
    title: "Центр прибыли",
    description: "Прибыль WB/Ozon, проблемные SKU, реклама и маржинальность.",
    href: "/analytics",
  },
  {
    title: "Кредиты",
    description: "Графики платежей, факт/план и долговая нагрузка.",
    href: "/finance/loans",
  },
  {
    title: "Платёжный календарь",
    description: "Ближайшие обязательства и контроль кассовых разрывов.",
    href: "/finance/payment-calendar",
  },
  {
    title: "Импорт отчётов",
    description: "Загрузка WB, Ozon, рекламы, остатков и себестоимости.",
    href: "/import",
  },
];

function formatCurrency(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPercent(value: number) {
  return `${value.toFixed(1)}%`;
}

function formatDate(value: string | Date) {
  const date = typeof value === "string" ? new Date(`${value}T12:00:00`) : value;

  return date.toLocaleDateString("ru-RU", {
    timeZone: "UTC",
  });
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function startOfWeek(date: Date) {
  const result = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12));
  const day = result.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;

  result.setUTCDate(result.getUTCDate() + diff);

  return result;
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);

  return result;
}

function createPeriodOptions() {
  const today = new Date();
  const currentWeekStart = startOfWeek(today);
  const previousWeekStart = addDays(currentWeekStart, -7);
  const previousWeekEnd = addDays(previousWeekStart, 6);

  const currentMonthStart = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1, 12));
  const previousMonthStart = new Date(Date.UTC(today.getFullYear(), today.getMonth() - 1, 1, 12));
  const previousMonthEnd = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 0, 12));

  return [
    {
      key: "previous-week",
      label: `Прошлая неделя: ${formatDate(previousWeekStart)} — ${formatDate(previousWeekEnd)}`,
      dateFrom: toIsoDate(previousWeekStart),
      dateTo: toIsoDate(previousWeekEnd),
    },
    {
      key: "current-week",
      label: `Текущая неделя: ${formatDate(currentWeekStart)} — ${formatDate(today)}`,
      dateFrom: toIsoDate(currentWeekStart),
      dateTo: toIsoDate(today),
    },
    {
      key: "current-month",
      label: `Текущий месяц: ${formatDate(currentMonthStart)} — ${formatDate(today)}`,
      dateFrom: toIsoDate(currentMonthStart),
      dateTo: toIsoDate(today),
    },
    {
      key: "previous-month",
      label: `Прошлый месяц: ${formatDate(previousMonthStart)} — ${formatDate(previousMonthEnd)}`,
      dateFrom: toIsoDate(previousMonthStart),
      dateTo: toIsoDate(previousMonthEnd),
    },
  ];
}

function safeNumber(value: unknown) {
  if (value === null || value === undefined) return 0;

  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
}

function isLoanCategory(category?: string | null) {
  const value = String(category ?? "").toLowerCase();

  return value.includes("кредит") || value.includes("займ");
}

function metricCardClassName(extra = "") {
  return `min-w-0 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 ${extra}`;
}

function metricValueClassName(extra = "") {
  return `break-words text-2xl font-bold tracking-tight sm:text-3xl ${extra}`;
}

function subTextClassName() {
  return "mt-3 break-words text-sm leading-6 text-slate-500";
}

function valueColor(value: number) {
  return value >= 0 ? "text-emerald-600" : "text-red-600";
}

function countAbc(rows: { abcByProfit: "A" | "B" | "C" }[]) {
  return rows.reduce(
    (acc, row) => {
      acc[row.abcByProfit] += 1;

      return acc;
    },
    {
      A: 0,
      B: 0,
      C: 0,
    }
  );
}

async function getFinanceCashResult(params: {
  companyName: string;
  dateFrom: string;
  dateTo: string;
}) {
  const from = new Date(`${params.dateFrom}T00:00:00`);
  const toExclusive = new Date(`${params.dateTo}T00:00:00`);
  toExclusive.setDate(toExclusive.getDate() + 1);

  const rows = await prisma.financeTransaction.findMany({
    where: {
      companyName: params.companyName,
      operationDate: {
        gte: from,
        lt: toExclusive,
      },
    },
  });

  let income = 0;
  let expense = 0;
  let loanPayments = 0;

  for (const row of rows) {
    const amount = Math.abs(safeNumber(row.amount));

    if (row.operationType === "INCOME") {
      income += amount;
    }

    if (row.operationType === "EXPENSE") {
      expense += amount;
    }

    if (row.operationType === "FINANCING" || isLoanCategory(row.category)) {
      loanPayments += amount;
    }
  }

  return {
    freeCashResult: income - expense - loanPayments,
    loanPayments,
  };
}

async function getLatestWbStockQty(companyName: string) {
  const latestStockImport = await prisma.importSession.findFirst({
    where: {
      companyName,
      reportType: "WB_STOCK",
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (!latestStockImport) return 0;

  const rows = await prisma.wbStock.findMany({
    where: {
      companyName,
      importSessionId: latestStockImport.id,
      warehouseName: "__TOTAL__",
    },
  });

  return rows.reduce(
    (sum, row) =>
      sum +
      safeNumber(row.inTransitToCustomer) +
      safeNumber(row.inTransitReturns) +
      safeNumber(row.totalStock),
    0
  );
}

async function getLatestOzonStockQty(companyName: string) {
  const latestStockImport = await prisma.importSession.findFirst({
    where: {
      companyName,
      reportType: "OZON_STOCK",
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (!latestStockImport) return 0;

  const rows = await prisma.ozonStock.findMany({
    where: {
      companyName,
      importSessionId: latestStockImport.id,
    },
  });

  return rows.reduce((sum, row) => {
    const raw = row as unknown as Record<string, unknown>;

    return (
      sum +
      safeNumber(raw.availableStock) +
      safeNumber(raw.availableQty) +
      safeNumber(raw.stock) +
      safeNumber(raw.quantity) +
      safeNumber(raw.qty)
    );
  }, 0);
}

export default async function HomePage({ searchParams }: Props) {
  const params = searchParams ? await searchParams : {};

  const periodOptions = createPeriodOptions();
  const selectedPeriod =
    periodOptions.find((period) => period.key === params.period) ??
    periodOptions[0];

  const selectedCompanyName =
    params.companyName && params.companyName !== "ALL"
      ? params.companyName
      : null;

  const companies = await prisma.company.findMany({
    orderBy: {
      name: "asc",
    },
  });

  const selectedCompanies = selectedCompanyName
    ? companies.filter((company) => company.name === selectedCompanyName)
    : companies;

  const companyRows: CompanyDashboardRow[] = [];

  for (const company of selectedCompanies) {
    const wb = await getProfitAnalytics({
      dateFrom: selectedPeriod.dateFrom,
      dateTo: selectedPeriod.dateTo,
      companyName: company.name,
    });

    const ozon = await getProfitAnalyticsOzon({
  dateFrom: selectedPeriod.dateFrom,
  dateTo: selectedPeriod.dateTo,
  companyName: company.name,

  usnRate:
    company.usnRate !== null && company.usnRate !== undefined
      ? Number(company.usnRate)
      : 1,

  vatRate:
    company.vatRate !== null && company.vatRate !== undefined
      ? Number(company.vatRate)
      : 5,
});

    const cash = await getFinanceCashResult({
      companyName: company.name,
      dateFrom: selectedPeriod.dateFrom,
      dateTo: selectedPeriod.dateTo,
    });

    const [wbStockQty, ozonStockQty] = await Promise.all([
      getLatestWbStockQty(company.name),
      getLatestOzonStockQty(company.name),
    ]);

    const wbAbc = countAbc(wb.rows);
    const ozonAbc = countAbc(ozon.rows);

    const wbRevenue = wb.totals.revenue;
    const ozonRevenue = ozon.totals.revenue;
    const totalRevenue = wbRevenue + ozonRevenue;

    const adsCost = wb.totals.adsCost + ozon.totals.adsCost;
    const drr = totalRevenue > 0 ? (adsCost / totalRevenue) * 100 : null;

    companyRows.push({
      companyName: company.name,

      wbRevenue,
      ozonRevenue,
      totalRevenue,

      wbOperatingProfitAfterTax: wb.totals.netProfitAfterTax,
      ozonOperatingProfitAfterTax: ozon.totals.netProfitAfterTax,
      operatingProfitAfterTax:
        wb.totals.netProfitAfterTax + ozon.totals.netProfitAfterTax,

      adsCost,
      drr,

      freeCashResult: cash.freeCashResult,
      loanPayments: cash.loanPayments,

      wbStockQty,
      ozonStockQty,

      wbAbcA: wbAbc.A,
      wbAbcB: wbAbc.B,
      wbAbcC: wbAbc.C,

      ozonAbcA: ozonAbc.A,
      ozonAbcB: ozonAbc.B,
      ozonAbcC: ozonAbc.C,
    });
  }

  const totalRevenue = companyRows.reduce((sum, row) => sum + row.totalRevenue, 0);

  const wbRevenue = companyRows.reduce((sum, row) => sum + row.wbRevenue, 0);
  const ozonRevenue = companyRows.reduce((sum, row) => sum + row.ozonRevenue, 0);

  const operatingProfitAfterTax = companyRows.reduce(
    (sum, row) => sum + row.operatingProfitAfterTax,
    0
  );

  const freeCashResult = companyRows.reduce(
    (sum, row) => sum + row.freeCashResult,
    0
  );

  const adsCost = companyRows.reduce((sum, row) => sum + row.adsCost, 0);
  const drr = totalRevenue > 0 ? (adsCost / totalRevenue) * 100 : null;

  const loanPayments = companyRows.reduce((sum, row) => sum + row.loanPayments, 0);

  const wbStockQty = companyRows.reduce((sum, row) => sum + row.wbStockQty, 0);
  const ozonStockQty = companyRows.reduce((sum, row) => sum + row.ozonStockQty, 0);

  const wbAbcA = companyRows.reduce((sum, row) => sum + row.wbAbcA, 0);
  const wbAbcB = companyRows.reduce((sum, row) => sum + row.wbAbcB, 0);
  const wbAbcC = companyRows.reduce((sum, row) => sum + row.wbAbcC, 0);

  const ozonAbcA = companyRows.reduce((sum, row) => sum + row.ozonAbcA, 0);
  const ozonAbcB = companyRows.reduce((sum, row) => sum + row.ozonAbcB, 0);
  const ozonAbcC = companyRows.reduce((sum, row) => sum + row.ozonAbcC, 0);

  const attentionItems = [
    {
      level: operatingProfitAfterTax < 0 ? "danger" : "ok",
      title: "Операционная прибыль",
      text:
        operatingProfitAfterTax < 0
          ? `Операционная прибыль после налогов отрицательная: ${formatCurrency(
              operatingProfitAfterTax
            )}.`
          : `Операционная прибыль после налогов: ${formatCurrency(
              operatingProfitAfterTax
            )}.`,
      href: "/analytics",
    },
    {
      level: freeCashResult < 0 ? "danger" : "ok",
      title: "Свободный денежный результат",
      text:
        freeCashResult < 0
          ? `После всех расходов минус ${formatCurrency(
              Math.abs(freeCashResult)
            )}. Нужно смотреть ДДС.`
          : `После всех расходов осталось ${formatCurrency(freeCashResult)}.`,
      href: "/finance/cash-flow",
    },
    {
      level: drr !== null && drr > 12 ? "danger" : "ok",
      title: "Реклама",
      text:
        drr !== null && drr > 12
          ? `ДРР ${formatPercent(drr)}. Нужно проверить кампании.`
          : "ДРР в пределах контроля или данных недостаточно.",
      href: "/ads-mapping",
    },
    {
      level: loanPayments > 0 ? "warning" : "ok",
      title: "Кредиты",
      text:
        loanPayments > 0
          ? `Платежи по кредитам за период: ${formatCurrency(loanPayments)}.`
          : "В выбранном периоде платежей по кредитам не найдено.",
      href: "/finance/loans",
    },
  ];

  return (
    <main className="min-h-screen bg-slate-100 p-4 sm:p-6 xl:p-10">
      <div className="mx-auto max-w-[1800px] space-y-8">
        <section className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <h1 className="break-words text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
              Dashboard
            </h1>

            <p className="mt-2 text-slate-500">
              Главный экран собственника: прибыль, денежный результат, реклама,
              остатки, ABC и кредитная нагрузка.
            </p>
          </div>

          <div className="flex min-w-0 flex-col gap-4 2xl:flex-row 2xl:items-center">
            <form
              action="/"
              className="min-w-0 rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-sm sm:px-5"
            >
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                Фильтры Dashboard
              </div>

              <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
                <select
                  name="period"
                  defaultValue={selectedPeriod.key}
                  className="min-w-0 rounded-xl border border-slate-200 bg-slate-100 px-4 py-3 text-sm font-semibold"
                >
                  {periodOptions.map((period) => (
                    <option key={period.key} value={period.key}>
                      {period.label}
                    </option>
                  ))}
                </select>

                <select
                  name="companyName"
                  defaultValue={params.companyName ?? "ALL"}
                  className="min-w-0 rounded-xl border border-slate-200 bg-slate-100 px-4 py-3 text-sm font-semibold"
                >
                  <option value="ALL">Все компании</option>

                  {companies.map((company) => (
                    <option key={company.id} value={company.name}>
                      {company.name}
                    </option>
                  ))}
                </select>

                <button
                  type="submit"
                  className="rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white transition hover:bg-slate-800"
                >
                  Показать
                </button>
              </div>
            </form>

            <Link
              href="/import"
              className="rounded-2xl bg-slate-900 px-6 py-4 text-center font-semibold text-white transition hover:bg-slate-800"
            >
              Импортировать отчёт
            </Link>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">Выручка всего</div>

            <div className={metricValueClassName("text-slate-950")}>
              {totalRevenue > 0 ? formatCurrency(totalRevenue) : "Нет данных"}
            </div>

            <div className={subTextClassName()}>
              WB: {formatCurrency(wbRevenue)} · Ozon: {formatCurrency(ozonRevenue)}
            </div>
          </div>

          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">
              Операционная прибыль после налогов
            </div>

            <div className={metricValueClassName(valueColor(operatingProfitAfterTax))}>
              {formatCurrency(operatingProfitAfterTax)}
            </div>

            <div className={subTextClassName()}>
              После себестоимости, рекламы, логистики, хранения и налогов.
            </div>
          </div>

          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">
              Свободный денежный результат
            </div>

            <div className={metricValueClassName(valueColor(freeCashResult))}>
              {formatCurrency(freeCashResult)}
            </div>

            <div className={subTextClassName()}>
              После всех финансовых операций, расходов и кредитных платежей.
            </div>
          </div>

          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">ДРР общий</div>

            <div
              className={metricValueClassName(
                drr !== null && drr > 12 ? "text-red-600" : "text-slate-950"
              )}
            >
              {drr !== null ? formatPercent(drr) : "Нет данных"}
            </div>

            <div className={subTextClassName()}>
              Реклама всего: {formatCurrency(adsCost)}
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">Кредитные платежи</div>

            <div className={metricValueClassName(loanPayments > 0 ? "text-red-600" : "text-slate-950")}>
              {loanPayments > 0 ? formatCurrency(loanPayments) : "Нет данных"}
            </div>

            <div className={subTextClassName()}>
              Факт по финансовым операциям за выбранный период.
            </div>
          </div>

          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">Остатки WB</div>

            <div className={metricValueClassName("text-slate-950")}>
              {wbStockQty > 0 ? `${formatNumber(wbStockQty)} шт` : "Нет данных"}
            </div>

            <div className={subTextClassName()}>
              ABC WB: A {wbAbcA} · B {wbAbcB} · C {wbAbcC}
            </div>
          </div>

          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">Остатки Ozon</div>

            <div className={metricValueClassName("text-slate-950")}>
              {ozonStockQty > 0 ? `${formatNumber(ozonStockQty)} шт` : "Нет данных"}
            </div>

            <div className={subTextClassName()}>
              ABC Ozon: A {ozonAbcA} · B {ozonAbcB} · C {ozonAbcC}
            </div>
          </div>

          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">Период</div>

            <div className="text-xl font-bold text-slate-950">
              {selectedPeriod.label}
            </div>

            <div className={subTextClassName()}>
              Период теперь задаётся едино для WB, Ozon и финансов.
            </div>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-4">
          {attentionItems.map((item) => (
            <Link
              key={item.title}
              href={item.href}
              className={`rounded-3xl border bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${
                item.level === "danger"
                  ? "border-red-200"
                  : item.level === "warning"
                    ? "border-amber-200"
                    : "border-slate-200"
              }`}
            >
              <div
                className={`text-sm font-semibold uppercase tracking-wide ${
                  item.level === "danger"
                    ? "text-red-500"
                    : item.level === "warning"
                      ? "text-amber-500"
                      : "text-slate-400"
                }`}
              >
                Что требует внимания
              </div>

              <h2 className="mt-3 text-xl font-bold text-slate-900">
                {item.title}
              </h2>

              <p className="mt-3 text-sm leading-6 text-slate-500">
                {item.text}
              </p>

              <div className="mt-5 font-semibold text-slate-900">
                Открыть →
              </div>
            </Link>
          ))}
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
          <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-2xl font-bold">Компании</h2>

              <p className="mt-2 text-slate-500">
                Сводка по ИП за выбранный период.
              </p>
            </div>

            <Link
              href="/settings/companies"
              className="rounded-xl border border-slate-300 px-5 py-3 text-center transition hover:bg-slate-100"
            >
              Настройки компаний
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1300px] border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="py-4 pr-4 text-left font-medium">Компания</th>
                  <th className="py-4 pr-4 text-left font-medium">WB</th>
                  <th className="py-4 pr-4 text-left font-medium">Ozon</th>
                  <th className="py-4 pr-4 text-left font-medium">Всего</th>
                  <th className="py-4 pr-4 text-left font-medium">
                    Опер. прибыль
                  </th>
                  <th className="py-4 pr-4 text-left font-medium">
                    Свободный результат
                  </th>
                  <th className="py-4 pr-4 text-left font-medium">Реклама</th>
                  <th className="py-4 pr-4 text-left font-medium">ДРР</th>
                  <th className="py-4 pr-4 text-left font-medium">Кредиты</th>
                  <th className="py-4 pr-4 text-left font-medium">ABC WB</th>
                  <th className="py-4 pr-4 text-left font-medium">ABC Ozon</th>
                  <th className="py-4 pr-4 text-left font-medium">Остатки</th>
                </tr>
              </thead>

              <tbody>
                {companyRows.map((row) => (
                  <tr
                    key={row.companyName}
                    className="border-b border-slate-100 transition hover:bg-slate-50"
                  >
                    <td className="py-5 pr-4 font-medium">{row.companyName}</td>

                    <td className="py-5 pr-4 font-semibold">
                      {formatCurrency(row.wbRevenue)}
                    </td>

                    <td className="py-5 pr-4 font-semibold">
                      {formatCurrency(row.ozonRevenue)}
                    </td>

                    <td className="py-5 pr-4 font-semibold">
                      {formatCurrency(row.totalRevenue)}
                    </td>

                    <td className={`py-5 pr-4 font-semibold ${valueColor(row.operatingProfitAfterTax)}`}>
                      {formatCurrency(row.operatingProfitAfterTax)}
                    </td>

                    <td className={`py-5 pr-4 font-semibold ${valueColor(row.freeCashResult)}`}>
                      {formatCurrency(row.freeCashResult)}
                    </td>

                    <td className="py-5 pr-4 font-semibold">
                      {formatCurrency(row.adsCost)}
                    </td>

                    <td className="py-5 pr-4 font-semibold">
                      {row.drr !== null ? formatPercent(row.drr) : "—"}
                    </td>

                    <td className="py-5 pr-4 font-semibold">
                      {formatCurrency(row.loanPayments)}
                    </td>

                    <td className="py-5 pr-4 font-semibold">
                      A {row.wbAbcA} · B {row.wbAbcB} · C {row.wbAbcC}
                    </td>

                    <td className="py-5 pr-4 font-semibold">
                      A {row.ozonAbcA} · B {row.ozonAbcB} · C {row.ozonAbcC}
                    </td>

                    <td className="py-5 pr-4 font-semibold">
                      WB {formatNumber(row.wbStockQty)} / Ozon{" "}
                      {formatNumber(row.ozonStockQty)} шт
                    </td>
                  </tr>
                ))}

                {companyRows.length === 0 && (
                  <tr>
                    <td colSpan={12} className="py-8 text-center text-slate-500">
                      Нет данных за выбранный период.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          {quickLinks.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
            >
              <h2 className="text-xl font-bold text-slate-900">{item.title}</h2>

              <p className="mt-3 text-sm leading-6 text-slate-500">
                {item.description}
              </p>

              <div className="mt-5 font-semibold text-slate-900">
                Открыть →
              </div>
            </Link>
          ))}
        </section>
      </div>
    </main>
  );
}