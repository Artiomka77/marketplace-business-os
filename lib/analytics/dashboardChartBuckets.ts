import type { DashboardDailyPoint } from "@/lib/analytics/dashboardDailyAnalytics";

export type DashboardChartGrain = "day" | "week" | "month";

export type DashboardChartBucket = {
  /** Stable bucket identity (ISO date of bucket start, or range key). */
  key: string;
  /** Inclusive start YYYY-MM-DD */
  dateFrom: string;
  /** Inclusive end YYYY-MM-DD */
  dateTo: string;
  /** Axis / insight label, e.g. `15.03`, `05–11 окт`, `Сен`, `Окт 01–18` */
  label: string;
  /** Short weekday/sublabel — empty for week/month grains */
  subLabel: string;
  grain: DashboardChartGrain;
  point: DashboardDailyPoint;
};

const WEEKDAY_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"] as const;
const MONTH_SHORT_RU = [
  "янв",
  "фев",
  "мар",
  "апр",
  "май",
  "июн",
  "июл",
  "авг",
  "сен",
  "окт",
  "ноя",
  "дек",
] as const;
const MONTH_TITLE_RU = [
  "Янв",
  "Фев",
  "Мар",
  "Апр",
  "Май",
  "Июн",
  "Июл",
  "Авг",
  "Сен",
  "Окт",
  "Ноя",
  "Дек",
] as const;

function parseIsoDateUtc(value: string): Date {
  const [y, m, d] = value.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toIsoDateUtc(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function inclusiveDays(dateFrom: string, dateTo: string): number {
  const start = parseIsoDateUtc(dateFrom);
  const end = parseIsoDateUtc(dateTo);
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

/** Monday=0 .. Sunday=6 in UTC calendar. */
function mondayIndex(date: Date): number {
  const day = date.getUTCDay(); // Sun=0
  return day === 0 ? 6 : day - 1;
}

function startOfUtcWeekMonday(date: Date): Date {
  return addUtcDays(date, -mondayIndex(date));
}

export function resolveDashboardChartGrain(
  dateFrom: string,
  dateTo: string
): DashboardChartGrain {
  const days = inclusiveDays(dateFrom, dateTo);
  if (days <= 31) return "day";
  if (days <= 120) return "week";
  return "month";
}

export function dashboardChartInsightTitles(grain: DashboardChartGrain): {
  best: string;
  weak: string;
  average: string;
} {
  if (grain === "month") {
    return {
      best: "Лучший месяц",
      weak: "Слабый месяц",
      average: "Средний месяц",
    };
  }
  if (grain === "week") {
    return {
      best: "Лучшая неделя",
      weak: "Слабая неделя",
      average: "Средняя неделя",
    };
  }
  return {
    best: "Лучший день",
    weak: "Слабый день",
    average: "Средний день",
  };
}

function emptyPoint(date: string): DashboardDailyPoint {
  return {
    date,
    wbRevenue: 0,
    ozonRevenue: 0,
    revenue: 0,
    adsCost: 0,
    drr: null,
    operatingProfitAfterTax: 0,
    netProfit: 0,
    cashFlowResult: 0,
    loanPayments: 0,
    creditPrincipal: 0,
    creditInterest: 0,
  };
}

function sumPoints(points: DashboardDailyPoint[], dateKey: string): DashboardDailyPoint {
  const out = emptyPoint(dateKey);
  for (const p of points) {
    out.wbRevenue += p.wbRevenue;
    out.ozonRevenue += p.ozonRevenue;
    out.revenue += p.revenue;
    out.adsCost += p.adsCost;
    out.operatingProfitAfterTax += p.operatingProfitAfterTax;
    out.netProfit += p.netProfit;
    out.cashFlowResult += p.cashFlowResult;
    out.loanPayments += p.loanPayments;
    out.creditPrincipal += p.creditPrincipal;
    out.creditInterest += p.creditInterest;
  }
  out.drr = out.revenue > 0 ? (out.adsCost / out.revenue) * 100 : null;
  return out;
}

function dayLabel(date: Date): { label: string; subLabel: string } {
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return {
    label: `${dd}.${mm}`,
    subLabel: WEEKDAY_SHORT[date.getUTCDay()] ?? "",
  };
}

function weekLabel(from: Date, to: Date): string {
  const fromDay = String(from.getUTCDate()).padStart(2, "0");
  const toDay = String(to.getUTCDate()).padStart(2, "0");
  const mon = MONTH_SHORT_RU[to.getUTCMonth()] ?? "";
  if (from.getUTCMonth() === to.getUTCMonth()) {
    return `${fromDay}–${toDay} ${mon}`;
  }
  const fromMon = MONTH_SHORT_RU[from.getUTCMonth()] ?? "";
  return `${fromDay} ${fromMon}–${toDay} ${mon}`;
}

function monthLabel(from: Date, to: Date): string {
  const title = MONTH_TITLE_RU[from.getUTCMonth()] ?? "";
  const monthStart = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0));
  const coversFullMonth =
    from.getTime() === monthStart.getTime() && to.getTime() === monthEnd.getTime();
  if (!coversFullMonth) {
    const fromDay = String(from.getUTCDate()).padStart(2, "0");
    const toDay = String(to.getUTCDate()).padStart(2, "0");
    return `${title} ${fromDay}–${toDay}`;
  }
  return title;
}

function pointsInRange(
  byDate: Map<string, DashboardDailyPoint>,
  fromIso: string,
  toIso: string
): DashboardDailyPoint[] {
  const out: DashboardDailyPoint[] = [];
  let cursor = parseIsoDateUtc(fromIso);
  const end = parseIsoDateUtc(toIso);
  while (cursor.getTime() <= end.getTime()) {
    const iso = toIsoDateUtc(cursor);
    const hit = byDate.get(iso);
    if (hit) out.push(hit);
    cursor = addUtcDays(cursor, 1);
  }
  return out;
}

/**
 * Aggregate daily dashboard points into calendar day / week / month buckets.
 * Ratios (DRR) are recomputed as SUM(ads)/SUM(revenue) on the bucket.
 */
export function buildDashboardChartBuckets(
  points: DashboardDailyPoint[],
  dateFrom: string,
  dateTo: string
): DashboardChartBucket[] {
  const grain = resolveDashboardChartGrain(dateFrom, dateTo);
  const byDate = new Map(points.map((p) => [p.date.slice(0, 10), p]));
  const periodStart = parseIsoDateUtc(dateFrom);
  const periodEnd = parseIsoDateUtc(dateTo);
  const buckets: DashboardChartBucket[] = [];

  if (grain === "day") {
    let cursor = periodStart;
    while (cursor.getTime() <= periodEnd.getTime()) {
      const iso = toIsoDateUtc(cursor);
      const point = byDate.get(iso) ?? emptyPoint(iso);
      const { label, subLabel } = dayLabel(cursor);
      buckets.push({
        key: iso,
        dateFrom: iso,
        dateTo: iso,
        label,
        subLabel,
        grain,
        point: { ...point, date: iso, drr: point.revenue > 0 ? (point.adsCost / point.revenue) * 100 : null },
      });
      cursor = addUtcDays(cursor, 1);
    }
    return buckets;
  }

  if (grain === "week") {
    let weekStart = startOfUtcWeekMonday(periodStart);
    while (weekStart.getTime() <= periodEnd.getTime()) {
      const weekEnd = addUtcDays(weekStart, 6);
      const from = weekStart.getTime() < periodStart.getTime() ? periodStart : weekStart;
      const to = weekEnd.getTime() > periodEnd.getTime() ? periodEnd : weekEnd;
      const fromIso = toIsoDateUtc(from);
      const toIso = toIsoDateUtc(to);
      const point = sumPoints(pointsInRange(byDate, fromIso, toIso), fromIso);
      buckets.push({
        key: fromIso,
        dateFrom: fromIso,
        dateTo: toIso,
        label: weekLabel(from, to),
        subLabel: "",
        grain,
        point,
      });
      weekStart = addUtcDays(weekStart, 7);
    }
    return buckets;
  }

  // month
  let cursor = new Date(
    Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), 1)
  );
  while (cursor.getTime() <= periodEnd.getTime()) {
    const monthEnd = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)
    );
    const from =
      cursor.getTime() < periodStart.getTime() ? periodStart : cursor;
    const to = monthEnd.getTime() > periodEnd.getTime() ? periodEnd : monthEnd;
    const fromIso = toIsoDateUtc(from);
    const toIso = toIsoDateUtc(to);
    const point = sumPoints(pointsInRange(byDate, fromIso, toIso), fromIso);
    buckets.push({
      key: fromIso,
      dateFrom: fromIso,
      dateTo: toIso,
      label: monthLabel(from, to),
      subLabel: "",
      grain,
      point,
    });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return buckets;
}

export function alignPreviousChartBuckets(
  current: DashboardChartBucket[],
  previousPoints: DashboardDailyPoint[],
  previousDateFrom: string | null | undefined,
  previousDateTo: string | null | undefined
): Array<{ current: DashboardChartBucket; previous: DashboardChartBucket | null }> {
  if (!previousDateFrom || !previousDateTo || previousPoints.length === 0) {
    return current.map((c) => ({ current: c, previous: null }));
  }
  const previousBuckets = buildDashboardChartBuckets(
    previousPoints,
    previousDateFrom,
    previousDateTo
  );
  return current.map((c, index) => ({
    current: c,
    previous: previousBuckets[index] ?? previousBuckets[previousBuckets.length - 1] ?? null,
  }));
}
