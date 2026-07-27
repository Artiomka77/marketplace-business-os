import type { ReactNode } from "react";

import { prisma } from "@/lib/prisma";
import { getProfitAnalytics } from "@/lib/analytics/profitAnalytics";
import { getProfitAnalyticsOzon } from "@/lib/analytics/profitAnalyticsOzon";
import { getDefaultLastCompletedWeekRange } from "@/lib/date/defaultPeriod";
import { buildDailyReport } from "@/lib/telegram/dailyReport";

function formatMoney(value: unknown) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

function formatNumber(value: unknown) {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

function formatPercent(value: number) {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function formatDateRu(value: string) {
  const date = new Date(`${value}T00:00:00`);

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getPreviousPeriodRange(dateFrom: string, dateTo: string) {
  const start = new Date(`${dateFrom}T00:00:00`);
  const end = new Date(`${dateTo}T00:00:00`);
  const dayMs = 24 * 60 * 60 * 1000;
  const periodDays = Math.max(
    1,
    Math.round((end.getTime() - start.getTime()) / dayMs) + 1,
  );
  const previousTo = new Date(start);
  previousTo.setDate(previousTo.getDate() - 1);
  const previousFrom = new Date(previousTo);
  previousFrom.setDate(previousFrom.getDate() - periodDays + 1);

  return {
    dateFrom: toIsoDate(previousFrom),
    dateTo: toIsoDate(previousTo),
  };
}

function formatShortMoney(value: number) {
  const abs = Math.abs(value);

  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString("ru-RU", {
      maximumFractionDigits: 1,
    })} млн ₽`;
  }

  if (abs >= 1000) {
    return `${Math.round(value / 1000).toLocaleString("ru-RU")} тыс. ₽`;
  }

  return formatMoney(value);
}

function getAmount(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function normalizeVendorCode(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[‐-‒–—−]/g, "-")
    .replace(/\s+/g, "")
    .trim();
}

type InsightRow = {
  companyName: string;
  marketplace: "WB" | "Ozon";
  sku: string;
  vendorCode: string;
  salesQty: number;
  revenue: number;
  profit: number;
  marginPercent: number;
  productMeta: ProductMeta;
};

type StockRow = {
  companyName: string;
  marketplace: "WB" | "Ozon";
  sku: string;
  vendorCode: string;
  quantity: number;
  unitCost: number;
  frozenMoney: number;
  productMeta: ProductMeta;
};

type SummaryRow = {
  name: string;
  revenue: number;
  profit: number;
  marginPercent: number;
  skuCount: number;
  tone?: "violet" | "blue" | "emerald";
};

type ProductMeta = {
  title: string;
  subtitle: string;
  imageUrl?: string | null;
  vendorCode: string;
  sku: string;
};

type OwnerReportCompany = {
  companyName: string;
  wb: {
    salesAmount?: number;
    economicTurnover?: number;
    taxableRevenue?: number;
    adSpend?: number;
    netProfitAfterTax?: number;
  };
  ozon: {
    salesAmount?: number;
    economicTurnover?: number;
    taxableRevenue?: number;
    adSpend?: number;
    netProfitAfterTax?: number;
  };
  finance: {
    netProfitImpact?: number;
    ownerWithdrawals?: number;
    netCashFlow?: number;
  };
};

type OwnerReportLike = {
  companies: OwnerReportCompany[];
};

type DashboardTotalsForInsights = {
  totalRevenue: number;
  wbRevenue: number;
  ozonRevenue: number;
  taxableRevenue: number;
  wbTaxableRevenue: number;
  ozonTaxableRevenue: number;
  netProfit: number;
  profitAfterOwnerWithdrawal: number;
  ownerWithdrawals: number;
  cashFlowResult: number;
  adsCost: number;
  drrBase: number;
  drrEconomicBase: number;
  drrTaxableBase: number;
  drr: number | null;
  drrByEconomicTurnover: number | null;
  drrByTaxableRevenue: number | null;
  marketplaceSummaries: SummaryRow[];
  companySummaries: SummaryRow[];
};

function summarizeOwnerReportForInsights(
  report: OwnerReportLike,
  companyNames: string[],
): DashboardTotalsForInsights {
  const allowedCompanies = new Set(companyNames);
  const reports = report.companies.filter((company) =>
    allowedCompanies.has(company.companyName),
  );

  let wbRevenue = 0;
  let ozonRevenue = 0;
  let wbTaxableRevenue = 0;
  let ozonTaxableRevenue = 0;
  let wbProfit = 0;
  let ozonProfit = 0;
  let wbAdsCost = 0;
  let ozonAdsCost = 0;
  let wbDrrBase = 0;
  let ozonDrrBase = 0;
  let wbDrrEconomicBase = 0;
  let ozonDrrEconomicBase = 0;
  let wbDrrTaxableBase = 0;
  let ozonDrrTaxableBase = 0;
  let netProfit = 0;
  let ownerWithdrawals = 0;
  let cashFlowResult = 0;

  const companySummaries = reports.map((company) => {
    // REVENUE_DRR_POLICY_V1:
    // главный масштаб Центра прибыли = экономический оборот. Налоговую выручку показываем отдельно.
    const companyWbRevenue = getAmount(
      company.wb.economicTurnover ?? company.wb.salesAmount,
    );
    const companyOzonRevenue = getAmount(
      company.ozon.economicTurnover ?? company.ozon.salesAmount,
    );
    const companyWbTaxableRevenue = getAmount(
      company.wb.taxableRevenue ?? company.wb.salesAmount,
    );
    const companyOzonTaxableRevenue = getAmount(company.ozon.taxableRevenue);
    const companyRevenue = companyWbRevenue + companyOzonRevenue;
    const companyWbProfit = getAmount(company.wb.netProfitAfterTax);
    const companyOzonProfit = getAmount(company.ozon.netProfitAfterTax);
    const companyFinanceProfit = getAmount(company.finance.netProfitImpact);
    const companyProfit = companyWbProfit + companyOzonProfit + companyFinanceProfit;

    wbRevenue += companyWbRevenue;
    ozonRevenue += companyOzonRevenue;
    wbTaxableRevenue += companyWbTaxableRevenue;
    ozonTaxableRevenue += companyOzonTaxableRevenue;
    wbProfit += companyWbProfit;
    ozonProfit += companyOzonProfit;
    wbAdsCost += getAmount(company.wb.adSpend);
    ozonAdsCost += getAmount(company.ozon.adSpend);
    // Главный ДРР считаем от экономического оборота; от налоговой выручки показываем справочно.
    wbDrrBase += companyWbRevenue;
    ozonDrrBase += companyOzonRevenue;
    wbDrrEconomicBase += companyWbRevenue;
    ozonDrrEconomicBase += companyOzonRevenue;
    wbDrrTaxableBase += companyWbTaxableRevenue;
    ozonDrrTaxableBase += companyOzonTaxableRevenue;
    netProfit += companyProfit;
    ownerWithdrawals += getAmount(company.finance.ownerWithdrawals);
    cashFlowResult += getAmount(company.finance.netCashFlow);

    return {
      name: company.companyName,
      revenue: companyRevenue,
      profit: companyProfit,
      marginPercent: getMargin(companyRevenue, companyProfit),
      skuCount: 0,
      tone: "violet" as const,
    };
  });

  const totalRevenue = wbRevenue + ozonRevenue;
  const taxableRevenue = wbTaxableRevenue + ozonTaxableRevenue;
  const profitAfterOwnerWithdrawal = netProfit - ownerWithdrawals;
  const adsCost = wbAdsCost + ozonAdsCost;
  const drrBase = wbDrrBase + ozonDrrBase;
  const drrEconomicBase = wbDrrEconomicBase + ozonDrrEconomicBase;
  const drrTaxableBase = wbDrrTaxableBase + ozonDrrTaxableBase;

  return {
    totalRevenue,
    wbRevenue,
    ozonRevenue,
    taxableRevenue,
    wbTaxableRevenue,
    ozonTaxableRevenue,
    netProfit,
    profitAfterOwnerWithdrawal,
    ownerWithdrawals,
    cashFlowResult,
    adsCost,
    drrBase,
    drrEconomicBase,
    drrTaxableBase,
    drr: drrBase > 0 ? (adsCost / drrBase) * 100 : null,
    drrByEconomicTurnover:
      drrEconomicBase > 0 ? (adsCost / drrEconomicBase) * 100 : null,
    drrByTaxableRevenue:
      drrTaxableBase > 0 ? (adsCost / drrTaxableBase) * 100 : null,
    marketplaceSummaries: [
      {
        name: "WB",
        revenue: wbRevenue,
        profit: wbProfit,
        marginPercent: getMargin(wbRevenue, wbProfit),
        skuCount: 0,
        tone: "violet",
      },
      {
        name: "Ozon",
        revenue: ozonRevenue,
        profit: ozonProfit,
        marginPercent: getMargin(ozonRevenue, ozonProfit),
        skuCount: 0,
        tone: "blue",
      },
    ],
    companySummaries,
  };
}

function getAnyNumber(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = getAmount(row[key]);

    if (value !== 0) {
      return value;
    }
  }

  return 0;
}

function getAnyString(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = String(row[key] ?? "").trim();

    if (value) {
      return value;
    }
  }

  return "";
}

function getMargin(revenue: number, profit: number) {
  return revenue ? (profit / revenue) * 100 : 0;
}

function getDeltaPercent(current: number, previous: number) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    Math.abs(previous) < 0.01
  ) {
    return null;
  }

  return ((current - previous) / Math.abs(previous)) * 100;
}

function formatDelta(
  delta: number | null,
  options?: { suffix?: string; inverse?: boolean },
) {
  if (delta === null) return "—";

  const isPositive = delta >= 0;
  const sign = isPositive ? "+" : "";
  const value = `${sign}${delta.toFixed(1)}${options?.suffix ?? "%"}`;

  return value;
}

function getDeltaClassName(delta: number | null, inverse = false) {
  if (delta === null) return "text-slate-400";

  const good = inverse ? delta <= 0 : delta >= 0;
  return good ? "text-emerald-600" : "text-red-600";
}

function getRecommendation(row: InsightRow) {
  if (row.profit < 0) return "Разобрать";
  if (row.marginPercent < 5) return "Проверить";
  if (row.marginPercent >= 20 && row.profit > 0) return "Масштабировать";
  return "Следить";
}

function getStockRecommendation(row: StockRow) {
  if (row.frozenMoney >= 50_000) return "Оборачиваемость";
  if (row.frozenMoney >= 20_000) return "Контроль";
  return "Следить";
}

function getToneColor(
  tone: "emerald" | "red" | "orange" | "violet" | "blue" | "slate",
) {
  if (tone === "emerald")
    return "text-emerald-700 bg-emerald-50 ring-emerald-100 border-emerald-100";
  if (tone === "red")
    return "text-red-700 bg-red-50 ring-red-100 border-red-100";
  if (tone === "orange")
    return "text-orange-700 bg-orange-50 ring-orange-100 border-orange-100";
  if (tone === "violet")
    return "text-violet-700 bg-violet-50 ring-violet-100 border-violet-100";
  if (tone === "blue")
    return "text-blue-700 bg-blue-50 ring-blue-100 border-blue-100";
  return "text-slate-700 bg-slate-50 ring-slate-100 border-slate-100";
}

function MiniLine({
  tone = "emerald",
}: {
  tone?: "emerald" | "red" | "orange" | "violet" | "blue";
}) {
  const stroke =
    tone === "red"
      ? "#ef4444"
      : tone === "orange"
        ? "#f97316"
        : tone === "violet"
          ? "#8b5cf6"
          : tone === "blue"
            ? "#2563eb"
            : "#10b981";

  return (
    <svg
      viewBox="0 0 112 34"
      className="h-8 w-24 overflow-visible"
      aria-hidden="true"
    >
      <path
        d="M2 26 C 12 20, 20 25, 29 17 S 44 22, 53 14 S 70 10, 80 17 S 98 13, 110 6"
        fill="none"
        stroke={stroke}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M2 26 C 12 20, 20 25, 29 17 S 44 22, 53 14 S 70 10, 80 17 S 98 13, 110 6 L110 34 L2 34 Z"
        fill={stroke}
        opacity="0.08"
      />
    </svg>
  );
}

function KpiCard({
  title,
  value,
  subtitle,
  tone = "emerald",
  icon,
  delta,
  inverseDelta = false,
  href,
}: {
  title: string;
  value: ReactNode;
  subtitle: ReactNode;
  tone?: "emerald" | "red" | "orange" | "violet" | "blue" | "slate";
  icon: ReactNode;
  delta?: number | null;
  inverseDelta?: boolean;
  href?: string;
}) {
  const iconClassName =
    tone === "emerald"
      ? "bg-emerald-500 text-white shadow-emerald-100"
      : tone === "red"
        ? "bg-red-500 text-white shadow-red-100"
        : tone === "orange"
          ? "bg-orange-500 text-white shadow-orange-100"
          : tone === "violet"
            ? "bg-violet-600 text-white shadow-violet-100"
            : tone === "blue"
              ? "bg-blue-600 text-white shadow-blue-100"
              : "bg-slate-800 text-white shadow-slate-100";

  const card = (
    <div className="flex h-full min-h-[148px] flex-col justify-between rounded-[22px] border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/50 transition hover:-translate-y-0.5 hover:shadow-md hover:shadow-slate-200/70">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-black text-slate-600">{title}</div>
          <div
            className={`mt-2 truncate text-[1.55rem] font-black leading-none tracking-tight ${tone === "red" || tone === "orange" || tone === "violet" ? getToneColor(tone).split(" ")[0] : "text-slate-950"}`}
          >
            {value}
          </div>
        </div>

        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl text-sm font-black shadow-lg ${iconClassName}`}
        >
          {icon}
        </span>
      </div>

      <div className="mt-3 flex items-end justify-between gap-2">
        <div className="min-w-0 text-[11px] font-bold leading-3.5 text-slate-500">
          <div className={getDeltaClassName(delta ?? null, inverseDelta)}>
            {formatDelta(delta ?? null)}
          </div>
          <div className="mt-1">{subtitle}</div>
        </div>
        <MiniLine tone={tone === "slate" ? "blue" : tone} />
      </div>
    </div>
  );

  if (href) {
    return (
      <a
        href={href}
        className="block h-full focus:outline-none focus:ring-2 focus:ring-violet-200 focus:ring-offset-2"
      >
        {card}
      </a>
    );
  }

  return card;
}

function ExecutiveItem({
  icon,
  title,
  text,
  tone,
  href,
}: {
  icon: ReactNode;
  title: string;
  text: ReactNode;
  tone: "emerald" | "red" | "orange" | "violet" | "blue" | "slate";
  href?: string;
}) {
  const content = (
    <div className="flex items-start gap-3 rounded-2xl p-1 transition hover:bg-slate-50">
      <span
        className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-2xl border text-sm font-black ring-1 ${getToneColor(tone)}`}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-sm font-black text-slate-950">{title}</div>
        <div className="mt-0.5 text-sm leading-5 text-slate-500">{text}</div>
      </div>
    </div>
  );

  if (href) {
    return (
      <a
        href={href}
        className="block focus:outline-none focus:ring-2 focus:ring-violet-200 focus:ring-offset-2"
      >
        {content}
      </a>
    );
  }

  return content;
}

function PriorityRow({
  priority,
  text,
  tone,
  href,
}: {
  priority: string;
  text: ReactNode;
  tone: "emerald" | "red" | "orange" | "violet" | "blue" | "slate";
  href?: string;
}) {
  const content = (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm shadow-slate-200/30 transition hover:border-violet-100 hover:bg-slate-50">
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-black ${getToneColor(tone)}`}
        >
          {priority}
        </span>
        <div className="truncate text-sm font-bold text-slate-700">{text}</div>
      </div>
      <span className="shrink-0 text-slate-300">›</span>
    </div>
  );

  if (href) {
    return (
      <a
        href={href}
        className="block focus:outline-none focus:ring-2 focus:ring-violet-200 focus:ring-offset-2"
      >
        {content}
      </a>
    );
  }

  return content;
}

function ProfitMapCard({
  label,
  value,
  subtitle,
  footer,
  tone,
  href,
}: {
  label: string;
  value: ReactNode;
  subtitle: ReactNode;
  footer: ReactNode;
  tone: "emerald" | "red" | "orange" | "violet" | "blue";
  href?: string;
}) {
  const colorClassName = getToneColor(tone);
  const barClassName =
    tone === "emerald"
      ? "bg-emerald-500"
      : tone === "red"
        ? "bg-red-400"
        : tone === "orange"
          ? "bg-orange-400"
          : tone === "blue"
            ? "bg-blue-500"
            : "bg-violet-500";

  const content = (
    <div
      className={`rounded-[22px] border p-4 transition hover:-translate-y-0.5 hover:shadow-md ${colorClassName}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-black uppercase tracking-[0.1em]">
            {label}
          </div>
          <div className="mt-2 text-2xl font-black tracking-tight text-slate-950">
            {value}
          </div>
        </div>
        <span className="flex h-8 w-8 items-center justify-center rounded-2xl bg-white/70 text-sm font-black">
          ↗
        </span>
      </div>
      <div className="mt-2 min-h-[34px] text-sm leading-5 text-slate-600">
        {subtitle}
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/70">
        <div
          className={`h-full rounded-full ${barClassName}`}
          style={{ width: "62%" }}
        />
      </div>
      <div className="mt-2 text-xs font-semibold text-slate-500">{footer}</div>
    </div>
  );

  if (href) {
    return (
      <a
        href={href}
        className="block focus:outline-none focus:ring-2 focus:ring-violet-200 focus:ring-offset-2"
      >
        {content}
      </a>
    );
  }

  return content;
}

function ProductThumb({
  meta,
  marketplace,
}: {
  meta: ProductMeta;
  marketplace: "WB" | "Ozon";
}) {
  const initials =
    meta.title
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || marketplace;

  const gradient =
    marketplace === "WB"
      ? "from-violet-100 to-slate-100"
      : "from-blue-100 to-slate-100";

  return (
    <div
      className={`flex h-10 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-gradient-to-br ${gradient} text-[10px] font-black text-slate-500`}
    >
      {meta.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={meta.imageUrl}
          alt={meta.title}
          className="h-full w-full object-cover"
        />
      ) : (
        initials
      )}
    </div>
  );
}

function MarketplacePill({ value }: { value: "WB" | "Ozon" }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-black ${value === "WB" ? "bg-violet-50 text-violet-700" : "bg-blue-50 text-blue-700"}`}
    >
      {value}
    </span>
  );
}

function ActionChip({
  children,
  tone = "slate",
}: {
  children: ReactNode;
  tone?: "emerald" | "red" | "orange" | "violet" | "blue" | "slate";
}) {
  return (
    <span
      className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-black ${getToneColor(tone)}`}
    >
      {children}
    </span>
  );
}

function SummaryBars({ title, rows }: { title: string; rows: SummaryRow[] }) {
  const maxRevenue = Math.max(...rows.map((row) => row.revenue), 1);

  return (
    <section className="rounded-[22px] border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/40">
      <div className="grid grid-cols-[minmax(180px,1fr)_120px_130px_90px] gap-4 text-[11px] font-black uppercase tracking-[0.08em] text-slate-400">
        <h2 className="text-base font-black normal-case tracking-tight text-slate-950">
          {title}
        </h2>
        <div className="text-right">Выручка</div>
        <div className="text-right">Чистая прибыль</div>
        <div className="text-right">Маржа</div>
      </div>

      <div className="mt-4 space-y-3">
        {rows.map((row) => (
          <div
            key={row.name}
            className="grid grid-cols-[minmax(180px,1fr)_120px_130px_90px] items-center gap-4"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-black text-white ${row.name === "Ozon" ? "bg-blue-600" : "bg-violet-600"}`}
                >
                  {row.name === "Ozon"
                    ? "OZ"
                    : row.name === "WB"
                      ? "WB"
                      : row.name.slice(0, 2).toUpperCase()}
                </span>
                <div className="truncate text-sm font-black text-slate-900">
                  {row.name}
                </div>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-violet-600"
                  style={{
                    width: `${Math.max(6, Math.min(100, (row.revenue / maxRevenue) * 100))}%`,
                  }}
                />
              </div>
            </div>
            <div className="text-right text-sm font-bold text-slate-700">
              {formatMoney(row.revenue)}
            </div>
            <div
              className={`text-right text-sm font-black ${row.profit >= 0 ? "text-emerald-600" : "text-red-600"}`}
            >
              {formatMoney(row.profit)}
            </div>
            <div className="text-right text-sm font-bold text-slate-700">
              {formatPercent(row.marginPercent)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function MarketplaceCompanyCell({
  marketplace,
  companyName,
}: {
  marketplace: "WB" | "Ozon";
  companyName: string;
}) {
  return (
    <div className="min-w-0">
      <MarketplacePill value={marketplace} />
      <div className="mt-1 truncate text-[10px] font-bold text-slate-400">
        {companyName}
      </div>
    </div>
  );
}

function TableTab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      className={`rounded-xl px-5 py-1.5 text-[11px] font-black transition focus:outline-none focus:ring-2 focus:ring-violet-200 ${
        active
          ? "bg-violet-600 text-white shadow-lg shadow-violet-100"
          : "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-white"
      }`}
    >
      {children}
    </a>
  );
}

function SkuRowsTable({
  rows,
  mode,
}: {
  rows: InsightRow[];
  mode: "profit" | "loss" | "risk";
}) {
  const actionTone =
    mode === "profit" ? "emerald" : mode === "loss" ? "red" : "orange";

  return (
    <>
      <div className="grid grid-cols-[minmax(230px,1fr)_92px_88px_88px_64px_104px] gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2 text-[10px] font-black uppercase tracking-[0.08em] text-slate-400">
        <div>Товар / артикул</div>
        <div>МП / компания</div>
        <div className="text-right">Выручка</div>
        <div className="text-right">Прибыль</div>
        <div className="text-right">Маржа</div>
        <div className="text-right">Действие</div>
      </div>

      <div>
        {rows.map((row, index) => {
          const profitClassName =
            row.profit < 0 ? "text-red-600" : "text-emerald-600";
          const marginClassName =
            row.marginPercent < 0
              ? "text-red-600"
              : row.marginPercent < 5
                ? "text-orange-600"
                : "text-slate-700";
          const actionLabel =
            mode === "profit"
              ? getRecommendation(row)
              : mode === "loss"
                ? "Разобрать"
                : "Проверить";

          return (
            <div
              key={`${row.companyName}-${row.marketplace}-${row.sku}-${row.vendorCode}-${index}`}
              className="grid grid-cols-[minmax(230px,1fr)_92px_88px_88px_64px_104px] items-center gap-2 border-b border-slate-100 px-4 py-2.5 last:border-b-0"
            >
              <div className="flex min-w-0 items-center gap-2">
                <ProductThumb
                  meta={row.productMeta}
                  marketplace={row.marketplace}
                />
                <div className="min-w-0">
                  <div className="truncate text-xs font-black text-slate-900">
                    {row.productMeta.title}
                  </div>
                  <div className="truncate text-[10px] font-semibold text-slate-400">
                    {row.vendorCode || row.sku || "—"}
                  </div>
                </div>
              </div>
              <MarketplaceCompanyCell
                marketplace={row.marketplace}
                companyName={row.companyName}
              />
              <div className="text-right text-xs font-bold text-slate-700">
                {formatMoney(row.revenue)}
              </div>
              <div
                className={`text-right text-xs font-black ${profitClassName}`}
              >
                {formatMoney(row.profit)}
              </div>
              <div
                className={`text-right text-xs font-black ${marginClassName}`}
              >
                {formatPercent(row.marginPercent)}
              </div>
              <div className="text-right">
                <ActionChip tone={actionTone}>{actionLabel}</ActionChip>
              </div>
            </div>
          );
        })}

        {rows.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-slate-500">
            Нет данных для отображения.
          </div>
        )}
      </div>
    </>
  );
}

function StockRowsTable({ rows }: { rows: StockRow[] }) {
  return (
    <>
      <div className="grid grid-cols-[minmax(230px,1fr)_92px_58px_76px_92px_104px] gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2 text-[10px] font-black uppercase tracking-[0.08em] text-slate-400">
        <div>Товар / артикул</div>
        <div>МП / компания</div>
        <div className="text-right">Ост.</div>
        <div className="text-right">Себест.</div>
        <div className="text-right">Сумма</div>
        <div className="text-right">Действие</div>
      </div>

      <div>
        {rows.map((row, index) => (
          <div
            key={`${row.companyName}-${row.marketplace}-${row.sku}-${row.vendorCode}-${index}`}
            className="grid grid-cols-[minmax(230px,1fr)_92px_58px_76px_92px_104px] items-center gap-2 border-b border-slate-100 px-4 py-2.5 last:border-b-0"
          >
            <div className="flex min-w-0 items-center gap-2">
              <ProductThumb
                meta={row.productMeta}
                marketplace={row.marketplace}
              />
              <div className="min-w-0">
                <div className="truncate text-xs font-black text-slate-900">
                  {row.productMeta.title}
                </div>
                <div className="truncate text-[10px] font-semibold text-slate-400">
                  {row.vendorCode || row.sku || "—"}
                </div>
              </div>
            </div>
            <MarketplaceCompanyCell
              marketplace={row.marketplace}
              companyName={row.companyName}
            />
            <div className="text-right text-xs font-bold text-slate-700">
              {formatNumber(row.quantity)}
            </div>
            <div className="text-right text-xs font-bold text-slate-700">
              {formatMoney(row.unitCost)}
            </div>
            <div className="text-right text-xs font-black text-red-600">
              {formatMoney(row.frozenMoney)}
            </div>
            <div className="text-right">
              <ActionChip tone="orange">Освободить</ActionChip>
            </div>
          </div>
        ))}

        {rows.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-slate-500">
            Нет данных по остаткам или себестоимости.
          </div>
        )}
      </div>
    </>
  );
}

function DataPanel({
  title,
  eyebrow,
  tabs,
  children,
}: {
  title: string;
  eyebrow: string;
  tabs: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[22px] border border-slate-200 bg-white shadow-sm shadow-slate-200/40">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div>
          <div className="text-[10px] font-black uppercase tracking-[0.13em] text-slate-400">
            {eyebrow}
          </div>
          <h2 className="mt-0.5 text-base font-black tracking-tight text-slate-950">
            {title}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {tabs}
          <a
            href="#"
            className="ml-2 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-1.5 text-[11px] font-black text-slate-600"
          >
            Смотреть все
          </a>
        </div>
      </div>

      {children}

      <div className="border-t border-slate-100 px-4 py-2 text-center">
        <a
          href="#"
          className="text-xs font-black text-slate-500 transition hover:text-violet-600"
        >
          Смотреть все →
        </a>
      </div>
    </section>
  );
}

function SkuProfitPanel({
  active,
  profitRows,
  lossRows,
  profitHref,
  lossHref,
}: {
  active: "profit" | "loss";
  profitRows: InsightRow[];
  lossRows: InsightRow[];
  profitHref: string;
  lossHref: string;
}) {
  const rows = active === "loss" ? lossRows : profitRows;

  return (
    <DataPanel
      eyebrow="SKU"
      title="SKU по прибыли"
      tabs={
        <>
          <TableTab href={profitHref} active={active === "profit"}>
            Топ прибыльных
          </TableTab>
          <TableTab href={lossHref} active={active === "loss"}>
            Убыточные
          </TableTab>
        </>
      }
    >
      <SkuRowsTable rows={rows} mode={active === "loss" ? "loss" : "profit"} />
    </DataPanel>
  );
}

function ControlPanel({
  active,
  riskRows,
  frozenRows,
  riskHref,
  frozenHref,
}: {
  active: "risk" | "frozen";
  riskRows: InsightRow[];
  frozenRows: StockRow[];
  riskHref: string;
  frozenHref: string;
}) {
  return (
    <DataPanel
      eyebrow="Контроль"
      title="Товары под контролем"
      tabs={
        <>
          <TableTab href={riskHref} active={active === "risk"}>
            Риск по марже
          </TableTab>
          <TableTab href={frozenHref} active={active === "frozen"}>
            Замороженные деньги
          </TableTab>
        </>
      }
    >
      {active === "frozen" ? (
        <StockRowsTable rows={frozenRows} />
      ) : (
        <SkuRowsTable rows={riskRows} mode="risk" />
      )}
    </DataPanel>
  );
}

// INSIGHTS_DETAIL_PANEL_V1: верхние KPI открывают свернутую детализацию через query detail.
type DetailView =
  "revenue" | "profit" | "cashflow" | "loss" | "frozen" | "potential";

type DetailMetric = {
  label: string;
  value: ReactNode;
  helper: ReactNode;
  tone?: "emerald" | "red" | "orange" | "violet" | "blue" | "slate";
};

function isDetailView(value: string | undefined): value is DetailView {
  return (
    value === "revenue" ||
    value === "profit" ||
    value === "cashflow" ||
    value === "loss" ||
    value === "frozen" ||
    value === "potential"
  );
}

function DetailMetricCard({ metric }: { metric: DetailMetric }) {
  const tone = metric.tone ?? "slate";
  const colorClassName =
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "red"
        ? "text-red-600"
        : tone === "orange"
          ? "text-orange-600"
          : tone === "violet"
            ? "text-violet-700"
            : tone === "blue"
              ? "text-blue-700"
              : "text-slate-950";

  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
      <div className="text-[10px] font-black uppercase tracking-[0.11em] text-slate-400">
        {metric.label}
      </div>
      <div
        className={`mt-1 text-lg font-black tracking-tight ${colorClassName}`}
      >
        {metric.value}
      </div>
      <div className="mt-1 text-xs font-semibold leading-4 text-slate-500">
        {metric.helper}
      </div>
    </div>
  );
}

function DetailPanel({
  title,
  description,
  closeHref,
  metrics,
  children,
}: {
  title: string;
  description: ReactNode;
  closeHref: string;
  metrics: DetailMetric[];
  children: ReactNode;
}) {
  return (
    <section
      id="detail-panel"
      className="scroll-mt-4 overflow-hidden rounded-[24px] border border-violet-100 bg-white shadow-sm shadow-violet-100/60"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 bg-gradient-to-r from-violet-50 via-white to-white px-4 py-4">
        <div className="min-w-0">
          <div className="text-[10px] font-black uppercase tracking-[0.14em] text-violet-500">
            Детализация блока
          </div>
          <h2 className="mt-1 text-xl font-black tracking-tight text-slate-950">
            {title}
          </h2>
          <div className="mt-1 max-w-4xl text-sm leading-5 text-slate-500">
            {description}
          </div>
        </div>
        <a
          href={closeHref}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-xs font-black text-slate-600 shadow-sm transition hover:border-violet-200 hover:text-violet-700"
        >
          Свернуть
        </a>
      </div>

      <div className="grid gap-3 border-b border-slate-100 p-4 md:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <DetailMetricCard key={metric.label} metric={metric} />
        ))}
      </div>

      <div className="p-4">{children}</div>
    </section>
  );
}

function buildInsightRows(
  analyticsByCompany: Array<{
    companyName: string;
    wb: Awaited<ReturnType<typeof getProfitAnalytics>>;
    ozon: Awaited<ReturnType<typeof getProfitAnalyticsOzon>>;
  }>,
  getMeta: (
    marketplace: "WB" | "Ozon",
    vendorCode: string,
    sku: string,
  ) => ProductMeta,
) {
  return analyticsByCompany.flatMap(({ companyName, wb, ozon }) => [
    ...wb.rows.map((row) => {
      const revenue = getAmount(row.revenue);
      const profit = getAmount(row.netProfitAfterTax);
      const sku = String(row.nmId ?? "");
      const vendorCode = String(row.vendorCode ?? "");

      return {
        companyName,
        marketplace: "WB" as const,
        sku,
        vendorCode,
        salesQty: getAmount(row.netSalesQty),
        revenue,
        profit,
        marginPercent: getMargin(revenue, profit),
        productMeta: getMeta("WB", vendorCode, sku),
      };
    }),

    ...ozon.rows.map((row) => {
      const revenue = getAmount(row.revenue);
      const profit = getAmount(row.netProfitAfterTax);
      const sku = String(row.nmId ?? "");
      const vendorCode = String(row.vendorCode ?? "");

      return {
        companyName,
        marketplace: "Ozon" as const,
        sku,
        vendorCode,
        salesQty: getAmount(row.netSalesQty),
        revenue,
        profit,
        marginPercent: getMargin(revenue, profit),
        productMeta: getMeta("Ozon", vendorCode, sku),
      };
    }),
  ]);
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams?: Promise<{
    company?: string;
    companyName?: string;
    dateFrom?: string;
    dateTo?: string;
    skuView?: string;
    controlView?: string;
    detail?: string;
  }>;
}) {
  const params = searchParams ? await searchParams : {};

  const defaultPeriod = getDefaultLastCompletedWeekRange();
  const dateFrom = params.dateFrom ?? defaultPeriod.dateFrom;
  const dateTo = params.dateTo ?? defaultPeriod.dateTo;
  const selectedCompany = params.company ?? params.companyName ?? "ALL";
  const skuView = params.skuView === "loss" ? "loss" : "profit";
  const controlView = params.controlView === "frozen" ? "frozen" : "risk";
  const activeDetail = isDetailView(params.detail) ? params.detail : null;
  const previousPeriod = getPreviousPeriodRange(dateFrom, dateTo);

  const companies = await prisma.company.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });

  const companyNames =
    selectedCompany === "ALL"
      ? companies.map((company) => company.name)
      : [selectedCompany];

  // Тяжёлые финансовые расчёты выполняем последовательно. PostgreSQL pool
  // production ограничен, а параллельный запуск WB/Ozon и двух периодов
  // создавал очередь запросов и пик памяти до OOM/HTTP 502.
  const ownerReport = await buildDailyReport({
    from: dateFrom,
    to: dateTo,
    skipComparison: true,
  });

  const previousOwnerReport = await buildDailyReport({
    from: previousPeriod.dateFrom,
    to: previousPeriod.dateTo,
    skipComparison: true,
  });

  const analyticsByCompany: Array<{
    companyName: string;
    wb: Awaited<ReturnType<typeof getProfitAnalytics>>;
    ozon: Awaited<ReturnType<typeof getProfitAnalyticsOzon>>;
  }> = [];

  for (const companyName of companyNames) {
    const wb = await getProfitAnalytics({
      dateFrom,
      dateTo,
      companyName,
      skipComparison: true,
    });
    const ozon = await getProfitAnalyticsOzon({
      dateFrom,
      dateTo,
      companyName,
      skipComparison: true,
    });

    analyticsByCompany.push({ companyName, wb, ozon });
  }

  const previousAnalyticsByCompany: Array<{
    companyName: string;
    wb: Awaited<ReturnType<typeof getProfitAnalytics>>;
    ozon: Awaited<ReturnType<typeof getProfitAnalyticsOzon>>;
  }> = [];

  for (const companyName of companyNames) {
    const wb = await getProfitAnalytics({
      dateFrom: previousPeriod.dateFrom,
      dateTo: previousPeriod.dateTo,
      companyName,
      skipComparison: true,
    });
    const ozon = await getProfitAnalyticsOzon({
      dateFrom: previousPeriod.dateFrom,
      dateTo: previousPeriod.dateTo,
      companyName,
      skipComparison: true,
    });

    previousAnalyticsByCompany.push({ companyName, wb, ozon });
  }

  const [
    productCosts,
    wbStocks,
    ozonStocks,
    wbProductCards,
    ozonProducts,
  ] = await Promise.all([
    prisma.productCost.findMany({
      select: {
        vendorCode: true,
        nmId: true,
        name: true,
        costPrice: true,
        costDate: true,
      },
      orderBy: [{ costDate: "desc" }, { createdAt: "desc" }],
    }),
    prisma.wbStock.findMany({
      where: selectedCompany !== "ALL" ? { companyName: selectedCompany } : {},
    }),
    prisma.ozonStock.findMany({
      where: selectedCompany !== "ALL" ? { companyName: selectedCompany } : {},
    }),
    prisma.wbProductCard.findMany({
      where: selectedCompany !== "ALL" ? { companyName: selectedCompany } : {},
      select: {
        vendorCode: true,
        nmId: true,
        title: true,
        subjectName: true,
        photoSmallUrl: true,
        photoBigUrl: true,
        lastSyncedAt: true,
      },
      orderBy: { lastSyncedAt: "desc" },
    }),
    prisma.ozonProduct.findMany({
      where: selectedCompany !== "ALL" ? { companyName: selectedCompany } : {},
      select: {
        vendorCode: true,
        sku: true,
        productName: true,
        imageSmallUrl: true,
        imageUrl: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const costByVendorCode = new Map<string, number>();
  const metaByVendorCode = new Map<string, ProductMeta>();
  const metaBySku = new Map<string, ProductMeta>();

  const rememberMeta = ({
    marketplace,
    vendorCode,
    sku,
    title,
    subtitle,
    imageUrl,
  }: {
    marketplace: "WB" | "Ozon";
    vendorCode: string;
    sku: string;
    title: string;
    subtitle: string;
    imageUrl?: string | null;
  }) => {
    const normalizedVendorCode = normalizeVendorCode(vendorCode);
    const normalizedSku = normalizeVendorCode(sku);
    const meta: ProductMeta = {
      title: title || vendorCode || sku || "Товар",
      subtitle,
      imageUrl,
      vendorCode,
      sku,
    };

    if (normalizedVendorCode) {
      metaByVendorCode.set(`${marketplace}:${normalizedVendorCode}`, meta);
    }

    if (normalizedSku) {
      metaBySku.set(`${marketplace}:${normalizedSku}`, meta);
    }
  };

  for (const card of wbProductCards) {
    rememberMeta({
      marketplace: "WB",
      vendorCode: card.vendorCode ?? "",
      sku: card.nmId ?? "",
      title: card.title ?? card.vendorCode ?? card.nmId ?? "WB товар",
      subtitle: card.subjectName ?? "WB",
      imageUrl: card.photoSmallUrl ?? card.photoBigUrl,
    });
  }

  for (const product of ozonProducts) {
    rememberMeta({
      marketplace: "Ozon",
      vendorCode: product.vendorCode ?? "",
      sku: product.sku ?? "",
      title:
        product.productName ??
        product.vendorCode ??
        product.sku ??
        "Ozon товар",
      subtitle: "Ozon",
      imageUrl: product.imageSmallUrl ?? product.imageUrl,
    });
  }

  for (const cost of productCosts) {
    const key = normalizeVendorCode(cost.vendorCode);

    if (key && !costByVendorCode.has(key)) {
      costByVendorCode.set(key, getAmount(cost.costPrice));
    }

    if (key && !metaByVendorCode.has(`WB:${key}`)) {
      const meta: ProductMeta = {
        title: cost.name ?? cost.vendorCode,
        subtitle: "ProductCost",
        vendorCode: cost.vendorCode,
        sku: cost.nmId ?? "",
        imageUrl: null,
      };
      metaByVendorCode.set(`WB:${key}`, meta);
    }
  }

  const getMeta = (
    marketplace: "WB" | "Ozon",
    vendorCode: string,
    sku: string,
  ): ProductMeta => {
    const vendorKey = normalizeVendorCode(vendorCode);
    const skuKey = normalizeVendorCode(sku);

    return (
      (vendorKey
        ? metaByVendorCode.get(`${marketplace}:${vendorKey}`)
        : undefined) ??
      (skuKey ? metaBySku.get(`${marketplace}:${skuKey}`) : undefined) ??
      (vendorKey ? metaByVendorCode.get(`WB:${vendorKey}`) : undefined) ?? {
        title: vendorCode || sku || "Товар",
        subtitle: marketplace,
        vendorCode,
        sku,
        imageUrl: null,
      }
    );
  };

  const rows = buildInsightRows(analyticsByCompany, getMeta);
  const previousRows = buildInsightRows(previousAnalyticsByCompany, getMeta);

  const allProfitableRows = rows
    .filter((row) => row.profit > 0)
    .sort((a, b) => b.profit - a.profit);

  const allLossRows = rows
    .filter((row) => row.profit < 0)
    .sort((a, b) => a.profit - b.profit);

  const allLowMarginRows = rows
    .filter((row) => row.revenue > 0 && row.marginPercent < 5)
    .sort((a, b) => a.marginPercent - b.marginPercent);

  const profitableRows = allProfitableRows.slice(0, 5);
  const lossRows = allLossRows.slice(0, 5);
  const lowMarginRows = allLowMarginRows.slice(0, 5);

  // KPI_SOURCE_DASHBOARD_OWNER_REPORT:
  // верхние KPI "Центра прибыли" берём из той же управленческой модели, что Dashboard.
  const dashboardTotals = summarizeOwnerReportForInsights(
    ownerReport,
    companyNames,
  );
  const previousDashboardTotals = summarizeOwnerReportForInsights(
    previousOwnerReport,
    companyNames,
  );

  const totalRevenue = dashboardTotals.totalRevenue;
  const totalProfit = dashboardTotals.netProfit;
  const profitAfterOwnerWithdrawals =
    dashboardTotals.profitAfterOwnerWithdrawal;
  const cashFlowResult = dashboardTotals.cashFlowResult;
  // KPI_CASH_FLOW_REPLACES_RENTABILITY_BLOCK
  const marginPercent = getMargin(totalRevenue, totalProfit);

  const previousRevenue = previousDashboardTotals.totalRevenue;
  const previousProfit = previousDashboardTotals.netProfit;
  const previousProfitAfterOwnerWithdrawals =
    previousDashboardTotals.profitAfterOwnerWithdrawal;
  const previousCashFlowResult = previousDashboardTotals.cashFlowResult;
  const previousMarginPercent = getMargin(previousRevenue, previousProfit);

  const lossSkuCount = allLossRows.length;
  const totalLossAmount = allLossRows.reduce((sum, row) => sum + row.profit, 0);
  const profitableProfit = allProfitableRows.reduce(
    (sum, row) => sum + row.profit,
    0,
  );

  const previousLossSkuCount = previousRows.filter(
    (row) => row.profit < 0,
  ).length;
  const previousProfitableProfit = previousRows
    .filter((row) => row.profit > 0)
    .reduce((sum, row) => sum + row.profit, 0);

  const stockRows: StockRow[] = [
    ...wbStocks.map((stock) => {
      const row = stock as unknown as Record<string, unknown>;
      const vendorCode = getAnyString(row, [
        "vendorCode",
        "supplierArticle",
        "article",
        "sku",
      ]);
      const sku = getAnyString(row, ["nmId", "sku", "barcode"]);
      const quantity = getAnyNumber(row, [
        "quantity",
        "qty",
        "stockQty",
        "availableQty",
        "available",
        "quantityFull",
      ]);
      const unitCost =
        costByVendorCode.get(normalizeVendorCode(vendorCode)) ?? 0;

      return {
        companyName: getAnyString(row, ["companyName"]) || "—",
        marketplace: "WB" as const,
        sku,
        vendorCode,
        quantity,
        unitCost,
        frozenMoney: quantity * unitCost,
        productMeta: getMeta("WB", vendorCode, sku),
      };
    }),
    ...ozonStocks.map((stock) => {
      const row = stock as unknown as Record<string, unknown>;
      const vendorCode = getAnyString(row, [
        "vendorCode",
        "offerId",
        "article",
        "sku",
      ]);
      const sku = getAnyString(row, ["sku", "productId", "barcode"]);
      const quantity = getAnyNumber(row, [
        "quantity",
        "qty",
        "stockQty",
        "availableQty",
        "available",
        "availableToSell",
      ]);
      const unitCost =
        costByVendorCode.get(normalizeVendorCode(vendorCode)) ?? 0;

      return {
        companyName: getAnyString(row, ["companyName"]) || "—",
        marketplace: "Ozon" as const,
        sku,
        vendorCode,
        quantity,
        unitCost,
        frozenMoney: quantity * unitCost,
        productMeta: getMeta("Ozon", vendorCode, sku),
      };
    }),
  ]
    .filter((row) => row.quantity > 0 && row.unitCost > 0)
    .sort((a, b) => b.frozenMoney - a.frozenMoney);

  const frozenMoney = stockRows.reduce((sum, row) => sum + row.frozenMoney, 0);
  const topFrozenRows = stockRows.slice(0, 5);

  const marketplaceSummaries = dashboardTotals.marketplaceSummaries;
  const companySummaries = dashboardTotals.companySummaries;

  const revenueDelta = getDeltaPercent(totalRevenue, previousRevenue);
  const profitDelta = getDeltaPercent(totalProfit, previousProfit);
  const profitAfterOwnerWithdrawalsDelta = getDeltaPercent(
    profitAfterOwnerWithdrawals,
    previousProfitAfterOwnerWithdrawals,
  );
  const marginDelta = Number.isFinite(previousMarginPercent)
    ? marginPercent - previousMarginPercent
    : null;
  const cashFlowDelta = getDeltaPercent(cashFlowResult, previousCashFlowResult);
  const lossSkuDelta = previousLossSkuCount
    ? ((lossSkuCount - previousLossSkuCount) / previousLossSkuCount) * 100
    : null;
  const potentialDelta = getDeltaPercent(
    profitableProfit,
    previousProfitableProfit,
  );
  const frozenShare =
    frozenMoney && totalRevenue
      ? (frozenMoney / Math.max(totalRevenue, 1)) * 100
      : 0;
  const periodLabel = `${formatDateRu(dateFrom)} — ${formatDateRu(dateTo)}`;
  const makeInsightsHref = (
    updates: Record<string, string | null | undefined>,
    anchor = "data-panels",
  ) => {
    const query = new URLSearchParams({
      company: selectedCompany,
      dateFrom,
      dateTo,
      skuView,
      controlView,
    });

    if (activeDetail) {
      query.set("detail", activeDetail);
    }

    for (const [key, value] of Object.entries(updates)) {
      if (value === null || value === undefined || value === "") {
        query.delete(key);
      } else {
        query.set(key, value);
      }
    }

    return `/insights?${query.toString()}${anchor ? `#${anchor}` : ""}`;
  };
  const makeDetailHref = (
    detail: DetailView,
    updates: Record<string, string> = {},
  ) => makeInsightsHref({ ...updates, detail }, "detail-panel");
  const closeDetailHref = makeInsightsHref({ detail: null }, "");

  const detailTitle =
    activeDetail === "revenue"
      ? "Экономический оборот"
      : activeDetail === "profit"
        ? "Чистая прибыль"
        : activeDetail === "cashflow"
          ? "Денежный поток"
          : activeDetail === "loss"
            ? "Убыточные SKU"
            : activeDetail === "frozen"
              ? "Заморожено в остатках"
              : activeDetail === "potential"
                ? "Потенциал роста"
                : "";

  const detailDescription =
    activeDetail === "revenue"
      ? "Разбор оборота по маркетплейсам и налоговой базы. Здесь важно не смешивать экономический оборот с налоговой выручкой."
      : activeDetail === "profit"
        ? "Разбор чистой прибыли, рентабельности и результата после вывода собственника."
        : activeDetail === "cashflow"
          ? "Денежный поток показывает разницу между поступлениями и фактическими выплатами. Это контроль ликвидности, а не прибыль по SKU."
          : activeDetail === "loss"
            ? "Список SKU, которые сейчас съедают прибыль. Их нужно разбирать по рекламе, цене, логистике и себестоимости."
            : activeDetail === "frozen"
              ? "Товары, в которых заморожены деньги в остатках. Цель — высвободить оборотный капитал без просадки прибыльного ядра."
              : activeDetail === "potential"
                ? "Прибыльные SKU, которые можно масштабировать: поставки, реклама и контроль наличия размеров."
                : "";

  const detailMetrics: DetailMetric[] =
    activeDetail === "revenue"
      ? [
          {
            label: "Экономический оборот",
            value: formatMoney(totalRevenue),
            helper: `${periodLabel} · главная база масштаба`,
            tone: "emerald",
          },
          {
            label: "WB",
            value: formatMoney(dashboardTotals.wbRevenue),
            helper: `${formatPercent(totalRevenue ? (dashboardTotals.wbRevenue / totalRevenue) * 100 : 0)} от оборота`,
            tone: "violet",
          },
          {
            label: "Ozon",
            value: formatMoney(dashboardTotals.ozonRevenue),
            helper: `${formatPercent(totalRevenue ? (dashboardTotals.ozonRevenue / totalRevenue) * 100 : 0)} от оборота`,
            tone: "blue",
          },
          {
            label: "Налоговая выручка",
            value: formatMoney(dashboardTotals.taxableRevenue),
            helper: `${formatPercent(totalRevenue ? (dashboardTotals.taxableRevenue / totalRevenue) * 100 : 0)} от экономического оборота`,
            tone: "slate",
          },
        ]
      : activeDetail === "profit"
        ? [
            {
              label: "Чистая прибыль",
              value: formatMoney(totalProfit),
              helper: `${formatPercent(marginPercent)} рентабельность`,
              tone: totalProfit >= 0 ? "emerald" : "red",
            },
            {
              label: "После вывода",
              value: formatMoney(profitAfterOwnerWithdrawals),
              helper: `Вывод собственника: ${formatMoney(dashboardTotals.ownerWithdrawals)}`,
              tone: profitAfterOwnerWithdrawals >= 0 ? "emerald" : "red",
            },
            {
              label: "Прибыльные SKU",
              value: formatMoney(profitableProfit),
              helper: `${formatNumber(allProfitableRows.length)} SKU в плюсе`,
              tone: "emerald",
            },
            {
              label: "Убытки SKU",
              value: formatMoney(totalLossAmount),
              helper: `${formatNumber(lossSkuCount)} SKU требуют решения`,
              tone: lossSkuCount > 0 ? "red" : "emerald",
            },
          ]
        : activeDetail === "cashflow"
          ? [
              {
                label: "Денежный поток",
                value: formatMoney(cashFlowResult),
                helper: "Поступления минус выплаты",
                tone: cashFlowResult >= 0 ? "emerald" : "red",
              },
              {
                label: "Чистая прибыль",
                value: formatMoney(totalProfit),
                helper: "Экономический результат периода",
                tone: totalProfit >= 0 ? "emerald" : "red",
              },
              {
                label: "После вывода",
                value: formatMoney(profitAfterOwnerWithdrawals),
                helper: `Вывод собственника: ${formatMoney(dashboardTotals.ownerWithdrawals)}`,
                tone: profitAfterOwnerWithdrawals >= 0 ? "emerald" : "red",
              },
              {
                label: "Оборот",
                value: formatMoney(totalRevenue),
                helper: "База для оценки нагрузки",
                tone: "slate",
              },
            ]
          : activeDetail === "loss"
            ? [
                {
                  label: "Убыточные SKU",
                  value: formatNumber(lossSkuCount),
                  helper: "Количество SKU с отрицательной прибылью",
                  tone: lossSkuCount > 0 ? "red" : "emerald",
                },
                {
                  label: "Суммарный убыток",
                  value: formatMoney(totalLossAmount),
                  helper: `${formatPercent(totalRevenue ? Math.abs(totalLossAmount / totalRevenue) * 100 : 0)} от оборота`,
                  tone: "red",
                },
                {
                  label: "Риск по марже",
                  value: `${formatNumber(allLowMarginRows.length)} SKU`,
                  helper: "Маржа ниже 5%",
                  tone: "orange",
                },
                {
                  label: "Первое действие",
                  value: "Разбор",
                  helper: "Реклама → цена → логистика → себестоимость",
                  tone: "slate",
                },
              ]
            : activeDetail === "frozen"
              ? [
                  {
                    label: "Заморожено",
                    value: formatMoney(frozenMoney),
                    helper: `${formatPercent(frozenShare)} от оборота`,
                    tone: "orange",
                  },
                  {
                    label: "SKU в остатках",
                    value: formatNumber(stockRows.length),
                    helper: "С ненулевой себестоимостью",
                    tone: "slate",
                  },
                  {
                    label: "ТОП-5 остатков",
                    value: formatMoney(
                      topFrozenRows.reduce(
                        (sum, row) => sum + row.frozenMoney,
                        0,
                      ),
                    ),
                    helper: "Крупнейшие позиции по заморозке",
                    tone: "orange",
                  },
                  {
                    label: "Цель",
                    value: "Высвободить",
                    helper: "Не трогая прибыльное ядро",
                    tone: "violet",
                  },
                ]
              : activeDetail === "potential"
                ? [
                    {
                      label: "Потенциал роста",
                      value: formatMoney(profitableProfit),
                      helper: "Суммарная прибыль прибыльных SKU",
                      tone: "violet",
                    },
                    {
                      label: "Прибыльные SKU",
                      value: formatNumber(allProfitableRows.length),
                      helper: "Кандидаты на масштабирование",
                      tone: "emerald",
                    },
                    {
                      label: "Маржа",
                      value: formatPercent(marginPercent),
                      helper: "Рентабельность всего периода",
                      tone: "emerald",
                    },
                    {
                      label: "ДРР",
                      value:
                        dashboardTotals.drr === null
                          ? "—"
                          : formatPercent(dashboardTotals.drr),
                      helper: "От экономического оборота",
                      tone: "orange",
                    },
                  ]
                : [];

  const detailContent =
    activeDetail === "revenue" ? (
      <div className="grid gap-4 xl:grid-cols-2">
        <SummaryBars
          title="Оборот по маркетплейсам"
          rows={marketplaceSummaries}
        />
        <SummaryBars title="Оборот по компаниям" rows={companySummaries} />
      </div>
    ) : activeDetail === "profit" ? (
      <div className="overflow-hidden rounded-[22px] border border-slate-200 bg-white">
        <SkuRowsTable rows={profitableRows} mode="profit" />
      </div>
    ) : activeDetail === "cashflow" ? (
      <div className="grid gap-3 md:grid-cols-3">
        <ExecutiveItem
          icon="↔"
          title="ДДС отрицательный — нужен контроль выплат"
          text={`Денежный поток за период: ${formatMoney(cashFlowResult)}. Сверьте крупные выплаты, кредиты и личные расходы.`}
          tone={cashFlowResult >= 0 ? "emerald" : "red"}
        />
        <ExecutiveItem
          icon="₽"
          title="Прибыль и деньги — разные показатели"
          text={`Чистая прибыль: ${formatMoney(totalProfit)}. После вывода: ${formatMoney(profitAfterOwnerWithdrawals)}.`}
          tone={totalProfit >= 0 ? "emerald" : "red"}
        />
        <ExecutiveItem
          icon="▣"
          title="Остатки влияют на ликвидность"
          text={`В товарах заморожено ${formatMoney(frozenMoney)}. Это деньги, которые не участвуют в обороте.`}
          tone="orange"
        />
      </div>
    ) : activeDetail === "loss" ? (
      <div className="overflow-hidden rounded-[22px] border border-slate-200 bg-white">
        <SkuRowsTable rows={lossRows} mode="loss" />
      </div>
    ) : activeDetail === "frozen" ? (
      <div className="overflow-hidden rounded-[22px] border border-slate-200 bg-white">
        <StockRowsTable rows={topFrozenRows} />
      </div>
    ) : activeDetail === "potential" ? (
      <div className="overflow-hidden rounded-[22px] border border-slate-200 bg-white">
        <SkuRowsTable rows={profitableRows} mode="profit" />
      </div>
    ) : null;

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1780px] space-y-4">
        <section className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/50">
          <div className="grid gap-4 xl:grid-cols-[minmax(300px,1fr)_minmax(680px,auto)] xl:items-start">
            <div className="min-w-0">
              <h1 className="text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">
                Центр прибыли
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-5 text-slate-500">
                Главная панель собственника: прибыль, убытки, точки роста и
                товары, которые требуют решения.
              </p>
            </div>

            <div className="space-y-2">
              <form className="grid gap-3 rounded-[22px] border border-slate-200 bg-white p-3 shadow-sm md:grid-cols-[210px_150px_150px_130px_110px]">
                <label className="block">
                  <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
                    Компания
                  </span>
                  <select
                    name="company"
                    defaultValue={selectedCompany}
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700 outline-none transition focus:border-indigo-200 focus:bg-white"
                  >
                    <option value="ALL">Все компании</option>
                    {companies.map((company) => (
                      <option key={company.id} value={company.name}>
                        {company.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
                    Дата от
                  </span>
                  <input
                    type="date"
                    name="dateFrom"
                    defaultValue={dateFrom}
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700 outline-none transition focus:border-indigo-200 focus:bg-white"
                  />
                </label>

                <label className="block">
                  <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
                    Дата до
                  </span>
                  <input
                    type="date"
                    name="dateTo"
                    defaultValue={dateTo}
                    className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-700 outline-none transition focus:border-indigo-200 focus:bg-white"
                  />
                </label>

                <div className="flex items-end">
                  <button className="w-full rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-black text-white shadow-lg shadow-violet-200 transition hover:bg-violet-700">
                    Применить
                  </button>
                </div>

                <div className="flex items-end">
                  <span className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-center text-xs font-black text-slate-600">
                    Период:{" "}
                    {Math.max(
                      1,
                      Math.round(
                        (new Date(`${dateTo}T00:00:00`).getTime() -
                          new Date(`${dateFrom}T00:00:00`).getTime()) /
                          (24 * 60 * 60 * 1000),
                      ) + 1,
                    )}{" "}
                    дней
                  </span>
                </div>
              </form>
            </div>
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
          <KpiCard
            title="Экономический оборот"
            value={formatMoney(totalRevenue)}
            subtitle={
              <span className="space-y-1">
                <span className="block">
                  WB: {formatMoney(dashboardTotals.wbRevenue)} · Ozon:{" "}
                  {formatMoney(dashboardTotals.ozonRevenue)}
                </span>
                <span className="block text-[10px] font-black text-slate-500 sm:text-[11px]">
                  Налоговая: {formatMoney(dashboardTotals.taxableRevenue)} ·
                  реклама / ДРР: {formatMoney(dashboardTotals.adsCost)} /{" "}
                  {dashboardTotals.drr === null
                    ? "—"
                    : formatPercent(dashboardTotals.drr)}{" "}
                  · от налоговой{" "}
                  {dashboardTotals.drrByTaxableRevenue === null
                    ? "—"
                    : formatPercent(dashboardTotals.drrByTaxableRevenue)}
                </span>
              </span>
            }
            tone="emerald"
            icon="₽"
            delta={revenueDelta}
            href={makeDetailHref("revenue", { skuView: "profit" })}
          />
          <KpiCard
            title="Чистая прибыль"
            value={formatMoney(totalProfit)}
            subtitle={
              <span className="space-y-1">
                <span className="block">
                  Рентабельность {formatPercent(marginPercent)}
                </span>
                <span
                  className={`inline-flex rounded-lg px-2 py-1 text-[11px] font-black leading-none sm:text-xs ${profitAfterOwnerWithdrawals >= 0 ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}
                >
                  После вывода: {formatMoney(profitAfterOwnerWithdrawals)}
                </span>
              </span>
            }
            tone={totalProfit >= 0 ? "emerald" : "red"}
            icon="↗"
            delta={profitDelta}
            href={makeDetailHref("profit", { skuView: "profit" })}
          />
          <KpiCard
            title="Денежный поток"
            value={formatMoney(cashFlowResult)}
            subtitle="Поступления − выплаты"
            tone={cashFlowResult >= 0 ? "emerald" : "red"}
            icon="↔"
            delta={cashFlowDelta}
            href={makeDetailHref("cashflow")}
          />
          <KpiCard
            title="Убыточные SKU"
            value={formatNumber(lossSkuCount)}
            subtitle="Требуют решения"
            tone={lossSkuCount > 0 ? "red" : "emerald"}
            icon="△"
            delta={lossSkuDelta}
            inverseDelta
            href={makeDetailHref("loss", { skuView: "loss" })}
          />
          <KpiCard
            title="Заморожено в остатках"
            value={formatMoney(frozenMoney)}
            subtitle={`${formatPercent(frozenShare)} от оборота`}
            tone={frozenMoney > 0 ? "orange" : "slate"}
            icon="▣"
            delta={null}
            inverseDelta
            href={makeDetailHref("frozen", { controlView: "frozen" })}
          />
          <KpiCard
            title="Потенциал роста"
            value={formatMoney(profitableProfit)}
            subtitle="Оценка доп. прибыли"
            tone="violet"
            icon="◎"
            delta={potentialDelta}
            href={makeDetailHref("potential", { skuView: "profit" })}
          />
        </section>

        {activeDetail && detailContent ? (
          <DetailPanel
            title={detailTitle}
            description={detailDescription}
            closeHref={closeDetailHref}
            metrics={detailMetrics}
          >
            {detailContent}
          </DetailPanel>
        ) : null}

        <section className="grid items-stretch gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(520px,0.95fr)]">
          <section className="h-full rounded-[22px] border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/40">
            <h2 className="text-lg font-black tracking-tight text-slate-950">
              Что происходит с прибылью
            </h2>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <ExecutiveItem
                icon="✓"
                title={
                  totalProfit >= 0
                    ? `Бизнес в плюсе: чистая прибыль ${formatMoney(totalProfit)}`
                    : `Бизнес в минусе: ${formatMoney(totalProfit)}`
                }
                text={`Рентабельность ${formatPercent(marginPercent)}. После вывода собственникам: ${formatMoney(profitAfterOwnerWithdrawals)}.`}
                tone={totalProfit >= 0 ? "emerald" : "red"}
                href={makeInsightsHref({ skuView: "profit" })}
              />
              <ExecutiveItem
                icon="△"
                title={`${formatNumber(lossSkuCount)} SKU убыточных: суммарные убытки ${formatMoney(totalLossAmount)}`}
                text="Сначала проверить рекламу, цену, логистику и себестоимость."
                tone={lossSkuCount > 0 ? "red" : "emerald"}
                href={makeInsightsHref({ skuView: "loss" })}
              />
              <ExecutiveItem
                icon="▣"
                title={`В остатках заморожено ${formatMoney(frozenMoney)}`}
                text="Нужен контроль оборачиваемости и план высвобождения оборотного капитала."
                tone={frozenMoney > 0 ? "orange" : "slate"}
                href={makeInsightsHref({ controlView: "frozen" })}
              />
              <ExecutiveItem
                icon="↗"
                title={`Потенциал роста: ${formatMoney(profitableProfit)} прибыли`}
                text="Расширяйте продажи прибыльных SKU и усиливайте поставки там, где маржа стабильна."
                tone="violet"
                href={makeInsightsHref({ skuView: "profit" })}
              />
            </div>
          </section>

          <section className="h-full rounded-[22px] border border-slate-200 bg-white p-4 shadow-sm shadow-slate-200/40">
            <h2 className="text-lg font-black tracking-tight text-slate-950">
              Рекомендации руководителю
            </h2>
            <div className="mt-4 grid gap-2.5">
              <PriorityRow
                priority="Приоритет 1"
                tone="red"
                text={`Выведите ${formatNumber(lossSkuCount)} убыточных SKU из рекламы и пересмотрите цену.`}
                href={makeInsightsHref({ skuView: "loss" })}
              />
              <PriorityRow
                priority="Приоритет 2"
                tone="orange"
                text={`Освободите ${formatMoney(frozenMoney)} из неликвидных остатков.`}
                href={makeInsightsHref({ controlView: "frozen" })}
              />
              <PriorityRow
                priority="Приоритет 3"
                tone="violet"
                text="Усилите рекламу на ТОП прибыльных SKU."
                href={makeInsightsHref({ skuView: "profit" })}
              />
              <PriorityRow
                priority="Приоритет 4"
                tone="emerald"
                text="Масштабируйте SKU из зоны потенциала роста."
                href={makeInsightsHref({ skuView: "profit" })}
              />
            </div>
          </section>
        </section>

        <section>
          <h2 className="mb-3 text-lg font-black tracking-tight text-slate-950">
            Карта прибыли
          </h2>
          <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
            <ProfitMapCard
              label="Зарабатывают"
              value={formatMoney(profitableProfit)}
              subtitle="Прибыль с прибыльных SKU"
              footer={`${formatPercent(totalProfit ? (profitableProfit / Math.abs(totalProfit)) * 100 : 0)} от общей прибыли`}
              tone="emerald"
              href={makeInsightsHref({ skuView: "profit" })}
            />
            <ProfitMapCard
              label="Съедают прибыль"
              value={formatMoney(totalLossAmount)}
              subtitle="Убытки по убыточным SKU"
              footer={`${formatPercent(totalRevenue ? Math.abs(totalLossAmount / totalRevenue) * 100 : 0)} от оборота`}
              tone="red"
              href={makeInsightsHref({ skuView: "loss" })}
            />
            <ProfitMapCard
              label="Риск по марже"
              value={`${formatNumber(allLowMarginRows.length)} SKU`}
              subtitle="Маржа ниже 5%"
              footer="Требуют внимания"
              tone="orange"
              href={makeInsightsHref({ controlView: "risk" })}
            />
            <ProfitMapCard
              label="Замороженные деньги"
              value={formatMoney(frozenMoney)}
              subtitle="В неликвидных остатках"
              footer="Влияние на оборотный капитал"
              tone="violet"
              href={makeInsightsHref({ controlView: "frozen" })}
            />
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <SummaryBars
            title="Прибыль по маркетплейсам"
            rows={marketplaceSummaries}
          />
          <SummaryBars title="Прибыль по компаниям" rows={companySummaries} />
        </section>

        <section id="data-panels" className="grid gap-4 xl:grid-cols-2">
          <SkuProfitPanel
            active={skuView}
            profitRows={profitableRows}
            lossRows={lossRows}
            profitHref={makeInsightsHref({ skuView: "profit" })}
            lossHref={makeInsightsHref({ skuView: "loss" })}
          />
          <ControlPanel
            active={controlView}
            riskRows={lowMarginRows}
            frozenRows={topFrozenRows}
            riskHref={makeInsightsHref({ controlView: "risk" })}
            frozenHref={makeInsightsHref({ controlView: "frozen" })}
          />
        </section>
      </div>
    </main>
  );
}
