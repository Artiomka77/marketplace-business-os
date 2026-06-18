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

type AbcCounts = {
  A: number;
  B: number;
  C: number;
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
  shortLabel: string;
  label: string;
  description: string;
  dateFrom: string;
  dateTo: string;
};

const quickLinks = [
  {
    title: "Центр прибыли",
    description: "Прибыль WB/Ozon, проблемные SKU, реклама и маржинальность.",
    href: "/analytics",
    icon: "📊",
  },
  {
    title: "Кредиты",
    description: "Графики платежей, факт/план и долговая нагрузка.",
    href: "/finance/loans",
    icon: "🏦",
  },
  {
    title: "Платёжный календарь",
    description: "Ближайшие обязательства и контроль кассовых разрывов.",
    href: "/finance/payment-calendar",
    icon: "📅",
  },
  {
    title: "Импорт отчётов",
    description: "Загрузка WB, Ozon, рекламы, остатков и себестоимости.",
    href: "/import",
    icon: "📥",
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

function createPeriodOptions(): PeriodOption[] {
  const now = new Date();
  const today = makeUtcDate(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  );

  const currentWeekStart = startOfWeek(today);
  const previousWeekStart = addDays(currentWeekStart, -7);
  const previousWeekEnd = addDays(previousWeekStart, 6);

  const last4WeeksStart = addDays(currentWeekStart, -28);
  const last4WeeksEnd = addDays(currentWeekStart, -1);

  const currentMonthStart = makeUtcDate(
    today.getUTCFullYear(),
    today.getUTCMonth(),
    1
  );
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
      shortLabel: "Прошлая неделя",
      label: `Прошлая неделя: ${formatDate(previousWeekStart)} — ${formatDate(
        previousWeekEnd
      )}`,
      description: `${formatDate(previousWeekStart)} — ${formatDate(
        previousWeekEnd
      )}`,
      dateFrom: toIsoDate(previousWeekStart),
      dateTo: toIsoDate(previousWeekEnd),
    },
    {
      key: "current-week",
      shortLabel: "Текущая неделя",
      label: `Текущая неделя: ${formatDate(currentWeekStart)} — ${formatDate(
        today
      )}`,
      description: `${formatDate(currentWeekStart)} — ${formatDate(today)}`,
      dateFrom: toIsoDate(currentWeekStart),
      dateTo: toIsoDate(today),
    },
    {
      key: "last-4-weeks",
      shortLabel: "Последние 4 недели",
      label: `Последние 4 недели: ${formatDate(last4WeeksStart)} — ${formatDate(
        last4WeeksEnd
      )}`,
      description: `${formatDate(last4WeeksStart)} — ${formatDate(
        last4WeeksEnd
      )}`,
      dateFrom: toIsoDate(last4WeeksStart),
      dateTo: toIsoDate(last4WeeksEnd),
    },
    {
      key: "current-month",
      shortLabel: "Текущий месяц",
      label: `Текущий месяц: ${formatDate(currentMonthStart)} — ${formatDate(
        today
      )}`,
      description: `${formatDate(currentMonthStart)} — ${formatDate(today)}`,
      dateFrom: toIsoDate(currentMonthStart),
      dateTo: toIsoDate(today),
    },
    {
      key: "previous-month",
      shortLabel: "Прошлый месяц",
      label: `Прошлый месяц: ${formatDate(previousMonthStart)} — ${formatDate(
        previousMonthEnd
      )}`,
      description: `${formatDate(previousMonthStart)} — ${formatDate(
        previousMonthEnd
      )}`,
      dateFrom: toIsoDate(previousMonthStart),
      dateTo: toIsoDate(previousMonthEnd),
    },
    {
      key: "current-quarter",
      shortLabel: "Текущий квартал",
      label: `Текущий квартал: ${formatDate(currentQuarterStart)} — ${formatDate(
        today
      )}`,
      description: `${formatDate(currentQuarterStart)} — ${formatDate(today)}`,
      dateFrom: toIsoDate(currentQuarterStart),
      dateTo: toIsoDate(today),
    },
    {
      key: "previous-quarter",
      shortLabel: "Прошлый квартал",
      label: `Прошлый квартал: ${formatDate(previousQuarterStart)} — ${formatDate(
        previousQuarterEnd
      )}`,
      description: `${formatDate(previousQuarterStart)} — ${formatDate(
        previousQuarterEnd
      )}`,
      dateFrom: toIsoDate(previousQuarterStart),
      dateTo: toIsoDate(previousQuarterEnd),
    },
    {
      key: "current-year",
      shortLabel: "Текущий год",
      label: `Текущий год: ${formatDate(currentYearStart)} — ${formatDate(today)}`,
      description: `${formatDate(currentYearStart)} — ${formatDate(today)}`,
      dateFrom: toIsoDate(currentYearStart),
      dateTo: toIsoDate(today),
    },
    {
      key: "previous-year",
      shortLabel: "Прошлый год",
      label: `Прошлый год: ${formatDate(previousYearStart)} — ${formatDate(
        previousYearEnd
      )}`,
      description: `${formatDate(previousYearStart)} — ${formatDate(
        previousYearEnd
      )}`,
      dateFrom: toIsoDate(previousYearStart),
      dateTo: toIsoDate(previousYearEnd),
    },
    {
      key: "custom",
      shortLabel: "Произвольный период",
      label: "Произвольный период",
      description: "Выбери даты вручную",
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

function abcTotal(abc: AbcCounts) {
  return abc.A + abc.B + abc.C;
}

function abcPercentNumber(count: number, total: number) {
  if (total <= 0) return 0;
  return (count / total) * 100;
}

function abcPercent(count: number, total: number) {
  return formatPercent(abcPercentNumber(count, total));
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

function buildDashboardHref(params: {
  period: string;
  companyName?: string | null;
  dateFrom?: string;
  dateTo?: string;
}) {
  const searchParams = new URLSearchParams();

  searchParams.set("period", params.period);

  if (params.companyName) {
    searchParams.set("companyName", params.companyName);
  } else {
    searchParams.set("companyName", "ALL");
  }

  if (params.dateFrom) {
    searchParams.set("dateFrom", params.dateFrom);
  }

  if (params.dateTo) {
    searchParams.set("dateTo", params.dateTo);
  }

  return `/?${searchParams.toString()}`;
}

function KpiIcon({ children, tone }: { children: React.ReactNode; tone: string }) {
  return (
    <div
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-lg ${tone}`}
    >
      {children}
    </div>
  );
}

function KpiCard({
  title,
  value,
  subtitle,
  icon,
  tone,
  valueClassName = "text-slate-950",
}: {
  title: string;
  value: string;
  subtitle: string;
  icon: React.ReactNode;
  tone: string;
  valueClassName?: string;
}) {
  return (
    <article className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-start gap-4">
        <KpiIcon tone={tone}>{icon}</KpiIcon>

        <div className="min-w-0">
          <div className="text-sm font-medium text-slate-500">{title}</div>

          <div className={`mt-4 break-words text-3xl font-bold tracking-tight ${valueClassName}`}>
            {value}
          </div>

          <div className="mt-3 text-sm leading-6 text-slate-500">{subtitle}</div>
        </div>
      </div>
    </article>
  );
}

function AbcPill({
  label,
  count,
  total,
  tone,
}: {
  label: "A" | "B" | "C";
  count: number;
  total: number;
  tone: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-bold ${tone}`}
    >
      {label} {count} ({abcPercent(count, total)})
    </span>
  );
}

function AbcPills({ abc }: { abc: AbcCounts }) {
  const total = abcTotal(abc);

  return (
    <div className="flex flex-wrap gap-2">
      <AbcPill label="A" count={abc.A} total={total} tone="bg-emerald-50 text-emerald-700" />
      <AbcPill label="B" count={abc.B} total={total} tone="bg-amber-50 text-amber-700" />
      <AbcPill label="C" count={abc.C} total={total} tone="bg-red-50 text-red-700" />
    </div>
  );
}

function AbcBar({ abc }: { abc: AbcCounts }) {
  const total = abcTotal(abc);
  const a = abcPercentNumber(abc.A, total);
  const b = abcPercentNumber(abc.B, total);
  const c = abcPercentNumber(abc.C, total);

  return (
    <div className="mt-4 h-3 overflow-hidden rounded-full bg-slate-100">
      <div className="flex h-full w-full">
        <div className="h-full bg-emerald-400" style={{ width: `${a}%` }} />
        <div className="h-full bg-amber-400" style={{ width: `${b}%` }} />
        <div className="h-full bg-red-400" style={{ width: `${c}%` }} />
      </div>
    </div>
  );
}

function AbcCard({ title, abc }: { title: string; abc: AbcCounts }) {
  const total = abcTotal(abc);

  return (
    <article className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-bold text-slate-950">{title}</h3>
          <p className="mt-1 text-sm text-slate-500">{formatNumber(total)} SKU</p>
        </div>

        <div className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-bold text-slate-700">
          ABC
        </div>
      </div>

      <AbcBar abc={abc} />

      <div className="mt-4">
        <AbcPills abc={abc} />
      </div>
    </article>
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
          description: `${formatDate(
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

  const selectedCompanyValue = params.companyName ?? "ALL";
  const presetPeriods = periodOptions.filter((period) => period.key !== "custom");

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
      icon: "⚠️",
    },
    {
      level: freeCashResult < 0 ? "danger" : "ok",
      title: "Свободный результат",
      text:
        freeCashResult < 0
          ? `После всех расходов минус ${formatCurrency(
              Math.abs(freeCashResult)
            )}. Нужно смотреть ДДС.`
          : `После всех расходов осталось ${formatCurrency(freeCashResult)}.`,
      href: "/finance/cash-flow",
      icon: "💸",
    },
    {
      level: drr !== null && drr > 12 ? "warning" : "ok",
      title: "Реклама",
      text:
        drr !== null && drr > 12
          ? `ДРР ${formatPercent(drr)}. Нужно проверить кампании.`
          : "ДРР в пределах контроля или данных недостаточно.",
      href: "/ads-mapping",
      icon: "📣",
    },
    {
      level: loanPayments > 0 ? "warning" : "ok",
      title: "Кредиты",
      text:
        loanPayments > 0
          ? `Платежи по кредитам за период: ${formatCurrency(loanPayments)}.`
          : "В выбранном периоде платежей по кредитам не найдено.",
      href: "/finance/loans",
      icon: "🏦",
    },
  ];

  return (
    <main className="min-h-screen bg-slate-100 p-4 sm:p-6 xl:p-10">
      <div className="mx-auto max-w-[1800px] space-y-8">
        <section className="grid gap-6 xl:grid-cols-[1fr_820px] xl:items-start">
          <div className="min-w-0 pt-2">
            <div className="inline-flex rounded-full bg-slate-950 px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] text-white">
              Dashboard собственника
            </div>

            <h1 className="mt-5 break-words text-4xl font-bold tracking-tight text-slate-950">
              Главная панель бизнеса
            </h1>

            <p className="mt-4 max-w-2xl text-lg leading-8 text-slate-500">
              Прибыль, денежный результат, реклама, остатки, ABC и кредитная
              нагрузка по Wildberries и Ozon за выбранный период.
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <div className="rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200">
                Период:{" "}
                <span className="font-black text-slate-950">
                  {selectedPeriod.description}
                </span>
              </div>

              <div className="rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200">
                Компания:{" "}
                <span className="font-black text-slate-950">
                  {selectedCompanyName ?? "Все компании"}
                </span>
              </div>
            </div>
          </div>

          <div className="rounded-[32px] border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="text-xs font-bold uppercase tracking-[0.18em] text-slate-400">
                  Фильтры Dashboard
                </div>

                <h2 className="mt-2 text-2xl font-bold text-slate-950">
                  Выбор периода
                </h2>

                <p className="mt-1 text-sm text-slate-500">
                  Быстрые периоды работают через URL. Даты ниже — для ручного
                  периода.
                </p>
              </div>

              <Link
                href="/import"
                className="inline-flex w-fit items-center gap-2 rounded-2xl bg-slate-950 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-slate-800 active:scale-95"
              >
                <span>📥</span>
                Импортировать отчёт
              </Link>
            </div>

            <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {presetPeriods.map((period) => {
                const isActive = selectedPeriodOption.key === period.key;

                return (
                  <Link
                    key={period.key}
                    href={buildDashboardHref({
                      period: period.key,
                      companyName: selectedCompanyValue,
                    })}
                    className={`rounded-2xl border p-4 transition active:scale-[0.99] ${
                      isActive
                        ? "border-slate-950 bg-slate-950 text-white shadow-sm"
                        : "border-slate-200 bg-slate-50 text-slate-800 hover:border-slate-300 hover:bg-white"
                    }`}
                  >
                    <div className="text-sm font-black">{period.shortLabel}</div>
                    <div
                      className={`mt-1 text-xs leading-5 ${
                        isActive ? "text-slate-200" : "text-slate-500"
                      }`}
                    >
                      {period.description}
                    </div>
                  </Link>
                );
              })}
            </div>

            <form action="/" className="mt-5 rounded-3xl bg-slate-50 p-4 ring-1 ring-slate-200">
              <div className="grid gap-3 lg:grid-cols-[1fr_1fr_1fr]">
                <label className="text-sm font-medium text-slate-500">
                  Компания
                  <select
                    name="companyName"
                    defaultValue={selectedCompanyValue}
                    className="mt-1 h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-950 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                  >
                    <option value="ALL">Все компании</option>

                    {companies.map((company) => (
                      <option key={company.id} value={company.name}>
                        {company.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-sm font-medium text-slate-500">
                  Дата от
                  <input
                    type="date"
                    name="dateFrom"
                    defaultValue={selectedPeriod.dateFrom}
                    className="mt-1 h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 font-semibold text-slate-950 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                  />
                </label>

                <label className="text-sm font-medium text-slate-500">
                  Дата до
                  <input
                    type="date"
                    name="dateTo"
                    defaultValue={selectedPeriod.dateTo}
                    className="mt-1 h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 font-semibold text-slate-950 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                  />
                </label>
              </div>

              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  type="submit"
                  name="period"
                  value={selectedPeriodOption.key}
                  className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-bold text-white transition hover:bg-slate-800 active:scale-95"
                >
                  Применить фильтр
                </button>

                <button
                  type="submit"
                  name="period"
                  value="custom"
                  className="rounded-2xl border border-blue-200 bg-white px-5 py-3 text-sm font-bold text-blue-700 transition hover:bg-blue-50 active:scale-95"
                >
                  Показать выбранные даты
                </button>

                <Link
                  href="/"
                  className="rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-bold text-slate-600 transition hover:bg-slate-100 active:scale-95"
                >
                  Сбросить
                </Link>
              </div>
            </form>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            title="Выручка всего"
            value={totalRevenue > 0 ? formatCurrency(totalRevenue) : "Нет данных"}
            subtitle={`WB: ${formatCurrency(wbRevenue)} · Ozon: ${formatCurrency(
              ozonRevenue
            )}`}
            icon="💼"
            tone="bg-blue-50 text-blue-600"
          />

          <KpiCard
            title="Операционная прибыль после налогов"
            value={formatCurrency(operatingProfitAfterTax)}
            subtitle="После себестоимости, рекламы, логистики, хранения и налогов."
            icon="↗"
            tone="bg-emerald-50 text-emerald-600"
            valueClassName={valueColor(operatingProfitAfterTax)}
          />

          <KpiCard
            title="Свободный денежный результат"
            value={formatCurrency(freeCashResult)}
            subtitle="После всех расходов, кредитов, процентов и личных трат."
            icon="₽"
            tone="bg-red-50 text-red-600"
            valueClassName={valueColor(freeCashResult)}
          />

          <KpiCard
            title="ДРР общий"
            value={drr !== null ? formatPercent(drr) : "Нет данных"}
            subtitle={`Реклама всего: ${formatCurrency(adsCost)}`}
            icon="📣"
            tone="bg-violet-50 text-violet-600"
          />
        </section>

        <section className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          <KpiCard
            title="Кредитные платежи"
            value={loanPayments > 0 ? formatCurrency(loanPayments) : "Нет данных"}
            subtitle="Факт по финансовым операциям за выбранный период."
            icon="💳"
            tone="bg-orange-50 text-orange-600"
            valueClassName={loanPayments > 0 ? "text-red-600" : "text-slate-950"}
          />

          <article className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-4">
              <KpiIcon tone="bg-blue-50 text-blue-600">▣</KpiIcon>
              <div>
                <div className="text-sm font-medium text-slate-500">Остатки WB</div>
                <div className="mt-4 text-3xl font-bold tracking-tight text-slate-950">
                  {wbStockQty > 0 ? `${formatNumber(wbStockQty)} шт` : "Нет данных"}
                </div>
              </div>
            </div>

            <div className="mt-5">
              <AbcPills abc={wbAbc} />
            </div>
          </article>

          <article className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-4">
              <KpiIcon tone="bg-indigo-50 text-indigo-600">▣</KpiIcon>
              <div>
                <div className="text-sm font-medium text-slate-500">Остатки Ozon</div>
                <div className="mt-4 text-3xl font-bold tracking-tight text-slate-950">
                  {ozonStockQty > 0
                    ? `${formatNumber(ozonStockQty)} шт`
                    : "Нет данных"}
                </div>
              </div>
            </div>

            <div className="mt-5">
              <AbcPills abc={ozonAbc} />
            </div>
          </article>

          <article className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-4">
              <KpiIcon tone="bg-violet-50 text-violet-600">◔</KpiIcon>
              <div>
                <div className="text-sm font-medium text-slate-500">ABC всего</div>
                <div className="mt-4 text-2xl font-bold tracking-tight text-slate-950">
                  {formatNumber(abcTotal(totalAbc))} SKU
                </div>
              </div>
            </div>

            <div className="mt-5">
              <AbcPills abc={totalAbc} />
            </div>
          </article>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-xl font-bold text-slate-950">Структура ABC по штукам</h2>

          <div className="mt-5 grid gap-5 xl:grid-cols-3">
            <AbcCard title="WB" abc={wbAbc} />
            <AbcCard title="Ozon" abc={ozonAbc} />
            <AbcCard title="Всего WB + Ozon" abc={totalAbc} />
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-xl font-bold text-slate-950">Что требует внимания</h2>

          <div className="mt-5 grid gap-5 xl:grid-cols-4">
            {attentionItems.map((item) => (
              <Link
                key={item.title}
                href={item.href}
                className={`rounded-3xl border p-5 transition hover:-translate-y-0.5 hover:shadow-md ${
                  item.level === "danger"
                    ? "border-red-200 bg-red-50/40"
                    : item.level === "warning"
                      ? "border-amber-200 bg-amber-50/40"
                      : "border-slate-200 bg-white"
                }`}
              >
                <div className="text-2xl">{item.icon}</div>

                <h3 className="mt-4 font-bold text-slate-950">{item.title}</h3>

                <p className="mt-3 text-sm leading-6 text-slate-600">{item.text}</p>

                <div className="mt-4 text-sm font-bold text-slate-950">Открыть →</div>
              </Link>
            ))}
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-bold text-slate-950">Компании</h2>

              <p className="mt-1 text-sm text-slate-500">
                Только компании, у которых есть показатели за выбранный период
                или актуальные остатки.
              </p>
            </div>

            <Link
              href="/settings/companies"
              className="rounded-2xl border border-slate-300 px-5 py-3 text-center text-sm font-semibold transition hover:bg-slate-100"
            >
              Настройки компаний
            </Link>
          </div>

          {companyRows.length > 0 ? (
            <div className="grid gap-5 xl:grid-cols-2">
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
                    className="rounded-3xl border border-slate-200 bg-slate-50 p-5"
                  >
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <h3 className="text-2xl font-bold text-slate-950">
                          {row.companyName}
                        </h3>

                        <p className="mt-1 text-sm text-slate-500">
                          WB / Ozon / финансы / остатки
                        </p>
                      </div>

                      <div
                        className={`w-fit rounded-full px-4 py-2 text-sm font-bold ${
                          row.operatingProfitAfterTax >= 0
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-red-50 text-red-700"
                        }`}
                      >
                        {formatCurrency(row.operatingProfitAfterTax)}
                      </div>
                    </div>

                    <div className="mt-6 grid gap-x-8 gap-y-5 sm:grid-cols-3">
                      <div>
                        <div className="text-sm text-slate-500">WB</div>
                        <div className="mt-1 font-bold text-slate-950">
                          {formatCurrency(row.wbRevenue)}
                        </div>
                      </div>

                      <div>
                        <div className="text-sm text-slate-500">Ozon</div>
                        <div className="mt-1 font-bold text-slate-950">
                          {formatCurrency(row.ozonRevenue)}
                        </div>
                      </div>

                      <div>
                        <div className="text-sm text-slate-500">Всего</div>
                        <div className="mt-1 font-bold text-slate-950">
                          {formatCurrency(row.totalRevenue)}
                        </div>
                      </div>

                      <div>
                        <div className="text-sm text-slate-500">Реклама</div>
                        <div className="mt-1 font-bold text-slate-950">
                          {formatCurrency(row.adsCost)}
                        </div>
                      </div>

                      <div>
                        <div className="text-sm text-slate-500">ДРР</div>
                        <div className="mt-1 font-bold text-slate-950">
                          {row.drr !== null ? formatPercent(row.drr) : "—"}
                        </div>
                      </div>

                      <div>
                        <div className="text-sm text-slate-500">Кредиты</div>
                        <div className="mt-1 font-bold text-slate-950">
                          {formatCurrency(row.loanPayments)}
                        </div>
                      </div>

                      <div>
                        <div className="text-sm text-slate-500">
                          Свободный результат
                        </div>
                        <div className={`mt-1 font-bold ${valueColor(row.freeCashResult)}`}>
                          {formatCurrency(row.freeCashResult)}
                        </div>
                      </div>

                      <div>
                        <div className="text-sm text-slate-500">Остатки WB</div>
                        <div className="mt-1 font-bold text-slate-950">
                          {formatNumber(row.wbStockQty)} шт
                        </div>
                      </div>

                      <div>
                        <div className="text-sm text-slate-500">Остатки Ozon</div>
                        <div className="mt-1 font-bold text-slate-950">
                          {formatNumber(row.ozonStockQty)} шт
                        </div>
                      </div>
                    </div>

                    <div className="mt-6 grid gap-4 border-t border-slate-200 pt-5 sm:grid-cols-2">
                      <div>
                        <div className="mb-3 text-sm font-bold text-slate-700">
                          ABC WB
                        </div>

                        <AbcPills abc={rowWbAbc} />
                      </div>

                      <div>
                        <div className="mb-3 text-sm font-bold text-slate-700">
                          ABC Ozon
                        </div>

                        <AbcPills abc={rowOzonAbc} />
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

        <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-xl font-bold text-slate-950">Быстрый доступ</h2>

          <div className="mt-5 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            {quickLinks.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-3xl border border-slate-200 bg-white p-5 transition hover:-translate-y-0.5 hover:shadow-md"
              >
                <div className="flex items-start gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-xl">
                    {item.icon}
                  </div>

                  <div>
                    <h3 className="font-bold text-slate-950">{item.title}</h3>

                    <p className="mt-2 text-sm leading-6 text-slate-500">
                      {item.description}
                    </p>

                    <div className="mt-3 text-sm font-bold text-slate-950">
                      Открыть →
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}