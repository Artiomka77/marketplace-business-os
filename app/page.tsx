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
    chartPreset?: string;
    marketplaceCompanyName?: string;
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

type ChartPresetKey =
  | "revenue-drr"
  | "revenue-profit"
  | "revenue-credits"
  | "profit-cashflow";

type ChartMetricKind = "money" | "percent";

type ChartMetricConfig = {
  label: string;
  kind: ChartMetricKind;
  colorClassName: string;
  dotClassName: string;
  strokeColor: string;
  barFromClassName: string;
  barToClassName: string;
};

type ChartPresetConfig = {
  key: ChartPresetKey;
  title: string;
  description: string;
  primary: ChartMetricConfig;
  secondary: ChartMetricConfig;
};

const chartPresets: ChartPresetConfig[] = [
  {
    key: "revenue-drr",
    title: "Выручка и ДРР",
    description: "Оборот и рекламная нагрузка за период.",
    primary: {
      label: "Выручка",
      kind: "money",
      colorClassName: "text-violet-700",
      dotClassName: "bg-violet-600",
      strokeColor: "#7c3aed",
      barFromClassName: "from-violet-600",
      barToClassName: "to-violet-300",
    },
    secondary: {
      label: "ДРР",
      kind: "percent",
      colorClassName: "text-orange-700",
      dotClassName: "bg-orange-500",
      strokeColor: "#f97316",
      barFromClassName: "from-orange-500",
      barToClassName: "to-orange-200",
    },
  },
  {
    key: "revenue-profit",
    title: "Выручка и прибыль",
    description: "Сравнение оборота с операционной прибылью.",
    primary: {
      label: "Выручка",
      kind: "money",
      colorClassName: "text-violet-700",
      dotClassName: "bg-violet-600",
      strokeColor: "#7c3aed",
      barFromClassName: "from-violet-600",
      barToClassName: "to-violet-300",
    },
    secondary: {
      label: "Опер. прибыль",
      kind: "money",
      colorClassName: "text-emerald-700",
      dotClassName: "bg-emerald-500",
      strokeColor: "#10b981",
      barFromClassName: "from-emerald-500",
      barToClassName: "to-emerald-200",
    },
  },
  {
    key: "revenue-credits",
    title: "Выручка и кредиты",
    description: "Оборот рядом с кредитной нагрузкой.",
    primary: {
      label: "Выручка",
      kind: "money",
      colorClassName: "text-violet-700",
      dotClassName: "bg-violet-600",
      strokeColor: "#7c3aed",
      barFromClassName: "from-violet-600",
      barToClassName: "to-violet-300",
    },
    secondary: {
      label: "Кредиты",
      kind: "money",
      colorClassName: "text-red-700",
      dotClassName: "bg-red-500",
      strokeColor: "#ef4444",
      barFromClassName: "from-red-500",
      barToClassName: "to-red-200",
    },
  },
  {
    key: "profit-cashflow",
    title: "Прибыль и ДДС",
    description: "Чистая прибыль рядом с денежным потоком.",
    primary: {
      label: "Чистая прибыль",
      kind: "money",
      colorClassName: "text-emerald-700",
      dotClassName: "bg-emerald-500",
      strokeColor: "#10b981",
      barFromClassName: "from-emerald-500",
      barToClassName: "to-emerald-200",
    },
    secondary: {
      label: "Денежный поток",
      kind: "money",
      colorClassName: "text-sky-700",
      dotClassName: "bg-sky-500",
      strokeColor: "#0ea5e9",
      barFromClassName: "from-sky-500",
      barToClassName: "to-sky-200",
    },
  },
];

const trendWeights = [0.52, 0.68, 0.8, 0.6, 0.92, 0.66, 0.76, 1, 0.74, 0.88, 0.64, 0.96, 0.7, 0.9];
const lineWeights = [0.74, 0.62, 0.7, 0.52, 0.82, 0.64, 0.9, 0.58, 0.72, 0.56, 0.86, 0.66, 0.78, 0.6];
const weekDayLabels = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

const quickActions = [
  {
    title: "Аналитика",
    description: "Детальные отчёты и графики",
    href: "/analytics",
    icon: "▦",
    tone: "bg-indigo-50 text-indigo-700",
  },
  {
    title: "Маркетплейсы",
    description: "Каналы, продажи и доля",
    href: "/analytics",
    icon: "◌",
    tone: "bg-violet-50 text-violet-700",
  },
  {
    title: "Реклама",
    description: "Кампании и эффективность",
    href: "/ads-mapping",
    icon: "↗",
    tone: "bg-emerald-50 text-emerald-700",
  },
  {
    title: "Финансы",
    description: "Прибыль и денежный поток",
    href: "/finance",
    icon: "₽",
    tone: "bg-amber-50 text-amber-700",
  },
  {
    title: "Кредиты и выводы",
    description: "Тело, проценты и выплаты",
    href: "/finance/loans",
    icon: "⌁",
    tone: "bg-orange-50 text-orange-700",
  },
  {
    title: "Остатки и ABC",
    description: "Ассортимент и оборачиваемость",
    href: "/stocks",
    icon: "◔",
    tone: "bg-blue-50 text-blue-700",
  },
  {
    title: "Импорт",
    description: "Файлы, API и загрузка данных",
    href: "/import",
    icon: "⇧",
    tone: "bg-cyan-50 text-cyan-700",
  },
  {
    title: "Настройки",
    description: "Компании и параметры",
    href: "/settings/companies",
    icon: "⚙",
    tone: "bg-slate-100 text-slate-700",
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

function formatChartMetric(value: number, kind: ChartMetricKind) {
  if (kind === "percent") return formatPercent(value);
  return formatCurrency(value);
}

function formatCompactMoney(value: number) {
  const absoluteValue = Math.abs(value);

  if (absoluteValue >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(".", ",")} млн ₽`;
  }

  if (absoluteValue >= 1_000) {
    return `${Math.round(value / 1_000)} тыс ₽`;
  }

  return `${Math.round(value)} ₽`;
}

function formatAxisValue(value: number, kind: ChartMetricKind) {
  if (kind === "percent") return formatPercent(value);
  return formatCompactMoney(value);
}

function getChartDates(dateFrom: string, dateTo: string) {
  const start = parseIsoDate(dateFrom);
  const end = parseIsoDate(dateTo);
  const days = getInclusiveDays(dateFrom, dateTo);
  const visiblePoints = Math.min(Math.max(days, 1), 14);

  if (days <= visiblePoints) {
    return Array.from({ length: days }, (_, index) => addDays(start, index));
  }

  return Array.from({ length: visiblePoints }, (_, index) => {
    const ratio = visiblePoints === 1 ? 0 : index / (visiblePoints - 1);
    const offset = Math.round((days - 1) * ratio);
    return addDays(start, offset);
  }).filter((date) => date.getTime() <= end.getTime());
}

function formatChartDate(date: Date) {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return {
    dateLabel: `${day}.${month}`,
    weekDayLabel: weekDayLabels[date.getUTCDay()],
  };
}

function getChartSeries(
  total: number,
  kind: ChartMetricKind,
  weights: number[],
  pointCount: number
) {
  const usedWeights = Array.from(
    { length: pointCount },
    (_, index) => weights[index % weights.length]
  );

  if (kind === "percent") {
    const base = Math.max(0, total);
    return usedWeights.map((weight) =>
      Math.max(0, base * (0.72 + weight * 0.48))
    );
  }

  const sign = total < 0 ? -1 : 1;
  const safeTotal = Math.abs(total);
  if (safeTotal === 0) return usedWeights.map(() => 0);

  const weightSum = usedWeights.reduce((sum, weight) => sum + weight, 0);
  return usedWeights.map((weight) => sign * (safeTotal * weight) / weightSum);
}

function getSeriesHeight(value: number, max: number) {
  if (max <= 0) return 8;
  return Math.max(8, Math.round((Math.abs(value) / max) * 100));
}

function getSeriesStats(values: number[]) {
  if (values.length === 0) {
    return { min: 0, avg: 0, max: 0 };
  }

  return {
    min: Math.min(...values),
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    max: Math.max(...values),
  };
}

function getChartPreset(value: unknown) {
  return (
    chartPresets.find((preset) => preset.key === value) ?? chartPresets[0]
  );
}

function formatSignedPercent(value: number) {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(1)}%`;
}

function formatSignedPoints(value: number) {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(1)} п.п.`;
}

function getRevenuePercent(value: number, revenue: number) {
  if (revenue === 0) return null;
  return (value / revenue) * 100;
}

function formatRevenuePercent(value: number, revenue: number) {
  const percent = getRevenuePercent(value, revenue);

  if (percent === null) return "— от выручки";

  return `${formatPercent(percent)} от выручки`;
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
  chartPreset?: string;
  marketplaceCompanyName?: string | null;
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

  if (params.chartPreset) {
    searchParams.set("chartPreset", params.chartPreset);
  }

  if (params.marketplaceCompanyName) {
    searchParams.set("marketplaceCompanyName", params.marketplaceCompanyName);
  }

  return `/?${searchParams.toString()}`;
}

function buildOperationsHref(params: {
  companyName?: string | null;
  dateFrom: string;
  dateTo: string;
  operationType?: string;
  category?: string;
  search?: string;
}) {
  const searchParams = new URLSearchParams();

  searchParams.set("company", params.companyName || "ALL");
  searchParams.set("operationType", params.operationType || "ALL");
  searchParams.set("category", params.category || "ALL");
  searchParams.set("dateFrom", params.dateFrom);
  searchParams.set("dateTo", params.dateTo);
  searchParams.set("rows", "100");

  if (params.search) {
    searchParams.set("search", params.search);
  }

  return `/finance/operations?${searchParams.toString()}`;
}

function MetricCard({
  title,
  value,
  subtitle,
  icon,
  accent,
  trend,
  href,
  valueClassName = "text-slate-950",
}: {
  title: string;
  value: string;
  subtitle: string;
  icon: ReactNode;
  accent: string;
  trend?: MetricTrend;
  href: string;
  valueClassName?: string;
}) {
  return (
    <Link
      href={href}
      className="group rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/60 transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-lg hover:shadow-indigo-100/50"
    >
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

      <div className="mt-5 text-sm font-bold text-slate-600">{title}</div>

      <div
        className={`mt-3 break-words text-[26px] font-black leading-tight tracking-tight ${valueClassName}`}
      >
        {value}
      </div>

      <p className="mt-3 min-h-[42px] text-sm leading-6 text-slate-500">
        {subtitle}
      </p>

      <div className="mt-4 text-sm font-black text-indigo-600 opacity-90 transition group-hover:translate-x-1">
        Подробнее →
      </div>
    </Link>
  );
}

function MiniMetric({
  title,
  value,
  subtitle,
  tone = "text-slate-950",
}: {
  title: string;
  value: string;
  subtitle?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
      <div className="text-xs font-bold uppercase tracking-[0.08em] text-slate-500">
        {title}
      </div>
      <div className={`mt-2 break-words text-lg font-black leading-tight ${tone}`}>
        {value}
      </div>

      {subtitle ? (
        <div className="mt-2 text-xs font-semibold leading-5 text-slate-500">
          {subtitle}
        </div>
      ) : null}
    </div>
  );
}

function CompactStat({
  label,
  value,
  tone = "text-slate-950",
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-slate-400">
        {label}
      </div>
      <div className={`mt-1 text-sm font-black ${tone}`}>{value}</div>
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

function DonutHoverZone({
  label,
  value,
  percent,
  tone,
  zoneClassName,
  hoverClassName,
}: {
  label: string;
  value: number;
  percent: number;
  tone: string;
  zoneClassName: string;
  hoverClassName: string;
}) {
  return (
    <div className={`group absolute z-20 ${zoneClassName}`}>
      <div className={`h-full w-full cursor-pointer transition ${hoverClassName}`} />
      <div className="pointer-events-none absolute left-1/2 top-1/2 z-30 hidden w-44 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left shadow-xl group-hover:block">
        <div className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
          {label}
        </div>
        <div className="mt-1 text-lg font-black text-slate-950">
          {formatCurrency(value)}
        </div>
        <div className={`mt-1 text-sm font-black ${tone}`}>
          {formatPercent(percent)}
        </div>
      </div>
    </div>
  );
}

function InteractiveDonut({
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
    <div className="relative flex h-64 w-full items-center justify-center rounded-[28px] bg-slate-50 p-6 ring-1 ring-slate-200">
      <div
        className="relative flex h-52 w-52 items-center justify-center rounded-full transition duration-150 hover:scale-[1.015] hover:shadow-xl hover:shadow-indigo-100"
        style={{
          background: `conic-gradient(#7c3aed 0 ${wbPercent}%, #0ea5e9 ${wbPercent}% 100%)`,
        }}
        title={`WB: ${formatCurrency(wbRevenue)} · ${formatPercent(wbPercent)} / Ozon: ${formatCurrency(ozonRevenue)} · ${formatPercent(ozonPercent)}`}
      >
        <div className="absolute inset-[18px] z-10 rounded-full bg-white shadow-inner shadow-slate-200" />

        <DonutHoverZone
          label="Wildberries"
          value={wbRevenue}
          percent={wbPercent}
          tone="text-violet-700"
          zoneClassName="inset-x-0 top-0 h-1/2 rounded-t-full"
          hoverClassName="rounded-t-full hover:bg-violet-500/15"
        />

        <DonutHoverZone
          label="Ozon"
          value={ozonRevenue}
          percent={ozonPercent}
          tone="text-sky-700"
          zoneClassName="inset-x-0 bottom-0 h-1/2 rounded-b-full"
          hoverClassName="rounded-b-full hover:bg-sky-500/15"
        />

        <div className="pointer-events-none relative z-30 flex h-28 w-28 flex-col items-center justify-center rounded-full bg-white text-center shadow-sm ring-1 ring-slate-100">
          <div className="text-xs font-bold text-slate-400">Выручка всего</div>
          <div className="mt-1 text-xl font-black text-slate-950">
            {formatCurrency(total)}
          </div>
        </div>
      </div>
    </div>
  );
}

function ChartPresetLink({
  preset,
  selectedPreset,
  href,
}: {
  preset: ChartPresetConfig;
  selectedPreset: ChartPresetConfig;
  href: string;
}) {
  const isActive = preset.key === selectedPreset.key;

  return (
    <Link
      href={href}
      className={`rounded-2xl border px-3 py-2 text-xs font-black transition active:scale-[0.99] ${
        isActive
          ? "border-indigo-600 bg-indigo-600 text-white shadow-sm shadow-indigo-100"
          : "border-slate-200 bg-white text-slate-500 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"
      }`}
    >
      {preset.primary.label} + {preset.secondary.label}
    </Link>
  );
}

function InteractiveTrendChart({
  preset,
  primaryTotal,
  secondaryTotal,
  dateFrom,
  dateTo,
}: {
  preset: ChartPresetConfig;
  primaryTotal: number;
  secondaryTotal: number;
  dateFrom: string;
  dateTo: string;
}) {
  const chartDates = getChartDates(dateFrom, dateTo);
  const primarySeries = getChartSeries(
    primaryTotal,
    preset.primary.kind,
    trendWeights,
    chartDates.length
  );
  const secondarySeries = getChartSeries(
    secondaryTotal,
    preset.secondary.kind,
    lineWeights,
    chartDates.length
  );
  const maxPrimary = Math.max(...primarySeries.map(Math.abs), 0);
  const maxSecondary = Math.max(...secondarySeries.map(Math.abs), 0);
  const primaryStats = getSeriesStats(primarySeries);
  const secondaryStats = getSeriesStats(secondarySeries);
  const chartWidth = 520;
  const chartHeight = 210;
  const plotLeft = 54;
  const plotRight = 44;
  const plotTop = 22;
  const plotBottom = 44;
  const plotWidth = chartWidth - plotLeft - plotRight;
  const plotHeight = chartHeight - plotTop - plotBottom;
  const pointGap = chartDates.length > 1 ? plotWidth / (chartDates.length - 1) : 0;

  const linePoints = secondarySeries
    .map((value, index) => {
      const x = plotLeft + index * pointGap;
      const height = getSeriesHeight(value, maxSecondary);
      const y = plotTop + plotHeight - (height / 100) * plotHeight;
      return `${x},${y}`;
    })
    .join(" ");

  const gridLines = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="mt-5 rounded-3xl bg-white p-4 ring-1 ring-slate-100">
      <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          className="h-[310px] w-full overflow-visible"
          role="img"
          aria-label={`${preset.primary.label} и ${preset.secondary.label} по дням`}
        >
          {gridLines.map((line) => {
            const y = plotTop + plotHeight * line;
            const primaryValue = maxPrimary * (1 - line);
            const secondaryValue = maxSecondary * (1 - line);

            return (
              <g key={line}>
                <line
                  x1={plotLeft}
                  x2={chartWidth - plotRight}
                  y1={y}
                  y2={y}
                  stroke="#e2e8f0"
                  strokeDasharray="4 6"
                />
                <text
                  x={plotLeft - 10}
                  y={y + 4}
                  textAnchor="end"
                  className="fill-slate-400 text-[10px] font-bold"
                >
                  {formatAxisValue(primaryValue, preset.primary.kind)}
                </text>
                <text
                  x={chartWidth - plotRight + 10}
                  y={y + 4}
                  textAnchor="start"
                  className="fill-slate-400 text-[10px] font-bold"
                >
                  {formatAxisValue(secondaryValue, preset.secondary.kind)}
                </text>
              </g>
            );
          })}

          <text x={plotLeft} y={12} className="fill-slate-500 text-[10px] font-black">
            {preset.primary.label}, {preset.primary.kind === "percent" ? "%" : "₽"}
          </text>
          <text
            x={chartWidth - plotRight}
            y={12}
            textAnchor="end"
            className="fill-slate-500 text-[10px] font-black"
          >
            {preset.secondary.label}, {preset.secondary.kind === "percent" ? "%" : "₽"}
          </text>

          {primarySeries.map((value, index) => {
            const x = plotLeft + index * pointGap;
            const height = (getSeriesHeight(value, maxPrimary) / 100) * plotHeight;
            const barWidth = Math.min(28, Math.max(14, pointGap * 0.42));
            const y = plotTop + plotHeight - height;
            const { dateLabel, weekDayLabel } = formatChartDate(chartDates[index]);

            return (
              <g key={index}>
                <rect
                  x={x - barWidth / 2}
                  y={y}
                  width={barWidth}
                  height={height}
                  rx={barWidth / 2}
                  fill="url(#primaryGradient)"
                  opacity="0.92"
                />
                <text
                  x={x}
                  y={plotTop + plotHeight + 20}
                  textAnchor="middle"
                  className="fill-slate-500 text-[10px] font-black"
                >
                  {dateLabel}
                </text>
                <text
                  x={x}
                  y={plotTop + plotHeight + 36}
                  textAnchor="middle"
                  className="fill-slate-400 text-[10px] font-bold"
                >
                  {weekDayLabel}
                </text>
              </g>
            );
          })}

          <polyline
            fill="none"
            stroke={preset.secondary.strokeColor}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="4"
            points={linePoints}
          />

          {secondarySeries.map((value, index) => {
            const x = plotLeft + index * pointGap;
            const height = getSeriesHeight(value, maxSecondary);
            const y = plotTop + plotHeight - (height / 100) * plotHeight;

            return (
              <circle
                key={index}
                cx={x}
                cy={y}
                r="4.5"
                fill="white"
                stroke={preset.secondary.strokeColor}
                strokeWidth="3"
              />
            );
          })}

          <defs>
            <linearGradient id="primaryGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={preset.primary.strokeColor} />
              <stop offset="100%" stopColor="#c4b5fd" />
            </linearGradient>
          </defs>
        </svg>

        <div className="absolute inset-x-[54px] top-[22px] flex h-[210px] items-stretch">
          {primarySeries.map((value, index) => {
            const secondaryValue = secondarySeries[index] ?? 0;
            const { dateLabel, weekDayLabel } = formatChartDate(chartDates[index]);
            const tooltipPosition =
              index <= 1
                ? "left-0 translate-x-0"
                : index >= primarySeries.length - 2
                  ? "right-0 translate-x-0"
                  : "left-1/2 -translate-x-1/2";

            return (
              <div key={index} className="group relative flex-1 cursor-crosshair">
                <div className="absolute inset-y-0 left-1/2 hidden w-px bg-indigo-300 group-hover:block" />
                <div
                  className={`pointer-events-none absolute top-10 z-30 hidden w-56 rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-xl group-hover:block ${tooltipPosition}`}
                >
                  <div className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                    {dateLabel} ({weekDayLabel})
                  </div>
                  <div className={`mt-2 text-sm font-black ${preset.primary.colorClassName}`}>
                    {preset.primary.label}: {formatChartMetric(value, preset.primary.kind)}
                  </div>
                  <div className={`mt-1 text-sm font-black ${preset.secondary.colorClassName}`}>
                    {preset.secondary.label}: {formatChartMetric(secondaryValue, preset.secondary.kind)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-3 grid gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs sm:grid-cols-2">
        <div>
          <div className={`font-black ${preset.primary.colorClassName}`}>
            {preset.primary.label}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-slate-600">
            <span>Мин: {formatChartMetric(primaryStats.min, preset.primary.kind)}</span>
            <span>Сред: {formatChartMetric(primaryStats.avg, preset.primary.kind)}</span>
            <span>Макс: {formatChartMetric(primaryStats.max, preset.primary.kind)}</span>
          </div>
        </div>
        <div>
          <div className={`font-black ${preset.secondary.colorClassName}`}>
            {preset.secondary.label}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-slate-600">
            <span>Мин: {formatChartMetric(secondaryStats.min, preset.secondary.kind)}</span>
            <span>Сред: {formatChartMetric(secondaryStats.avg, preset.secondary.kind)}</span>
            <span>Макс: {formatChartMetric(secondaryStats.max, preset.secondary.kind)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function MarketplaceShare({
  wbRevenue,
  ozonRevenue,
  current,
  selectedPreset,
  period,
  companyName,
  marketplaceCompanyName,
  companies,
}: {
  wbRevenue: number;
  ozonRevenue: number;
  current: DashboardSummary;
  selectedPreset: ChartPresetConfig;
  period: PeriodOption;
  companyName: string;
  marketplaceCompanyName: string;
  companies: { name: string }[];
}) {
  const total = wbRevenue + ozonRevenue;
  const wbPercent = total > 0 ? (wbRevenue / total) * 100 : 0;
  const ozonPercent = total > 0 ? (ozonRevenue / total) * 100 : 0;

  function metricTotal(metric: ChartMetricConfig) {
    if (metric.label === "Выручка") return current.totalRevenue;
    if (metric.label === "ДРР") return current.drr ?? 0;
    if (metric.label === "Опер. прибыль") return current.operatingProfitAfterTax;
    if (metric.label === "Кредиты") return current.loanPayments;
    if (metric.label === "Чистая прибыль") return current.netProfit;
    if (metric.label === "Денежный поток") return current.cashFlowResult;
    return 0;
  }

  const primaryTotal = metricTotal(selectedPreset.primary);
  const secondaryTotal = metricTotal(selectedPreset.secondary);

  return (
    <section className="panel p-5 sm:p-6">
      <div className="grid gap-6 xl:grid-cols-[340px_1fr]">
        <div>
          <div className="section-eyebrow">Разрез по маркетплейсам</div>
          <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950">
            Доля выручки WB / Ozon
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Выбор компании синхронно меняет долю WB/Ozon и график динамики.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {[{ name: "ALL", label: "Все компании" }, ...companies.map((company) => ({ name: company.name, label: company.name }))].map((option) => {
              const isActive = option.name === marketplaceCompanyName;

              return (
                <Link
                  key={option.name}
                  href={buildDashboardHref({
                    period: period.key,
                    companyName,
                    marketplaceCompanyName: option.name,
                    dateFrom: period.key === "custom" ? period.dateFrom : undefined,
                    dateTo: period.key === "custom" ? period.dateTo : undefined,
                    chartPreset: selectedPreset.key,
                  })}
                  className={`rounded-2xl border px-3 py-2 text-xs font-black transition ${
                    isActive
                      ? "border-indigo-600 bg-indigo-600 text-white shadow-sm shadow-indigo-100"
                      : "border-slate-200 bg-white text-slate-500 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"
                  }`}
                >
                  {option.label}
                </Link>
              );
            })}
          </div>

          <div className="mt-5 space-y-4">
            <div className="group flex cursor-default items-center justify-between gap-4 rounded-2xl border border-violet-100 bg-violet-50/50 px-4 py-3 transition hover:border-violet-300 hover:bg-violet-50 hover:shadow-sm">
              <div className="flex items-center gap-3">
                <span className="h-3 w-3 rounded-full bg-violet-600" />
                <div>
                  <div className="text-sm font-bold text-violet-700">
                    Wildberries
                  </div>
                  <div className="text-lg font-black text-slate-950">
                    {formatCurrency(wbRevenue)}
                  </div>
                </div>
              </div>
              <div className="text-lg font-black text-violet-700">
                {formatPercent(wbPercent)}
              </div>
            </div>

            <div className="group flex cursor-default items-center justify-between gap-4 rounded-2xl border border-sky-100 bg-sky-50/60 px-4 py-3 transition hover:border-sky-300 hover:bg-sky-50 hover:shadow-sm">
              <div className="flex items-center gap-3">
                <span className="h-3 w-3 rounded-full bg-sky-500" />
                <div>
                  <div className="text-sm font-bold text-sky-700">Ozon</div>
                  <div className="text-lg font-black text-slate-950">
                    {formatCurrency(ozonRevenue)}
                  </div>
                </div>
              </div>
              <div className="text-lg font-black text-sky-700">
                {formatPercent(ozonPercent)}
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
          <InteractiveDonut wbRevenue={wbRevenue} ozonRevenue={ozonRevenue} />

          <div className="rounded-[28px] bg-slate-50 p-5 ring-1 ring-slate-200">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <div className="section-eyebrow">Динамика</div>
                <h3 className="mt-2 text-xl font-black text-slate-950">
                  {selectedPreset.title}
                </h3>
                <p className="mt-1 text-sm leading-5 text-slate-500">
                  {selectedPreset.description}
                </p>
                <div className="mt-3 flex flex-wrap gap-3 text-xs font-bold">
                  <span className={`inline-flex items-center gap-2 ${selectedPreset.primary.colorClassName}`}>
                    <span className={`h-2.5 w-2.5 rounded-full ${selectedPreset.primary.dotClassName}`} />
                    {selectedPreset.primary.label}
                  </span>
                  <span className={`inline-flex items-center gap-2 ${selectedPreset.secondary.colorClassName}`}>
                    <span className={`h-2.5 w-2.5 rounded-full ${selectedPreset.secondary.dotClassName}`} />
                    {selectedPreset.secondary.label}
                  </span>
                </div>
              </div>
              <Link
                href="/analytics"
                className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-indigo-600 transition hover:bg-indigo-50"
              >
                Открыть →
              </Link>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {chartPresets.map((preset) => (
                <ChartPresetLink
                  key={preset.key}
                  preset={preset}
                  selectedPreset={selectedPreset}
                  href={buildDashboardHref({
                    period: period.key,
                    companyName,
                    marketplaceCompanyName,
                    dateFrom: period.key === "custom" ? period.dateFrom : undefined,
                    dateTo: period.key === "custom" ? period.dateTo : undefined,
                    chartPreset: preset.key,
                  })}
                />
              ))}
            </div>

            <InteractiveTrendChart
              preset={selectedPreset}
              primaryTotal={primaryTotal}
              secondaryTotal={secondaryTotal}
              dateFrom={period.dateFrom}
              dateTo={period.dateTo}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function CompanyDetailColumn({
  title,
  href,
  children,
}: {
  title: string;
  href: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-indigo-200 hover:bg-indigo-50/30"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-black text-slate-950">{title}</div>
        <div className="text-sm font-black text-slate-300 transition group-hover:translate-x-1 group-hover:text-indigo-500">
          →
        </div>
      </div>

      <div className="mt-3 space-y-2">{children}</div>

      <div className="mt-3 text-xs font-black text-indigo-600">
        Открыть →
      </div>
    </Link>
  );
}

function CompanyCard({
  row,
  dateFrom,
  dateTo,
}: {
  row: CompanyDashboardRow;
  dateFrom: string;
  dateTo: string;
}) {
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

  const totalAbc = abcTotal(rowWbAbc) + abcTotal(rowOzonAbc);
  const drrText = row.drr !== null ? formatPercent(row.drr) : "—";

  return (
    <article className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm shadow-slate-200/60">
      <div className="border-b border-slate-100 bg-gradient-to-br from-white to-slate-50 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xl font-black tracking-tight text-slate-950">
                {row.companyName}
              </h3>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-black text-slate-500 ring-1 ring-slate-200">
                WB / Ozon
              </span>
            </div>
          </div>

          <div
            className={`w-fit rounded-full px-4 py-2 text-sm font-black ring-1 ${valueTone(
              row.profitAfterOwnerWithdrawal
            )}`}
          >
            После вывода: {formatCurrency(row.profitAfterOwnerWithdrawal)}
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
          <MiniMetric
            title="Выручка"
            value={formatCurrency(row.totalRevenue)}
            subtitle="100%"
          />
          <MiniMetric
            title="Опер. прибыль"
            value={formatCurrency(row.operatingProfitAfterTax)}
            subtitle={formatRevenuePercent(row.operatingProfitAfterTax, row.totalRevenue)}
            tone={valueColor(row.operatingProfitAfterTax)}
          />
          <MiniMetric
            title="Чистая прибыль"
            value={formatCurrency(row.netProfit)}
            subtitle={formatRevenuePercent(row.netProfit, row.totalRevenue)}
            tone={valueColor(row.netProfit)}
          />
          <MiniMetric
            title="Ден. поток"
            value={formatCurrency(row.cashFlowResult)}
            subtitle={formatRevenuePercent(row.cashFlowResult, row.totalRevenue)}
            tone={valueColor(row.cashFlowResult)}
          />
        </div>
      </div>

      <div className="p-5">
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
          <CompanyDetailColumn title="Каналы" href="/analytics">
            <CompactStat
              label="WB"
              value={`${formatCurrency(row.wbRevenue)} (${formatPercent(getRevenuePercent(row.wbRevenue, row.totalRevenue) ?? 0)})`}
            />
            <CompactStat
              label="Ozon"
              value={`${formatCurrency(row.ozonRevenue)} (${formatPercent(getRevenuePercent(row.ozonRevenue, row.totalRevenue) ?? 0)})`}
            />
          </CompanyDetailColumn>

          <CompanyDetailColumn title="Реклама" href="/ads-mapping">
            <CompactStat
              label="Расходы"
              value={formatCurrency(row.adsCost)}
              tone={row.adsCost > 0 ? "text-red-600" : "text-slate-950"}
            />
            <CompactStat
              label="ДРР"
              value={drrText}
              tone={row.drr !== null && row.drr > 12 ? "text-red-600" : "text-slate-950"}
            />
          </CompanyDetailColumn>

          <CompanyDetailColumn
            title="Кредиты и деньги"
            href={buildOperationsHref({
              companyName: row.companyName,
              dateFrom,
              dateTo,
              operationType: "ALL",
              search: "кредит",
            })}
          >
            <CompactStat label="Кредиты" value={formatCurrency(row.loanPayments)} tone={row.loanPayments > 0 ? "text-red-600" : "text-slate-950"} />
            <CompactStat label="Тело" value={formatCurrency(row.creditPrincipal)} tone={row.creditPrincipal > 0 ? "text-red-600" : "text-slate-950"} />
            <CompactStat label="Проценты" value={formatCurrency(row.creditInterest)} tone={row.creditInterest > 0 ? "text-red-600" : "text-slate-950"} />
          </CompanyDetailColumn>

          <CompanyDetailColumn title="Ассортимент (ABC)" href="/abc">
            <CompactStat label="ABC всего" value={`${formatNumber(totalAbc)} SKU`} />
            <CompactStat label="WB" value={`${formatNumber(abcTotal(rowWbAbc))} SKU`} />
            <CompactStat label="Ozon" value={`${formatNumber(abcTotal(rowOzonAbc))} SKU`} />
          </CompanyDetailColumn>
        </div>

        <div className="mt-5 grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2">
          <div>
            <div className="mb-3 text-sm font-black text-slate-700">ABC WB</div>
            <AbcPills abc={rowWbAbc} />
          </div>
          <div>
            <div className="mb-3 text-sm font-black text-slate-700">ABC Ozon</div>
            <AbcPills abc={rowOzonAbc} />
          </div>
        </div>
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

  const [allCurrentRows, allPreviousRows] = await Promise.all([
    buildCompanyDashboardRows({
      companies,
      dateFrom: selectedPeriod.dateFrom,
      dateTo: selectedPeriod.dateTo,
    }),
    buildCompanyDashboardRows({
      companies,
      dateFrom: previousPeriod.dateFrom,
      dateTo: previousPeriod.dateTo,
    }),
  ]);

  const currentRows = selectedCompanyName
    ? allCurrentRows.filter((row) => row.companyName === selectedCompanyName)
    : allCurrentRows;

  const previousRows = selectedCompanyName
    ? allPreviousRows.filter((row) => row.companyName === selectedCompanyName)
    : allPreviousRows;

  const current = summarizeDashboardRows(currentRows);
  const previous = summarizeDashboardRows(previousRows);

  const selectedCompanyValue = params.companyName ?? "ALL";
  const rawMarketplaceCompanyValue =
    params.marketplaceCompanyName ?? selectedCompanyValue ?? "ALL";
  const selectedMarketplaceCompanyValue = companies.some(
    (company) => company.name === rawMarketplaceCompanyValue
  )
    ? rawMarketplaceCompanyValue
    : "ALL";
  const marketplaceCurrent = summarizeDashboardRows(
    selectedMarketplaceCompanyValue === "ALL"
      ? allCurrentRows
      : allCurrentRows.filter(
          (row) => row.companyName === selectedMarketplaceCompanyValue
        )
  );
  const selectedChartPreset = getChartPreset(params.chartPreset);
  const presetPeriods = periodOptions.filter((period) => period.key !== "custom");

  const attentionItems = [
    {
      level: current.cashFlowResult < 0 ? "danger" : "ok",
      title: "Денежный поток",
      text:
        current.cashFlowResult < 0
          ? `Отрицательный ДДС за период: ${formatCurrency(current.cashFlowResult)}.`
          : `Денежный поток положительный: ${formatCurrency(current.cashFlowResult)}.`,
      href: "/finance/cashflow",
      icon: "↓",
    },
    {
      level: current.drr !== null && current.drr > 12 ? "warning" : "ok",
      title: "Реклама",
      text:
        current.drr !== null && current.drr > 12
          ? `ДРР ${formatPercent(current.drr)}. Нужно проверить кампании.`
          : `ДРР ${current.drr !== null ? formatPercent(current.drr) : "—"}.`,
      href: "/ads-mapping",
      icon: "↗",
    },
    {
      level: current.netProfit < 0 ? "danger" : "ok",
      title: "Чистая прибыль",
      text:
        current.netProfit < 0
          ? `Чистая прибыль отрицательная: ${formatCurrency(current.netProfit)}.`
          : `Чистая прибыль: ${formatCurrency(current.netProfit)}.`,
      href: "/finance/operations",
      icon: "₽",
    },
    {
      level: current.loanPayments > 0 ? "warning" : "ok",
      title: "Кредиты",
      text:
        current.loanPayments > 0
          ? `Платежи по кредитам: ${formatCurrency(current.loanPayments)}.`
          : "В выбранном периоде платежей по кредитам не найдено.",
      href: "/finance/loans",
      icon: "⌁",
    },
  ];

  return (
    <main className="page-shell">
      <div className="page-container">
        <section className="sticky top-0 z-40 -mx-4 border-b border-slate-200 bg-background/90 px-4 py-2.5 backdrop-blur-xl sm:-mx-6 sm:px-6 xl:-mx-8 xl:px-8">
          <details open className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-1 py-1 transition hover:bg-slate-50/70">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="rounded-2xl bg-indigo-600 px-3 py-2 text-xs font-black text-white shadow-sm shadow-indigo-200">
                  Дашборд собственника
                </span>

                <span className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm">
                  Период: {selectedPeriod.description}
                </span>

                <span className="hidden rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm md:inline-flex">
                  Сравнение: {previousPeriod.description}
                </span>

                <span className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm">
                  {selectedCompanyName ?? "Все компании"}
                </span>
              </div>

              <span className="shrink-0 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-600 shadow-sm transition hover:bg-slate-50">
                <span className="hidden group-open:inline">Скрыть панель ↑</span>
                <span className="group-open:hidden">Показать панель ↓</span>
              </span>
            </summary>

            <div className="mt-2 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div className="hidden min-w-0 text-sm leading-6 text-slate-500 lg:block">
                Главные показатели бизнеса за выбранный период. Фильтры можно скрыть, чтобы освободить экран.
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-center xl:shrink-0">
                <details className="group/filter relative">
                  <summary className="secondary-button cursor-pointer list-none gap-2 py-2.5">
                    Фильтры и период
                    <span className="text-slate-400 transition group-open/filter:rotate-180">↓</span>
                  </summary>

                  <div className="mt-3 max-h-[75vh] w-full overflow-y-auto rounded-[28px] border border-slate-200 bg-white p-4 shadow-2xl xl:absolute xl:right-0 xl:top-full xl:z-50 xl:w-[760px]">
                    <div className="grid gap-2 sm:grid-cols-3">
                      {presetPeriods.map((period) => {
                        const isActive = selectedPeriodOption.key === period.key;

                        return (
                          <Link
                            key={period.key}
                            href={buildDashboardHref({
                              period: period.key,
                              companyName: selectedCompanyValue,
                              marketplaceCompanyName: selectedMarketplaceCompanyValue,
                              chartPreset: selectedChartPreset.key,
                            })}
                            className={`rounded-2xl border p-3 transition active:scale-[0.99] ${
                              isActive
                                ? "border-indigo-600 bg-indigo-600 text-white"
                                : "border-slate-200 bg-slate-50 text-slate-800 hover:bg-white"
                            }`}
                          >
                            <div className="text-sm font-black">{period.shortLabel}</div>
                            <div
                              className={`mt-1 text-xs leading-5 ${
                                isActive ? "text-indigo-100" : "text-slate-500"
                              }`}
                            >
                              {period.description}
                            </div>
                          </Link>
                        );
                      })}
                    </div>

                    <form action="/" className="mt-4 rounded-3xl bg-slate-50 p-4 ring-1 ring-slate-200">
                      <input type="hidden" name="chartPreset" value={selectedChartPreset.key} />
                      <input type="hidden" name="marketplaceCompanyName" value={selectedMarketplaceCompanyValue} />
                      <div className="grid gap-3 lg:grid-cols-[1fr_1fr_1fr]">
                        <label className="text-sm font-medium text-slate-500">
                          Компания
                          <select name="companyName" defaultValue={selectedCompanyValue} className="filter-control mt-1">
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
                          <input type="date" name="dateFrom" defaultValue={selectedPeriod.dateFrom} className="filter-control mt-1" />
                        </label>

                        <label className="text-sm font-medium text-slate-500">
                          Дата до
                          <input type="date" name="dateTo" defaultValue={selectedPeriod.dateTo} className="filter-control mt-1" />
                        </label>
                      </div>

                      <div className="mt-4 flex flex-wrap gap-3">
                        <button type="submit" name="period" value="custom" className="primary-button">
                          Показать выбранные даты
                        </button>

                        <Link href="/" className="secondary-button">
                          Сбросить
                        </Link>
                      </div>
                    </form>
                  </div>
                </details>

                <Link href="/import" className="primary-button gap-2 py-2.5">
                  ⇧ Импорт данных
                </Link>
              </div>
            </div>
          </details>
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          <MetricCard
            title="Выручка всего"
            value={current.totalRevenue > 0 ? formatCurrency(current.totalRevenue) : "Нет данных"}
            subtitle={`WB: ${formatCurrency(current.wbRevenue)} · Ozon: ${formatCurrency(current.ozonRevenue)}`}
            icon="▣"
            accent="bg-indigo-50 text-indigo-700"
            href="/analytics"
            trend={buildMoneyTrend({ current: current.totalRevenue, previous: previous.totalRevenue, goodWhen: "up" })}
          />

          <MetricCard
            title="Операционная прибыль"
            value={formatCurrency(current.operatingProfitAfterTax)}
            subtitle={`После себестоимости, рекламы, логистики и налогов · ${formatRevenuePercent(current.operatingProfitAfterTax, current.totalRevenue)}`}
            icon="↗"
            accent="bg-emerald-50 text-emerald-700"
            valueClassName={valueColor(current.operatingProfitAfterTax)}
            href="/analytics"
            trend={buildMoneyTrend({ current: current.operatingProfitAfterTax, previous: previous.operatingProfitAfterTax, goodWhen: "up" })}
          />

          <MetricCard
            title="Чистая прибыль"
            value={formatCurrency(current.netProfit)}
            subtitle={`Опер. прибыль ± финансовые статьи · ${formatRevenuePercent(current.netProfit, current.totalRevenue)}`}
            icon="₽"
            accent="bg-red-50 text-red-700"
            valueClassName={valueColor(current.netProfit)}
            href={buildOperationsHref({ dateFrom: selectedPeriod.dateFrom, dateTo: selectedPeriod.dateTo })}
            trend={buildMoneyTrend({ current: current.netProfit, previous: previous.netProfit, goodWhen: "up" })}
          />

          <MetricCard
            title="После вывода собственника"
            value={formatCurrency(current.profitAfterOwnerWithdrawal)}
            subtitle={`Чистая прибыль минус личные расходы: ${formatCurrency(current.personalExpenses)} · ${formatRevenuePercent(current.profitAfterOwnerWithdrawal, current.totalRevenue)}`}
            icon="●"
            accent="bg-blue-50 text-blue-700"
            valueClassName={valueColor(current.profitAfterOwnerWithdrawal)}
            href={buildOperationsHref({ dateFrom: selectedPeriod.dateFrom, dateTo: selectedPeriod.dateTo, operationType: "PERSONAL" })}
            trend={buildMoneyTrend({ current: current.profitAfterOwnerWithdrawal, previous: previous.profitAfterOwnerWithdrawal, goodWhen: "up" })}
          />

          <MetricCard
            title="Денежный поток"
            value={formatCurrency(current.cashFlowResult)}
            subtitle={`ДДС: поступления минус фактические выплаты · ${formatRevenuePercent(current.cashFlowResult, current.totalRevenue)}`}
            icon="⇄"
            accent="bg-cyan-50 text-cyan-700"
            valueClassName={valueColor(current.cashFlowResult)}
            href="/finance/cashflow"
            trend={buildMoneyTrend({ current: current.cashFlowResult, previous: previous.cashFlowResult, goodWhen: "up" })}
          />

          <MetricCard
            title="Реклама / ДРР"
            value={current.drr !== null ? formatPercent(current.drr) : "Нет данных"}
            subtitle={`Реклама всего: ${formatCurrency(current.adsCost)} · ${formatRevenuePercent(current.adsCost, current.totalRevenue)}`}
            icon="↗"
            accent="bg-orange-50 text-orange-700"
            valueClassName={current.drr !== null && current.drr > 12 ? "text-red-600" : "text-slate-950"}
            href="/ads-mapping"
            trend={buildPercentTrend({ current: current.drr, previous: previous.drr, goodWhen: "down" })}
          />
        </section>

        <section className="grid gap-5 2xl:grid-cols-[1fr_420px]">
          <MarketplaceShare
            wbRevenue={marketplaceCurrent.wbRevenue}
            ozonRevenue={marketplaceCurrent.ozonRevenue}
            current={marketplaceCurrent}
            selectedPreset={selectedChartPreset}
            period={selectedPeriod}
            companyName={selectedCompanyValue}
            marketplaceCompanyName={selectedMarketplaceCompanyValue}
            companies={companies}
          />

          <section className="panel p-5 sm:p-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="section-eyebrow">Инсайты</div>
                <h2 className="mt-2 text-xl font-black text-slate-950">
                  Что требует внимания
                </h2>
              </div>
              <span className="rounded-full bg-red-50 px-3 py-1 text-xs font-black text-red-600 ring-1 ring-red-100">
                {attentionItems.filter((item) => item.level !== "ok").length}
              </span>
            </div>

            <div className="mt-5 space-y-3">
              {attentionItems.map((item) => (
                <Link
                  key={item.title}
                  href={item.href}
                  className="group flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-indigo-200 hover:bg-indigo-50/30"
                >
                  <div
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-sm font-black ${
                      item.level === "danger"
                        ? "bg-red-50 text-red-600"
                        : item.level === "warning"
                          ? "bg-amber-50 text-amber-600"
                          : "bg-emerald-50 text-emerald-600"
                    }`}
                  >
                    {item.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-black text-slate-950">{item.title}</div>
                    <p className="mt-1 text-sm leading-5 text-slate-500">{item.text}</p>
                  </div>
                  <div className="text-lg font-black text-slate-300 transition group-hover:translate-x-1 group-hover:text-indigo-500">
                    →
                  </div>
                </Link>
              ))}
            </div>
          </section>
        </section>

        <section className="panel p-5 sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="section-eyebrow">Компании</div>
              <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950">
                Разрез по компаниям
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
                Главное по каждой компании без перегруза: выручка, прибыль, ДДС, реклама, кредиты и ассортимент.
              </p>
            </div>

            <Link href="/settings/companies" className="secondary-button">
              Настройки компаний
            </Link>
          </div>

          {current.companyRows.length > 0 ? (
            <div className="mt-6 grid gap-5 xl:grid-cols-2">
              {current.companyRows.map((row) => (
                <CompanyCard
                  key={row.companyName}
                  row={row}
                  dateFrom={selectedPeriod.dateFrom}
                  dateTo={selectedPeriod.dateTo}
                />
              ))}
            </div>
          ) : (
            <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-8 text-center text-slate-500">
              Нет компаний с показателями за выбранный период.
            </div>
          )}
        </section>

        <section className="panel p-5 sm:p-6">
          <div>
            <div className="section-eyebrow">Навигация</div>
            <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-950">
              Быстрые действия
            </h2>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {quickActions.map((item) => (
              <Link
                key={item.href + item.title}
                href={item.href}
                className="group flex items-center gap-4 rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-indigo-200 hover:bg-indigo-50/30"
              >
                <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-base font-black ${item.tone}`}>
                  {item.icon}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="font-black text-slate-950">{item.title}</div>
                  <p className="mt-1 text-sm leading-5 text-slate-500">{item.description}</p>
                </div>

                <div className="text-lg font-black text-slate-300 transition group-hover:translate-x-1 group-hover:text-indigo-500">
                  →
                </div>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
