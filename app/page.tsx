import Link from "next/link";
import type { ReactNode } from "react";

import { prisma } from "@/lib/prisma";
import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import {
  getDashboardDailyAnalytics,
  type DashboardDailyPoint,
} from "@/lib/analytics/dashboardDailyAnalytics";
import { calculateFinanceMetricsForRows } from "@/lib/finance/financeMetrics";

type Props = {
  searchParams?: Promise<{
    period?: string;
    companyName?: string;
    dateFrom?: string;
    dateTo?: string;
    chartPreset?: string;
    marketplaceCompanyName?: string;
    debug?: string;
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
  warehouseStockQty: number;
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
  warehouseStockQty: number;
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

const weekDayLabels = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

const quickActions = [
  {
    title: "Сравнить периоды",
    description: "Динамика и тренды",
    href: "/analytics",
    icon: "↔",
    tone: "bg-violet-50 text-violet-700",
  },
  {
    title: "План / Факт",
    description: "Планирование прибыли",
    href: "/finance/plan-fact",
    icon: "◉",
    tone: "bg-fuchsia-50 text-fuchsia-700",
  },
  {
    title: "Отчёт по рекламе",
    description: "Эффективность кампаний",
    href: "/ads-mapping",
    icon: "▸",
    tone: "bg-emerald-50 text-emerald-700",
  },
  {
    title: "ABC-анализ",
    description: "Ассортимент и оборачиваемость",
    href: "/abc",
    icon: "▥",
    tone: "bg-blue-50 text-blue-700",
  },
  {
    title: "Склады и остатки",
    description: "Движение и остатки",
    href: "/stocks",
    icon: "▣",
    tone: "bg-amber-50 text-amber-700",
  },
  {
    title: "Экспорт данных",
    description: "В Excel / CSV",
    href: "/import",
    icon: "⇩",
    tone: "bg-indigo-50 text-indigo-700",
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

function compactDailyPairs(
  currentPoints: DashboardDailyPoint[],
  previousPoints: DashboardDailyPoint[],
  maxPoints = 14
): Array<{ current: DashboardDailyPoint; previous: DashboardDailyPoint | null }> {
  const result: Array<{ current: DashboardDailyPoint; previous: DashboardDailyPoint | null }> = [];

  if (currentPoints.length === 0) return result;

  if (currentPoints.length <= maxPoints) {
    currentPoints.forEach((current, index) => {
      result.push({
        current,
        previous: previousPoints[index] ?? previousPoints[previousPoints.length - 1] ?? null,
      });
    });

    return result;
  }

  const lastIndex = currentPoints.length - 1;

  Array.from({ length: maxPoints }, (_, index) => {
    const ratio = maxPoints === 1 ? 0 : index / (maxPoints - 1);
    const sourceIndex = Math.round(lastIndex * ratio);
    const current = currentPoints[sourceIndex];

    if (!current) return;

    result.push({
      current,
      previous: previousPoints[sourceIndex] ?? previousPoints[previousPoints.length - 1] ?? null,
    });
  });

  return result;
}

function metricValueFromDailyPoint(
  point: DashboardDailyPoint | null | undefined,
  metric: ChartMetricConfig
) {
  if (!point) return 0;

  if (metric.label === "Выручка") return point.revenue;
  if (metric.label === "ДРР") return point.drr ?? 0;
  if (metric.label === "Опер. прибыль") return point.operatingProfitAfterTax;
  if (metric.label === "Кредиты") return point.loanPayments;
  if (metric.label === "Чистая прибыль") return point.netProfit;
  if (metric.label === "Денежный поток") return point.cashFlowResult;

  return 0;
}

function sumDailyValue(
  points: DashboardDailyPoint[],
  selector: (point: DashboardDailyPoint) => number
) {
  return points.reduce((sum, point) => sum + selector(point), 0);
}

function metricTotalFromDailyPoints(
  points: DashboardDailyPoint[],
  metric: ChartMetricConfig
) {
  if (metric.label === "Выручка") return sumDailyValue(points, (point) => point.revenue);
  if (metric.label === "ДРР") {
    const revenue = sumDailyValue(points, (point) => point.revenue);
    const adsCost = sumDailyValue(points, (point) => point.adsCost);
    return revenue > 0 ? (adsCost / revenue) * 100 : 0;
  }
  if (metric.label === "Опер. прибыль") {
    return sumDailyValue(points, (point) => point.operatingProfitAfterTax);
  }
  if (metric.label === "Кредиты") return sumDailyValue(points, (point) => point.loanPayments);
  if (metric.label === "Чистая прибыль") return sumDailyValue(points, (point) => point.netProfit);
  if (metric.label === "Денежный поток") return sumDailyValue(points, (point) => point.cashFlowResult);

  return 0;
}

function averageMetricFromDailyPoints(
  points: DashboardDailyPoint[],
  metric: ChartMetricConfig
) {
  if (points.length === 0) return 0;
  if (metric.label === "ДРР") return metricTotalFromDailyPoints(points, metric);

  return metricTotalFromDailyPoints(points, metric) / points.length;
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

function formatSignedCurrency(value: number) {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${formatCurrency(value)}`;
}

function isNearlySameMoney(periodValue: number, dailyValue: number) {
  const diff = Math.abs(dailyValue - periodValue);
  const base = Math.max(Math.abs(periodValue), Math.abs(dailyValue), 1);
  return diff <= 1 || diff / base <= 0.005;
}

function isNearlySamePercent(periodValue: number | null, dailyValue: number | null) {
  if (periodValue === null && dailyValue === null) return true;
  if (periodValue === null || dailyValue === null) return false;
  return Math.abs(dailyValue - periodValue) <= 0.1;
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

function calculateCompanyDelta(current: number, previous?: number | null) {
  const previousValue = previous ?? 0;

  if (previousValue === 0) {
    if (current === 0) return { label: "0.0%", className: "text-slate-400" };
    return { label: "новый показатель", className: "text-indigo-600" };
  }

  const delta = ((current - previousValue) / Math.abs(previousValue)) * 100;

  return {
    label: formatSignedPercent(delta),
    className: delta >= 0 ? "text-emerald-600" : "text-red-600",
  };
}

function CompanyKpiMeta({
  revenuePercent,
  current,
  previous,
}: {
  revenuePercent?: string | null;
  current: number;
  previous?: number | null;
}) {
  const delta = calculateCompanyDelta(current, previous);

  return (
    <div className="mt-1 space-y-0.5 text-[11px] font-bold leading-4">
      {revenuePercent ? <div className="text-slate-500">{revenuePercent}</div> : null}
      <div className={delta.className}>{delta.label} к сравнению</div>
    </div>
  );
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
    row.warehouseStockQty !== 0 ||
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
  debug?: boolean;
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

  if (params.debug) {
    searchParams.set("debug", "1");
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
  compact = false,
}: {
  wbRevenue: number;
  ozonRevenue: number;
  compact?: boolean;
}) {
  const total = wbRevenue + ozonRevenue;
  const wbPercent = total > 0 ? (wbRevenue / total) * 100 : 0;
  const ozonPercent = total > 0 ? (ozonRevenue / total) * 100 : 0;

  return (
    <div className="relative flex h-40 w-full items-center justify-center rounded-[24px] bg-slate-50 p-4 ring-1 ring-slate-200 sm:h-44">
      <div
        className="relative flex h-32 w-32 items-center justify-center rounded-full transition duration-150 hover:scale-[1.03] hover:shadow-xl hover:shadow-indigo-100 sm:h-36 sm:w-36"
        style={{
          background: `conic-gradient(#7c3aed 0 ${wbPercent}%, #0ea5e9 ${wbPercent}% 100%)`,
        }}
        title={`WB: ${formatCurrency(wbRevenue)} · ${formatPercent(wbPercent)} / Ozon: ${formatCurrency(ozonRevenue)} · ${formatPercent(ozonPercent)}`}
      >
        <div className="absolute inset-[14px] z-10 rounded-full bg-white shadow-inner shadow-slate-200" />

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

        <div className="pointer-events-none relative z-30 flex h-20 w-20 flex-col items-center justify-center rounded-full bg-white text-center shadow-sm ring-1 ring-slate-100 sm:h-24 sm:w-24">
          <div className="text-[10px] font-bold text-slate-400 sm:text-xs">Выручка всего</div>
          <div className="mt-1 text-sm font-black text-slate-950 sm:text-base">
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
      className={`rounded-2xl border px-3 py-1.5 text-xs font-black transition active:scale-[0.99] ${
        isActive
          ? "border-indigo-600 bg-indigo-600 text-white shadow-sm shadow-indigo-100"
          : "border-slate-200 bg-white text-slate-500 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"
      }`}
    >
      {preset.primary.label} + {preset.secondary.label}
    </Link>
  );
}

function InsightValue({
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
      <div className="text-[11px] font-bold text-slate-400">{label}</div>
      <div className={`mt-1 text-sm font-black ${tone}`}>{value}</div>
    </div>
  );
}

function percentDelta(currentValue: number, previousValue: number) {
  if (previousValue === 0) return null;
  return ((currentValue - previousValue) / Math.abs(previousValue)) * 100;
}

function formatDelta(value: number | null, kind: ChartMetricKind) {
  if (value === null) return "—";
  if (kind === "percent") return formatSignedPoints(value);
  return formatSignedPercent(value);
}

function formatSecondaryInsight(params: {
  preset: ChartPresetConfig;
  primaryValue: number;
  secondaryValue: number;
}) {
  const { preset, primaryValue, secondaryValue } = params;

  if (preset.secondary.label === "ДРР") {
    const adsCost = primaryValue * (secondaryValue / 100);
    return `${formatCurrency(adsCost)} / ${formatPercent(secondaryValue)}`;
  }

  if (preset.primary.label === "Выручка" && preset.secondary.kind === "money") {
    const share = primaryValue !== 0 ? (secondaryValue / primaryValue) * 100 : 0;
    return `${formatCurrency(secondaryValue)} / ${formatPercent(share)}`;
  }

  return formatChartMetric(secondaryValue, preset.secondary.kind);
}

function InteractiveTrendChart({
  preset,
  currentPoints,
  previousPoints,
}: {
  preset: ChartPresetConfig;
  currentPoints: DashboardDailyPoint[];
  previousPoints: DashboardDailyPoint[];
}) {
  const dailyPairs = compactDailyPairs(currentPoints, previousPoints);
  const primarySeries = dailyPairs.map((pair) =>
    metricValueFromDailyPoint(pair.current, preset.primary)
  );
  const secondarySeries = dailyPairs.map((pair) =>
    metricValueFromDailyPoint(pair.current, preset.secondary)
  );
  const previousPrimarySeries = dailyPairs.map((pair) =>
    metricValueFromDailyPoint(pair.previous, preset.primary)
  );
  const previousSecondarySeries = dailyPairs.map((pair) =>
    metricValueFromDailyPoint(pair.previous, preset.secondary)
  );
  const maxPrimary = Math.max(
    ...primarySeries.map(Math.abs),
    ...previousPrimarySeries.map(Math.abs),
    0
  );
  const maxSecondary = Math.max(
    ...secondarySeries.map(Math.abs),
    ...previousSecondarySeries.map(Math.abs),
    0
  );
  const chartWidth = 760;
  const chartHeight = 176;
  const plotLeft = 58;
  const plotRight = 54;
  const plotTop = 18;
  const plotBottom = 36;
  const plotWidth = chartWidth - plotLeft - plotRight;
  const plotHeight = chartHeight - plotTop - plotBottom;
  const pointGap = dailyPairs.length > 1 ? plotWidth / (dailyPairs.length - 1) : 0;

  const linePoints = secondarySeries
    .map((value, index) => {
      const x = plotLeft + index * pointGap;
      const height = getSeriesHeight(value, maxSecondary);
      const y = plotTop + plotHeight - (height / 100) * plotHeight;
      return `${x},${y}`;
    })
    .join(" ");

  const previousLinePoints = previousSecondarySeries
    .map((value, index) => {
      const x = plotLeft + index * pointGap;
      const height = getSeriesHeight(value, maxSecondary);
      const y = plotTop + plotHeight - (height / 100) * plotHeight;
      return `${x},${y}`;
    })
    .join(" ");

  const gridLines = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="mt-4 rounded-[24px] bg-white p-3 ring-1 ring-slate-100">
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs font-bold text-slate-500">
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-sm bg-violet-600" />
          {preset.primary.label}
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-sm border border-violet-300 bg-violet-100" />
          Сравнение
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-orange-500" />
          {preset.secondary.label}
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="h-px w-5 border-t border-dashed border-orange-300" />
          Сравнение
        </span>
      </div>

      <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          className="h-[240px] w-full overflow-visible"
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
            const previousHeight =
              (getSeriesHeight(previousPrimarySeries[index] ?? 0, maxPrimary) / 100) *
              plotHeight;
            const barWidth = Math.min(28, Math.max(14, pointGap * 0.34));
            const previousBarWidth = barWidth;
            const y = plotTop + plotHeight - height;
            const previousY = plotTop + plotHeight - previousHeight;
            const { dateLabel, weekDayLabel } = formatChartDate(parseIsoDate(dailyPairs[index].current.date));

            return (
              <g key={dailyPairs[index].current.date}>
                <rect
                  x={x - previousBarWidth / 2 + barWidth * 0.45}
                  y={previousY}
                  width={previousBarWidth}
                  height={previousHeight}
                  rx="10"
                  fill="#ddd6fe"
                  opacity="0.72"
                  stroke="#c4b5fd"
                  strokeDasharray="4 3"
                />
                <rect
                  x={x - barWidth / 2 - barWidth * 0.3}
                  y={y}
                  width={barWidth}
                  height={height}
                  rx="10"
                  fill="url(#primaryGradient)"
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
            stroke="#fdba74"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="3"
            strokeDasharray="5 6"
            points={previousLinePoints}
          />
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
                key={dailyPairs[index].current.date}
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

        <div className="absolute inset-x-[64px] top-[56px] flex h-[122px] items-stretch">
          {dailyPairs.map((pair, index) => {
            const value = primarySeries[index] ?? 0;
            const secondaryValue = secondarySeries[index] ?? 0;
            const previousPrimaryValue = previousPrimarySeries[index] ?? 0;
            const previousSecondaryValue = previousSecondarySeries[index] ?? 0;
            const { dateLabel, weekDayLabel } = formatChartDate(parseIsoDate(pair.current.date));
            const comparisonDate = pair.previous?.date ?? pair.current.date;
            const {
              dateLabel: comparisonDateLabel,
              weekDayLabel: comparisonWeekDayLabel,
            } = formatChartDate(parseIsoDate(comparisonDate));
            const tooltipPosition =
              index <= 1
                ? "left-0 translate-x-0"
                : index >= dailyPairs.length - 2
                  ? "right-0 translate-x-0"
                  : "left-1/2 -translate-x-1/2";

            return (
              <div key={pair.current.date} className="group relative flex-1 cursor-crosshair">
                <div className="absolute inset-y-0 left-1/2 hidden w-px bg-indigo-300 group-hover:block" />
                <div
                  className={`pointer-events-none absolute top-4 z-30 hidden w-40 rounded-xl border border-slate-200 bg-white px-2.5 py-2 text-left shadow-lg group-hover:block ${tooltipPosition}`}
                >
                  <div className="text-[9px] font-black uppercase tracking-[0.06em] text-slate-400">
                    {dateLabel} · {weekDayLabel}
                  </div>
                  <div className="mt-1.5 space-y-1 text-[10px] font-black leading-4">
                    <div className="text-[9px] uppercase tracking-[0.08em] text-slate-400">
                      Текущий
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-slate-500">{preset.primary.label}</span>
                      <span className={preset.primary.colorClassName}>
                        {formatAxisValue(value, preset.primary.kind)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-slate-500">{preset.secondary.label}</span>
                      <span className={preset.secondary.colorClassName}>
                        {formatAxisValue(secondaryValue, preset.secondary.kind)}
                      </span>
                    </div>
                    <div className="my-1 h-px bg-slate-100" />
                    <div className="text-[9px] uppercase tracking-[0.08em] text-slate-400">
                      Сравнение: {comparisonDateLabel} · {comparisonWeekDayLabel}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-slate-500">{preset.primary.label}</span>
                      <span className="text-slate-600">
                        {formatAxisValue(previousPrimaryValue, preset.primary.kind)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-slate-500">{preset.secondary.label}</span>
                      <span className="text-slate-600">
                        {formatAxisValue(previousSecondaryValue, preset.secondary.kind)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DynamicInsights({
  preset,
  currentPoints,
  previousPoints,
}: {
  preset: ChartPresetConfig;
  currentPoints: DashboardDailyPoint[];
  previousPoints: DashboardDailyPoint[];
}) {
  const dailyPairs = compactDailyPairs(currentPoints, previousPoints);
  const primarySeries = dailyPairs.map((pair) =>
    metricValueFromDailyPoint(pair.current, preset.primary)
  );
  const secondarySeries = dailyPairs.map((pair) =>
    metricValueFromDailyPoint(pair.current, preset.secondary)
  );
  const primaryStats = getSeriesStats(primarySeries);
  const secondaryStats = getSeriesStats(secondarySeries);
  const isDrrPreset = preset.secondary.label === "ДРР";

  const primaryTotal = metricTotalFromDailyPoints(currentPoints, preset.primary);
  const secondaryTotal = metricTotalFromDailyPoints(currentPoints, preset.secondary);
  const previousPrimaryTotal = metricTotalFromDailyPoints(previousPoints, preset.primary);
  const previousSecondaryTotal = metricTotalFromDailyPoints(previousPoints, preset.secondary);

  const bestPrimaryIndex = primarySeries.indexOf(primaryStats.max);
  const weakPrimaryIndex = primarySeries.indexOf(primaryStats.min);
  const peakSecondaryIndex = secondarySeries.indexOf(secondaryStats.max);
  const avgPrimary = averageMetricFromDailyPoints(currentPoints, preset.primary);
  const avgSecondary = averageMetricFromDailyPoints(currentPoints, preset.secondary);

  function row(index: number) {
    const pair = dailyPairs[index] ?? dailyPairs[0];
    const currentPoint = pair?.current;
    const date = currentPoint?.date ?? toIsoDate(new Date());
    const { dateLabel, weekDayLabel } = formatChartDate(parseIsoDate(date));
    const primaryValue = currentPoint
      ? metricValueFromDailyPoint(currentPoint, preset.primary)
      : 0;
    const secondaryValue = currentPoint
      ? metricValueFromDailyPoint(currentPoint, preset.secondary)
      : 0;

    return {
      dateLabel,
      weekDayLabel,
      primaryValue,
      secondaryValue,
    };
  }

  const best = row(bestPrimaryIndex >= 0 ? bestPrimaryIndex : 0);
  const weak = row(weakPrimaryIndex >= 0 ? weakPrimaryIndex : 0);
  const peak = row(peakSecondaryIndex >= 0 ? peakSecondaryIndex : 0);
  const primaryDelta = percentDelta(primaryTotal, previousPrimaryTotal);
  const secondaryDelta =
    preset.secondary.kind === "percent"
      ? secondaryTotal - previousSecondaryTotal
      : percentDelta(secondaryTotal, previousSecondaryTotal);

  const rows = [
    { icon: "↗", title: "Лучший день", data: best, tone: "bg-emerald-50 text-emerald-600" },
    { icon: "↓", title: "Слабый день", data: weak, tone: "bg-red-50 text-red-600" },
    { icon: preset.secondary.kind === "percent" ? "↟" : "◔", title: `Пик: ${preset.secondary.label}`, data: peak, tone: "bg-orange-50 text-orange-600" },
  ];

  const headerClassName = isDrrPreset
    ? "grid grid-cols-[30px_minmax(78px,1fr)_58px_76px_82px_44px] items-center gap-2 px-3 py-2"
    : "grid grid-cols-[30px_minmax(88px,1.15fr)_64px_1fr_1fr] items-center gap-2 px-3 py-2";
  const rowClassName = isDrrPreset
    ? "grid grid-cols-[30px_minmax(78px,1fr)_58px_76px_82px_44px] items-center gap-2 border-b border-slate-100 px-3 py-2.5 last:border-b-0"
    : "grid grid-cols-[30px_minmax(88px,1.15fr)_64px_1fr_1fr] items-center gap-2 border-b border-slate-100 px-3 py-2.5 last:border-b-0";

  function adsValue(primaryValue: number, secondaryValue: number) {
    return primaryValue * (secondaryValue / 100);
  }

  function renderInsightCells(data: {
    dateLabel: string;
    weekDayLabel: string;
    primaryValue: number;
    secondaryValue: number;
  }) {
    if (isDrrPreset) {
      return (
        <>
          <div className={`text-xs font-black ${preset.primary.colorClassName}`}>
            {formatChartMetric(data.primaryValue, preset.primary.kind)}
          </div>
          <div className="text-xs font-black text-orange-700">
            {formatCurrency(adsValue(data.primaryValue, data.secondaryValue))}
          </div>
          <div className="text-xs font-black text-emerald-600">
            {formatPercent(data.secondaryValue)}
          </div>
        </>
      );
    }

    return (
      <>
        <div className={`text-xs font-black ${preset.primary.colorClassName}`}>
          {formatChartMetric(data.primaryValue, preset.primary.kind)}
        </div>
        <div className={`text-xs font-black ${preset.secondary.colorClassName}`}>
          {formatSecondaryInsight({
            preset,
            primaryValue: data.primaryValue,
            secondaryValue: data.secondaryValue,
          })}
        </div>
      </>
    );
  }

  const averageRow = {
    dateLabel: "—",
    weekDayLabel: "за период",
    primaryValue: avgPrimary,
    secondaryValue: avgSecondary,
  };

  return (
    <section className="panel h-full min-w-0 p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-black tracking-tight text-slate-950">
            Выводы по динамике
          </h2>
        </div>
        <span className="rounded-2xl bg-indigo-50 px-3 py-2 text-xs font-black text-indigo-600">
          {preset.primary.label} + {preset.secondary.label}
        </span>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className={`${headerClassName} border-b border-slate-100 text-[10px] font-black uppercase tracking-[0.08em] text-slate-400`}>
          <div />
          <div>Показатель</div>
          <div>День</div>
          <div>{preset.primary.label}</div>
          {isDrrPreset ? (
            <>
              <div>Реклама</div>
              <div>ДРР</div>
            </>
          ) : (
            <div>{preset.secondary.label}</div>
          )}
        </div>

        {rows.map((item) => (
          <div key={item.title} className={rowClassName}>
            <div className={`flex h-8 w-8 items-center justify-center rounded-2xl text-xs font-black ${item.tone}`}>
              {item.icon}
            </div>
            <div>
              <div className="text-xs font-black text-slate-950">{item.title}</div>
            </div>
            <div className="text-xs font-bold leading-4 text-slate-600">
              <div>{item.data.dateLabel}</div>
              <div className="text-slate-400">{item.data.weekDayLabel}</div>
            </div>
            {renderInsightCells(item.data)}
          </div>
        ))}

        <div className={rowClassName}>
          <div className="flex h-8 w-8 items-center justify-center rounded-2xl bg-blue-50 text-xs font-black text-blue-600">≈</div>
          <div>
            <div className="text-xs font-black text-slate-950">Средний день</div>
          </div>
          <div className="text-xs font-bold leading-4 text-slate-600">
            <div>{averageRow.dateLabel}</div>
            <div className="text-slate-400">{averageRow.weekDayLabel}</div>
          </div>
          {renderInsightCells(averageRow)}
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-orange-100 bg-orange-50/50 p-3 text-sm font-semibold leading-6 text-slate-700">
        Выручка стабильна, но рекламную нагрузку стоит проверять в дни пиков.
      </div>

      <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3 text-sm font-black text-slate-700">
        <span className="text-slate-500">Сравнение:</span>{" "}
        <span className={primaryDelta !== null && primaryDelta >= 0 ? "text-emerald-600" : "text-red-600"}>
          {preset.primary.label} {formatDelta(primaryDelta, preset.primary.kind)}
        </span>
        <span className="px-2 text-slate-300">·</span>
        <span className={secondaryDelta !== null && secondaryDelta <= 0 ? "text-emerald-600" : "text-red-600"}>
          {preset.secondary.label} {formatDelta(secondaryDelta, preset.secondary.kind)}
        </span>
      </div>
    </section>
  );
}

type ReconciliationKind = "money" | "percent";

type ReconciliationRow = {
  label: string;
  kind: ReconciliationKind;
  periodValue: number | null;
  dailyValue: number | null;
  diff: number | null;
  isOk: boolean;
};

function summarizeDailyForReconciliation(points: DashboardDailyPoint[]) {
  const revenue = sumDailyValue(points, (point) => point.revenue);
  const wbRevenue = sumDailyValue(points, (point) => point.wbRevenue);
  const ozonRevenue = sumDailyValue(points, (point) => point.ozonRevenue);
  const adsCost = sumDailyValue(points, (point) => point.adsCost);
  const operatingProfitAfterTax = sumDailyValue(points, (point) => point.operatingProfitAfterTax);
  const netProfit = sumDailyValue(points, (point) => point.netProfit);
  const cashFlowResult = sumDailyValue(points, (point) => point.cashFlowResult);
  const loanPayments = sumDailyValue(points, (point) => point.loanPayments);

  return {
    revenue,
    wbRevenue,
    ozonRevenue,
    adsCost,
    drr: revenue > 0 ? (adsCost / revenue) * 100 : null,
    operatingProfitAfterTax,
    netProfit,
    cashFlowResult,
    loanPayments,
  };
}

function makeMoneyReconciliationRow(label: string, periodValue: number, dailyValue: number): ReconciliationRow {
  const diff = dailyValue - periodValue;

  return {
    label,
    kind: "money",
    periodValue,
    dailyValue,
    diff,
    isOk: isNearlySameMoney(periodValue, dailyValue),
  };
}

function makePercentReconciliationRow(
  label: string,
  periodValue: number | null,
  dailyValue: number | null
): ReconciliationRow {
  const diff = periodValue === null || dailyValue === null ? null : dailyValue - periodValue;

  return {
    label,
    kind: "percent",
    periodValue,
    dailyValue,
    diff,
    isOk: isNearlySamePercent(periodValue, dailyValue),
  };
}

function buildReconciliationRows(summary: DashboardSummary, points: DashboardDailyPoint[]) {
  const daily = summarizeDailyForReconciliation(points);

  return [
    makeMoneyReconciliationRow("Выручка всего", summary.totalRevenue, daily.revenue),
    makeMoneyReconciliationRow("Выручка WB", summary.wbRevenue, daily.wbRevenue),
    makeMoneyReconciliationRow("Выручка Ozon", summary.ozonRevenue, daily.ozonRevenue),
    makeMoneyReconciliationRow("Реклама", summary.adsCost, daily.adsCost),
    makePercentReconciliationRow("ДРР", summary.drr, daily.drr),
    makeMoneyReconciliationRow("Опер. прибыль", summary.operatingProfitAfterTax, daily.operatingProfitAfterTax),
    makeMoneyReconciliationRow("Чистая прибыль", summary.netProfit, daily.netProfit),
    makeMoneyReconciliationRow("Денежный поток", summary.cashFlowResult, daily.cashFlowResult),
    makeMoneyReconciliationRow("Кредиты", summary.loanPayments, daily.loanPayments),
  ];
}

function createDailyExpectedTotals(summary: DashboardSummary) {
  return {
    wbRevenue: summary.wbRevenue,
    ozonRevenue: summary.ozonRevenue,
    revenue: summary.totalRevenue,
    adsCost: summary.adsCost,
    operatingProfitAfterTax: summary.operatingProfitAfterTax,
    netProfit: summary.netProfit,
    cashFlowResult: summary.cashFlowResult,
    loanPayments: summary.loanPayments,
    creditPrincipal: summary.creditPrincipal,
    creditInterest: summary.creditInterest,
  };
}

function formatReconciliationValue(value: number | null, kind: ReconciliationKind) {
  if (value === null) return "—";
  if (kind === "percent") return formatPercent(value);
  return formatCurrency(value);
}

function formatReconciliationDiff(value: number | null, kind: ReconciliationKind) {
  if (value === null) return "—";
  if (kind === "percent") return formatSignedPoints(value);
  return formatSignedCurrency(value);
}

function ReconciliationTable({
  title,
  rows,
}: {
  title: string;
  rows: ReconciliationRow[];
}) {
  const problemRows = rows.filter((row) => !row.isOk);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div className="text-sm font-black text-slate-950">{title}</div>
        <span
          className={`rounded-full px-2.5 py-1 text-[10px] font-black ring-1 ${
            problemRows.length === 0
              ? "bg-emerald-50 text-emerald-700 ring-emerald-100"
              : "bg-amber-50 text-amber-700 ring-amber-100"
          }`}
        >
          {problemRows.length === 0 ? "OK" : `${problemRows.length} расх.`}
        </span>
      </div>

      <div className="divide-y divide-slate-100">
        <div className="grid grid-cols-[minmax(110px,1.2fr)_1fr_1fr_0.9fr_64px] gap-3 px-4 py-2 text-[10px] font-black uppercase tracking-[0.08em] text-slate-400">
          <div>Показатель</div>
          <div>Итог</div>
          <div>По дням</div>
          <div>Разница</div>
          <div>Статус</div>
        </div>

        {rows.map((row) => (
          <div
            key={row.label}
            className="grid grid-cols-[minmax(110px,1.2fr)_1fr_1fr_0.9fr_64px] items-center gap-3 px-4 py-2 text-xs"
          >
            <div className="font-bold text-slate-700">{row.label}</div>
            <div className="font-black text-slate-950">{formatReconciliationValue(row.periodValue, row.kind)}</div>
            <div className="font-black text-slate-950">{formatReconciliationValue(row.dailyValue, row.kind)}</div>
            <div className={row.diff !== null && row.diff < 0 ? "font-black text-red-600" : "font-black text-emerald-600"}>
              {formatReconciliationDiff(row.diff, row.kind)}
            </div>
            <div>
              <span
                className={`rounded-full px-2 py-1 text-[10px] font-black ring-1 ${
                  row.isOk
                    ? "bg-emerald-50 text-emerald-700 ring-emerald-100"
                    : "bg-red-50 text-red-700 ring-red-100"
                }`}
              >
                {row.isOk ? "OK" : "Нет"}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DailyDataReconciliation({
  currentSummary,
  previousSummary,
  currentPoints,
  previousPoints,
}: {
  currentSummary: DashboardSummary;
  previousSummary: DashboardSummary;
  currentPoints: DashboardDailyPoint[];
  previousPoints: DashboardDailyPoint[];
}) {
  const currentRows = buildReconciliationRows(currentSummary, currentPoints);
  const previousRows = buildReconciliationRows(previousSummary, previousPoints);
  const currentProblems = currentRows.filter((row) => !row.isOk).length;
  const previousProblems = previousRows.filter((row) => !row.isOk).length;
  const totalProblems = currentProblems + previousProblems;

  return (
    <section className="panel p-5 sm:p-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="section-eyebrow">Контроль данных</div>
          <h2 className="mt-1 text-xl font-black tracking-tight text-slate-950">
            Сверка: сумма по дням = итог периода
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
            Сравниваем агрегаты Dashboard с суммой реальных дневных точек, которые используются в графике динамики.
          </p>
        </div>

        <span
          className={`w-fit rounded-full px-3 py-1.5 text-xs font-black ring-1 ${
            totalProblems === 0
              ? "bg-emerald-50 text-emerald-700 ring-emerald-100"
              : "bg-amber-50 text-amber-700 ring-amber-100"
          }`}
        >
          {totalProblems === 0 ? "Сверка пройдена" : `Есть расхождения: ${totalProblems}`}
        </span>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <ReconciliationTable title="Текущий период" rows={currentRows} />
        <ReconciliationTable title="Период сравнения" rows={previousRows} />
      </div>

      <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-600">
        Если есть расхождения, это не обязательно ошибка интерфейса. Чаще всего причина в разных источниках расчёта: итог WB может брать недельный финансовый отчёт, а дневной график — строки продаж по датам. Следующий шаг — выровнять источник расчёта для тех показателей, где сверка не сошлась.
      </div>
    </section>
  );
}

function MarketplaceShare({
  wbRevenue,
  ozonRevenue,
  previousWbRevenue,
  previousOzonRevenue,
  current,
  previous,
  selectedPreset,
  period,
  companyName,
  marketplaceCompanyName,
  companies,
}: {
  wbRevenue: number;
  ozonRevenue: number;
  previousWbRevenue: number;
  previousOzonRevenue: number;
  current: DashboardSummary;
  previous: DashboardSummary;
  selectedPreset: ChartPresetConfig;
  period: PeriodOption;
  companyName: string;
  marketplaceCompanyName: string;
  companies: { name: string }[];
}) {
  const total = wbRevenue + ozonRevenue;
  const previousTotal = previousWbRevenue + previousOzonRevenue;
  const wbPercent = total > 0 ? (wbRevenue / total) * 100 : 0;
  const ozonPercent = total > 0 ? (ozonRevenue / total) * 100 : 0;
  const previousWbPercent = previousTotal > 0 ? (previousWbRevenue / previousTotal) * 100 : 0;
  const previousOzonPercent = previousTotal > 0 ? (previousOzonRevenue / previousTotal) * 100 : 0;
  const stockQty = current.wbStockQty + current.ozonStockQty + current.warehouseStockQty;
  const companyOptions = [
    { name: "ALL", label: "Все компании" },
    ...companies.map((company) => ({ name: company.name, label: company.name })),
  ];

  return (
    <section className="panel h-full p-4 sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="section-eyebrow">Разрез по маркетплейсам</div>
          <h2 className="mt-1 text-xl font-black tracking-tight text-slate-950">
            Доля выручки WB / Ozon
          </h2>
        </div>

        <div className="flex flex-wrap gap-2">
          {companyOptions.map((option) => {
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
      </div>

      <div className="mt-5 space-y-4">
        <div className="grid gap-4 md:grid-cols-[160px_1fr_58px] md:items-center">
          <div className="flex items-start gap-3">
            <span className="mt-1 h-3 w-3 rounded-full bg-violet-600" />
            <div>
              <div className="text-base font-black text-violet-700">Wildberries</div>
              <div className="mt-1 text-lg font-black text-slate-950">{formatCurrency(wbRevenue)}</div>
              <div className="mt-1 text-xs font-bold text-slate-400">{formatCurrency(previousWbRevenue)}</div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="h-3 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-violet-600" style={{ width: `${wbPercent}%` }} />
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-slate-50 ring-1 ring-violet-100">
              <div
                className="h-full rounded-full border border-dashed border-violet-300 bg-violet-100"
                style={{ width: `${previousWbPercent}%` }}
              />
            </div>
          </div>

          <div className="text-right">
            <div className="text-lg font-black text-violet-700">{formatPercent(wbPercent)}</div>
            <div className="mt-1 text-sm font-black text-slate-400">{formatPercent(previousWbPercent)}</div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-[160px_1fr_58px] md:items-center">
          <div className="flex items-start gap-3">
            <span className="mt-1 h-3 w-3 rounded-full bg-sky-500" />
            <div>
              <div className="text-base font-black text-sky-700">Ozon</div>
              <div className="mt-1 text-lg font-black text-slate-950">{formatCurrency(ozonRevenue)}</div>
              <div className="mt-1 text-xs font-bold text-slate-400">{formatCurrency(previousOzonRevenue)}</div>
            </div>
          </div>

          <div className="space-y-2">
            <div className="h-3 overflow-hidden rounded-full bg-slate-100">
              <div className="h-full rounded-full bg-sky-500" style={{ width: `${ozonPercent}%` }} />
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-slate-50 ring-1 ring-sky-100">
              <div
                className="h-full rounded-full border border-dashed border-sky-300 bg-sky-100"
                style={{ width: `${previousOzonPercent}%` }}
              />
            </div>
          </div>

          <div className="text-right">
            <div className="text-lg font-black text-sky-700">{formatPercent(ozonPercent)}</div>
            <div className="mt-1 text-sm font-black text-slate-400">{formatPercent(previousOzonPercent)}</div>
          </div>
        </div>
      </div>

      <div className="mt-5 grid overflow-hidden rounded-2xl border border-slate-200 bg-white sm:grid-cols-2 xl:grid-cols-4">
        <div className="flex items-center gap-3 border-b border-slate-100 p-3 sm:border-r xl:border-b-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-violet-50 text-base font-black text-violet-700">▦</div>
          <div>
            <div className="text-xs font-bold text-slate-500">Выручка всего</div>
            <div className="mt-1 text-base font-black text-slate-950">{formatCurrency(current.totalRevenue)}</div>
            <div className="mt-1 text-xs font-black text-emerald-600">{formatDelta(percentDelta(current.totalRevenue, previous.totalRevenue), "money")}</div>
          </div>
        </div>

        <div className="flex items-center gap-3 border-b border-slate-100 p-3 xl:border-b-0 xl:border-r">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-red-50 text-base font-black text-red-600">↗</div>
          <div>
            <div className="text-xs font-bold text-slate-500">Реклама / ДРР</div>
            <div className="mt-1 text-base font-black text-slate-950">{formatCurrency(current.adsCost)} / {current.drr !== null ? formatPercent(current.drr) : "—"}</div>
            <div className="mt-1 text-xs font-black text-red-600">{formatDelta(current.drr !== null && previous.drr !== null ? current.drr - previous.drr : null, "percent")}</div>
          </div>
        </div>

        <div className="flex items-center gap-3 border-b border-slate-100 p-3 sm:border-r xl:border-b-0">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-emerald-50 text-base font-black text-emerald-600">⌁</div>
          <div>
            <div className="text-xs font-bold text-slate-500">Опер. прибыль</div>
            <div className="mt-1 text-base font-black text-slate-950">{formatCurrency(current.operatingProfitAfterTax)}</div>
            <div className="mt-1 text-xs font-black text-emerald-600">{formatDelta(percentDelta(current.operatingProfitAfterTax, previous.operatingProfitAfterTax), "money")}</div>
          </div>
        </div>

        <div className="flex items-center gap-3 p-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-orange-50 text-base font-black text-orange-600">□</div>
          <div>
            <div className="text-xs font-bold text-slate-500">Остаток товаров</div>
            <div className="mt-1 text-base font-black text-slate-950">{formatNumber(stockQty)} шт. / — ₽</div>
            <div className="mt-1 text-xs font-black text-slate-400">себестоимость подключим отдельно</div>
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
  previousRow,
  dateFrom,
  dateTo,
}: {
  row: CompanyDashboardRow;
  previousRow?: CompanyDashboardRow;
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
  const openCompanyHref = buildDashboardHref({
    period: "custom",
    companyName: row.companyName,
    marketplaceCompanyName: row.companyName,
    dateFrom,
    dateTo,
  });

  return (
    <article className="h-full overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm shadow-slate-200/60 transition hover:border-indigo-200 hover:shadow-md">
      <div className="border-b border-slate-100 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-lg font-black tracking-tight text-slate-950">
                {row.companyName}
              </h3>
              <span className="rounded-full bg-slate-50 px-2 py-0.5 text-[10px] font-black text-slate-500 ring-1 ring-slate-200">
                WB / Ozon
              </span>
            </div>
          </div>

          <Link
            href={openCompanyHref}
            className="shrink-0 text-xs font-black text-indigo-600 transition hover:text-indigo-800"
          >
            Открыть →
          </Link>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-white p-3">
            <div className="text-[10px] font-bold text-slate-500">Выручка</div>
            <div className="mt-1 text-base font-black text-slate-950">
              {formatCurrency(row.totalRevenue)}
            </div>
            <CompanyKpiMeta
              current={row.totalRevenue}
              previous={previousRow?.totalRevenue}
            />
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-3">
            <div className="text-[10px] font-bold text-slate-500">Опер. прибыль</div>
            <div className={`mt-1 text-base font-black ${valueColor(row.operatingProfitAfterTax)}`}>
              {formatCurrency(row.operatingProfitAfterTax)}
            </div>
            <CompanyKpiMeta
              revenuePercent={formatRevenuePercent(row.operatingProfitAfterTax, row.totalRevenue)}
              current={row.operatingProfitAfterTax}
              previous={previousRow?.operatingProfitAfterTax}
            />
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-3">
            <div className="text-[10px] font-bold text-slate-500">Чистая прибыль</div>
            <div className={`mt-1 text-base font-black ${valueColor(row.netProfit)}`}>
              {formatCurrency(row.netProfit)}
            </div>
            <CompanyKpiMeta
              revenuePercent={formatRevenuePercent(row.netProfit, row.totalRevenue)}
              current={row.netProfit}
              previous={previousRow?.netProfit}
            />
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-3">
            <div className="text-[10px] font-bold text-slate-500">Ден. поток</div>
            <div className={`mt-1 text-base font-black ${valueColor(row.cashFlowResult)}`}>
              {formatCurrency(row.cashFlowResult)}
            </div>
            <CompanyKpiMeta
              revenuePercent={formatRevenuePercent(row.cashFlowResult, row.totalRevenue)}
              current={row.cashFlowResult}
              previous={previousRow?.cashFlowResult}
            />
          </div>
        </div>
      </div>

      <div className="grid gap-4 p-4 sm:grid-cols-4">
        <Link href="/analytics" className="group min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-black text-slate-950">Каналы</div>
            <span className="text-slate-300 transition group-hover:translate-x-1 group-hover:text-indigo-500">→</span>
          </div>
          <div className="mt-3 space-y-2 text-[11px] leading-4">
            <div>
              <div className="font-bold uppercase tracking-[0.08em] text-slate-400">WB</div>
              <div className="font-black text-slate-950">
                {formatCurrency(row.wbRevenue)} ({formatPercent(getRevenuePercent(row.wbRevenue, row.totalRevenue) ?? 0)})
              </div>
            </div>
            <div>
              <div className="font-bold uppercase tracking-[0.08em] text-slate-400">Ozon</div>
              <div className="font-black text-slate-950">
                {formatCurrency(row.ozonRevenue)} ({formatPercent(getRevenuePercent(row.ozonRevenue, row.totalRevenue) ?? 0)})
              </div>
            </div>
          </div>
        </Link>

        <Link href="/ads-mapping" className="group min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-black text-slate-950">Реклама</div>
            <span className="text-slate-300 transition group-hover:translate-x-1 group-hover:text-indigo-500">→</span>
          </div>
          <div className="mt-3 space-y-2 text-[11px] leading-4">
            <div>
              <div className="font-bold uppercase tracking-[0.08em] text-slate-400">Расходы</div>
              <div className={row.adsCost > 0 ? "font-black text-red-600" : "font-black text-slate-950"}>
                {formatCurrency(row.adsCost)}
              </div>
            </div>
            <div>
              <div className="font-bold uppercase tracking-[0.08em] text-slate-400">ДРР</div>
              <div className={row.drr !== null && row.drr > 12 ? "font-black text-red-600" : "font-black text-slate-950"}>
                {drrText}
              </div>
            </div>
          </div>
        </Link>

        <Link
          href={buildOperationsHref({
            companyName: row.companyName,
            dateFrom,
            dateTo,
            operationType: "ALL",
            search: "кредит",
          })}
          className="group min-w-0"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-black text-slate-950">Кредиты и деньги</div>
            <span className="text-slate-300 transition group-hover:translate-x-1 group-hover:text-indigo-500">→</span>
          </div>
          <div className="mt-3 space-y-2 text-[11px] leading-4">
            <div>
              <div className="font-bold uppercase tracking-[0.08em] text-slate-400">Кредиты</div>
              <div className={row.loanPayments > 0 ? "font-black text-red-600" : "font-black text-slate-950"}>
                {formatCurrency(row.loanPayments)}
              </div>
            </div>
            <div>
              <div className="font-bold uppercase tracking-[0.08em] text-slate-400">Тело / проценты</div>
              <div className="font-black text-slate-950">
                {formatCurrency(row.creditPrincipal)} / {formatCurrency(row.creditInterest)}
              </div>
            </div>
          </div>
        </Link>

        <Link href="/abc" className="group min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-black text-slate-950">Ассортимент</div>
            <span className="text-slate-300 transition group-hover:translate-x-1 group-hover:text-indigo-500">→</span>
          </div>
          <div className="mt-3 space-y-2 text-[11px] leading-4">
            <div>
              <div className="font-bold uppercase tracking-[0.08em] text-slate-400">ABC всего</div>
              <div className="font-black text-slate-950">{formatNumber(totalAbc)} SKU</div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <span className="rounded-full bg-emerald-50 px-2 py-0.5 font-bold text-emerald-700">A {formatNumber(rowWbAbc.A + rowOzonAbc.A)}</span>
              <span className="rounded-full bg-amber-50 px-2 py-0.5 font-bold text-amber-700">B {formatNumber(rowWbAbc.B + rowOzonAbc.B)}</span>
              <span className="rounded-full bg-red-50 px-2 py-0.5 font-bold text-red-700">C {formatNumber(rowWbAbc.C + rowOzonAbc.C)}</span>
            </div>
          </div>
        </Link>
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
    },
  });

  const totalRows = rows.filter((row) => row.warehouseName === "__TOTAL__");
  const stockRows = totalRows.length > 0 ? totalRows : rows;

  return stockRows.reduce(
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

async function getLatestWarehouseStockQty(companyName: string) {
  const latestWarehouseImport = await prisma.importSession.findFirst({
    where: {
      companyName,
      reportType: "OZON_WAREHOUSE_STOCK",
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (!latestWarehouseImport) return 0;

  const rows = await prisma.ozonWarehouseStock.findMany({
    where: {
      companyName,
      importSessionId: latestWarehouseImport.id,
    },
  });

  return rows.reduce((sum, row) => sum + safeNumber(row.warehouseQty), 0);
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

    const [wbStockQty, ozonStockQty, warehouseStockQty] = await Promise.all([
      getLatestWbStockQty(company.name),
      getLatestOzonStockQty(company.name),
      getLatestWarehouseStockQty(company.name),
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
      warehouseStockQty,
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
  const warehouseStockQty = companyRows.reduce((sum, row) => sum + row.warehouseStockQty, 0);

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
    warehouseStockQty,
    wbAbc,
    ozonAbc,
    totalAbc,
  };
}

export default async function HomePage({ searchParams }: Props) {
  const params = searchParams ? await searchParams : {};
  const showDebug = params.debug === "1";

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
  const companyRowsWithMetrics = allCurrentRows.filter(hasAnyCompanyMetric);
  const marketplaceCompanies = companyRowsWithMetrics.map((row) => ({
    name: row.companyName,
  }));
  const rawMarketplaceCompanyValue =
    params.marketplaceCompanyName ?? selectedCompanyValue ?? "ALL";
  const selectedMarketplaceCompanyValue = marketplaceCompanies.some(
    (company) => company.name === rawMarketplaceCompanyValue
  )
    ? rawMarketplaceCompanyValue
    : "ALL";
  const marketplaceCurrent = summarizeDashboardRows(
    selectedMarketplaceCompanyValue === "ALL"
      ? companyRowsWithMetrics
      : companyRowsWithMetrics.filter(
          (row) => row.companyName === selectedMarketplaceCompanyValue
        )
  );
  const marketplacePreviousRows = allPreviousRows.filter((row) =>
    selectedMarketplaceCompanyValue === "ALL"
      ? marketplaceCompanies.some((company) => company.name === row.companyName)
      : row.companyName === selectedMarketplaceCompanyValue
  );
  const marketplacePrevious = summarizeDashboardRows(marketplacePreviousRows);
  const selectedChartPreset = getChartPreset(params.chartPreset);
  const dailyCompanyName =
    selectedMarketplaceCompanyValue === "ALL" ? null : selectedMarketplaceCompanyValue;
  const [currentDailyPoints, previousDailyPoints] = await Promise.all([
    getDashboardDailyAnalytics({
      dateFrom: selectedPeriod.dateFrom,
      dateTo: selectedPeriod.dateTo,
      companyName: dailyCompanyName,
      expectedTotals: createDailyExpectedTotals(marketplaceCurrent),
    }),
    getDashboardDailyAnalytics({
      dateFrom: previousPeriod.dateFrom,
      dateTo: previousPeriod.dateTo,
      companyName: dailyCompanyName,
      expectedTotals: createDailyExpectedTotals(marketplacePrevious),
    }),
  ]);
  const currentReconciliationRows = buildReconciliationRows(marketplaceCurrent, currentDailyPoints);
  const previousReconciliationRows = buildReconciliationRows(marketplacePrevious, previousDailyPoints);
  const currentReconciliationProblems = currentReconciliationRows.filter((row) => !row.isOk).length;
  const previousReconciliationProblems = previousReconciliationRows.filter((row) => !row.isOk).length;
  const totalReconciliationProblems = currentReconciliationProblems + previousReconciliationProblems;
  const hasDataQualityIssues = totalReconciliationProblems > 0;

  const debugHref = buildDashboardHref({
    period: selectedPeriod.key,
    companyName: selectedCompanyValue,
    marketplaceCompanyName: selectedMarketplaceCompanyValue,
    dateFrom: selectedPeriod.key === "custom" ? selectedPeriod.dateFrom : undefined,
    dateTo: selectedPeriod.key === "custom" ? selectedPeriod.dateTo : undefined,
    chartPreset: selectedChartPreset.key,
    debug: true,
  });

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

  const previousCompanyRowsByName = new Map(
    previous.companyRows.map((row) => [row.companyName, row])
  );

  return (
    <main className="page-shell">
      <div className="page-container">
        <section className="sticky top-0 z-40 -mx-4 border-b border-slate-200 bg-background/90 px-4 py-2.5 backdrop-blur-xl sm:-mx-6 sm:px-6 xl:-mx-8 xl:px-8">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="rounded-2xl bg-indigo-600 px-3 py-2 text-xs font-black text-white shadow-sm shadow-indigo-200">
                Дашборд собственника
              </span>

              <details className="group/period relative">
                <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700">
                  <span>Период: {selectedPeriod.description}</span>
                  <span className="text-slate-400 transition group-open/period:rotate-180">↓</span>
                </summary>

                <div className="absolute left-0 top-full z-50 mt-2 w-[760px] max-w-[92vw] rounded-[28px] border border-slate-200 bg-white p-4 shadow-2xl shadow-slate-300/40">
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
                    <input type="hidden" name="period" value="custom" />
                    <input type="hidden" name="companyName" value={selectedCompanyValue} />
                    <input type="hidden" name="marketplaceCompanyName" value={selectedMarketplaceCompanyValue} />
                    <input type="hidden" name="chartPreset" value={selectedChartPreset.key} />

                    <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                      <label className="text-sm font-medium text-slate-500">
                        Дата от
                        <input
                          type="date"
                          name="dateFrom"
                          defaultValue={selectedPeriod.dateFrom}
                          className="filter-control mt-1"
                        />
                      </label>

                      <label className="text-sm font-medium text-slate-500">
                        Дата до
                        <input
                          type="date"
                          name="dateTo"
                          defaultValue={selectedPeriod.dateTo}
                          className="filter-control mt-1"
                        />
                      </label>

                      <button type="submit" className="primary-button h-11">
                        Применить
                      </button>
                    </div>
                  </form>
                </div>
              </details>

              <span className="hidden rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm md:inline-flex">
                Сравнение: {previousPeriod.description}
              </span>

              <details className="group/company relative">
                <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700">
                  <span>{selectedCompanyName ?? "Все компании"}</span>
                  <span className="text-slate-400 transition group-open/company:rotate-180">↓</span>
                </summary>

                <div className="absolute left-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-[24px] border border-slate-200 bg-white p-2 shadow-2xl shadow-slate-300/40">
                  <Link
                    href={buildDashboardHref({
                      period: selectedPeriod.key,
                      companyName: "ALL",
                      marketplaceCompanyName: "ALL",
                      dateFrom: selectedPeriod.key === "custom" ? selectedPeriod.dateFrom : undefined,
                      dateTo: selectedPeriod.key === "custom" ? selectedPeriod.dateTo : undefined,
                      chartPreset: selectedChartPreset.key,
                    })}
                    className={`flex items-center justify-between rounded-2xl px-3 py-2.5 text-sm font-black transition ${
                      selectedCompanyValue === "ALL"
                        ? "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100"
                        : "text-slate-600 hover:bg-slate-50 hover:text-slate-950"
                    }`}
                  >
                    Все компании
                    {selectedCompanyValue === "ALL" ? <span>✓</span> : null}
                  </Link>

                  {companies.map((company) => {
                    const isActive = selectedCompanyValue === company.name;

                    return (
                      <Link
                        key={company.id}
                        href={buildDashboardHref({
                          period: selectedPeriod.key,
                          companyName: company.name,
                          marketplaceCompanyName: company.name,
                          dateFrom: selectedPeriod.key === "custom" ? selectedPeriod.dateFrom : undefined,
                          dateTo: selectedPeriod.key === "custom" ? selectedPeriod.dateTo : undefined,
                          chartPreset: selectedChartPreset.key,
                        })}
                        className={`mt-1 flex items-center justify-between rounded-2xl px-3 py-2.5 text-sm font-black transition ${
                          isActive
                            ? "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100"
                            : "text-slate-600 hover:bg-slate-50 hover:text-slate-950"
                        }`}
                      >
                        {company.name}
                        {isActive ? <span>✓</span> : null}
                      </Link>
                    );
                  })}
                </div>
              </details>

              {hasDataQualityIssues ? (
                <Link
                  href={debugHref}
                  className="inline-flex items-center gap-1.5 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-black text-amber-700 shadow-sm transition hover:border-amber-300 hover:bg-amber-100"
                  title="Обнаружено расхождение между итогами периода и дневной детализацией. Нажмите, чтобы открыть техническую сверку."
                >
                  <span>⚠</span>
                  <span>Данные требуют проверки</span>
                  <span className="rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] text-amber-700 ring-1 ring-amber-200">
                    {totalReconciliationProblems}
                  </span>
                </Link>
              ) : null}
            </div>

            <Link href="/import" className="primary-button w-fit gap-2 py-2.5">
              ⇧ Импорт данных
            </Link>
          </div>

          <div className="mt-2 hidden text-sm leading-6 text-slate-500 lg:block">
            Главные показатели бизнеса за выбранный период. Период и компанию можно поменять прямо в закреплённой панели.
          </div>
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

        <section className="grid items-stretch gap-4 2xl:grid-cols-[repeat(6,minmax(0,1fr))]">
          <div className="min-w-0 2xl:col-span-4">
            <MarketplaceShare
              wbRevenue={marketplaceCurrent.wbRevenue}
              ozonRevenue={marketplaceCurrent.ozonRevenue}
              previousWbRevenue={marketplacePrevious.wbRevenue}
              previousOzonRevenue={marketplacePrevious.ozonRevenue}
              current={marketplaceCurrent}
              previous={marketplacePrevious}
              selectedPreset={selectedChartPreset}
              period={selectedPeriod}
              companyName={selectedCompanyValue}
              marketplaceCompanyName={selectedMarketplaceCompanyValue}
              companies={marketplaceCompanies}
            />
          </div>

          <section className="panel h-full min-w-0 p-4 2xl:col-span-2">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-black text-slate-950">
                  Что требует внимания
                </h2>
              </div>
              <span className="rounded-full bg-red-50 px-3 py-1 text-xs font-black text-red-600 ring-1 ring-red-100">
                {attentionItems.filter((item) => item.level !== "ok").length}
              </span>
            </div>

            <div className="mt-4 space-y-3">
              {attentionItems.map((item) => (
                <Link
                  key={item.title}
                  href={item.href}
                  className="group flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 transition hover:border-indigo-200 hover:bg-indigo-50/30"
                >
                  <div
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-sm font-black ${
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
                    <div className="text-sm font-black text-slate-950">{item.title}</div>
                    <p className="mt-1 text-xs leading-5 text-slate-500">{item.text}</p>
                  </div>
                  <div className="text-lg font-black text-slate-300 transition group-hover:translate-x-1 group-hover:text-indigo-500">
                    →
                  </div>
                </Link>
              ))}
            </div>
          </section>
        </section>

        <section className="grid items-stretch gap-4 2xl:grid-cols-[repeat(6,minmax(0,1fr))]">
          <section className="panel h-full min-w-0 p-4 2xl:col-span-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <h3 className="text-xl font-black tracking-tight text-slate-950">
                  Динамика: {selectedChartPreset.title}
                </h3>
              </div>
              <Link
                href="/analytics"
                className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-indigo-600 transition hover:bg-indigo-50"
              >
                Открыть аналитику →
              </Link>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {chartPresets.map((preset) => (
                <ChartPresetLink
                  key={preset.key}
                  preset={preset}
                  selectedPreset={selectedChartPreset}
                  href={buildDashboardHref({
                    period: selectedPeriod.key,
                    companyName: selectedCompanyValue,
                    marketplaceCompanyName: selectedMarketplaceCompanyValue,
                    dateFrom:
                      selectedPeriod.key === "custom"
                        ? selectedPeriod.dateFrom
                        : undefined,
                    dateTo:
                      selectedPeriod.key === "custom"
                        ? selectedPeriod.dateTo
                        : undefined,
                    chartPreset: preset.key,
                  })}
                />
              ))}
            </div>

            <InteractiveTrendChart
              preset={selectedChartPreset}
              currentPoints={currentDailyPoints}
              previousPoints={previousDailyPoints}
            />
          </section>

          <div className="min-w-0 2xl:col-span-2">
            <DynamicInsights
              preset={selectedChartPreset}
              currentPoints={currentDailyPoints}
              previousPoints={previousDailyPoints}
            />
          </div>
        </section>

        {showDebug && hasDataQualityIssues ? (
          <DailyDataReconciliation
            currentSummary={marketplaceCurrent}
            previousSummary={marketplacePrevious}
            currentPoints={currentDailyPoints}
            previousPoints={previousDailyPoints}
          />
        ) : null}

        <section className="grid items-stretch gap-5 2xl:grid-cols-6">
          <section className="panel h-full p-5 sm:p-6 2xl:col-span-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="section-eyebrow">Компании</div>
                <h2 className="mt-1 text-xl font-black tracking-tight text-slate-950">
                  Разрез по компаниям
                </h2>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
                  Главное по каждой компании: выручка, прибыль, ДДС, реклама, кредиты и ассортимент.
                </p>
              </div>

              <Link href="/settings/companies" className="secondary-button">
                Настройки компаний
              </Link>
            </div>

            {current.companyRows.length > 0 ? (
              <div className="mt-5 grid gap-4 xl:grid-cols-2">
                {current.companyRows.map((row) => (
                  <CompanyCard
                    key={row.companyName}
                    row={row}
                    previousRow={previousCompanyRowsByName.get(row.companyName)}
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

          <section className="panel h-full p-5 sm:p-6 2xl:col-span-2">
            <div>
              <h2 className="text-xl font-black tracking-tight text-slate-950">
                Быстрые действия
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                Быстрый переход к действиям после просмотра Dashboard.
              </p>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {quickActions.map((item) => (
                <Link
                  key={item.href + item.title}
                  href={item.href}
                  className="group flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 transition hover:border-indigo-200 hover:bg-indigo-50/30"
                >
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-base font-black ${item.tone}`}>
                    {item.icon}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-black leading-5 text-slate-950">{item.title}</div>
                    <p className="mt-1 text-xs leading-4 text-slate-500">{item.description}</p>
                  </div>

                  <div className="text-base font-black text-slate-300 transition group-hover:translate-x-1 group-hover:text-indigo-500">
                    →
                  </div>
                </Link>
              ))}
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}
