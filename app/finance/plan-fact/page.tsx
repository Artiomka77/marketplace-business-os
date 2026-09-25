import { loadPeriodFinancePack, WaveDEConsumerUnavailableError } from "@/lib/consumers/waveDE";
import { storedFinite } from "@/lib/dashboard/managementRevenue";
function isProfitAnalyticsUnavailable(_v: unknown): boolean { return true; }
import Link from "next/link";

import { prisma } from "@/lib/prisma";
import {
  buildFinanceCategoryTreatmentIndex,
  calculateFinanceMetricsForRows,
  getFinanceTransactionTreatment,
} from "@/lib/finance/financeMetrics";
import { getEffectiveFinanceTransactions } from "@/lib/finance/effectiveFinanceTransactions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function formatMoney(value: unknown) {
  if (value === null) return "недоступно";
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

function formatNumber(value: unknown) {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 2,
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

function formatDateInput(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function previousMonth(year: number, month: number) {
  if (month === 1) return { year: year - 1, month: 12 };
  return { year, month: month - 1 };
}

function getAmount(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function hasPreliminaryTax(value: unknown) {
  const totals = value as Record<string, unknown>;
  return (
    totals.taxesUnavailable === true ||
    totals.taxesEstimated === true
  );
}
function hasPreliminaryProfitOrCogs(value: unknown) {
  const totals = value as Record<string, unknown>;
  return (
    totals.costCoverageIncomplete === true ||
    totals.dataMode === "PRELIMINARY" ||
    totals.netProfitStatus === "PRELIMINARY"
  );
}

function normalize(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .trim();
}

function normalizeVendorCode(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[‐-‒–—−]/g, "-")
    .replace(/\s+/g, "")
    .trim();
}

function isReturn(value: unknown) {
  const text = normalize(value);
  return text.includes("возврат") || text.includes("return");
}

function expense(value: unknown) {
  const amount = getAmount(value);
  if (amount === 0) return 0;
  return Math.abs(amount);
}

function safePercent(part: number | null, total: number | null) {
  if (part === null || total === null || !total) return Number.NaN;
  return (part / total) * 100;
}

function getExecution(plan: number, fact: number | null) {
  if (fact === null || !plan) return Number.NaN;
  return (fact / plan) * 100;
}

function diffClass(value: number | null, lowerIsBetter = false) {
  if (value === null || value === 0) return "text-slate-900";
  if (lowerIsBetter) return value <= 0 ? "text-emerald-600" : "text-red-600";
  return value >= 0 ? "text-emerald-600" : "text-red-600";
}

function statusClass(execution: number) {
  if (execution >= 95) return "bg-emerald-100 text-emerald-700";
  if (execution >= 80) return "bg-amber-100 text-amber-700";
  return "bg-red-100 text-red-700";
}

function isTaxCategory(category: string) {
  const text = normalize(category);
  return text.includes("налог") || text.includes("взнос");
}

function isSalaryCategory(category: string) {
  const text = normalize(category);
  return text.includes("зарп") || text.includes("зп") || text.includes("сотруд");
}

function isNetProfitExpenseTreatment(treatment: string) {
  return (
    treatment === "INCLUDE_IN_NET_PROFIT" ||
    treatment === "CREDIT_INTEREST"
  );
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

type SplitValue = {
  label: string;
  value: string;
};

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

function SplitMetricCard({
  title,
  total,
  items,
  className = "text-slate-900",
}: {
  title: string;
  total: string;
  items: SplitValue[];
  className?: string;
}) {
  return (
    <div className="min-w-0 rounded-2xl bg-white p-5 shadow-sm">
      <div className="text-sm text-slate-500">{title}</div>

      <div
        className={`mt-2 break-words text-2xl font-bold tabular-nums leading-tight sm:text-3xl ${className}`}
      >
        {total}
      </div>

      <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
        {items.map((item) => (
          <div
            key={item.label}
            className="flex items-center justify-between gap-3 text-sm"
          >
            <span className="text-slate-500">{item.label}</span>
            <span className="font-bold text-slate-900">{item.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MarketplaceProfitCard({
  title,
  revenue,
  cogs,
  costs,
  ads,
  taxes,
  taxesPreliminary = false,
  cogsPreliminary = false,
}: {
  title: string;
  revenue: number | null;
  cogs: number | null;
  costs: number | null;
  ads: number | null;
  taxes: number | null;
  taxesPreliminary?: boolean;
  cogsPreliminary?: boolean;
}) {
  if (
    revenue === null ||
    cogs === null ||
    costs === null ||
    ads === null ||
    taxes === null
  ) {
    return (
      <div
        className="rounded-2xl bg-white p-5 shadow-sm"
        data-plan-fact-marketplace="unavailable"
      >
        <div className="text-sm text-slate-500">{title}</div>
        <div className="mt-2 text-3xl font-bold text-amber-700">недоступно</div>
        <div className="mt-4 text-sm text-slate-500">
          Финансовые данные WB за период неполны.
        </div>
      </div>
    );
  }
  const netProfit = revenue - cogs - costs - ads - taxes;
  const margin = safePercent(netProfit, revenue);

  return (
    <div className="rounded-2xl bg-white p-5 shadow-sm">
      <div className="text-sm text-slate-500">{title}</div>

      <div
        className={`mt-2 text-3xl font-bold ${
          netProfit >= 0 ? "text-emerald-600" : "text-red-600"
        }`}
      >
        {formatMoney(netProfit)}
      </div>

      <div className="mt-4 space-y-2 border-t border-slate-100 pt-3 text-sm">
        <div className="flex justify-between gap-3">
          <span className="text-slate-500">Выручка</span>
          <span className="font-bold">{formatMoney(revenue)}</span>
        </div>

        <div className="flex justify-between gap-3">
          <span className="text-slate-500">
            {cogsPreliminary ? "Себестоимость (предварительно)" : "Себестоимость"}
          </span>
          <span className="font-bold">{formatMoney(cogs)}</span>
        </div>

        <div className="flex justify-between gap-3">
          <span className="text-slate-500">Комиссии / логистика</span>
          <span className="font-bold">{formatMoney(costs)}</span>
        </div>

        <div className="flex justify-between gap-3">
          <span className="text-slate-500">Реклама</span>
          <span className="font-bold">{formatMoney(ads)}</span>
        </div>

        <div className="flex justify-between gap-3">
          <span className="text-slate-500">
            {taxesPreliminary ? "Налоги (предварительно)" : "Налоги"}
          </span>
          <span className="font-bold">{formatMoney(taxes)}</span>
        </div>

        <div className="flex justify-between gap-3 border-t border-slate-100 pt-2">
          <span className="text-slate-500">Чистая маржа</span>
          <span
            className={`font-bold ${
              margin >= 0 ? "text-emerald-600" : "text-red-600"
            }`}
          >
            {formatPercent(margin)}
          </span>
        </div>
      </div>
    </div>
  );
}

function BarCompare({
  title,
  plan,
  fact,
  lowerIsBetter,
}: {
  title: string;
  plan: number;
  fact: number | null;
  lowerIsBetter: boolean;
}) {
  if (fact === null) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
        <div className="font-bold text-slate-900">{title}</div>
        <div className="mt-2 text-sm text-amber-900">
          План: {formatMoney(plan)}. Факт недоступен — WB финансовые данные неполны,
          combined не считается как Ozon-only.
        </div>
      </div>
    );
  }
  const max = Math.max(Math.abs(plan), Math.abs(fact), 1);
  const planWidth = Math.min(100, (Math.abs(plan) / max) * 100);
  const factWidth = Math.min(100, (Math.abs(fact) / max) * 100);
  const diff = fact - plan;
  const execution = getExecution(plan, fact);

  return (
    <div className="rounded-2xl border border-slate-200 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-bold text-slate-900">{title}</div>

        <div
          className={`rounded-full px-3 py-1 text-sm font-bold ${statusClass(
            execution
          )}`}
        >
          {plan ? formatPercent(execution) : "без плана"}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <div>
          <div className="mb-1 flex justify-between text-sm text-slate-500">
            <span>План</span>
            <span>{formatMoney(plan)}</span>
          </div>
          <div className="h-3 rounded-full bg-slate-100">
            <div
              className="h-3 rounded-full bg-slate-400"
              style={{ width: `${planWidth}%` }}
            />
          </div>
        </div>

        <div>
          <div className="mb-1 flex justify-between text-sm text-slate-500">
            <span>Факт</span>
            <span>{formatMoney(fact)}</span>
          </div>
          <div className="h-3 rounded-full bg-slate-100">
            <div
              className="h-3 rounded-full bg-slate-900"
              style={{ width: `${factWidth}%` }}
            />
          </div>
        </div>
      </div>

      <div className={`mt-3 text-sm font-bold ${diffClass(diff, lowerIsBetter)}`}>
        Отклонение: {formatMoney(diff)}
      </div>
    </div>
  );
}

async function getFinanceTransactions(params: {
  year: number;
  month: number;
  company: string;
}) {
  // Realized FACT metrics: canonical effective-finance (explicit FACT + due schedule EFFECTIVE FACT).
  // Future PLAN is queried separately and MUST NOT enter realized cash/P&L FACT totals.
  const dateFrom = new Date(params.year, params.month - 1, 1, 0, 0, 0, 0);
  const dateToExclusive = new Date(params.year, params.month, 1, 0, 0, 0, 0);
  const asOfDate = new Date(dateToExclusive.getTime() - 1);
  const effectiveRows = await getEffectiveFinanceTransactions({
    prisma,
    companyName: params.company !== "ALL" ? params.company : null,
    dateFrom,
    dateToExclusive,
    asOfDate,
  });
  return effectiveRows.filter((row) => !row.isInternalTransfer);
}

async function getFuturePlanFinanceTransactions(params: {
  year: number;
  month: number;
  company: string;
}) {
  const dateFrom = new Date(params.year, params.month - 1, 1, 0, 0, 0, 0);
  const dateToExclusive = new Date(params.year, params.month, 1, 0, 0, 0, 0);
  const asOfDate = new Date(dateToExclusive.getTime() - 1);
  const asOfKeyStart = new Date(
    asOfDate.getFullYear(),
    asOfDate.getMonth(),
    asOfDate.getDate() + 1,
    0,
    0,
    0,
    0,
  );
  return prisma.financeTransaction.findMany({
    where: {
      transactionStatus: "PLAN",
      operationDate: {
        gte: dateFrom,
        lt: dateToExclusive,
      },
      // future relative to asOf (not yet due / not realized)
      OR: [
        { obligationDate: { gte: asOfKeyStart } },
        {
          AND: [
            { obligationDate: null },
            { operationDate: { gte: asOfKeyStart } },
          ],
        },
      ],
      isInternalTransfer: false,
      ...(params.company !== "ALL" ? { companyName: params.company } : {}),
    },
  });
}

type WbSaleRow = Awaited<ReturnType<typeof prisma.wbSale.findMany>>[number];

function dedupeWbSalesByLatestImport(rows: WbSaleRow[]) {
  const sessions = new Map<
    string,
    {
      importSessionId: string;
      dateFrom: Date;
      dateTo: Date;
      createdAt: Date;
      rowsCount: number;
    }
  >();

  for (const row of rows) {
    if (!row.saleDate) {
      continue;
    }

    const importSessionId = row.importSessionId || row.id;
    const current = sessions.get(importSessionId);

    if (!current) {
      sessions.set(importSessionId, {
        importSessionId,
        dateFrom: row.saleDate,
        dateTo: row.saleDate,
        createdAt: row.createdAt,
        rowsCount: 1,
      });
      continue;
    }

    if (row.saleDate < current.dateFrom) current.dateFrom = row.saleDate;
    if (row.saleDate > current.dateTo) current.dateTo = row.saleDate;
    if (row.createdAt > current.createdAt) current.createdAt = row.createdAt;

    current.rowsCount += 1;
  }

  const orderedSessions = [...sessions.values()].sort((a, b) => {
    const aDays =
      Math.ceil(
        (a.dateTo.getTime() - a.dateFrom.getTime()) / (24 * 60 * 60 * 1000)
      ) + 1;

    const bDays =
      Math.ceil(
        (b.dateTo.getTime() - b.dateFrom.getTime()) / (24 * 60 * 60 * 1000)
      ) + 1;

    if (bDays !== aDays) return bDays - aDays;
    if (b.rowsCount !== a.rowsCount) return b.rowsCount - a.rowsCount;

    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  const selectedSessions: typeof orderedSessions = [];

  for (const session of orderedSessions) {
    const isCoveredBySelected = selectedSessions.some(
      (selected) =>
        session.dateFrom >= selected.dateFrom && session.dateTo <= selected.dateTo
    );

    if (!isCoveredBySelected) {
      selectedSessions.push(session);
    }
  }

  const selectedSessionIds = new Set(
    selectedSessions.map((session) => session.importSessionId)
  );

  return rows.filter((row) =>
    selectedSessionIds.has(row.importSessionId || row.id)
  );
}

async function getPnlFact(params: {
  year: number;
  month: number;
  company: string;
}) {
  const dateFrom = startOfMonth(params.year, params.month);
  const dateTo = endOfMonth(params.year, params.month);
  const dateFromText = formatDateInput(dateFrom);
  const dateToText = formatDateInput(dateTo);
  const companyName = params.company !== "ALL" ? params.company : null;

  // Protected pool is max=1: serialize DB-heavy work (no parallel DB fan-out).
  let waveDEPeriodUnavailable: { reason: string; message: string } | null = null;
  let waveDEPeriodMeta: Awaited<ReturnType<typeof loadPeriodFinancePack>>["meta"] | null = null;
  let waveDEPeriodPayload: Awaited<ReturnType<typeof loadPeriodFinancePack>>["payload"] | null = null;
  let wb: any = null;
  let ozon: any = null;
  try {
    const loaded = await loadPeriodFinancePack({
      companyScope: params.company !== "ALL" ? params.company : "ALL",
      dateFrom: dateFromText,
      dateTo: dateToText,
    });
    waveDEPeriodMeta = loaded.meta;
    waveDEPeriodPayload = loaded.payload;
  } catch (error) {
    if (error instanceof WaveDEConsumerUnavailableError) {
      waveDEPeriodUnavailable = { reason: error.reason, message: error.message };
    } else {
      throw error;
    }
  }


  const financeTransactions = await getFinanceTransactions(params);
  const futurePlanFinanceTransactions = await getFuturePlanFinanceTransactions(params);
  // futurePlanFinanceTransactions are PLAN-only and excluded from calculateFinanceMetricsForRows below.

  const financeCategories = await prisma.financeCategory.findMany({
    where: {
      isActive: true,
    },
    orderBy: [
      { categoryType: "asc" },
      { sortOrder: "asc" },
      { name: "asc" },
    ],
  });

  const financeMetrics = calculateFinanceMetricsForRows({
    transactions: financeTransactions,
    categories: financeCategories,
  });

  const categoryTreatmentIndex =
    buildFinanceCategoryTreatmentIndex(financeCategories);

  const financeNetProfitExpenseTransactions = financeTransactions.filter((row) => {
    const treatment = getFinanceTransactionTreatment(
      row,
      categoryTreatmentIndex
    ).treatment;

    return (
      row.operationType !== "INCOME" &&
      isNetProfitExpenseTreatment(treatment)
    );
  });

  const financeTax = financeNetProfitExpenseTransactions
    .filter((row) => isTaxCategory(row.category))
    .reduce((sum, row) => sum + getAmount(row.amount), 0);

  const financeSalary = financeNetProfitExpenseTransactions
    .filter((row) => isSalaryCategory(row.category))
    .reduce((sum, row) => sum + getAmount(row.amount), 0);

  const periodUnavailable = Boolean(waveDEPeriodUnavailable) || !waveDEPeriodPayload;
  const periodRows = Array.isArray(waveDEPeriodPayload) ? waveDEPeriodPayload : [];
  const periodRow =
    periodRows.find((row: any) => {
      const name = String(row?.companyName ?? "ALL");
      if (!companyName) return name === "ALL";
      return name === companyName;
    }) ?? periodRows[0] ?? null;

  const wbUnavailable = periodUnavailable || periodRow?.wbRevenue == null;
  const wbTaxesPreliminary = false;
  const ozonTaxesPreliminary = false;
  const taxesPreliminary = false;
  const wbCogsOrProfitPreliminary = false;
  const ozonCogsOrProfitPreliminary = false;
  const cogsPreliminary = false;
  const profitPreliminary = false;

  const ozonRevenue = periodUnavailable ? null : storedFinite(periodRow?.ozonRevenue);
  const ozonSellerPayout = 0;
  const ozonCogs = 0;
  const ozonAdsSpend = periodUnavailable ? 0 : Number(periodRow?.ozonAdsCost ?? 0);
  const ozonTaxes = 0;
  const ozonMarketplaceCosts = 0;
  const ozonMarginalProfit = 0;
  const ozonNetProfitAfterTax = 0;

  const wbRevenue = wbUnavailable ? null : storedFinite(periodRow?.wbRevenue);
  const wbCogs = null; // COGS not carried in period aggregate grain used here
  const wbAdsSpend = periodUnavailable ? null : Number(periodRow?.wbAdsCost ?? 0);
  const wbTaxes = null;
  const wbMarketplaceCosts = null;
  const wbMarginalProfit = null;
  const wbNetProfitAfterTax = periodUnavailable
    ? null
    : storedFinite(periodRow?.operatingProfitAfterTax);

  // When period HIT exists, prefer canonical period totals for combined marketplace rollup.
  const marketplaceRevenue =
    wbRevenue == null || ozonRevenue == null || storedFinite(periodRow?.totalRevenue) == null
      ? null
      : storedFinite(periodRow?.totalRevenue);
  const marketplaceAds = periodUnavailable
    ? null
    : Number(periodRow?.adsCost ?? ((wbAdsSpend ?? 0) + ozonAdsSpend));
  const marketplaceCosts = null;
  const cogs = null;
  const marketplaceTaxes = null;
  const totalTaxes = marketplaceTaxes === null ? null : marketplaceTaxes + financeTax;

  const grossProfit = null;
  const contributionProfit = null;

  const financeOtherProfitExpenses = Math.max(
    0,
    financeMetrics.netProfitExpense -
      financeTax -
      financeSalary -
      financeMetrics.creditInterest
  );

  // Единый стандарт проекта:
  // операционная прибыль = прибыль WB/Ozon после себестоимости, рекламы, логистики и налогов;
  // чистая прибыль = операционная прибыль + финансовые доходы − финансовые расходы,
  // которые по роли статьи входят в P&L.
  const operatingProfit = periodUnavailable
    ? null
    : storedFinite(periodRow?.operatingProfitAfterTax);
  const netProfit =
    operatingProfit === null
      ? null
      : operatingProfit +
        financeMetrics.netProfitIncome -
        financeMetrics.netProfitExpense;

  const cashFlow = financeMetrics.netCashFlow;

  return {
    wbPnlUnavailable: wbUnavailable,
    combinedPnlUnavailable: wbUnavailable,
    wbTaxesPreliminary,
    ozonTaxesPreliminary,
    taxesPreliminary,
    wbCogsOrProfitPreliminary,
    ozonCogsOrProfitPreliminary,
    cogsPreliminary,
    profitPreliminary,
    wbRows: 0,
    wbRawRows: 0,
    wbAdsRows: wbUnavailable || !wbAdsSpend ? 0 : 1,
    wbRevenue,
    wbReward: null,
    wbLogistics: null,
    wbStorage: null,
    wbAcceptance: null,
    wbDeductions: null,
    wbPenalties: null,
    wbPaymentService: null,
    wbMarketplaceCosts,
    wbAdsSpend,
    wbTaxes,
    wbCogs,
    wbQty: null,
    wbRowsWithCost: 0,
    wbRowsWithoutCost: 0,
    wbMarginalProfit,
    wbNetProfitAfterTax,

    ozonRows: 0,
    ozonAdsRows: ozonAdsSpend !== 0 ? 1 : 0,
    ozonRevenue,
    ozonCommission: 0,
    ozonLogistics: 0,
    ozonReverseLogistics: 0,
    ozonMarketplaceCosts,
    ozonAdsSpend,
    ozonTaxes,
    ozonCogs,
    ozonQty: 0,
    ozonRowsWithCost: 0,
    ozonRowsWithoutCost: 0,
    ozonMarginalProfit,
    ozonNetProfitAfterTax,

    marketplaceRevenue,
    marketplaceAds,
    marketplaceCosts,
    cogs,
    marketplaceTaxes,
    totalTaxes,

    grossProfit,
    contributionProfit,

    financeTax,
    financeSalary,
    financeOtherProfitExpenses,
    financeCreditInterest: financeMetrics.creditInterest,
    futurePlanCount: futurePlanFinanceTransactions.length,
    effectiveFinanceSource: "getEffectiveFinanceTransactions",

    financeCreditPrincipal: financeMetrics.creditPrincipal,
    financeCreditReceived: financeMetrics.creditReceived,
    financeOwnerWithdrawals: financeMetrics.ownerWithdrawals,
    financeCashOnly: financeMetrics.cashOnlyTotal,
    financeNetProfitIncome: financeMetrics.netProfitIncome,
    financeNetProfitExpense: financeMetrics.netProfitExpense,

    financeIncome: financeMetrics.cashIncome,
    financeExpenseTotal: financeMetrics.cashOutflow,

    operatingProfit,
    netProfit,
    cashFlow,

    productCostCount: 0,
    productCostSkuCount: 0,
    hasMarketplaceData: !periodUnavailable && Boolean(periodRow),
    waveDEPeriodMeta,
    waveDEPeriodUnavailable,
  };
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
  const prev = previousMonth(selectedYear, selectedMonth);

  // Protected pool is max=1: serialize companies/plans/fact/prevFact DB work.
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

  const fact = await getPnlFact({
    year: selectedYear,
    month: selectedMonth,
    company: selectedCompany,
  });

  const prevFact = await getPnlFact({
    year: prev.year,
    month: prev.month,
    company: selectedCompany,
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

  const revenueExecution = getExecution(planRevenue, fact.marketplaceRevenue);
  const profitExecution = getExecution(planProfit, fact.netProfit);

  const cogsShare = safePercent(fact.cogs, fact.marketplaceRevenue);
  const marketplaceCostsShare = safePercent(
    fact.marketplaceCosts,
    fact.marketplaceRevenue
  );
  const adsShare = safePercent(fact.marketplaceAds, fact.marketplaceRevenue);

  const rows = [
    {
      title: "Выручка WB/Ozon",
      plan: planRevenue,
      fact: fact.marketplaceRevenue,
      lowerIsBetter: false,
      source: "WB/Ozon",
      isPnl: true,
    },
    {
      title: fact.profitPreliminary
        ? "Чистая прибыль (предварительно)"
        : "Чистая прибыль",
      plan: planProfit,
      fact: fact.netProfit,
      lowerIsBetter: false,
      source: "P&L",
      isPnl: true,
    },
    {
      title: fact.profitPreliminary
        ? "Операционная прибыль WB/Ozon (предварительно)"
        : "Операционная прибыль WB/Ozon",
      plan: 0,
      fact: fact.operatingProfit,
      lowerIsBetter: false,
      source: "WB/Ozon",
      isPnl: true,
    },
    {
      title: fact.cogsPreliminary
        ? "Себестоимость (предварительно)"
        : "Себестоимость",
      plan: 0,
      fact: fact.cogs,
      lowerIsBetter: true,
      source: "ProductCost",
      isPnl: true,
    },
    {
      title: "Комиссии / логистика МП",
      plan: planLogistics,
      fact: fact.marketplaceCosts,
      lowerIsBetter: true,
      source: "WB/Ozon",
      isPnl: true,
    },
    {
      title: "Реклама WB/Ozon",
      plan: planAds,
      fact: fact.marketplaceAds,
      lowerIsBetter: true,
      source: "WB/Ozon",
      isPnl: true,
    },
    {
      title: fact.taxesPreliminary
        ? "Налоги (предварительно)"
        : "Налоги",
      plan: planTax,
      fact: fact.totalTaxes,
      lowerIsBetter: true,
      source: "WB/Ozon + Финансы",
      isPnl: true,
    },
    {
      title: "Зарплата",
      plan: planSalary,
      fact: fact.financeSalary,
      lowerIsBetter: true,
      source: "Финансы / P&L",
      isPnl: true,
    },
    {
      title: "Проценты кредита",
      plan: 0,
      fact: fact.financeCreditInterest,
      lowerIsBetter: true,
      source: "Финансы / P&L",
      isPnl: true,
    },
    {
      title: "Прочие расходы",
      plan: planOther,
      fact: fact.financeOtherProfitExpenses,
      lowerIsBetter: true,
      source: "Финансы / P&L",
      isPnl: true,
    },
    {
      title: "Тело кредита",
      plan: 0,
      fact: fact.financeCreditPrincipal,
      lowerIsBetter: true,
      source: "Финансы / ДДС",
      isPnl: false,
    },
    {
      title: "Получено кредитов / займов",
      plan: 0,
      fact: fact.financeCreditReceived,
      lowerIsBetter: false,
      source: "Финансы / ДДС",
      isPnl: false,
    },
    {
      title: "Вывод собственника",
      plan: 0,
      fact: fact.financeOwnerWithdrawals,
      lowerIsBetter: true,
      source: "Финансы / ДДС",
      isPnl: false,
    },
    {
      title: "Только ДДС",
      plan: 0,
      fact: fact.financeCashOnly,
      lowerIsBetter: true,
      source: "Финансы / ДДС",
      isPnl: false,
    },
  ];

  const topDeviations = [...rows]
    .filter((row) => row.plan > 0 && row.fact !== null)
    .sort(
      (a, b) =>
        Math.abs((b.fact as number) - b.plan) -
        Math.abs((a.fact as number) - a.plan)
    )
    .slice(0, 5);

  return (
    <main
      className="min-h-screen bg-slate-100 p-4 sm:p-6 lg:p-8"
      data-plan-fact-wb-pnl-availability={
        fact.wbPnlUnavailable ? "unavailable" : "available"
      }
      data-plan-fact-combined-complete={
        fact.combinedPnlUnavailable ? "no" : "yes"
      }
      data-plan-fact-taxes-preliminary={fact.taxesPreliminary ? "yes" : "no"}
      data-plan-fact-cogs-preliminary={fact.cogsPreliminary ? "yes" : "no"}
      data-plan-fact-profit-preliminary={fact.profitPreliminary ? "yes" : "no"}
    >
      <div className="mx-auto max-w-[1700px] space-y-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-slate-900 sm:text-4xl">
              План-Факт P&amp;L WB/Ozon
            </h1>

            <p className="mt-3 text-slate-500">
              Управленческий P&amp;L: план, факт и разбивка WB/Ozon по ключевым
              статьям. Финансовые операции считаются через единую роль статьи
              profitTreatment.
            </p>
          </div>

          <Link
            href="/finance/budget"
            className="rounded-xl bg-slate-900 px-5 py-3 text-center font-semibold text-white"
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

        {fact.wbPnlUnavailable ? (
          <section
            data-testid="plan-fact-wb-pnl-unavailable"
            data-wb-pnl-availability="unavailable"
            data-plan-fact-ozon-numeric="yes"
            className="rounded-2xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-950"
          >
            <div className="font-bold">
              Финансовые данные WB за выбранный месяц неполны.
            </div>
            <div className="mt-2 leading-6">
              WB факт, combined факт, отклонение и выполнение, зависящие от WB,
              недоступны. Ozon остаётся числовым отдельно и не подменяет итог
              WB+Ozon. План бюджета остаётся видимым.
            </div>
          </section>
        ) : null}

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
            value={formatMoney(fact.marketplaceRevenue)}
            subValue={`${formatPercent(revenueExecution)} · WB/Ozon`}
            className="text-emerald-600"
          />

          <MetricCard title="План прибыли" value={formatMoney(planProfit)} />

          <MetricCard
            title={
              fact.profitPreliminary
                ? "Чистая прибыль (предварительно)"
                : "Чистая прибыль"
            }
            value={formatMoney(fact.netProfit)}
            subValue={`${formatPercent(profitExecution)} · к прошлому: ${formatMoney(
              fact.netProfit === null || prevFact.netProfit === null
                ? null
                : fact.netProfit - prevFact.netProfit
            )}`}
            className={
              fact.netProfit === null
                ? "text-amber-700"
                : fact.netProfit >= 0
                  ? "text-emerald-600"
                  : "text-red-600"
            }
          />

          <MetricCard
            title="Отклонение прибыли"
            value={formatMoney(
              fact.netProfit === null ? null : fact.netProfit - planProfit
            )}
            className={diffClass(
              fact.netProfit === null ? null : fact.netProfit - planProfit
            )}
          />
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SplitMetricCard
            title="Выручка"
            total={formatMoney(fact.marketplaceRevenue)}
            className="text-emerald-600"
            items={[
              {
                label: `WB (${formatNumber(fact.wbQty)} шт.)`,
                value: `${formatMoney(fact.wbRevenue)} · ${formatPercent(
                  safePercent(fact.wbRevenue, fact.marketplaceRevenue)
                )}`,
              },
              {
                label: `Ozon (${formatNumber(fact.ozonQty)} шт.)`,
                value: `${formatMoney(fact.ozonRevenue)} · ${formatPercent(
                  safePercent(fact.ozonRevenue, fact.marketplaceRevenue)
                )}`,
              },
            ]}
          />

          <SplitMetricCard
            title={
              fact.cogsPreliminary
                ? "Себестоимость (предварительно)"
                : "Себестоимость"
            }
            total={formatMoney(fact.cogs)}
            className="text-red-600"
            items={[
              {
                label: "WB",
                value: `${formatMoney(fact.wbCogs)} · ${formatPercent(
                  safePercent(fact.wbCogs, fact.wbRevenue)
                )}`,
              },
              {
                label: "Ozon",
                value: `${formatMoney(fact.ozonCogs)} · ${formatPercent(
                  safePercent(fact.ozonCogs, fact.ozonRevenue)
                )}`,
              },
              { label: "Доля", value: formatPercent(cogsShare) },
            ]}
          />

          <SplitMetricCard
            title="Комиссии / логистика МП"
            total={formatMoney(fact.marketplaceCosts)}
            className="text-red-600"
            items={[
              {
                label: "WB",
                value: `${formatMoney(fact.wbMarketplaceCosts)} · ${formatPercent(
                  safePercent(fact.wbMarketplaceCosts, fact.wbRevenue)
                )}`,
              },
              {
                label: "Ozon",
                value: `${formatMoney(
                  fact.ozonMarketplaceCosts
                )} · ${formatPercent(
                  safePercent(fact.ozonMarketplaceCosts, fact.ozonRevenue)
                )}`,
              },
              { label: "Доля", value: formatPercent(marketplaceCostsShare) },
            ]}
          />

          <SplitMetricCard
            title="Реклама WB/Ozon"
            total={formatMoney(fact.marketplaceAds)}
            className="text-red-600"
            items={[
              {
                label: "WB",
                value: `${formatMoney(fact.wbAdsSpend)} · ${formatPercent(
                  safePercent(fact.wbAdsSpend, fact.wbRevenue)
                )}`,
              },
              {
                label: "Ozon",
                value: `${formatMoney(fact.ozonAdsSpend)} · ${formatPercent(
                  safePercent(fact.ozonAdsSpend, fact.ozonRevenue)
                )}`,
              },
              { label: "ДРР", value: formatPercent(adsShare) },
            ]}
          />
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            title="Валовая прибыль"
            value={formatMoney(fact.grossProfit)}
            subValue="Выручка − себестоимость"
            className={
              fact.grossProfit === null
                ? "text-amber-700"
                : fact.grossProfit >= 0
                  ? "text-emerald-600"
                  : "text-red-600"
            }
          />

          <MetricCard
            title="Маржинальная прибыль"
            value={formatMoney(fact.contributionProfit)}
            subValue={`WB: ${formatMoney(fact.wbMarginalProfit)} · Ozon: ${formatMoney(
              fact.ozonMarginalProfit
            )}`}
            className={
              fact.contributionProfit === null
                ? "text-amber-700"
                : fact.contributionProfit >= 0
                  ? "text-emerald-600"
                  : "text-red-600"
            }
          />

          <MetricCard
            title={
              fact.profitPreliminary
                ? "Операционная прибыль (предварительно)"
                : "Операционная прибыль"
            }
            value={formatMoney(fact.operatingProfit)}
            subValue={`WB: ${formatMoney(fact.wbNetProfitAfterTax)} · Ozon: ${formatMoney(
              fact.ozonNetProfitAfterTax
            )}`}
            className={
              fact.operatingProfit === null
                ? "text-amber-700"
                : fact.operatingProfit >= 0
                  ? "text-emerald-600"
                  : "text-red-600"
            }
          />

          <MetricCard
            title="Денежный поток"
            value={formatMoney(fact.cashFlow)}
            subValue="По финансовым операциям / ДДС"
            className={fact.cashFlow >= 0 ? "text-emerald-600" : "text-red-600"}
          />
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          <MarketplaceProfitCard
            title="WB прибыль после налогов"
            revenue={fact.wbRevenue}
            cogs={fact.wbCogs}
            costs={fact.wbMarketplaceCosts}
            ads={fact.wbAdsSpend}
            taxes={fact.wbTaxes}
            taxesPreliminary={fact.wbTaxesPreliminary}
            cogsPreliminary={fact.wbCogsOrProfitPreliminary}
          />

          <MarketplaceProfitCard
            title="Ozon прибыль после налогов"
            revenue={fact.ozonRevenue}
            cogs={fact.ozonCogs}
            costs={fact.ozonMarketplaceCosts}
            ads={fact.ozonAdsSpend}
            taxes={fact.ozonTaxes}
            taxesPreliminary={fact.ozonTaxesPreliminary}
            cogsPreliminary={fact.ozonCogsOrProfitPreliminary}
          />
        </section>

        <section className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
          <MetricCard
            title={
              fact.taxesPreliminary
                ? "Налоги (предварительно)"
                : "Налоги"
            }
            value={formatMoney(fact.totalTaxes)}
            subValue={`WB/Ozon: ${formatMoney(fact.marketplaceTaxes)} · фин.: ${formatMoney(
              fact.financeTax
            )}`}
            className="text-red-600"
          />

          <MetricCard
            title="Зарплата"
            value={formatMoney(fact.financeSalary)}
            className="text-red-600"
          />

          <MetricCard
            title="Прочие P&L расходы"
            value={formatMoney(fact.financeOtherProfitExpenses)}
            className="text-red-600"
          />

          <MetricCard
            title="Проценты кредита"
            value={formatMoney(fact.financeCreditInterest)}
            subValue="Входит в P&L"
            className="text-red-600"
          />

          <MetricCard
            title="Тело кредита"
            value={formatMoney(fact.financeCreditPrincipal)}
            subValue="Не входит в P&L"
            className="text-red-600"
          />

          <MetricCard
            title="Вывод собственника"
            value={formatMoney(fact.financeOwnerWithdrawals)}
            subValue="Не входит в P&L"
            className="text-amber-600"
          />
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <div className="rounded-2xl bg-white p-5 shadow-sm sm:p-6">
            <h2 className="text-2xl font-bold text-slate-900">
              Выполнение бюджета по статьям P&amp;L
            </h2>

            <div className="mt-6 space-y-4">
              {rows
                .filter((row) => row.isPnl)
                .map((row) => (
                  <BarCompare
                    key={row.title}
                    title={`${row.title} · ${row.source}`}
                    plan={row.plan}
                    fact={row.fact}
                    lowerIsBetter={row.lowerIsBetter}
                  />
                ))}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-5 shadow-sm sm:p-6">
            <h2 className="text-2xl font-bold text-slate-900">
              ТОП отклонений
            </h2>

            <div className="mt-6 space-y-3">
              {topDeviations.map((row, index) => {
                const diff =
                  row.fact === null ? null : row.fact - row.plan;

                return (
                  <div
                    key={row.title}
                    className="rounded-2xl border border-slate-200 p-4"
                  >
                    <div className="text-sm text-slate-500">#{index + 1}</div>
                    <div className="mt-1 font-bold text-slate-900">
                      {row.title}
                    </div>
                    <div className="mt-1 text-sm text-slate-500">
                      Источник: {row.source}
                    </div>
                    <div
                      className={`mt-2 text-xl font-bold ${diffClass(
                        diff,
                        row.lowerIsBetter
                      )}`}
                    >
                      {formatMoney(diff)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="rounded-2xl bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-2xl font-bold text-slate-900">
            План-Факт P&amp;L по статьям
          </h2>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[1150px] text-sm">
              <thead className="bg-slate-100 text-left text-slate-700">
                <tr>
                  <th className="p-3">Статья</th>
                  <th className="p-3">Источник</th>
                  <th className="p-3">Роль</th>
                  <th className="p-3 text-right">План</th>
                  <th className="p-3 text-right">Факт</th>
                  <th className="p-3 text-right">Выполнение</th>
                  <th className="p-3 text-right">Отклонение ₽</th>
                  <th className="p-3 text-right">Отклонение %</th>
                </tr>
              </thead>

              <tbody>
                {rows.map((row) => {
                  const diff = row.fact === null ? null : row.fact - row.plan;
                  const diffPercent =
                    diff === null || !row.plan ? Number.NaN : (diff / row.plan) * 100;
                  const execution = getExecution(row.plan, row.fact);

                  return (
                    <tr key={row.title} className="border-t border-slate-100">
                      <td className="p-3 font-semibold">{row.title}</td>
                      <td className="p-3 text-slate-500">{row.source}</td>
                      <td className="p-3">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-bold ${
                            row.isPnl
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-cyan-50 text-cyan-700"
                          }`}
                        >
                          {row.isPnl ? "P&L" : "Только ДДС"}
                        </span>
                      </td>
                      <td className="p-3 text-right">{formatMoney(row.plan)}</td>
                      <td className="p-3 text-right font-semibold">
                        {formatMoney(row.fact)}
                      </td>
                      <td className="p-3 text-right font-bold">
                        {row.plan ? formatPercent(execution) : "—"}
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
            Формула P&amp;L
          </h2>

          <p className="mt-3 text-slate-500">
            Операционная прибыль = прибыль WB/Ozon после себестоимости,
            комиссий, логистики, рекламы и налогов. Чистая прибыль = операционная
            прибыль + доходы из финансовых операций, которые входят в P&amp;L −
            расходы из финансовых операций, которые входят в P&amp;L. Фулфилмент,
            закупка, тело кредита и вывод собственника не задваиваются в P&amp;L и
            показываются отдельно как денежный поток.
          </p>
        </section>
      </div>
    </main>
  );
}