import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";

type Props = {
  searchParams?: Promise<{
    period?: string;
    companyName?: string;
    dateFrom?: string;
    dateTo?: string;
  }>;
};

type CompanyDashboardRow = {
  companyName: string;
  wbRevenue: number;
  ozonRevenue: number;
  totalRevenue: number;
  operatingProfitAfterTax: number;
  freeCashResult: number;
  adsCost: number;
  drr: number | null;
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

type PeriodOption = {
  key: string;
  label: string;
  dateFrom: string;
  dateTo: string;
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
  const date = typeof value === "string" ? new Date(`${value}T12:00:00Z`) : value;

  return date.toLocaleDateString("ru-RU", {
    timeZone: "UTC",
  });
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function makeUtcDate(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month, day, 12, 0, 0));
}

function startOfWeek(date: Date) {
  const result = makeUtcDate(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  );

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

function startOfQuarter(date: Date) {
  const quarterStartMonth = Math.floor(date.getUTCMonth() / 3) * 3;

  return makeUtcDate(date.getUTCFullYear(), quarterStartMonth, 1);
}

function endOfQuarter(date: Date) {
  const quarterStartMonth = Math.floor(date.getUTCMonth() / 3) * 3;
  const nextQuarterStart = makeUtcDate(
    date.getUTCFullYear(),
    quarterStartMonth + 3,
    1
  );

  return addDays(nextQuarterStart, -1);
}

function createPeriodOptions(): PeriodOption[] {
  const now = new Date();
  const today = makeUtcDate(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  const currentWeekStart = startOfWeek(today);
  const previousWeekStart = addDays(currentWeekStart, -7);
  const previousWeekEnd = addDays(previousWeekStart, 6);

  const last4WeeksStart = addDays(currentWeekStart, -28);
  const last4WeeksEnd = addDays(currentWeekStart, -1);

  const currentMonthStart = makeUtcDate(today.getUTCFullYear(), today.getUTCMonth(), 1);
  const previousMonthStart = makeUtcDate(
    today.getUTCFullYear(),
    today.getUTCMonth() - 1,
    1
  );
  const previousMonthEnd = addDays(currentMonthStart, -1);

  const currentQuarterStart = startOfQuarter(today);
  const previousQuarterEnd = addDays(currentQuarterStart, -1);
  const previousQuarterStart = startOfQuarter(previousQuarterEnd);

  const currentYearStart = makeUtcDate(today.getUTCFullYear(), 0, 1);
  const previousYearStart = makeUtcDate(today.getUTCFullYear() - 1, 0, 1);
  const previousYearEnd = makeUtcDate(today.getUTCFullYear() - 1, 11, 31);

  return [
    {
      key: "previous-week",
      label: `Прошлая неделя: ${formatDate(previousWeekStart)} — ${formatDate(
        previousWeekEnd
      )}`,
      dateFrom: toIsoDate(previousWeekStart),
      dateTo: toIsoDate(previousWeekEnd),
    },
    {
      key: "current-week",
      label: `Текущая неделя: ${formatDate(currentWeekStart)} — ${formatDate(
        today
      )}`,
      dateFrom: toIsoDate(currentWeekStart),
      dateTo: toIsoDate(today),
    },
    {
      key: "last-4-weeks",
      label: `Последние 4 недели: ${formatDate(last4WeeksStart)} — ${formatDate(
        last4WeeksEnd
      )}`,
      dateFrom: toIsoDate(last4WeeksStart),
      dateTo: toIsoDate(last4WeeksEnd),
    },
    {
      key: "current-month",
      label: `Текущий месяц: ${formatDate(currentMonthStart)} — ${formatDate(
        today
      )}`,
      dateFrom: toIsoDate(currentMonthStart),
      dateTo: toIsoDate(today),
    },
    {
      key: "previous-month",
      label: `Прошлый месяц: ${formatDate(previousMonthStart)} — ${formatDate(
        previousMonthEnd
      )}`,
      dateFrom: toIsoDate(previousMonthStart),
      dateTo: toIsoDate(previousMonthEnd),
    },
    {
      key: "current-quarter",
      label: `Текущий квартал: ${formatDate(currentQuarterStart)} — ${formatDate(
        today
      )}`,
      dateFrom: toIsoDate(currentQuarterStart),
      dateTo: toIsoDate(today),
    },
    {
      key: "previous-quarter",
      label: `Прошлый квартал: ${formatDate(previousQuarterStart)} — ${formatDate(
        previousQuarterEnd
      )}`,
      dateFrom: toIsoDate(previousQuarterStart),
      dateTo: toIsoDate(previousQuarterEnd),
    },
    {
      key: "current-year",
      label: `Текущий год: ${formatDate(currentYearStart)} — ${formatDate(today)}`,
      dateFrom: toIsoDate(currentYearStart),
      dateTo: toIsoDate(today),
    },
    {
      key: "previous-year",
      label: `Прошлый год: ${formatDate(previousYearStart)} — ${formatDate(
        previousYearEnd
      )}`,
      dateFrom: toIsoDate(previousYearStart),
      dateTo: toIsoDate(previousYearEnd),
    },
    {
      key: "custom",
      label: "Произвольный период",
      dateFrom: toIsoDate(previousWeekStart),
      dateTo: toIsoDate(previousWeekEnd),
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

function abcTotal(abc: { A: number; B: number; C: number }) {
  return abc.A + abc.B + abc.C;
}

function abcPercent(count: number, total: number) {
  if (total <= 0) return "0.0%";
  return formatPercent((count / total) * 100);
}

function abcLabel(abc: { A: number; B: number; C: number }) {
  const total = abcTotal(abc);

  return `A ${abc.A} (${abcPercent(abc.A, total)}) · B ${abc.B} (${abcPercent(
    abc.B,
    total
  )}) · C ${abc.C} (${abcPercent(abc.C, total)})`;
}

function hasAnyCompanyMetric(row: CompanyDashboardRow) {
  return (
    row.wbRevenue !== 0 ||
    row.ozonRevenue !== 0 ||
    row.totalRevenue !== 0 ||
    row.operatingProfitAfterTax !== 0 ||
    row.freeCashResult !== 0 ||
    row.adsCost !== 0 ||
    row.loanPayments !== 0 ||
    row.wbStockQty !== 0 ||
    row.ozonStockQty !== 0 ||
    row.wbAbcA !== 0 ||
    row.wbAbcB !== 0 ||
    row.wbAbcC !== 0 ||
    row.ozonAbcA !== 0 ||
    row.ozonAbcB !== 0 ||
    row.ozonAbcC !== 0
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
  const selectedPeriodOption =
    periodOptions.find((period) => period.key === params.period) ??
    periodOptions[0];

  const selectedPeriod =
    selectedPeriodOption.key === "custom"
      ? {
          ...selectedPeriodOption,
          dateFrom: params.dateFrom || selectedPeriodOption.dateFrom,
          dateTo: params.dateTo || selectedPeriodOption.dateTo,
          label: `Произвольный период: ${formatDate(
            params.dateFrom || selectedPeriodOption.dateFrom
          )} — ${formatDate(params.dateTo || selectedPeriodOption.dateTo)}`,
        }
      : selectedPeriodOption;

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

  const rawCompanyRows: CompanyDashboardRow[] = [];

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

    rawCompanyRows.push({
      companyName: company.name,

      wbRevenue,
      ozonRevenue,
      totalRevenue,

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

  const companyRows = rawCompanyRows.filter(hasAnyCompanyMetric);

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

  const wbAbc = {
    A: companyRows.reduce((sum, row) => sum + row.wbAbcA, 0),
    B: companyRows.reduce((sum, row) => sum + row.wbAbcB, 0),
    C: companyRows.reduce((sum, row) => sum + row.wbAbcC, 0),
  };

  const ozonAbc = {
    A: companyRows.reduce((sum, row) => sum + row.ozonAbcA, 0),
    B: companyRows.reduce((sum, row) => sum + row.ozonAbcB, 0),
    C: companyRows.reduce((sum, row) => sum + row.ozonAbcC, 0),
  };

  const totalAbc = {
    A: wbAbc.A + ozonAbc.A,
    B: wbAbc.B + ozonAbc.B,
    C: wbAbc.C + ozonAbc.C,
  };

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

              <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-[minmax(280px,420px)_minmax(190px,240px)_auto] md:items-center">
                <select
                  name="period"
                  defaultValue={selectedPeriodOption.key}
                  className="w-full min-w-0 rounded-xl border border-slate-200 bg-slate-100 px-4 py-3 text-sm font-semibold"
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
                  className="w-full min-w-0 rounded-xl border border-slate-200 bg-slate-100 px-4 py-3 text-sm font-semibold"
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

              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="text-sm text-slate-500">
                  Дата от
                  <input
                    type="date"
                    name="dateFrom"
                    defaultValue={selectedPeriod.dateFrom}
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-100 px-4 py-3 font-semibold text-slate-900"
                  />
                </label>

                <label className="text-sm text-slate-500">
                  Дата до
                  <input
                    type="date"
                    name="dateTo"
                    defaultValue={selectedPeriod.dateTo}
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-100 px-4 py-3 font-semibold text-slate-900"
                  />
                </label>
              </div>
            </form>

            <Link
              href="/import"
              className="rounded-2xl bg-slate-900 px-5 py-3 text-center text-sm font-semibold text-white transition hover:bg-slate-800"
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

            <div
              className={metricValueClassName(
                loanPayments > 0 ? "text-red-600" : "text-slate-950"
              )}
            >
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

            <div className={subTextClassName()}>ABC WB: {abcLabel(wbAbc)}</div>
          </div>

          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">Остатки Ozon</div>

            <div className={metricValueClassName("text-slate-950")}>
              {ozonStockQty > 0
                ? `${formatNumber(ozonStockQty)} шт`
                : "Нет данных"}
            </div>

            <div className={subTextClassName()}>ABC Ozon: {abcLabel(ozonAbc)}</div>
          </div>

          <div className={metricCardClassName()}>
            <div className="mb-4 text-sm text-slate-500">ABC всего</div>

            <div className="break-words text-xl font-bold tracking-tight text-slate-950 sm:text-2xl">
              {abcLabel(totalAbc)}
            </div>

            <div className={subTextClassName()}>
              WB и Ozon по выбранному периоду.
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
                Только компании, у которых есть показатели за выбранный период
                или актуальные остатки.
              </p>
            </div>

            <Link
              href="/settings/companies"
              className="rounded-xl border border-slate-300 px-5 py-3 text-center transition hover:bg-slate-100"
            >
              Настройки компаний
            </Link>
          </div>

          {companyRows.length > 0 ? (
            <div className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
              {companyRows.map((row) => {
                const rowWbAbc = {
                  A: row.wbAbcA,
                  B: row.wbAbcB,
                  C: row.wbAbcC,
                };

                const rowOzonAbc = {
                  A: row.ozonAbcA,
                  B: row.ozonAbcB,
                  C: row.ozonAbcC,
                };

                return (
                  <article
                    key={row.companyName}
                    className="rounded-2xl border border-slate-200 bg-slate-50 p-5"
                  >
                    <div className="mb-5 flex items-start justify-between gap-4">
                      <div>
                        <h3 className="text-xl font-bold text-slate-950">
                          {row.companyName}
                        </h3>

                        <p className="mt-1 text-sm text-slate-500">
                          WB / Ozon / финансы / остатки
                        </p>
                      </div>

                      <div
                        className={`rounded-full px-3 py-1 text-sm font-semibold ${
                          row.operatingProfitAfterTax >= 0
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-red-50 text-red-700"
                        }`}
                      >
                        {formatCurrency(row.operatingProfitAfterTax)}
                      </div>
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <div>
                        <div className="text-sm text-slate-500">Выручка WB</div>
                        <div className="mt-1 font-bold">
                          {formatCurrency(row.wbRevenue)}
                        </div>
                      </div>

                      <div>
                        <div className="text-sm text-slate-500">Выручка Ozon</div>
                        <div className="mt-1 font-bold">
                          {formatCurrency(row.ozonRevenue)}
                        </div>
                      </div>

                      <div>
                        <div className="text-sm text-slate-500">Всего</div>
                        <div className="mt-1 font-bold">
                          {formatCurrency(row.totalRevenue)}
                        </div>
                      </div>

                      <div>
                        <div className="text-sm text-slate-500">Реклама</div>
                        <div className="mt-1 font-bold">
                          {formatCurrency(row.adsCost)}
                        </div>
                      </div>

                      <div>
                        <div className="text-sm text-slate-500">ДРР</div>
                        <div className="mt-1 font-bold">
                          {row.drr !== null ? formatPercent(row.drr) : "—"}
                        </div>
                      </div>

                      <div>
                        <div className="text-sm text-slate-500">Кредиты</div>
                        <div className="mt-1 font-bold">
                          {formatCurrency(row.loanPayments)}
                        </div>
                      </div>

                      <div>
                        <div className="text-sm text-slate-500">
                          Свободный результат
                        </div>
                        <div
                          className={`mt-1 font-bold ${valueColor(
                            row.freeCashResult
                          )}`}
                        >
                          {formatCurrency(row.freeCashResult)}
                        </div>
                      </div>

                      <div>
                        <div className="text-sm text-slate-500">Остатки</div>
                        <div className="mt-1 font-bold">
                          WB {formatNumber(row.wbStockQty)} / Ozon{" "}
                          {formatNumber(row.ozonStockQty)} шт
                        </div>
                      </div>
                    </div>

                    <div className="mt-5 grid gap-3 border-t border-slate-200 pt-4 sm:grid-cols-2">
                      <div>
                        <div className="text-sm font-semibold text-slate-700">
                          ABC WB
                        </div>

                        <div className="mt-1 text-sm text-slate-500">
                          {abcLabel(rowWbAbc)}
                        </div>
                      </div>

                      <div>
                        <div className="text-sm font-semibold text-slate-700">
                          ABC Ozon
                        </div>

                        <div className="mt-1 text-sm text-slate-500">
                          {abcLabel(rowOzonAbc)}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-8 text-center text-slate-500">
              Нет компаний с показателями за выбранный период.
            </div>
          )}
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