import Link from "next/link";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import {
  buildFinanceCategoryTreatmentIndex,
  calculateFinanceMetricsForRows,
  getFinanceTransactionCashEffect,
  getFinanceTransactionTreatment,
} from "@/lib/finance/financeMetrics";

type SearchParams = {
  company?: string;
  operationType?: string;
  category?: string;
  bankAccount?: string;
  search?: string;
  rows?: string;
  sortBy?: string;
  sortDir?: string;
  dateFrom?: string;
  dateTo?: string;
  metric?: string;
  source?: string;
};

type OperationType =
  | "ALL"
  | "INCOME"
  | "EXPENSE"
  | "TRANSFER"
  | "FINANCING"
  | "PERSONAL";

type SourceFilter = "ALL" | "MANUAL" | "TELEGRAM" | "EXCEL";

type MetricKey =
  | "cashIncome"
  | "cashOutflow"
  | "netCashFlow"
  | "netProfitImpact"
  | "ownerWithdrawals"
  | "transferTotal"
  | "cashOnlyTotal"
  | "creditPrincipal"
  | "creditInterest"
  | "ignoredTotal";

type FinanceTransactionRow = Awaited<
  ReturnType<typeof prisma.financeTransaction.findMany>
>[number];

const ROWS_OPTIONS = [25, 50, 100, 250, 500];
const SORTABLE_COLUMNS = [
  "operationDate",
  "obligationDate",
  "amount",
  "companyName",
  "operationType",
  "category",
  "subcategory",
  "counterparty",
  "bankAccount",
  "project",
];

const OPERATION_TABS: { value: OperationType; label: string }[] = [
  { value: "ALL", label: "Все операции" },
  { value: "INCOME", label: "Поступления" },
  { value: "EXPENSE", label: "Расходы" },
  { value: "TRANSFER", label: "Переводы" },
  { value: "FINANCING", label: "Кредиты" },
  { value: "PERSONAL", label: "Вывод собственника" },
];

const SOURCE_FILTER_OPTIONS: { value: SourceFilter; label: string }[] = [
  { value: "ALL", label: "Все источники" },
  { value: "MANUAL", label: "Вручную" },
  { value: "TELEGRAM", label: "Telegram" },
  { value: "EXCEL", label: "Excel" },
];

const METRIC_DRILLDOWN_OPTIONS: {
  key: MetricKey;
  title: string;
  description: string;
}[] = [
  {
    key: "cashIncome",
    title: "Поступления ДДС",
    description: "Все операции, которые увеличивают деньги на счетах.",
  },
  {
    key: "cashOutflow",
    title: "Выплаты ДДС",
    description: "Все операции, которые уменьшают деньги на счетах.",
  },
  {
    key: "netCashFlow",
    title: "Чистый ДДС",
    description: "Поступления и выплаты, из которых складывается чистое движение денег.",
  },
  {
    key: "netProfitImpact",
    title: "Влияние на чистую прибыль",
    description: "Операции, которые влияют на P&L и чистую прибыль бизнеса.",
  },
  {
    key: "ownerWithdrawals",
    title: "Вывод собственника",
    description: "Деньги, выведенные из бизнеса собственником.",
  },
  {
    key: "transferTotal",
    title: "Внутренние переводы",
    description: "Перемещения денег между своими счетами и кассами.",
  },
  {
    key: "cashOnlyTotal",
    title: "Только ДДС",
    description: "Расходы, которые уменьшают деньги, но не уменьшают прибыль повторно.",
  },
  {
    key: "creditPrincipal",
    title: "Тело кредита",
    description: "Погашение основного долга: влияет на деньги, но не на чистую прибыль.",
  },
  {
    key: "creditInterest",
    title: "Проценты кредита",
    description: "Проценты по кредитам: влияют и на ДДС, и на чистую прибыль.",
  },
  {
    key: "ignoredTotal",
    title: "Не учитывается",
    description: "Технические операции без влияния на ключевые показатели.",
  },
];

function normalizeSourceFilter(value?: string): SourceFilter {
  if (value === "MANUAL") return "MANUAL";
  if (value === "TELEGRAM") return "TELEGRAM";
  if (value === "EXCEL") return "EXCEL";
  return "ALL";
}

function formatMoney(value: unknown) {
  const number = Number(value ?? 0);

  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(number) ? number : 0);
}

function formatSignedMoney(value: number) {
  const abs = Math.abs(value);
  const formatted = formatMoney(abs);

  if (value < 0) return `-${formatted}`;
  if (value > 0) return `+${formatted}`;
  return formatted;
}

function formatDate(value?: Date | null) {
  if (!value) return "—";
  return value.toLocaleDateString("ru-RU");
}

function formatDateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getDefaultDateRange() {
  const now = new Date();
  const dateTo = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateFrom = new Date(now.getFullYear(), now.getMonth(), 1);

  return {
    dateFrom: formatDateInput(dateFrom),
    dateTo: formatDateInput(dateTo),
  };
}

function toDate(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!text) return null;

  const date = new Date(`${text}T12:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toNumber(value: FormDataEntryValue | null) {
  const number = Number(
    String(value ?? "")
      .replace(/\s/g, "")
      .replace(",", "."),
  );

  return Number.isFinite(number) ? number : 0;
}

function operationTypeLabel(type: string) {
  if (type === "INCOME") return "Поступление";
  if (type === "EXPENSE") return "Расход";
  if (type === "TRANSFER") return "Перевод";
  if (type === "FINANCING") return "Финансирование";
  if (type === "PERSONAL") return "Личные";
  return type || "—";
}

function operationTypeClassName(type: string) {
  if (type === "INCOME") {
    return "bg-emerald-50 text-emerald-700 ring-emerald-100";
  }

  if (type === "EXPENSE") return "bg-red-50 text-red-700 ring-red-100";
  if (type === "TRANSFER") return "bg-slate-100 text-slate-600 ring-slate-200";
  if (type === "FINANCING") return "bg-blue-50 text-blue-700 ring-blue-100";

  if (type === "PERSONAL") {
    return "bg-orange-50 text-orange-700 ring-orange-100";
  }

  return "bg-slate-50 text-slate-700 ring-slate-200";
}

function amountClassName(value: number) {
  if (value > 0) return "text-emerald-600";
  if (value < 0) return "text-red-600";
  return "text-slate-900";
}

function shortText(value: string | null | undefined, fallback = "—") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function sourceLabel(value?: string | null) {
  if (value === "TELEGRAM_BOT") return "Telegram";
  if (value === "FINANCE_EXCEL_IMPORT") return "Excel";
  if (value === "GOOGLE_SHEETS_IMPORT") return "Google Sheets";
  if (value === "MANUAL") return "Вручную";
  if (!value) return "Вручную";
  return value;
}

function sourceDescription(value?: string | null) {
  if (value === "TELEGRAM_BOT") {
    return "Операция добавлена через Telegram-бота.";
  }

  if (value === "FINANCE_EXCEL_IMPORT") {
    return "Операция загружена из Excel-шаблона финансовых операций.";
  }

  if (value === "GOOGLE_SHEETS_IMPORT") {
    return "Операция загружена из старого Google Sheets / Excel-импорта.";
  }

  if (!value || value === "MANUAL") {
    return "Операция добавлена вручную на странице финансовых операций.";
  }

  return "Источник операции в базе.";
}

function sourceClassName(value?: string | null) {
  if (value === "TELEGRAM_BOT") {
    return "bg-sky-50 text-sky-700 ring-sky-100";
  }

  if (value === "FINANCE_EXCEL_IMPORT" || value === "GOOGLE_SHEETS_IMPORT") {
    return "bg-emerald-50 text-emerald-700 ring-emerald-100";
  }

  if (!value || value === "MANUAL") {
    return "bg-slate-100 text-slate-600 ring-slate-200";
  }

  return "bg-violet-50 text-violet-700 ring-violet-100";
}

function getMetricConfig(metric: string | undefined) {
  return METRIC_DRILLDOWN_OPTIONS.find((option) => option.key === metric);
}

function rowBelongsToMetric(
  row: FinanceTransactionRow,
  metric: MetricKey,
  treatment: ReturnType<typeof getFinanceTransactionTreatment>,
  categoryIndex: ReturnType<typeof buildFinanceCategoryTreatmentIndex>,
) {
  const cashEffect = getFinanceTransactionCashEffect(row, categoryIndex);

  if (metric === "cashIncome") return cashEffect > 0;
  if (metric === "cashOutflow") return cashEffect < 0;
  if (metric === "netCashFlow") return cashEffect !== 0;
  if (metric === "netProfitImpact") {
    return (
      treatment.treatment === "INCLUDE_IN_NET_PROFIT" ||
      treatment.treatment === "CREDIT_INTEREST"
    );
  }
  if (metric === "ownerWithdrawals") return treatment.treatment === "OWNER_WITHDRAWAL";
  if (metric === "transferTotal") return row.operationType === "TRANSFER" || !!row.isInternalTransfer;
  if (metric === "cashOnlyTotal") return treatment.treatment === "CASH_ONLY";
  if (metric === "creditPrincipal") return treatment.treatment === "CREDIT_PRINCIPAL";
  if (metric === "creditInterest") return treatment.treatment === "CREDIT_INTEREST";
  if (metric === "ignoredTotal") return treatment.treatment === "IGNORE";

  return false;
}

function getMetricValue(
  metric: MetricKey,
  metrics: {
    cashIncome: number;
    cashOutflow: number;
    netCashFlow: number;
    netProfitImpact: number;
    ownerWithdrawals: number;
    transferTotal: number;
    cashOnlyTotal: number;
    creditPrincipal: number;
    creditInterest: number;
    ignoredTotal: number;
  },
) {
  return metrics[metric];
}

function compareUnknownValues(a: unknown, b: unknown) {
  const aValue = a instanceof Date ? a.getTime() : Number(a);
  const bValue = b instanceof Date ? b.getTime() : Number(b);

  if (Number.isFinite(aValue) && Number.isFinite(bValue)) {
    return aValue - bValue;
  }

  return String(a ?? "").localeCompare(String(b ?? ""), "ru");
}

function sortFinanceRowsInMemory(
  rows: FinanceTransactionRow[],
  sortBy: string,
  sortDir: string,
) {
  return [...rows].sort((a, b) => {
    const aValue = a[sortBy as keyof FinanceTransactionRow];
    const bValue = b[sortBy as keyof FinanceTransactionRow];
    const result = compareUnknownValues(aValue, bValue);

    return sortDir === "asc" ? result : -result;
  });
}

async function createFinanceTransaction(formData: FormData) {
  "use server";

  const companyName = String(formData.get("companyName") ?? "").trim();
  const operationType = String(formData.get("operationType") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim();
  const amount = toNumber(formData.get("amount"));
  const operationDate = toDate(formData.get("operationDate"));
  const obligationDate = toDate(formData.get("obligationDate"));

  if (!companyName || !operationType || !category || !operationDate || amount <= 0) {
    return;
  }

  await prisma.financeTransaction.create({
    data: {
      companyName,
      operationType,
      category,
      operationDate,
      obligationDate,
      amount,
      subcategory: String(formData.get("subcategory") ?? "").trim() || null,
      counterparty: String(formData.get("counterparty") ?? "").trim() || null,
      bankAccount: String(formData.get("bankAccount") ?? "").trim() || null,
      project: String(formData.get("project") ?? "").trim() || null,
      comment: String(formData.get("comment") ?? "").trim() || null,
      isInternalTransfer:
        operationType === "TRANSFER" || formData.get("isInternalTransfer") === "on",
    },
  });

  revalidatePath("/finance/operations");
  revalidatePath("/finance");
  revalidatePath("/");
}

async function deleteFinanceTransaction(formData: FormData) {
  "use server";

  const id = String(formData.get("id") ?? "");

  if (!id) return;

  await prisma.financeTransaction.delete({
    where: {
      id,
    },
  });

  revalidatePath("/finance/operations");
  revalidatePath("/finance");
  revalidatePath("/");
}

function buildHref(params: SearchParams, patch: Partial<SearchParams>) {
  const query = new URLSearchParams();
  const defaultRange = getDefaultDateRange();

  const next = {
    company: params.company ?? "ALL",
    operationType: params.operationType ?? "ALL",
    category: params.category ?? "ALL",
    bankAccount: params.bankAccount ?? "ALL",
    search: params.search ?? "",
    dateFrom: params.dateFrom ?? defaultRange.dateFrom,
    dateTo: params.dateTo ?? defaultRange.dateTo,
    rows: params.rows ?? "50",
    sortBy: params.sortBy ?? "operationDate",
    sortDir: params.sortDir ?? "desc",
    metric: params.metric ?? "",
    source: params.source ?? "ALL",
    ...patch,
  };

  query.set("company", next.company);
  query.set("operationType", next.operationType);
  query.set("category", next.category);
  query.set("bankAccount", next.bankAccount);
  query.set("dateFrom", next.dateFrom);
  query.set("dateTo", next.dateTo);
  query.set("rows", next.rows);
  query.set("sortBy", next.sortBy);
  query.set("sortDir", next.sortDir);
  query.set("source", next.source);

  if (next.metric) query.set("metric", next.metric);
  if (next.search) query.set("search", next.search);

  return `/finance/operations?${query.toString()}`;
}

function tinyTrendPath(tone: "emerald" | "red" | "blue" | "violet" | "orange" | "slate") {
  if (tone === "red") return "M2 24 L12 17 L20 20 L30 11 L40 14 L50 6 L62 10";
  if (tone === "orange") return "M2 26 L12 20 L20 22 L30 14 L40 18 L50 9 L62 6";
  if (tone === "violet") return "M2 25 L11 23 L20 16 L30 19 L39 12 L49 14 L62 5";
  if (tone === "slate") return "M2 18 L12 18 L22 18 L32 18 L42 18 L52 18 L62 18";
  return "M2 26 L12 20 L20 23 L30 15 L40 18 L50 9 L62 6";
}

function KpiCard({
  title,
  value,
  helper,
  tone,
  icon,
  href,
  active,
}: {
  title: string;
  value: string;
  helper: string;
  tone: "emerald" | "red" | "blue" | "violet" | "orange" | "slate";
  icon: string;
  href: string;
  active?: boolean;
}) {
  const palette = {
    emerald: {
      card: "border-emerald-100 bg-emerald-50/55 hover:border-emerald-200",
      icon: "bg-emerald-100 text-emerald-700 ring-emerald-200",
      value: "text-emerald-600",
      stroke: "stroke-emerald-500",
      ring: "ring-emerald-200",
    },
    red: {
      card: "border-red-100 bg-red-50/55 hover:border-red-200",
      icon: "bg-red-100 text-red-700 ring-red-200",
      value: "text-red-600",
      stroke: "stroke-red-500",
      ring: "ring-red-200",
    },
    blue: {
      card: "border-blue-100 bg-blue-50/55 hover:border-blue-200",
      icon: "bg-blue-100 text-blue-700 ring-blue-200",
      value: "text-blue-600",
      stroke: "stroke-blue-500",
      ring: "ring-blue-200",
    },
    violet: {
      card: "border-violet-100 bg-violet-50/55 hover:border-violet-200",
      icon: "bg-violet-100 text-violet-700 ring-violet-200",
      value: "text-violet-600",
      stroke: "stroke-violet-500",
      ring: "ring-violet-200",
    },
    orange: {
      card: "border-orange-100 bg-orange-50/55 hover:border-orange-200",
      icon: "bg-orange-100 text-orange-700 ring-orange-200",
      value: "text-orange-600",
      stroke: "stroke-orange-500",
      ring: "ring-orange-200",
    },
    slate: {
      card: "border-slate-200 bg-white hover:border-slate-300",
      icon: "bg-slate-100 text-slate-600 ring-slate-200",
      value: "text-slate-950",
      stroke: "stroke-slate-500",
      ring: "ring-slate-200",
    },
  }[tone];

  return (
    <Link
      href={href}
      className={`group relative block overflow-hidden rounded-[24px] border p-5 shadow-sm shadow-slate-200/60 transition hover:-translate-y-0.5 hover:shadow-md ${palette.card} ${
        active ? `ring-2 ${palette.ring}` : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-black text-slate-500">{title}</div>
          <div className={`mt-3 text-2xl font-black tracking-tight ${palette.value}`}>
            {value}
          </div>
        </div>

        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-sm font-black ring-1 ${palette.icon}`}
        >
          {icon}
        </div>
      </div>

      <div className="mt-3 text-xs font-semibold leading-5 text-slate-500">
        {helper}
      </div>

      <svg
        className="mt-4 h-9 w-28 opacity-80 transition group-hover:opacity-100"
        viewBox="0 0 64 32"
        fill="none"
        aria-hidden="true"
      >
        <path
          d={tinyTrendPath(tone)}
          className={palette.stroke}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </Link>
  );
}

function compactNumber(value: number) {
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(".", ",")} млн ₽`;
  }

  if (Math.abs(value) >= 1_000) {
    return `${Math.round(value / 1_000).toLocaleString("ru-RU")} тыс. ₽`;
  }

  return formatMoney(value);
}

function filterButtonClass(active: boolean) {
  return active
    ? "bg-violet-50 text-violet-700 ring-1 ring-violet-100"
    : "bg-slate-50 text-slate-500 hover:bg-slate-100 hover:text-slate-800";
}

export default async function FinanceOperationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const defaultRange = getDefaultDateRange();

  const company = params?.company ?? "ALL";
  const operationType = (params?.operationType ?? "ALL") as OperationType;
  const selectedCategory = params?.category ?? "ALL";
  const selectedBankAccount = params?.bankAccount ?? "ALL";
  const search = params?.search ?? "";
  const rowsLimit = Number(params?.rows ?? 50);
  const sortBy = params?.sortBy ?? "operationDate";
  const sortDir = params?.sortDir ?? "desc";
  const dateFrom = params?.dateFrom ?? defaultRange.dateFrom;
  const dateTo = params?.dateTo ?? defaultRange.dateTo;
  const selectedMetric = params?.metric ?? "";
  const selectedSource = normalizeSourceFilter(params?.source);

  const safeRowsLimit = ROWS_OPTIONS.includes(rowsLimit) ? rowsLimit : 50;
  const safeSortBy = SORTABLE_COLUMNS.includes(sortBy) ? sortBy : "operationDate";
  const safeSortDir = sortDir === "asc" ? "asc" : "desc";

  function sortHref(column: string) {
    const nextSortDir =
      safeSortBy === column && safeSortDir === "desc" ? "asc" : "desc";

    return buildHref(params, {
      sortBy: column,
      sortDir: nextSortDir,
    });
  }

  function sortIcon(column: string) {
    if (safeSortBy !== column) return "↕";
    return safeSortDir === "desc" ? "↓" : "↑";
  }

  const [categories, companies, accounts] = await Promise.all([
    prisma.financeCategory.findMany({
      where: {
        isActive: true,
      },
      orderBy: [{ categoryType: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.$queryRaw<{ id: string; name: string }[]>`
      select "id", "name"
      from "Company"
      where "isActive" = true
      order by "name" asc
    `,
    prisma.financeAccount.findMany({
      where: {
        isActive: true,
      },
      orderBy: [{ companyName: "asc" }, { name: "asc" }],
    }),
  ]);

  const transactionWhere = {
    ...(company !== "ALL" ? { companyName: company } : {}),
    ...(operationType !== "ALL" ? { operationType } : {}),
    ...(selectedCategory !== "ALL" ? { category: selectedCategory } : {}),
    ...(selectedBankAccount !== "ALL" ? { bankAccount: selectedBankAccount } : {}),
    ...(selectedSource === "MANUAL" ? { sourceType: null } : {}),
    ...(selectedSource === "TELEGRAM" ? { sourceType: "TELEGRAM_BOT" } : {}),
    ...(selectedSource === "EXCEL"
      ? {
          sourceType: {
            in: ["FINANCE_EXCEL_IMPORT", "GOOGLE_SHEETS_IMPORT"],
          },
        }
      : {}),
    ...(search
      ? {
          OR: [
            { category: { contains: search, mode: "insensitive" as const } },
            { subcategory: { contains: search, mode: "insensitive" as const } },
            { counterparty: { contains: search, mode: "insensitive" as const } },
            { bankAccount: { contains: search, mode: "insensitive" as const } },
            { project: { contains: search, mode: "insensitive" as const } },
            { comment: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...(dateFrom || dateTo
      ? {
          operationDate: {
            ...(dateFrom ? { gte: new Date(`${dateFrom}T00:00:00`) } : {}),
            ...(dateTo ? { lte: new Date(`${dateTo}T23:59:59`) } : {}),
          },
        }
      : {}),
  };

  const [metricRows, rawRows, rawTotalRowsCount] = await Promise.all([
    prisma.financeTransaction.findMany({
      where: transactionWhere,
    }),
    prisma.financeTransaction.findMany({
      where: transactionWhere,
      orderBy: {
        [safeSortBy]: safeSortDir,
      },
      take: safeRowsLimit,
    }),
    prisma.financeTransaction.count({
      where: transactionWhere,
    }),
  ]);

  const metrics = calculateFinanceMetricsForRows({
    transactions: metricRows,
    categories,
  });

  const categoryTreatmentIndex = buildFinanceCategoryTreatmentIndex(categories);
  const selectedMetricConfig = getMetricConfig(selectedMetric);
  const selectedMetricRowsAll = selectedMetricConfig
    ? metricRows.filter((row) => {
        const treatment = getFinanceTransactionTreatment(row, categoryTreatmentIndex);

        return rowBelongsToMetric(
          row,
          selectedMetricConfig.key,
          treatment,
          categoryTreatmentIndex,
        );
      })
    : [];

  const rows = selectedMetricConfig
    ? sortFinanceRowsInMemory(selectedMetricRowsAll, safeSortBy, safeSortDir).slice(
        0,
        safeRowsLimit,
      )
    : rawRows;

  const totalRowsCount = selectedMetricConfig
    ? selectedMetricRowsAll.length
    : rawTotalRowsCount;

  const selectedMetricValue = selectedMetricConfig
    ? getMetricValue(selectedMetricConfig.key, metrics)
    : 0;

  const bankAccounts = accounts.map((account) => ({
    name: account.name,
    companyName: account.companyName,
  }));

  const visibleAccounts =
    company === "ALL"
      ? bankAccounts
      : bankAccounts.filter((account) => account.companyName === company);

  const hasActiveFilters =
    company !== "ALL" ||
    operationType !== "ALL" ||
    selectedCategory !== "ALL" ||
    selectedBankAccount !== "ALL" ||
    selectedSource !== "ALL" ||
    Boolean(search) ||
    Boolean(selectedMetricConfig);

  return (
    <main className="page-shell">
      <div className="page-container space-y-5">
        <section className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h1 className="text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">
              Финансовые операции
            </h1>
            <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-500">
              Все движения денег: поступления, расходы, оплаты, кредиты и переводы.
              Контролируйте ДДС и прибыль компании.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link
              href="/finance/categories"
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              <span>▦</span>
              Справочник статей
            </Link>

            <details className="relative">
              <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-black text-emerald-700 shadow-sm transition hover:bg-emerald-100 [&::-webkit-details-marker]:hidden">
                <span>▣</span>
                Импорт Excel
                <span className="text-emerald-500">⌄</span>
              </summary>

              <div className="absolute right-0 z-20 mt-2 w-72 overflow-hidden rounded-3xl border border-slate-200 bg-white p-2 shadow-xl shadow-slate-200/70">
                <a
                  href="/api/templates/finance-transactions"
                  className="flex w-full items-start gap-3 rounded-2xl px-4 py-3 text-left transition hover:bg-slate-50"
                >
                  <span className="mt-1 text-emerald-600">⇩</span>
                  <span>
                    <span className="block text-sm font-black text-slate-800">
                      Скачать шаблон
                    </span>
                    <span className="mt-1 block text-xs font-semibold text-slate-500">
                      Excel-шаблон для загрузки операций
                    </span>
                  </span>
                </a>

                <Link
                  href="/import?reportType=FINANCE_TRANSACTIONS"
                  className="flex w-full items-start gap-3 rounded-2xl px-4 py-3 text-left transition hover:bg-slate-50"
                >
                  <span className="mt-1 text-violet-600">⇧</span>
                  <span>
                    <span className="block text-sm font-black text-slate-800">
                      Загрузить файл
                    </span>
                    <span className="mt-1 block text-xs font-semibold text-slate-500">
                      Импорт операций из Excel
                    </span>
                  </span>
                </Link>
              </div>
            </details>

            <a
              href="#quick-add"
              className="inline-flex items-center gap-2 rounded-2xl bg-slate-950 px-5 py-3 text-sm font-black text-white shadow-lg shadow-slate-300 transition hover:bg-slate-800"
            >
              <span>＋</span>
              Добавить операцию
            </a>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
          <KpiCard
            title="Поступления (ДДС)"
            value={formatMoney(metrics.cashIncome)}
            helper="Нажмите, чтобы увидеть операции"
            tone="emerald"
            icon="↙"
            href={`${buildHref(params, { metric: "cashIncome" })}#journal`}
            active={selectedMetric === "cashIncome"}
          />
          <KpiCard
            title="Выплаты (ДДС)"
            value={formatMoney(metrics.cashOutflow)}
            helper="Нажмите, чтобы увидеть операции"
            tone="red"
            icon="↗"
            href={`${buildHref(params, { metric: "cashOutflow" })}#journal`}
            active={selectedMetric === "cashOutflow"}
          />
          <KpiCard
            title="Чистый ДДС"
            value={formatMoney(metrics.netCashFlow)}
            helper="Поступления и выплаты"
            tone={metrics.netCashFlow >= 0 ? "emerald" : "violet"}
            icon="↯"
            href={`${buildHref(params, { metric: "netCashFlow" })}#journal`}
            active={selectedMetric === "netCashFlow"}
          />
          <KpiCard
            title="Влияние на чистую прибыль"
            value={formatMoney(metrics.netProfitImpact)}
            helper="Операции, влияющие на P&L"
            tone={metrics.netProfitImpact >= 0 ? "emerald" : "violet"}
            icon="▣"
            href={`${buildHref(params, { metric: "netProfitImpact" })}#journal`}
            active={selectedMetric === "netProfitImpact"}
          />
          <KpiCard
            title="Вывод собственника"
            value={formatMoney(metrics.ownerWithdrawals)}
            helper="Нажмите, чтобы увидеть выводы"
            tone="orange"
            icon="₽"
            href={`${buildHref(params, { metric: "ownerWithdrawals" })}#journal`}
            active={selectedMetric === "ownerWithdrawals"}
          />
          <KpiCard
            title="Внутренние переводы"
            value={formatMoney(metrics.transferTotal)}
            helper="Между счетами и кассами"
            tone="slate"
            icon="⇄"
            href={`${buildHref(params, { metric: "transferTotal" })}#journal`}
            active={selectedMetric === "transferTotal"}
          />
        </section>

        <section className="panel p-5 sm:p-6">
          <form className="grid gap-4 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1.2fr_1fr_1fr_1fr_120px_130px] xl:items-end">
            <input type="hidden" name="search" value={search} />
            <input type="hidden" name="rows" value={safeRowsLimit} />
            <input type="hidden" name="sortBy" value={safeSortBy} />
            <input type="hidden" name="sortDir" value={safeSortDir} />
            <input type="hidden" name="metric" value={selectedMetric} />
            <input type="hidden" name="bankAccount" value={selectedBankAccount} />

            <label className="block">
              <span className="text-xs font-black text-slate-500">Период от</span>
              <input
                type="date"
                name="dateFrom"
                defaultValue={dateFrom}
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700 outline-none transition focus:border-violet-200 focus:bg-white focus:ring-4 focus:ring-violet-50"
              />
            </label>

            <label className="block">
              <span className="text-xs font-black text-slate-500">Период до</span>
              <input
                type="date"
                name="dateTo"
                defaultValue={dateTo}
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700 outline-none transition focus:border-violet-200 focus:bg-white focus:ring-4 focus:ring-violet-50"
              />
            </label>

            <label className="block">
              <span className="text-xs font-black text-slate-500">Компания</span>
              <select
                name="company"
                defaultValue={company}
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700 outline-none transition focus:border-violet-200 focus:bg-white focus:ring-4 focus:ring-violet-50"
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
              <span className="text-xs font-black text-slate-500">Тип операции</span>
              <select
                name="operationType"
                defaultValue={operationType}
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700 outline-none transition focus:border-violet-200 focus:bg-white focus:ring-4 focus:ring-violet-50"
              >
                <option value="ALL">Все типы</option>
                <option value="INCOME">Поступления</option>
                <option value="EXPENSE">Расходы</option>
                <option value="TRANSFER">Переводы</option>
                <option value="FINANCING">Финансирование</option>
                <option value="PERSONAL">Личные / вывод</option>
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-black text-slate-500">Статья</span>
              <select
                name="category"
                defaultValue={selectedCategory}
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700 outline-none transition focus:border-violet-200 focus:bg-white focus:ring-4 focus:ring-violet-50"
              >
                <option value="ALL">Все статьи</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.name}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-black text-slate-500">Источник</span>
              <select
                name="source"
                defaultValue={selectedSource}
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700 outline-none transition focus:border-violet-200 focus:bg-white focus:ring-4 focus:ring-violet-50"
              >
                {SOURCE_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <Link
              href="/finance/operations"
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-center text-sm font-black text-slate-700 transition hover:bg-slate-50"
            >
              Сбросить
            </Link>

            <button className="rounded-2xl bg-slate-950 px-4 py-3 text-sm font-black text-white shadow-lg shadow-slate-300 transition hover:bg-slate-800">
              Применить
            </button>

            <details className="md:col-span-2 xl:col-span-6">
              <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-600 transition hover:bg-slate-50 [&::-webkit-details-marker]:hidden">
                <span>≡</span>
                Расширенные фильтры
              </summary>

              <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <label className="block">
                  <span className="text-xs font-black text-slate-500">Счёт / касса</span>
                  <select
                    name="bankAccount"
                    defaultValue={selectedBankAccount}
                    className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700 outline-none transition focus:border-violet-200 focus:bg-white focus:ring-4 focus:ring-violet-50"
                  >
                    <option value="ALL">Все счета</option>
                    {visibleAccounts.map((account) => (
                      <option
                        key={`${account.companyName}-${account.name}`}
                        value={account.name}
                      >
                        {account.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </details>

            <div className="hidden text-right text-xs font-semibold text-slate-400 xl:block xl:col-span-2">
              {hasActiveFilters ? "Фильтр применён" : "Фильтр не применён"}
            </div>
          </form>
        </section>

        <section id="quick-add" className="panel border-violet-100 bg-violet-50/30 p-5 sm:p-6">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-lg font-black tracking-tight text-violet-900">
                Быстрое добавление операции
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-500">
                Добавьте поступление, расход, кредит, вывод или перевод за несколько секунд.
              </p>
            </div>

            <Link
              href="/finance/operations/new"
              className="inline-flex items-center gap-2 text-sm font-black text-violet-700"
            >
              Открыть полную форму
              <span>→</span>
            </Link>
          </div>

          <form
            action={createFinanceTransaction}
            className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-12"
          >
            <input
              type="date"
              name="operationDate"
              defaultValue={dateTo}
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-violet-200 focus:ring-4 focus:ring-violet-50 xl:col-span-2"
            />

            <select
              name="companyName"
              defaultValue={company !== "ALL" ? company : companies[0]?.name}
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-violet-200 focus:ring-4 focus:ring-violet-50 xl:col-span-2"
            >
              {companies.map((company) => (
                <option key={company.id} value={company.name}>
                  {company.name}
                </option>
              ))}
            </select>

            <select
              name="operationType"
              defaultValue={operationType !== "ALL" ? operationType : "EXPENSE"}
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-violet-200 focus:ring-4 focus:ring-violet-50 xl:col-span-2"
            >
              <option value="INCOME">Поступление</option>
              <option value="EXPENSE">Расход</option>
              <option value="TRANSFER">Перевод</option>
              <option value="FINANCING">Финансирование</option>
              <option value="PERSONAL">Личные / вывод</option>
            </select>

            <select
              name="category"
              defaultValue={selectedCategory !== "ALL" ? selectedCategory : ""}
              required
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-violet-200 focus:ring-4 focus:ring-violet-50 xl:col-span-2"
            >
              <option value="">Выберите статью</option>
              {categories.map((category) => (
                <option key={category.id} value={category.name}>
                  {category.name}
                </option>
              ))}
            </select>

            <select
              name="bankAccount"
              defaultValue={selectedBankAccount !== "ALL" ? selectedBankAccount : ""}
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-violet-200 focus:ring-4 focus:ring-violet-50 xl:col-span-2"
            >
              <option value="">Счёт / касса</option>
              {visibleAccounts.map((account) => (
                <option key={`${account.companyName}-${account.name}`} value={account.name}>
                  {account.name}
                </option>
              ))}
            </select>

            <input
              name="amount"
              inputMode="decimal"
              placeholder="Сумма"
              required
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-violet-200 focus:ring-4 focus:ring-violet-50 xl:col-span-1"
            />

            <input
              name="comment"
              placeholder="Комментарий"
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-violet-200 focus:ring-4 focus:ring-violet-50 xl:col-span-3"
            />

            <button className="rounded-2xl bg-violet-700 px-4 py-3 text-sm font-black text-white shadow-lg shadow-violet-200 transition hover:bg-violet-800 xl:col-span-1">
              Сохранить
            </button>

            <details className="md:col-span-2 xl:col-span-8">
              <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-2xl px-1 py-2 text-sm font-black text-violet-700 [&::-webkit-details-marker]:hidden">
                Дополнительные поля
                <span>⌄</span>
              </summary>

              <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                <input
                  type="date"
                  name="obligationDate"
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
                />

                <input
                  name="subcategory"
                  placeholder="Подстатья"
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
                />

                <input
                  name="counterparty"
                  placeholder="Контрагент"
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
                />

                <input
                  name="project"
                  placeholder="Проект"
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
                />

                <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700">
                  <input type="checkbox" name="isInternalTransfer" />
                  Внутренний перевод
                </label>
              </div>
            </details>
          </form>
        </section>

        {selectedMetricConfig ? (
          <section className="panel p-5 sm:p-6" id="journal">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <div className="inline-flex rounded-full bg-violet-50 px-3 py-1 text-xs font-black uppercase tracking-[0.12em] text-violet-700 ring-1 ring-violet-100">
                  Расшифровка показателя
                </div>
                <h2 className="mt-3 text-2xl font-black tracking-tight text-slate-950">
                  {selectedMetricConfig.title}
                </h2>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">
                  {selectedMetricConfig.description}
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:min-w-[420px]">
                <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
                  <div className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                    Сумма блока
                  </div>
                  <div className="mt-2 text-2xl font-black text-slate-950">
                    {formatMoney(selectedMetricValue)}
                  </div>
                </div>

                <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
                  <div className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                    Операций
                  </div>
                  <div className="mt-2 text-2xl font-black text-slate-950">
                    {selectedMetricRowsAll.length}
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              <Link
                href={`${buildHref(params, { metric: "" })}#journal`}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-700 transition hover:bg-slate-50"
              >
                Показать все операции
              </Link>
            </div>
          </section>
        ) : null}

        <section className="panel overflow-hidden" id={selectedMetricConfig ? undefined : "journal"}>
          <div className="border-b border-slate-200 p-5 sm:p-6">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <h2 className="text-2xl font-black tracking-tight text-slate-950">
                  {selectedMetricConfig
                    ? `Операции блока: ${selectedMetricConfig.title}`
                    : "Журнал операций"}
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-500">
                  Показано {rows.length} из {totalRowsCount} операций по выбранным фильтрам.
                </p>
              </div>

              <form className="flex flex-col gap-3 xl:flex-row xl:items-center">
                <input type="hidden" name="company" value={company} />
                <input type="hidden" name="operationType" value={operationType} />
                <input type="hidden" name="category" value={selectedCategory} />
                <input type="hidden" name="bankAccount" value={selectedBankAccount} />
                <input type="hidden" name="dateFrom" value={dateFrom} />
                <input type="hidden" name="dateTo" value={dateTo} />
                <input type="hidden" name="sortBy" value={safeSortBy} />
                <input type="hidden" name="sortDir" value={safeSortDir} />
                <input type="hidden" name="metric" value={selectedMetric} />
                <input type="hidden" name="source" value={selectedSource} />

                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">
                    🔎
                  </span>
                  <input
                    type="text"
                    name="search"
                    defaultValue={search}
                    placeholder="Поиск по комментарию, контрагенту..."
                    className="w-full rounded-2xl border border-slate-200 bg-white py-3 pl-11 pr-4 text-sm font-bold text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-violet-200 focus:ring-4 focus:ring-violet-50 xl:w-[340px]"
                  />
                </div>

                <select
                  name="rows"
                  defaultValue={safeRowsLimit}
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-700 outline-none"
                >
                  {ROWS_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option} на странице
                    </option>
                  ))}
                </select>

                <button className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-black text-white shadow-lg shadow-slate-300 transition hover:bg-slate-800">
                  Найти
                </button>

                <button
                  type="button"
                  disabled
                  title="Экспорт сделаем вместе с Excel-импортом"
                  className="cursor-not-allowed rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-400"
                >
                  Экспорт
                </button>
              </form>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              {OPERATION_TABS.map((tab) => {
                const isActive = operationType === tab.value;

                return (
                  <Link
                    key={tab.value}
                    href={buildHref(params, {
                      operationType: tab.value,
                      metric: "",
                    })}
                    className={`rounded-2xl px-4 py-2 text-sm font-black transition ${filterButtonClass(isActive)}`}
                  >
                    {tab.label}
                  </Link>
                );
              })}
            </div>
          </div>

          <div className="divide-y divide-slate-100 lg:hidden">
            {rows.map((row) => {
              const treatment = getFinanceTransactionTreatment(row, categoryTreatmentIndex);
              const cashEffect = getFinanceTransactionCashEffect(row, categoryTreatmentIndex);

              return (
                <div key={row.id} className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-sm font-semibold text-slate-500">
                        {formatDate(row.operationDate)}
                      </div>
                      <div className="mt-1 font-black text-slate-950">
                        {row.companyName}
                      </div>
                    </div>

                    <div
                      className={`text-right text-lg font-black ${amountClassName(cashEffect)}`}
                    >
                      {cashEffect === 0
                        ? formatMoney(row.amount)
                        : formatSignedMoney(cashEffect)}
                    </div>
                  </div>

                  <div className="mt-3">
                    <div
                      className={`inline-flex rounded-full px-3 py-1 text-xs font-black ring-1 ${operationTypeClassName(row.operationType)}`}
                    >
                      {operationTypeLabel(row.operationType)}
                    </div>

                    <div className="mt-2 font-black text-slate-950">{row.category}</div>

                    <div
                      className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-black ring-1 ${treatment.className}`}
                    >
                      {treatment.label}
                    </div>
                  </div>

                  <div className="mt-3 grid gap-2 text-sm font-semibold text-slate-600">
                    <div>Счёт: {shortText(row.bankAccount)}</div>
                    <div>Контрагент: {shortText(row.counterparty)}</div>
                    <div>Комментарий: {shortText(row.comment)}</div>
                    <div>
                      Источник:{" "}
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-black ring-1 ${sourceClassName(row.sourceType)}`}
                      >
                        {sourceLabel(row.sourceType)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}

            {rows.length === 0 ? (
              <div className="p-8 text-center text-slate-500">
                Операции пока не загружены.
              </div>
            ) : null}
          </div>

          <div className="hidden lg:block">
            <table className="w-full border-collapse text-sm">
              <thead className="bg-slate-50 text-left text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                <tr>
                  <th className="px-4 py-4">
                    <Link href={sortHref("operationDate")}>Дата {sortIcon("operationDate")}</Link>
                  </th>
                  <th className="px-4 py-4">
                    <Link href={sortHref("companyName")}>Компания {sortIcon("companyName")}</Link>
                  </th>
                  <th className="px-4 py-4">
                    <Link href={sortHref("operationType")}>Тип {sortIcon("operationType")}</Link>
                  </th>
                  <th className="px-4 py-4">
                    <Link href={sortHref("category")}>Статья {sortIcon("category")}</Link>
                  </th>
                  <th className="px-4 py-4">Счёт / касса</th>
                  <th className="px-4 py-4 text-right">
                    <Link href={sortHref("amount")}>Сумма {sortIcon("amount")}</Link>
                  </th>
                  <th className="px-4 py-4">Роль в модели</th>
                  <th className="px-4 py-4">Источник</th>
                  <th className="px-4 py-4">Комментарий</th>
                  <th className="px-4 py-4 text-center">Действия</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => {
                  const treatment = getFinanceTransactionTreatment(row, categoryTreatmentIndex);
                  const cashEffect = getFinanceTransactionCashEffect(row, categoryTreatmentIndex);

                  return (
                    <tr key={row.id} className="transition hover:bg-slate-50/80">
                      <td className="px-4 py-4 align-top">
                        <div className="font-black text-slate-800">
                          {formatDate(row.operationDate)}
                        </div>
                        {row.obligationDate ? (
                          <div className="mt-1 text-xs font-semibold text-slate-400">
                            Обязательство: {formatDate(row.obligationDate)}
                          </div>
                        ) : null}
                      </td>

                      <td className="px-4 py-4 align-top font-bold text-slate-700">
                        {row.companyName}
                      </td>

                      <td className="px-4 py-4 align-top">
                        <span
                          className={`inline-flex whitespace-nowrap rounded-full px-3 py-1 text-xs font-black ring-1 ${operationTypeClassName(row.operationType)}`}
                        >
                          {operationTypeLabel(row.operationType)}
                        </span>
                      </td>

                      <td className="px-4 py-4 align-top">
                        <div className="font-black text-slate-950">{row.category}</div>
                        {row.subcategory ? (
                          <div className="mt-1 text-xs font-semibold text-slate-400">
                            {row.subcategory}
                          </div>
                        ) : null}
                      </td>

                      <td className="px-4 py-4 align-top">
                        <div className="font-semibold text-slate-700">
                          {shortText(row.bankAccount)}
                        </div>
                        {row.counterparty ? (
                          <div className="mt-1 text-xs font-semibold text-slate-400">
                            {row.counterparty}
                          </div>
                        ) : null}
                      </td>

                      <td
                        className={`px-4 py-4 text-right align-top text-base font-black ${amountClassName(cashEffect)}`}
                      >
                        {cashEffect === 0
                          ? formatMoney(row.amount)
                          : formatSignedMoney(cashEffect)}
                      </td>

                      <td className="px-4 py-4 align-top">
                        <div
                          className={`inline-flex max-w-[160px] rounded-full px-3 py-1 text-xs font-black ring-1 ${treatment.className}`}
                          title={treatment.description}
                        >
                          <span className="truncate">{treatment.label}</span>
                        </div>
                      </td>

                      <td className="px-4 py-4 align-top">
                        <div
                          className={`inline-flex whitespace-nowrap rounded-full px-3 py-1 text-xs font-black ring-1 ${sourceClassName(row.sourceType)}`}
                          title={sourceDescription(row.sourceType)}
                        >
                          {sourceLabel(row.sourceType)}
                        </div>
                      </td>

                      <td className="max-w-[280px] px-4 py-4 align-top">
                        <div className="truncate font-semibold text-slate-600">
                          {shortText(row.comment)}
                        </div>
                        {row.project ? (
                          <div className="mt-1 text-xs font-semibold text-slate-400">
                            Проект: {row.project}
                          </div>
                        ) : null}
                      </td>

                      <td className="px-4 py-4 text-center align-top">
                        <details className="relative inline-block">
                          <summary className="flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-2xl bg-slate-50 text-lg font-black text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 [&::-webkit-details-marker]:hidden">
                            ⋮
                          </summary>

                          <div className="absolute right-0 z-20 mt-2 w-40 overflow-hidden rounded-2xl border border-slate-200 bg-white p-2 text-left shadow-xl shadow-slate-200/70">
                            <Link
                              href={`/finance/operations/edit/${row.id}`}
                              className="block rounded-xl px-3 py-2 text-sm font-black text-slate-700 hover:bg-slate-50"
                            >
                              Изменить
                            </Link>

                            <form action={deleteFinanceTransaction}>
                              <input type="hidden" name="id" value={row.id} />
                              <button
                                type="submit"
                                className="block w-full rounded-xl px-3 py-2 text-left text-sm font-black text-red-600 hover:bg-red-50"
                              >
                                Удалить
                              </button>
                            </form>
                          </div>
                        </details>
                      </td>
                    </tr>
                  );
                })}

                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="p-10 text-center text-slate-500">
                      Операции пока не загружены.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="flex flex-col gap-3 border-t border-slate-100 p-5 text-sm font-semibold text-slate-500 sm:flex-row sm:items-center sm:justify-between">
            <div>
              Показано 1–{rows.length} из {totalRowsCount} операций
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled
                className="h-9 w-9 cursor-not-allowed rounded-2xl border border-slate-200 bg-slate-50 text-slate-300"
              >
                ‹
              </button>
              <div className="flex h-9 min-w-9 items-center justify-center rounded-2xl bg-violet-700 px-3 font-black text-white shadow-sm shadow-violet-200">
                1
              </div>
              <button
                type="button"
                disabled
                className="h-9 w-9 cursor-not-allowed rounded-2xl border border-slate-200 bg-slate-50 text-slate-300"
              >
                ›
              </button>
              <div className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-slate-500">
                Страница 1
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
