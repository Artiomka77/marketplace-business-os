import Link from "next/link";

import { prisma } from "@/lib/prisma";
import {
  buildFinanceCategoryTreatmentIndex,
  calculateFinanceMetricsForRows,
  getFinanceTransactionCashEffect,
  getFinanceTransactionTreatment,
} from "@/lib/finance/financeMetrics";

type MetricTone =
  | "green"
  | "red"
  | "blue"
  | "cyan"
  | "violet"
  | "amber"
  | "orange"
  | "slate";

const metricToneMap: Record<
  MetricTone,
  {
    card: string;
    icon: string;
    value: string;
    border: string;
    badge: string;
  }
> = {
  green: {
    card: "border-emerald-100 bg-emerald-50/70",
    icon: "bg-emerald-100 text-emerald-700",
    value: "text-emerald-700",
    border: "border-emerald-100",
    badge: "bg-emerald-50 text-emerald-700 ring-emerald-100",
  },
  red: {
    card: "border-red-100 bg-red-50/70",
    icon: "bg-red-100 text-red-700",
    value: "text-red-700",
    border: "border-red-100",
    badge: "bg-red-50 text-red-700 ring-red-100",
  },
  blue: {
    card: "border-blue-100 bg-blue-50/70",
    icon: "bg-blue-100 text-blue-700",
    value: "text-blue-700",
    border: "border-blue-100",
    badge: "bg-blue-50 text-blue-700 ring-blue-100",
  },
  cyan: {
    card: "border-cyan-100 bg-cyan-50/70",
    icon: "bg-cyan-100 text-cyan-700",
    value: "text-cyan-800",
    border: "border-cyan-100",
    badge: "bg-cyan-50 text-cyan-700 ring-cyan-100",
  },
  violet: {
    card: "border-violet-100 bg-violet-50/70",
    icon: "bg-violet-100 text-violet-700",
    value: "text-violet-700",
    border: "border-violet-100",
    badge: "bg-violet-50 text-violet-700 ring-violet-100",
  },
  amber: {
    card: "border-amber-100 bg-amber-50/70",
    icon: "bg-amber-100 text-amber-700",
    value: "text-amber-700",
    border: "border-amber-100",
    badge: "bg-amber-50 text-amber-700 ring-amber-100",
  },
  orange: {
    card: "border-orange-100 bg-orange-50/70",
    icon: "bg-orange-100 text-orange-700",
    value: "text-orange-700",
    border: "border-orange-100",
    badge: "bg-orange-50 text-orange-700 ring-orange-100",
  },
  slate: {
    card: "border-slate-200 bg-white",
    icon: "bg-slate-100 text-slate-700",
    value: "text-slate-900",
    border: "border-slate-200",
    badge: "bg-slate-50 text-slate-700 ring-slate-200",
  },
};

const monthNames = [
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
];

function toNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function formatMoney(value: unknown) {
  const number = toNumber(value);

  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(number);
}

function formatCompactMoney(value: unknown) {
  const number = Math.abs(toNumber(value));

  if (number >= 1_000_000) {
    return `${(number / 1_000_000).toLocaleString("ru-RU", {
      maximumFractionDigits: 1,
    })} млн ₽`;
  }

  if (number >= 1_000) {
    return `${Math.round(number / 1_000).toLocaleString("ru-RU")} тыс. ₽`;
  }

  return formatMoney(number);
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "—";

  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatShare(value: number, total: number) {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return "0.0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

function formatDateInput(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function formatDisplayDate(date: Date) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
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
    59
  );
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function addMonths(date: Date, months: number) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59);
}

function startOfQuarter(date: Date) {
  const quarterStartMonth = Math.floor(date.getMonth() / 3) * 3;
  return new Date(date.getFullYear(), quarterStartMonth, 1);
}

function startOfYear(date: Date) {
  return new Date(date.getFullYear(), 0, 1);
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function shortMonthLabel(date: Date) {
  return `${monthNames[date.getMonth()]} '${String(date.getFullYear()).slice(-2)}`;
}

function buildFinanceHref(company: string, dateFrom?: string, dateTo?: string) {
  const query = new URLSearchParams();

  query.set("company", company);

  if (dateFrom) query.set("dateFrom", dateFrom);
  if (dateTo) query.set("dateTo", dateTo);

  return `/finance?${query.toString()}`;
}

function calcDelta(current: number, previous: number) {
  const absolute = current - previous;
  const percent = previous === 0 ? null : (absolute / Math.abs(previous)) * 100;

  return {
    absolute,
    percent,
  };
}

function parentLabel(value: string | null | undefined) {
  if (!value) return "Без группы";
  if (value === "FINANCING") return "Кредиты и займы";
  return value;
}

function valueClass(value: number) {
  return value >= 0 ? "text-emerald-600" : "text-red-600";
}

function deltaClass(value: number, goodWhen: "up" | "down") {
  if (value === 0) return "text-slate-500";

  if (goodWhen === "up") {
    return value > 0 ? "text-emerald-600" : "text-red-600";
  }

  return value < 0 ? "text-emerald-600" : "text-red-600";
}

function treatmentGroupLabel(treatment: string, parentName?: string | null) {
  if (treatment === "CREDIT_RECEIVED") return "Финансовая деятельность";
  if (treatment === "CREDIT_PRINCIPAL") return "Финансовая деятельность";
  if (treatment === "CREDIT_INTEREST") return "Финансовая деятельность";
  if (treatment === "OWNER_WITHDRAWAL") return "Собственник";
  if (treatment === "CASH_ONLY") return parentLabel(parentName);
  if (treatment === "INCLUDE_IN_NET_PROFIT") return parentLabel(parentName);
  if (treatment === "IGNORE") return "Не учитывается";

  return parentLabel(parentName);
}

function buildCategoryRows(params: {
  transactions: {
    operationType: string;
    category: string;
    amount: unknown;
    subcategory?: string | null;
    isInternalTransfer?: boolean | null;
    transferDirection?: string | null;
  }[];
  categories: {
    name: string;
    categoryType: string;
    parentName?: string | null;
    profitTreatment?: string | null;
  }[];
}) {
  const categoryTreatmentIndex = buildFinanceCategoryTreatmentIndex(
    params.categories
  );

  const categoryMap = new Map(
    params.categories.map((category) => [category.name, category])
  );

  const incomeMap = new Map<
    string,
    {
      category: string;
      amount: number;
      treatmentLabel: string;
      treatmentClassName: string;
    }
  >();

  const outflowMap = new Map<
    string,
    {
      group: string;
      category: string;
      amount: number;
      treatmentLabel: string;
      treatmentClassName: string;
    }
  >();

  for (const row of params.transactions) {
    const effect = getFinanceTransactionCashEffect(
      row,
      categoryTreatmentIndex
    );

    if (effect === 0) continue;

    const treatment = getFinanceTransactionTreatment(
      row,
      categoryTreatmentIndex
    );

    const category = categoryMap.get(row.category);
    const group = treatmentGroupLabel(treatment.treatment, category?.parentName);

    if (effect > 0) {
      const current =
        incomeMap.get(row.category) ??
        {
          category: row.category,
          amount: 0,
          treatmentLabel: treatment.label,
          treatmentClassName: treatment.className,
        };

      current.amount += effect;
      incomeMap.set(row.category, current);

      continue;
    }

    const key = `${group}|||${row.category}`;

    const current =
      outflowMap.get(key) ??
      {
        group,
        category: row.category,
        amount: 0,
        treatmentLabel: treatment.label,
        treatmentClassName: treatment.className,
      };

    current.amount += Math.abs(effect);
    outflowMap.set(key, current);
  }

  return {
    incomeRows: Array.from(incomeMap.values()).sort(
      (a, b) => b.amount - a.amount
    ),
    outflowRows: Array.from(outflowMap.values()).sort(
      (a, b) => a.group.localeCompare(b.group, "ru") || b.amount - a.amount
    ),
  };
}

function MetricCard({
  title,
  value,
  description,
  delta,
  deltaGoodWhen = "up",
  tone = "slate",
  icon,
  valueClassName,
  compact = false,
}: {
  title: string;
  value: string;
  description?: string;
  delta?: { absolute: number; percent: number | null };
  deltaGoodWhen?: "up" | "down";
  tone?: MetricTone;
  icon: string;
  valueClassName?: string;
  compact?: boolean;
}) {
  const style = metricToneMap[tone];
  const valueColor = valueClassName ?? style.value;

  return (
    <div
      className={`rounded-[26px] border p-5 shadow-[0_12px_30px_rgba(15,23,42,0.04)] ${style.card}`}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-semibold text-slate-500">{title}</div>
          <div
            className={`mt-3 font-black tracking-tight ${valueColor} ${
              compact ? "text-2xl" : "text-3xl"
            }`}
          >
            {value}
          </div>
        </div>

        <div
          className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-xl ${style.icon}`}
        >
          {icon}
        </div>
      </div>

      {delta ? (
        <div
          className={`mt-3 text-sm font-bold ${deltaClass(
            delta.absolute,
            deltaGoodWhen
          )}`}
        >
          {formatMoney(delta.absolute)} /{" "}
          {delta.percent === null ? "—" : formatPercent(delta.percent)}
        </div>
      ) : null}

      {description ? (
        <p className="mt-3 text-sm font-medium leading-6 text-slate-600">
          {description}
        </p>
      ) : null}
    </div>
  );
}

function CategoryTable({
  title,
  total,
  rows,
  tone,
  emptyText,
}: {
  title: string;
  total: number;
  rows: {
    category: string;
    amount: number;
    treatmentLabel: string;
    treatmentClassName: string;
    group?: string;
  }[];
  tone: "green" | "red";
  emptyText: string;
}) {
  const isIncome = tone === "green";
  const accent = isIncome ? "text-emerald-700" : "text-red-700";
  const pill = isIncome
    ? "bg-emerald-50 text-emerald-700 ring-emerald-100"
    : "bg-red-50 text-red-700 ring-red-100";
  const bar = isIncome ? "bg-emerald-500" : "bg-red-500";

  return (
    <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-[0_18px_45px_rgba(15,23,42,0.05)]">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-2xl font-black tracking-tight text-slate-950">
          {title}
        </h2>
        <div
          className={`rounded-full px-4 py-2 text-xs font-black ring-1 ${pill}`}
        >
          Всего {formatMoney(total)}
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-2xl border border-slate-100">
        <div className="grid grid-cols-[minmax(0,1.3fr)_130px_90px_150px] bg-slate-50 px-4 py-3 text-xs font-black uppercase tracking-[0.12em] text-slate-400 max-xl:grid-cols-[minmax(0,1fr)_120px_70px]">
          <div>Статья</div>
          <div className="text-right">Сумма</div>
          <div className="text-right">Доля</div>
          <div className="text-right max-xl:hidden">Динамика</div>
        </div>

        {rows.slice(0, 6).map((item, index) => {
          const share = total > 0 ? item.amount / total : 0;
          return (
            <div
              key={`${item.category}-${index}`}
              className="grid grid-cols-[minmax(0,1.3fr)_130px_90px_150px] items-center gap-3 border-t border-slate-100 px-4 py-4 max-xl:grid-cols-[minmax(0,1fr)_120px_70px]"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${bar}`}
                  />
                  <span className="truncate font-bold text-slate-900">
                    {item.category}
                  </span>
                </div>
                <div
                  className={`mt-2 inline-flex rounded-full px-3 py-1 text-[11px] font-black ring-1 ${item.treatmentClassName}`}
                >
                  {item.treatmentLabel}
                </div>
              </div>

              <div className="text-right font-black text-slate-900">
                {formatMoney(item.amount)}
              </div>
              <div className="text-right text-sm font-bold text-slate-500">
                {formatShare(item.amount, total)}
              </div>
              <div className="max-xl:hidden">
                <div className="flex items-center justify-end gap-3">
                  <span className={`text-sm font-black ${accent}`}>
                    {Math.round(share * 100)}%
                  </span>
                  <div className="h-2 w-20 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full ${bar}`}
                      style={{ width: `${Math.max(6, Math.min(100, share * 100))}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {rows.length === 0 ? (
          <div className="border-t border-slate-100 px-4 py-10 text-center text-sm font-semibold text-slate-500">
            {emptyText}
          </div>
        ) : null}

        <div className="grid grid-cols-[minmax(0,1fr)_160px_90px] border-t border-slate-100 bg-slate-50 px-4 py-4 text-sm font-black text-slate-900">
          <div>{isIncome ? "Итого поступлений" : "Итого выплат"}</div>
          <div className="text-right">{formatMoney(total)}</div>
          <div className="text-right">100%</div>
        </div>
      </div>
    </section>
  );
}

function MoneyMovementChart({
  rows,
}: {
  rows: { label: string; income: number; outflow: number; net: number }[];
}) {
  const width = 760;
  const height = 260;
  const paddingX = 54;
  const zeroY = 126;
  const chartHalfHeight = 82;
  const step = rows.length > 1 ? (width - paddingX * 2) / (rows.length - 1) : 0;
  const maxValue = Math.max(
    1,
    ...rows.flatMap((row) => [row.income, row.outflow, Math.abs(row.net)])
  );

  const graphPoints = rows.map((row, index) => {
    const x = paddingX + index * step;
    const normalizedNet = Math.max(-1, Math.min(1, row.net / maxValue));
    const y = zeroY - normalizedNet * chartHalfHeight;
    return { x, y };
  });

  const linePoints = graphPoints
    .map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mt-4 h-[260px] w-full">
      <defs>
        <linearGradient id="incomeBar" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="100%" stopColor="#a7f3d0" />
        </linearGradient>
        <linearGradient id="outflowBar" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#fecaca" />
          <stop offset="100%" stopColor="#ef4444" />
        </linearGradient>
      </defs>

      {[0, 1, 2, 3, 4].map((line) => {
        const y = 40 + line * 43;
        return (
          <line
            key={line}
            x1={paddingX - 20}
            x2={width - paddingX + 20}
            y1={y}
            y2={y}
            stroke="#e2e8f0"
            strokeDasharray="4 6"
          />
        );
      })}

      <line
        x1={paddingX - 22}
        x2={width - paddingX + 22}
        y1={zeroY}
        y2={zeroY}
        stroke="#cbd5e1"
      />

      {rows.map((row, index) => {
        const x = paddingX + index * step;
        const incomeHeight = Math.max(4, Math.min(chartHalfHeight, (row.income / maxValue) * chartHalfHeight));
        const outflowHeight = Math.max(4, Math.min(chartHalfHeight, (row.outflow / maxValue) * chartHalfHeight));
        const barWidth = 26;

        return (
          <g key={row.label}>
            <rect
              x={x - barWidth - 4}
              y={zeroY - incomeHeight}
              width={barWidth}
              height={incomeHeight}
              rx="6"
              fill="url(#incomeBar)"
            />
            <rect
              x={x + 4}
              y={zeroY}
              width={barWidth}
              height={outflowHeight}
              rx="6"
              fill="url(#outflowBar)"
            />
            <text
              x={x}
              y={236}
              textAnchor="middle"
              className="fill-slate-500 text-[12px] font-bold"
            >
              {row.label}
            </text>
          </g>
        );
      })}

      <polyline
        points={linePoints}
        fill="none"
        stroke="#0f2f5f"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {graphPoints.map((point, index) => (
        <g key={`${point.x}-${point.y}`}>
          <circle cx={point.x} cy={point.y} r="6" fill="#ffffff" stroke="#0f2f5f" strokeWidth="3" />
          <title>{`${rows[index].label}: ${formatMoney(rows[index].net)}`}</title>
        </g>
      ))}

      <text x="16" y="44" className="fill-slate-400 text-[11px] font-bold">
        +{formatCompactMoney(maxValue)}
      </text>
      <text x="16" y={zeroY + 4} className="fill-slate-400 text-[11px] font-bold">
        0
      </text>
      <text x="16" y="210" className="fill-slate-400 text-[11px] font-bold">
        -{formatCompactMoney(maxValue)}
      </text>
    </svg>
  );
}

const items = [
  { title: "Финансовые операции", href: "/finance/operations" },
  { title: "ОДДС", href: "/finance/cashflow" },
  { title: "Денежные счета", href: "/finance/accounts" },
  { title: "Кредиты и займы", href: "/finance/loans" },
  { title: "Платёжный календарь", href: "/finance/calendar" },
  { title: "Прогноз ликвидности", href: "/finance/forecast" },
  { title: "Справочник статей", href: "/finance/categories" },
];

export default async function FinancePage({
  searchParams,
}: {
  searchParams?: Promise<{
    company?: string;
    dateFrom?: string;
    dateTo?: string;
  }>;
}) {
  const params = searchParams ? await searchParams : {};

  const company = params.company ?? "ALL";
  const companyName = company !== "ALL" ? company : null;

  const dateFrom = params.dateFrom ?? "";
  const dateTo = params.dateTo ?? "";

  const today = startOfDay(new Date());
  const in30Days = endOfDay(addDays(today, 30));

  const defaultPeriodStart = startOfMonth(today);
  const defaultPeriodEnd = endOfMonth(today);

  const periodStart = dateFrom
    ? new Date(`${dateFrom}T00:00:00`)
    : defaultPeriodStart;

  const periodEnd = dateTo
    ? new Date(`${dateTo}T23:59:59`)
    : defaultPeriodEnd;

  const periodDays = Math.max(
    1,
    Math.ceil(
      (endOfDay(periodEnd).getTime() - startOfDay(periodStart).getTime()) /
        (24 * 60 * 60 * 1000)
    ) + 1
  );

  const previousPeriodEnd = endOfDay(addDays(periodStart, -1));
  const previousPeriodStart = startOfDay(
    addDays(previousPeriodEnd, -periodDays + 1)
  );

  const trendStart = startOfMonth(addMonths(today, -5));
  const trendEnd = endOfMonth(today);

  const companies = await prisma.company.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });

  const accounts = await prisma.financeAccount.findMany({
    where: {
      isActive: true,
      ...(companyName ? { companyName } : {}),
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

  const periodTransactions = await prisma.financeTransaction.findMany({
    where: {
      operationDate: {
        gte: periodStart,
        lte: periodEnd,
      },
      ...(companyName ? { companyName } : {}),
    },
  });

  const previousPeriodTransactions = await prisma.financeTransaction.findMany({
    where: {
      operationDate: {
        gte: previousPeriodStart,
        lte: previousPeriodEnd,
      },
      ...(companyName ? { companyName } : {}),
    },
  });

  const trendTransactions = await prisma.financeTransaction.findMany({
    where: {
      operationDate: {
        gte: trendStart,
        lte: trendEnd,
      },
      ...(companyName ? { companyName } : {}),
    },
  });

  const currentMetrics = calculateFinanceMetricsForRows({
    transactions: periodTransactions,
    categories,
  });

  const previousMetrics = calculateFinanceMetricsForRows({
    transactions: previousPeriodTransactions,
    categories,
  });

  const loans = await prisma.loan.findMany({
    where: {
      ...(companyName ? { companyName } : {}),
    },
  });

  const activeLoans = loans.filter((loan) => toNumber(loan.currentDebt) > 0.01);
  const activeLoanIds = activeLoans.map((loan) => loan.id);

  const loanPayments30Days = activeLoanIds.length
    ? await prisma.loanPayment.findMany({
        where: {
          paid: false,
          loanId: {
            in: activeLoanIds,
          },
          paymentDate: {
            gte: today,
            lte: in30Days,
          },
        },
        include: {
          loan: {
            select: {
              bankName: true,
              companyName: true,
            },
          },
        },
        orderBy: {
          paymentDate: "asc",
        },
      })
    : [];

  const totalCash = accounts.reduce(
    (sum, account) => sum + toNumber(account.currentBalance),
    0
  );

  const incomePeriod = currentMetrics.cashIncome;
  const expensePeriod = currentMetrics.cashOutflow;
  const netCashFlowPeriod = currentMetrics.netCashFlow;

  const incomePreviousPeriod = previousMetrics.cashIncome;
  const expensePreviousPeriod = previousMetrics.cashOutflow;
  const netCashFlowPreviousPeriod = previousMetrics.netCashFlow;

  const incomeDelta = calcDelta(incomePeriod, incomePreviousPeriod);
  const expenseDelta = calcDelta(expensePeriod, expensePreviousPeriod);
  const netCashFlowDelta = calcDelta(
    netCashFlowPeriod,
    netCashFlowPreviousPeriod
  );

  const totalDebt = activeLoans.reduce(
    (sum, loan) => sum + toNumber(loan.currentDebt),
    0
  );

  const payments30Days = loanPayments30Days.reduce((sum, payment) => {
    const total =
      toNumber(payment.totalAmount) ||
      toNumber(payment.principalAmount) + toNumber(payment.interestAmount);

    return sum + total;
  }, 0);

  const cashAfter30Days = totalCash - payments30Days;

  const averageDailyExpense = expensePeriod / periodDays;
  const liquidityDays =
    averageDailyExpense > 0 ? Math.floor(totalCash / averageDailyExpense) : null;

  const { incomeRows, outflowRows } = buildCategoryRows({
    transactions: periodTransactions,
    categories,
  });

  const trendMonths = Array.from({ length: 6 }, (_, index) =>
    startOfMonth(addMonths(trendStart, index))
  );

  type TrendTransaction = (typeof trendTransactions)[number];
  const trendTransactionsByMonth = new Map<string, TrendTransaction[]>();

  for (const transaction of trendTransactions) {
    const key = monthKey(transaction.operationDate);
    const rows = trendTransactionsByMonth.get(key) ?? ([] as TrendTransaction[]);
    rows.push(transaction);
    trendTransactionsByMonth.set(key, rows);
  }

  const trendRows = trendMonths.map((month) => {
    const transactions = trendTransactionsByMonth.get(monthKey(month)) ?? [];
    const metrics = calculateFinanceMetricsForRows({
      transactions,
      categories,
    });

    return {
      label: shortMonthLabel(month),
      income: metrics.cashIncome,
      outflow: metrics.cashOutflow,
      net: metrics.netCashFlow,
    };
  });

  const todayText = formatDateInput(today);
  const weekStartText = formatDateInput(addDays(today, -6));
  const days30StartText = formatDateInput(addDays(today, -29));
  const monthStartText = formatDateInput(startOfMonth(today));
  const quarterStartText = formatDateInput(startOfQuarter(today));
  const yearStartText = formatDateInput(startOfYear(today));

  const attentionItems = [
    {
      title: "Низкий запас ликвидности",
      description:
        liquidityDays === null
          ? "Расходов за период нет, запас не ограничен."
          : "Запас ликвидности ниже комфортного уровня 14+ дней.",
      value: liquidityDays === null ? "∞" : `${liquidityDays} дн.`,
      icon: "!",
      tone: liquidityDays === null || liquidityDays >= 14 ? "green" : "red",
    },
    {
      title: "Платежи по кредитам в ближайшие 30 дней",
      description: "Предстоящие платежи по активным кредитам.",
      value: formatMoney(payments30Days),
      icon: "▣",
      tone: payments30Days > 0 ? "orange" : "green",
    },
    {
      title: "Крупные расходы",
      description: "Общая сумма выплат ДДС за выбранный период.",
      value: formatMoney(expensePeriod),
      icon: "₽",
      tone: "amber",
    },
    {
      title: "Вывод собственника",
      description: "Сколько собственник вывел за период.",
      value: formatMoney(currentMetrics.ownerWithdrawals),
      icon: "◦",
      tone: "blue",
    },
  ] as const;

  return (
    <main className="min-h-screen bg-slate-50 px-5 py-6 lg:px-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <section className="rounded-[30px] border border-slate-200 bg-white p-5 shadow-[0_18px_50px_rgba(15,23,42,0.05)]">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <h1 className="text-4xl font-black tracking-tight text-slate-950">
                Финансы
              </h1>
              <p className="mt-2 max-w-3xl text-sm font-medium leading-6 text-slate-500">
                Ключевые финансовые показатели, денежные потоки, кредиты и
                запас ликвидности бизнеса.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Link
                href="/finance/operations"
                className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-800 shadow-sm transition hover:bg-slate-50"
              >
                <span className="text-lg text-blue-700">+</span>
                Создать
              </Link>
              <Link
                href="/finance/loans"
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-800 shadow-sm transition hover:bg-slate-50"
              >
                Кредиты
              </Link>
              <Link
                href="/finance/categories"
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-800 shadow-sm transition hover:bg-slate-50"
              >
                KPI
              </Link>
              <Link
                href="/settings/companies"
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-800 shadow-sm transition hover:bg-slate-50"
              >
                Настройки
              </Link>
            </div>
          </div>

          <div className="mt-6 grid gap-3 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-end">
            <div className="rounded-[24px] border border-slate-200 bg-slate-50/80 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="px-3 text-sm font-black text-slate-500">
                  Период
                </span>
                <Link
                  href={buildFinanceHref(company, todayText, todayText)}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50"
                >
                  Сегодня
                </Link>
                <Link
                  href={buildFinanceHref(company, weekStartText, todayText)}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50"
                >
                  7 дней
                </Link>
                <Link
                  href={buildFinanceHref(company, days30StartText, todayText)}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50"
                >
                  30 дней
                </Link>
                <Link
                  href={buildFinanceHref(company, monthStartText, todayText)}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50"
                >
                  Месяц
                </Link>
                <Link
                  href={buildFinanceHref(company, quarterStartText, todayText)}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50"
                >
                  Квартал
                </Link>
                <Link
                  href={buildFinanceHref(company, yearStartText, todayText)}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50"
                >
                  Год
                </Link>
                <Link
                  href={buildFinanceHref(company)}
                  className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-black text-white shadow-sm"
                >
                  Текущий месяц
                </Link>
              </div>
            </div>

            <form className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px]">
              <div className="rounded-[24px] border border-slate-200 bg-white p-3 shadow-sm">
                <label className="mb-2 block text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                  Компания
                </label>
                <select
                  name="company"
                  defaultValue={company}
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-black text-slate-800 outline-none transition focus:border-blue-300 focus:bg-white"
                >
                  <option value="ALL">Все компании</option>

                  {companies.map((item) => (
                    <option key={item.id} value={item.name}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <input type="hidden" name="dateFrom" value={dateFrom} />
                <input type="hidden" name="dateTo" value={dateTo} />
              </div>

              <button className="rounded-[24px] bg-slate-950 px-6 py-4 text-sm font-black text-white shadow-[0_12px_25px_rgba(15,23,42,0.18)] transition hover:bg-slate-800">
                Применить
              </button>
            </form>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 text-xs font-bold text-slate-400">
            <span>Период: {formatDateInput(periodStart)} — {formatDateInput(periodEnd)}</span>
            <span className="hidden h-1 w-1 rounded-full bg-slate-300 sm:block" />
            <span>Обновлено: {formatDisplayDate(new Date())}</span>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-4">
          <MetricCard
            title="Денег на счетах"
            value={formatMoney(totalCash)}
            description={`${accounts.length} активных счетов`}
            tone="green"
            icon="▣"
          />
          <MetricCard
            title="Чистый ДДС за период"
            value={formatMoney(netCashFlowPeriod)}
            delta={netCashFlowDelta}
            valueClassName={valueClass(netCashFlowPeriod)}
            tone={netCashFlowPeriod >= 0 ? "green" : "red"}
            icon="◔"
          />
          <MetricCard
            title="Остаток после платежей 30 дней"
            value={formatMoney(cashAfter30Days)}
            valueClassName={valueClass(cashAfter30Days)}
            tone={cashAfter30Days >= 0 ? "green" : "red"}
            icon="◇"
          />
          <MetricCard
            title="Запас ликвидности"
            value={liquidityDays === null ? "∞" : `${liquidityDays} дн.`}
            description="По средним выплатам ДДС за выбранный период"
            tone={liquidityDays === null || liquidityDays >= 14 ? "blue" : "red"}
            icon="≈"
          />
        </section>

        <section className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-4">
          <MetricCard
            title="Поступления ДДС"
            value={formatMoney(incomePeriod)}
            delta={incomeDelta}
            deltaGoodWhen="up"
            tone="green"
            icon="↓"
            compact
          />
          <MetricCard
            title="Выплаты ДДС"
            value={formatMoney(expensePeriod)}
            delta={expenseDelta}
            deltaGoodWhen="down"
            tone="red"
            icon="↑"
            compact
          />
          <MetricCard
            title="Только ДДС"
            value={formatMoney(currentMetrics.cashOnlyTotal)}
            description="Фулфилмент, закупки, упаковка и расходы, уже сидящие в себестоимости."
            tone="cyan"
            icon="≡"
            compact
          />
          <MetricCard
            title="Получено кредитов / займов"
            value={formatMoney(currentMetrics.creditReceived)}
            description="Увеличивает ДДС, но не является прибылью."
            tone="blue"
            icon="⌂"
            compact
          />
          <MetricCard
            title="Проценты кредита"
            value={formatMoney(currentMetrics.creditInterest)}
            description="Уменьшают и ДДС, и чистую прибыль."
            tone="violet"
            icon="%"
            compact
          />
          <MetricCard
            title="Вывод собственника"
            value={formatMoney(currentMetrics.ownerWithdrawals)}
            description="Уменьшает ДДС и показатель после вывода собственника."
            tone="orange"
            icon="◦"
            compact
          />
          <MetricCard
            title="Общий долг"
            value={formatMoney(totalDebt)}
            description={`${activeLoans.length} активных кредитов`}
            tone="red"
            icon="₽"
            compact
          />
          <MetricCard
            title="Платежи по кредитам 30 дней"
            value={formatMoney(payments30Days)}
            description={`${loanPayments30Days.length} будущих платежей`}
            tone="orange"
            icon="▤"
            compact
          />
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-[0_18px_45px_rgba(15,23,42,0.05)]">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-2xl font-black tracking-tight text-slate-950">
                  Движение денег
                </h2>
                <div className="mt-3 flex flex-wrap items-center gap-4 text-xs font-black text-slate-500">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                    Поступления
                  </span>
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
                    Выплаты
                  </span>
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-slate-950" />
                    Чистый ДДС
                  </span>
                </div>
              </div>

              <div className="inline-flex rounded-2xl border border-slate-200 bg-slate-50 p-1 text-xs font-black text-slate-600">
                <span className="rounded-xl px-3 py-2">Неделя</span>
                <span className="rounded-xl bg-white px-3 py-2 text-slate-950 shadow-sm">Месяц</span>
                <span className="rounded-xl px-3 py-2">Квартал</span>
              </div>
            </div>

            <MoneyMovementChart rows={trendRows} />

            <Link
              href="/finance/cashflow"
              className="mt-2 inline-flex items-center gap-2 text-sm font-black text-blue-700 hover:text-blue-900"
            >
              Перейти к отчёту <span>→</span>
            </Link>
          </div>

          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-[0_18px_45px_rgba(15,23,42,0.05)]">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-2xl font-black tracking-tight text-slate-950">
                Что требует внимания
              </h2>
              <Link
                href="/finance/calendar"
                className="rounded-2xl border border-slate-200 px-4 py-2 text-xs font-black text-slate-700 hover:bg-slate-50"
              >
                Все уведомления
              </Link>
            </div>

            <div className="mt-5 space-y-3">
              {attentionItems.map((item) => {
                const style = metricToneMap[item.tone];
                return (
                  <div
                    key={item.title}
                    className={`flex items-center justify-between gap-4 rounded-2xl border p-4 ${style.card}`}
                  >
                    <div className="flex items-center gap-4">
                      <div
                        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-lg font-black ${style.icon}`}
                      >
                        {item.icon}
                      </div>
                      <div>
                        <div className="font-black text-slate-950">{item.title}</div>
                        <div className="mt-1 text-sm font-medium text-slate-600">
                          {item.description}
                        </div>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className={`text-lg font-black ${style.value}`}>
                        {item.value}
                      </div>
                      <div className="mt-1 text-slate-400">›</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <CategoryTable
            title="Поступления по статьям"
            total={incomePeriod}
            rows={incomeRows}
            tone="green"
            emptyText="Поступлений за период нет."
          />
          <CategoryTable
            title="Выплаты по статьям"
            total={expensePeriod}
            rows={outflowRows}
            tone="red"
            emptyText="Выплат за период нет."
          />
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-[0_18px_45px_rgba(15,23,42,0.05)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-2xl font-black tracking-tight text-slate-950">
                Быстрые разделы
              </h2>
              <p className="mt-2 text-sm font-medium text-slate-500">
                Основные финансовые страницы открываются из этой панели.
              </p>
            </div>

            <div className="text-sm font-bold text-slate-400">
              Показатели рассчитываются на основе финансовых операций.
            </div>
          </div>

          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="group rounded-2xl border border-slate-200 bg-slate-50/70 p-5 transition hover:border-blue-200 hover:bg-blue-50/60"
              >
                <div className="font-black text-slate-950">{item.title}</div>
                <div className="mt-3 text-sm font-black text-blue-700 group-hover:text-blue-900">
                  Открыть →
                </div>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
