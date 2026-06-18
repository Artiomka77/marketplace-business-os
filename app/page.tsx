import Link from "next/link";
import type { ReactNode } from "react";

import { prisma } from "@/lib/prisma";
import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import { calculateFinanceMetricsForRows } from "@/lib/finance/financeMetrics";

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

type CompanyForDashboard = {
  name: string;
  usnRate: unknown;
  vatRate: unknown;
};

type CompanyDashboardRow = {
  companyName: string;
  wbRevenue: number;
  ozonRevenue: number;
  totalRevenue: number;
  operatingProfitAfterTax: number;
  netProfit: number;
  profitAfterOwnerWithdrawal: number;
  cashFlowResult: number;
  adsCost: number;
  drr: number | null;
  loanPayments: number;
  creditPrincipal: number;
  creditInterest: number;
  personalExpenses: number;
  financialExpenses: number;
  cashOnlyExpenses: number;
  wbStockQty: number;
  ozonStockQty: number;
  wbAbcA: number;
  wbAbcB: number;
  wbAbcC: number;
  ozonAbcA: number;
  ozonAbcB: number;
  ozonAbcC: number;
};

type DashboardSummary = {
  companyRows: CompanyDashboardRow[];
  totalRevenue: number;
  wbRevenue: number;
  ozonRevenue: number;
  operatingProfitAfterTax: number;
  netProfit: number;
  profitAfterOwnerWithdrawal: number;
  cashFlowResult: number;
  adsCost: number;
  drr: number | null;
  loanPayments: number;
  creditPrincipal: number;
  creditInterest: number;
  personalExpenses: number;
  financialExpenses: number;
  cashOnlyExpenses: number;
  wbStockQty: number;
  ozonStockQty: number;
  wbAbc: AbcCounts;
  ozonAbc: AbcCounts;
  totalAbc: AbcCounts;
};

type PeriodOption = {
  key: string;
  shortLabel: string;
  label: string;
  description: string;
  dateFrom: string;
  dateTo: string;
};

type MetricTrend = {
  label: string;
  title: string;
  className: string;
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

function formatSignedPercent(value: number) {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(1)}%`;
}

function formatSignedPoints(value: number) {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(1)} п.п.`;
}

function formatDate(value: string | Date) {
  const date =
    typeof value === "string" ? new Date(`${value}T12:00:00Z`) : value;

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

function parseIsoDate(value: string) {
  const [yearText, monthText, dayText] = value.split("-");
  return makeUtcDate(Number(yearText), Number(monthText) - 1, Number(dayText));
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

function getInclusiveDays(dateFrom: string, dateTo: string) {
  const from = parseIsoDate(dateFrom);
  const to = parseIsoDate(dateTo);
  const ms = to.getTime() - from.getTime();

  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

function getPreviousPeriod(dateFrom: string, dateTo: string) {
  const currentFrom = parseIsoDate(dateFrom);
  const days = getInclusiveDays(dateFrom, dateTo);

  const previousTo = addDays(currentFrom, -1);
  const previousFrom = addDays(previousTo, -(days - 1));

  return {
    dateFrom: toIsoDate(previousFrom),
    dateTo: toIsoDate(previousTo),
    description: `${formatDate(previousFrom)} — ${formatDate(previousTo)}`,
  };
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
      shortLabel: "4 недели",
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
      label: `Текущий год: ${formatDate(currentYearStart)} — ${formatDate(
        today
      )}`,
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
      shortLabel: "Свой период",
      label: "Произвольный период",
      description: "Выбор дат вручную",
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

function valueColor(value: number) {
  return value >= 0 ? "text-emerald-600" : "text-red-600";
}

function valueTone(value: number) {
  return value >= 0
    ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
    : "bg-red-50 text-red-700 ring-red-200";
}

function trendTone(isGood: boolean | null) {
  if (isGood === true) {
    return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  }

  if (isGood === false) {
    return "bg-red-50 text-red-700 ring-red-200";
  }

  return "bg-slate-50 text-slate-600 ring-slate-200";
}

function buildMoneyTrend(params: {
  current: number;
  previous: number;
  goodWhen: "up" | "down";
}): MetricTrend {
  const delta = params.current - params.previous;
  const percent =
    params.previous !== 0 ? (delta / Math.abs(params.previous)) * 100 : null;

  const isGood =
    delta === 0 ? null : params.goodWhen === "up" ? delta > 0 : delta < 0;

  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  const deltaText = `${sign}${formatCurrency(Math.abs(delta))}`;

  return {
    label:
      percent === null
        ? deltaText
        : `${deltaText} · ${formatSignedPercent(percent)}`,
    title: "к предыдущему периоду",
    className: trendTone(isGood),
  };
}

function buildPercentTrend(params: {
  current: number | null;
  previous: number | null;
  goodWhen: "up" | "down";
}): MetricTrend {
  if (params.current === null || params.previous === null) {
    return {
      label: "нет сравнения",
      title: "к предыдущему периоду",
      className: trendTone(null),
    };
  }

  const delta = params.current - params.previous;
  const isGood =
    delta === 0 ? null : params.goodWhen === "up" ? delta > 0 : delta < 0;

  return {
    label: formatSignedPoints(delta),
    title: "к предыдущему периоду",
    className: trendTone(isGood),
  };
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
    row.netProfit !== 0 ||
    row.profitAfterOwnerWithdrawal !== 0 ||
    row.cashFlowResult !== 0 ||
    row.adsCost !== 0 ||
    row.loanPayments !== 0 ||
    row.creditPrincipal !== 0 ||
    row.creditInterest !== 0 ||
    row.personalExpenses !== 0 ||
    row.financialExpenses !== 0 ||
    row.cashOnlyExpenses !== 0 ||
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
  searchParams.set("companyName", params.companyName || "ALL");

  if (params.dateFrom) {
    searchParams.set("dateFrom", params.dateFrom);
  }

  if (params.dateTo) {
    searchParams.set("dateTo", params.dateTo);
  }

  return `/?${searchParams.toString()}`;
}

function MetricCard({
  title,
  value,
  subtitle,
  icon,
  accent,
  trend,
  valueClassName = "text-slate-950",
}: {
  title: string;
  value: string;
  subtitle: string;
  icon: ReactNode;
  accent: string;
  trend?: MetricTrend;
  valueClassName?: string;
}) {
  return (
    <article className="group rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-start justify-between gap-4">
        <div
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-lg ${accent}`}
        >
          {icon}
        </div>

        {trend ? (
          <div
            className={`rounded-full px-3 py-1 text-[11px] font-black ring-1 ${trend.className}`}
            title={trend.title}
          >
            {trend.label}
          </div>
        ) : (
          <div className="rounded-full bg-slate-50 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
            KPI
          </div>
        )}
      </div>

      <div className="mt-5 text-sm font-semibold text-slate-500">{title}</div>

      <div
        className={`mt-3 break-words text-[28px] font-black leading-tight tracking-tight ${valueClassName}`}
      >
        {value}
      </div>

      <p className="mt-3 min-h-[44px] text-sm leading-6 text-slate-500">
        {subtitle}
      </p>
    </article>
  );
}

function MiniMetric({
  title,
  value,
  tone = "text-slate-950",
}: {
  title: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="rounded-2xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200">
      <div className="text-xs font-semibold text-slate-500">{title}</div>
      <div className={`mt-1 text-lg font-black ${tone}`}>{value}</div>
    </div>
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
      <AbcPill
        label="A"
        count={abc.A}
        total={total}
        tone="bg-emerald-50 text-emerald-700"
      />
      <AbcPill
        label="B"
        count={abc.B}
        total={total}
        tone="bg-amber-50 text-amber-700"
      />
      <AbcPill
        label="C"
        count={abc.C}
        total={total}
        tone="bg-red-50 text-red-700"
      />
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
    <article className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-black text-slate-950">{title}</h3>
          <p className="mt-1 text-sm text-slate-500">
            {formatNumber(total)} SKU
          </p>
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

function MarketplaceShare({
  wbRevenue,
  ozonRevenue,
}: {
  wbRevenue: number;
  ozonRevenue: number;
}) {
  const total = wbRevenue + ozonRevenue;
  const wbPercent = total > 0 ? (wbRevenue / total) * 100 : 0;
  const ozonPercent = total > 0 ? (ozonRevenue / total) * 100 : 0;

  return (
    <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">
            Маркетплейсы
          </div>
          <h2 className="mt-2 text-2xl font-black text-slate-950">
            Выручка WB / Ozon
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Быстрая оценка, где сейчас формируется оборот за выбранный период.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:min-w-[460px]">
          <MiniMetric
            title="Wildberries"
            value={`${formatCurrency(wbRevenue)} · ${formatPercent(wbPercent)}`}
            tone="text-blue-700"
          />
          <MiniMetric
            title="Ozon"
            value={`${formatCurrency(ozonRevenue)} · ${formatPercent(
              ozonPercent
            )}`}
            tone="text-violet-700"
          />
        </div>
      </div>

      <div className="mt-5 h-4 overflow-hidden rounded-full bg-slate-100">
        <div className="flex h-full w-full">
          <div className="h-full bg-blue-500" style={{ width: `${wbPercent}%` }} />
          <div
            className="h-full bg-violet-500"
            style={{ width: `${ozonPercent}%` }}
          />
        </div>
      </div>
    </section>
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

  const [rows, categories] = await Promise.all([
    prisma.financeTransaction.findMany({
      where: {
        companyName: params.companyName,
        operationDate: {
          gte: from,
          lt: toExclusive,
        },
      },
    }),
    prisma.financeCategory.findMany({
      select: {
        name: true,
        categoryType: true,
        parentName: true,
        profitTreatment: true,
      },
    }),
  ]);

  const metrics = calculateFinanceMetricsForRows({
    transactions: rows,
    categories,
  });

  return {
    cashFlowResult: metrics.netCashFlow,
    loanPayments: metrics.creditPrincipal + metrics.creditInterest,
    creditPrincipal: metrics.creditPrincipal,
    creditInterest: metrics.creditInterest,
    personalExpenses: metrics.ownerWithdrawals,
    financialExpenses: Math.max(0, metrics.netProfitExpense - metrics.creditInterest),
    cashOnlyExpenses: metrics.cashOnlyTotal,
    netProfitIncludedIncome: metrics.netProfitIncome,
    netProfitIncludedExpenses: metrics.netProfitExpense,
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

async function buildCompanyDashboardRows(params: {
  companies: CompanyForDashboard[];
  dateFrom: string;
  dateTo: string;
}) {
  const rows: CompanyDashboardRow[] = [];

  for (const company of params.companies) {
    const wb = await getProfitAnalytics({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      companyName: company.name,
    });

    const ozon = await getProfitAnalyticsOzon({
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
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
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
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

    const operatingProfitAfterTax =
      wb.totals.netProfitAfterTax + ozon.totals.netProfitAfterTax;

    const adsCost = wb.totals.adsCost + ozon.totals.adsCost;
    const drr = totalRevenue > 0 ? (adsCost / totalRevenue) * 100 : null;

    const netProfit =
      operatingProfitAfterTax +
      cash.netProfitIncludedIncome -
      cash.netProfitIncludedExpenses;

    const profitAfterOwnerWithdrawal = netProfit - cash.personalExpenses;

    rows.push({
      companyName: company.name,
      wbRevenue,
      ozonRevenue,
      totalRevenue,
      operatingProfitAfterTax,
      netProfit,
      profitAfterOwnerWithdrawal,
      cashFlowResult: cash.cashFlowResult,
      adsCost,
      drr,
      loanPayments: cash.loanPayments,
      creditPrincipal: cash.creditPrincipal,
      creditInterest: cash.creditInterest,
      personalExpenses: cash.personalExpenses,
      financialExpenses: cash.financialExpenses,
      cashOnlyExpenses: cash.cashOnlyExpenses,
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

  return rows;
}

function summarizeDashboardRows(rows: CompanyDashboardRow[]): DashboardSummary {
  const companyRows = rows.filter(hasAnyCompanyMetric);

  const totalRevenue = companyRows.reduce((sum, row) => sum + row.totalRevenue, 0);
  const wbRevenue = companyRows.reduce((sum, row) => sum + row.wbRevenue, 0);
  const ozonRevenue = companyRows.reduce((sum, row) => sum + row.ozonRevenue, 0);

  const operatingProfitAfterTax = companyRows.reduce(
    (sum, row) => sum + row.operatingProfitAfterTax,
    0
  );

  const netProfit = companyRows.reduce((sum, row) => sum + row.netProfit, 0);

  const profitAfterOwnerWithdrawal = companyRows.reduce(
    (sum, row) => sum + row.profitAfterOwnerWithdrawal,
    0
  );

  const cashFlowResult = companyRows.reduce(
    (sum, row) => sum + row.cashFlowResult,
    0
  );

  const adsCost = companyRows.reduce((sum, row) => sum + row.adsCost, 0);
  const drr = totalRevenue > 0 ? (adsCost / totalRevenue) * 100 : null;

  const loanPayments = companyRows.reduce((sum, row) => sum + row.loanPayments, 0);
  const creditPrincipal = companyRows.reduce(
    (sum, row) => sum + row.creditPrincipal,
    0
  );
  const creditInterest = companyRows.reduce(
    (sum, row) => sum + row.creditInterest,
    0
  );
  const personalExpenses = companyRows.reduce(
    (sum, row) => sum + row.personalExpenses,
    0
  );
  const financialExpenses = companyRows.reduce(
    (sum, row) => sum + row.financialExpenses,
    0
  );
  const cashOnlyExpenses = companyRows.reduce(
    (sum, row) => sum + row.cashOnlyExpenses,
    0
  );

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

  return {
    companyRows,
    totalRevenue,
    wbRevenue,
    ozonRevenue,
    operatingProfitAfterTax,
    netProfit,
    profitAfterOwnerWithdrawal,
    cashFlowResult,
    adsCost,
    drr,
    loanPayments,
    creditPrincipal,
    creditInterest,
    personalExpenses,
    financialExpenses,
    cashOnlyExpenses,
    wbStockQty,
    ozonStockQty,
    wbAbc,
    ozonAbc,
    totalAbc,
  };
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

  const previousPeriod = getPreviousPeriod(
    selectedPeriod.dateFrom,
    selectedPeriod.dateTo
  );

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

  const [currentRows, previousRows] = await Promise.all([
    buildCompanyDashboardRows({
      companies: selectedCompanies,
      dateFrom: selectedPeriod.dateFrom,
      dateTo: selectedPeriod.dateTo,
    }),
    buildCompanyDashboardRows({
      companies: selectedCompanies,
      dateFrom: previousPeriod.dateFrom,
      dateTo: previousPeriod.dateTo,
    }),
  ]);

  const current = summarizeDashboardRows(currentRows);
  const previous = summarizeDashboardRows(previousRows);

  const selectedCompanyValue = params.companyName ?? "ALL";
  const presetPeriods = periodOptions.filter((period) => period.key !== "custom");

  const attentionItems = [
    {
      level: current.operatingProfitAfterTax < 0 ? "danger" : "ok",
      title: "Операционная прибыль",
      text:
        current.operatingProfitAfterTax < 0
          ? `Операционная прибыль после налогов отрицательная: ${formatCurrency(
              current.operatingProfitAfterTax
            )}.`
          : `Операционная прибыль после налогов: ${formatCurrency(
              current.operatingProfitAfterTax
            )}.`,
      href: "/analytics",
      icon: "⚠️",
    },
    {
      level: current.netProfit < 0 ? "danger" : "ok",
      title: "Чистая прибыль",
      text:
        current.netProfit < 0
          ? `Чистая прибыль отрицательная: ${formatCurrency(
              current.netProfit
            )}. Проверь проценты по кредитам и расходы, влияющие на прибыль.`
          : `Чистая прибыль бизнеса: ${formatCurrency(current.netProfit)}.`,
      href: "/finance/cash-flow",
      icon: "💸",
    },
    {
      level: current.profitAfterOwnerWithdrawal < 0 ? "danger" : "ok",
      title: "После вывода собственника",
      text:
        current.profitAfterOwnerWithdrawal < 0
          ? `После личных расходов и вывода собственника минус ${formatCurrency(
              Math.abs(current.profitAfterOwnerWithdrawal)
            )}.`
          : `После личных расходов и вывода собственника осталось ${formatCurrency(
              current.profitAfterOwnerWithdrawal
            )}.`,
      href: "/finance/operations",
      icon: "👤",
    },
    {
      level: current.drr !== null && current.drr > 12 ? "warning" : "ok",
      title: "Реклама",
      text:
        current.drr !== null && current.drr > 12
          ? `ДРР ${formatPercent(current.drr)}. Нужно проверить кампании.`
          : "ДРР в пределах контроля или данных недостаточно.",
      href: "/ads-mapping",
      icon: "📣",
    },
    {
      level: current.loanPayments > 0 ? "warning" : "ok",
      title: "Кредиты",
      text:
        current.loanPayments > 0
          ? `Платежи по кредитам за период: ${formatCurrency(
              current.loanPayments
            )}.`
          : "В выбранном периоде платежей по кредитам не найдено.",
      href: "/finance/loans",
      icon: "🏦",
    },
  ];

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-6 sm:px-6 xl:px-10">
      <div className="mx-auto max-w-[1800px] space-y-6">
        <section className="rounded-[36px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <span className="rounded-full bg-slate-950 px-4 py-2 text-xs font-bold uppercase tracking-[0.18em] text-white">
                  Dashboard собственника
                </span>

                <span className="rounded-full bg-slate-100 px-4 py-2 text-xs font-bold text-slate-600 ring-1 ring-slate-200">
                  {selectedPeriod.description}
                </span>

                <span className="rounded-full bg-slate-100 px-4 py-2 text-xs font-bold text-slate-600 ring-1 ring-slate-200">
                  Сравнение: {previousPeriod.description}
                </span>

                <span className="rounded-full bg-slate-100 px-4 py-2 text-xs font-bold text-slate-600 ring-1 ring-slate-200">
                  {selectedCompanyName ?? "Все компании"}
                </span>
              </div>

              <h1 className="mt-5 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">
                Главная панель бизнеса
              </h1>

              <p className="mt-3 max-w-3xl text-base leading-7 text-slate-500">
                Деньги, прибыль, реклама, остатки, ABC и кредитная нагрузка по
                Wildberries и Ozon за выбранный период.
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row xl:shrink-0">
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 px-5 py-3 text-sm font-black text-slate-950 transition hover:bg-white">
                  Фильтры и период
                  <span className="ml-2 text-slate-400 transition group-open:rotate-180">
                    ↓
                  </span>
                </summary>

                <div className="mt-3 w-full rounded-[28px] border border-slate-200 bg-white p-4 shadow-xl xl:absolute xl:right-10 xl:z-20 xl:w-[760px]">
                  <div className="grid gap-2 sm:grid-cols-3">
                    {presetPeriods.map((period) => {
                      const isActive = selectedPeriodOption.key === period.key;

                      return (
                        <Link
                          key={period.key}
                          href={buildDashboardHref({
                            period: period.key,
                            companyName: selectedCompanyValue,
                          })}
                          className={`rounded-2xl border p-3 transition active:scale-[0.99] ${
                            isActive
                              ? "border-slate-950 bg-slate-950 text-white"
                              : "border-slate-200 bg-slate-50 text-slate-800 hover:bg-white"
                          }`}
                        >
                          <div className="text-sm font-black">
                            {period.shortLabel}
                          </div>
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

                  <form
                    action="/"
                    className="mt-4 rounded-3xl bg-slate-50 p-4 ring-1 ring-slate-200"
                  >
                    <div className="grid gap-3 lg:grid-cols-[1fr_1fr_1fr]">
                      <label className="text-sm font-medium text-slate-500">
                        Компания
                        <select
                          name="companyName"
                          defaultValue={selectedCompanyValue}
                          className="mt-1 h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-950 outline-none transition focus:border-slate-900 focus:ring-2 focus:ring-slate-200"
                        >
                          <option value="ALL">Все компании</option>

                          {current.companyRows.map((company) => (
                            <option
                              key={company.companyName}
                              value={company.companyName}
                            >
                              {company.companyName}
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
                        value="custom"
                        className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-bold text-white transition hover:bg-slate-800 active:scale-95"
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
              </details>

              <Link
                href="/import"
                className="inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-950 px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-slate-800 active:scale-95"
              >
                <span>📥</span>
                Импорт
              </Link>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          <MetricCard
            title="Выручка всего"
            value={
              current.totalRevenue > 0
                ? formatCurrency(current.totalRevenue)
                : "Нет данных"
            }
            subtitle={`WB: ${formatCurrency(
              current.wbRevenue
            )} · Ozon: ${formatCurrency(current.ozonRevenue)}`}
            icon="💼"
            accent="bg-blue-50 text-blue-600"
            trend={buildMoneyTrend({
              current: current.totalRevenue,
              previous: previous.totalRevenue,
              goodWhen: "up",
            })}
          />

          <MetricCard
            title="Операционная прибыль"
            value={formatCurrency(current.operatingProfitAfterTax)}
            subtitle="После себестоимости, рекламы, логистики, хранения и налогов."
            icon="↗"
            accent="bg-emerald-50 text-emerald-600"
            valueClassName={valueColor(current.operatingProfitAfterTax)}
            trend={buildMoneyTrend({
              current: current.operatingProfitAfterTax,
              previous: previous.operatingProfitAfterTax,
              goodWhen: "up",
            })}
          />

          <MetricCard
            title="Чистая прибыль"
            value={formatCurrency(current.netProfit)}
            subtitle="Опер. прибыль ± статьи, которые отмечены как влияющие на прибыль."
            icon="₽"
            accent="bg-red-50 text-red-600"
            valueClassName={valueColor(current.netProfit)}
            trend={buildMoneyTrend({
              current: current.netProfit,
              previous: previous.netProfit,
              goodWhen: "up",
            })}
          />

          <MetricCard
            title="После вывода собственника"
            value={formatCurrency(current.profitAfterOwnerWithdrawal)}
            subtitle={`Чистая прибыль минус личные расходы: ${formatCurrency(
              current.personalExpenses
            )}`}
            icon="👤"
            accent="bg-amber-50 text-amber-600"
            valueClassName={valueColor(current.profitAfterOwnerWithdrawal)}
            trend={buildMoneyTrend({
              current: current.profitAfterOwnerWithdrawal,
              previous: previous.profitAfterOwnerWithdrawal,
              goodWhen: "up",
            })}
          />

          <MetricCard
            title="Денежный поток"
            value={formatCurrency(current.cashFlowResult)}
            subtitle="ДДС: поступления минус все фактические выплаты."
            icon="💸"
            accent="bg-cyan-50 text-cyan-600"
            valueClassName={valueColor(current.cashFlowResult)}
            trend={buildMoneyTrend({
              current: current.cashFlowResult,
              previous: previous.cashFlowResult,
              goodWhen: "up",
            })}
          />

          <MetricCard
            title="ДРР общий"
            value={current.drr !== null ? formatPercent(current.drr) : "Нет данных"}
            subtitle={`Реклама всего: ${formatCurrency(current.adsCost)}`}
            icon="📣"
            accent="bg-violet-50 text-violet-600"
            valueClassName={
              current.drr !== null && current.drr > 12
                ? "text-red-600"
                : "text-slate-950"
            }
            trend={buildPercentTrend({
              current: current.drr,
              previous: previous.drr,
              goodWhen: "down",
            })}
          />
        </section>

        <MarketplaceShare
          wbRevenue={current.wbRevenue}
          ozonRevenue={current.ozonRevenue}
        />

        <section className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          <MetricCard
            title="Тело кредита"
            value={
              current.creditPrincipal > 0
                ? formatCurrency(current.creditPrincipal)
                : "Нет данных"
            }
            subtitle="Погашение основного долга: влияет на ДДС, но не на чистую прибыль."
            icon="🏦"
            accent="bg-blue-50 text-blue-600"
            valueClassName={
              current.creditPrincipal > 0 ? "text-red-600" : "text-slate-950"
            }
            trend={buildMoneyTrend({
              current: current.creditPrincipal,
              previous: previous.creditPrincipal,
              goodWhen: "down",
            })}
          />

          <MetricCard
            title="Проценты по кредиту"
            value={
              current.creditInterest > 0
                ? formatCurrency(current.creditInterest)
                : "Нет данных"
            }
            subtitle="Финансовый расход: влияет и на ДДС, и на чистую прибыль."
            icon="%"
            accent="bg-violet-50 text-violet-600"
            valueClassName={
              current.creditInterest > 0 ? "text-red-600" : "text-slate-950"
            }
            trend={buildMoneyTrend({
              current: current.creditInterest,
              previous: previous.creditInterest,
              goodWhen: "down",
            })}
          />

          <MetricCard
            title="Только ДДС"
            value={
              current.cashOnlyExpenses > 0
                ? formatCurrency(current.cashOnlyExpenses)
                : "Нет данных"
            }
            subtitle="Фулфилмент, закупки и прочие статьи, уже сидящие в себестоимости."
            icon="📦"
            accent="bg-cyan-50 text-cyan-600"
            valueClassName={
              current.cashOnlyExpenses > 0 ? "text-red-600" : "text-slate-950"
            }
            trend={buildMoneyTrend({
              current: current.cashOnlyExpenses,
              previous: previous.cashOnlyExpenses,
              goodWhen: "down",
            })}
          />

          <MetricCard
            title="Остатки WB"
            value={
              current.wbStockQty > 0
                ? `${formatNumber(current.wbStockQty)} шт`
                : "Нет данных"
            }
            subtitle={`ABC: A ${current.wbAbc.A} · B ${current.wbAbc.B} · C ${current.wbAbc.C}`}
            icon="▣"
            accent="bg-blue-50 text-blue-600"
          />

          <MetricCard
            title="Остатки Ozon"
            value={
              current.ozonStockQty > 0
                ? `${formatNumber(current.ozonStockQty)} шт`
                : "Нет данных"
            }
            subtitle={`ABC: A ${current.ozonAbc.A} · B ${current.ozonAbc.B} · C ${current.ozonAbc.C}`}
            icon="▣"
            accent="bg-indigo-50 text-indigo-600"
          />

          <MetricCard
            title="ABC всего"
            value={`${formatNumber(abcTotal(current.totalAbc))} SKU`}
            subtitle={`A ${current.totalAbc.A} · B ${current.totalAbc.B} · C ${current.totalAbc.C}`}
            icon="◔"
            accent="bg-violet-50 text-violet-600"
          />
        </section>

        <section className="grid gap-5 xl:grid-cols-[1fr_1fr]">
          <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">
                  ABC структура
                </div>
                <h2 className="mt-2 text-2xl font-black text-slate-950">
                  Качество ассортимента
                </h2>
              </div>

              <div className="rounded-2xl bg-slate-100 px-4 py-2 text-sm font-black text-slate-700">
                {formatNumber(abcTotal(current.totalAbc))} SKU
              </div>
            </div>

            <div className="mt-5 grid gap-4">
              <AbcCard title="WB" abc={current.wbAbc} />
              <AbcCard title="Ozon" abc={current.ozonAbc} />
              <AbcCard title="Всего WB + Ozon" abc={current.totalAbc} />
            </div>
          </section>

          <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">
              Контроль собственника
            </div>
            <h2 className="mt-2 text-2xl font-black text-slate-950">
              Что требует внимания
            </h2>

            <div className="mt-5 grid gap-3">
              {attentionItems.map((item) => (
                <Link
                  key={item.title}
                  href={item.href}
                  className={`rounded-3xl border p-4 transition hover:-translate-y-0.5 hover:shadow-md ${
                    item.level === "danger"
                      ? "border-red-200 bg-red-50/50"
                      : item.level === "warning"
                        ? "border-amber-200 bg-amber-50/50"
                        : "border-slate-200 bg-slate-50"
                  }`}
                >
                  <div className="flex items-start gap-4">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white text-xl shadow-sm">
                      {item.icon}
                    </div>

                    <div>
                      <h3 className="font-black text-slate-950">{item.title}</h3>
                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        {item.text}
                      </p>
                      <div className="mt-2 text-sm font-black text-slate-950">
                        Открыть →
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        </section>

        <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">
                Компании
              </div>
              <h2 className="mt-2 text-2xl font-black text-slate-950">
                Разрез по ИП
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                Выручка, реклама, ДРР, прибыль, вывод собственника, ДДС, кредиты,
                остатки и ABC по каждой компании.
              </p>
            </div>

            <Link
              href="/settings/companies"
              className="rounded-2xl border border-slate-300 px-5 py-3 text-center text-sm font-bold transition hover:bg-slate-100"
            >
              Настройки компаний
            </Link>
          </div>

          {current.companyRows.length > 0 ? (
            <div className="grid gap-5 xl:grid-cols-2">
              {current.companyRows.map((row) => {
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
                    className="rounded-[28px] border border-slate-200 bg-slate-50 p-5"
                  >
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <h3 className="text-2xl font-black text-slate-950">
                          {row.companyName}
                        </h3>

                        <p className="mt-1 text-sm text-slate-500">
                          WB / Ozon / финансы / остатки
                        </p>
                      </div>

                      <div
                        className={`w-fit rounded-full px-4 py-2 text-sm font-black ring-1 ${valueTone(
                          row.profitAfterOwnerWithdrawal
                        )}`}
                      >
                        {formatCurrency(row.profitAfterOwnerWithdrawal)}
                      </div>
                    </div>

                    <div className="mt-5 grid gap-3 sm:grid-cols-3">
                      <MiniMetric title="WB" value={formatCurrency(row.wbRevenue)} />
                      <MiniMetric
                        title="Ozon"
                        value={formatCurrency(row.ozonRevenue)}
                      />
                      <MiniMetric
                        title="Всего"
                        value={formatCurrency(row.totalRevenue)}
                      />
                      <MiniMetric
                        title="Реклама"
                        value={formatCurrency(row.adsCost)}
                      />
                      <MiniMetric
                        title="ДРР"
                        value={row.drr !== null ? formatPercent(row.drr) : "—"}
                        tone={
                          row.drr !== null && row.drr > 12
                            ? "text-red-700"
                            : "text-slate-950"
                        }
                      />
                      <MiniMetric
                        title="Тело кредита"
                        value={formatCurrency(row.creditPrincipal)}
                      />
                      <MiniMetric
                        title="Проценты"
                        value={formatCurrency(row.creditInterest)}
                      />
                      <MiniMetric
                        title="Чистая прибыль"
                        value={formatCurrency(row.netProfit)}
                        tone={valueColor(row.netProfit)}
                      />
                      <MiniMetric
                        title="После вывода"
                        value={formatCurrency(row.profitAfterOwnerWithdrawal)}
                        tone={valueColor(row.profitAfterOwnerWithdrawal)}
                      />
                      <MiniMetric
                        title="Денежный поток"
                        value={formatCurrency(row.cashFlowResult)}
                        tone={valueColor(row.cashFlowResult)}
                      />
                      <MiniMetric
                        title="Личные расходы"
                        value={formatCurrency(row.personalExpenses)}
                      />
                      <MiniMetric
                        title="Только ДДС"
                        value={formatCurrency(row.cashOnlyExpenses)}
                      />
                      <MiniMetric
                        title="Расходы в прибыли"
                        value={formatCurrency(row.financialExpenses)}
                      />
                      <MiniMetric
                        title="Остатки WB"
                        value={`${formatNumber(row.wbStockQty)} шт`}
                      />
                      <MiniMetric
                        title="Остатки Ozon"
                        value={`${formatNumber(row.ozonStockQty)} шт`}
                      />
                    </div>

                    <div className="mt-5 grid gap-4 border-t border-slate-200 pt-5 sm:grid-cols-2">
                      <div>
                        <div className="mb-3 text-sm font-black text-slate-700">
                          ABC WB
                        </div>
                        <AbcPills abc={rowWbAbc} />
                      </div>

                      <div>
                        <div className="mb-3 text-sm font-black text-slate-700">
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

        <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">
            Быстрый доступ
          </div>
          <h2 className="mt-2 text-2xl font-black text-slate-950">
            Основные разделы
          </h2>

          <div className="mt-5 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            {quickLinks.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-3xl border border-slate-200 bg-slate-50 p-5 transition hover:-translate-y-0.5 hover:bg-white hover:shadow-md"
              >
                <div className="flex items-start gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white text-xl shadow-sm">
                    {item.icon}
                  </div>

                  <div>
                    <h3 className="font-black text-slate-950">{item.title}</h3>

                    <p className="mt-2 text-sm leading-6 text-slate-500">
                      {item.description}
                    </p>

                    <div className="mt-3 text-sm font-black text-slate-950">
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