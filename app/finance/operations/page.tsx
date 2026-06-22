import Link from "next/link";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import {
  buildFinanceCategoryTreatmentIndex,
  calculateFinanceMetricsForRows,
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
};

type OperationType =
  | "ALL"
  | "INCOME"
  | "EXPENSE"
  | "TRANSFER"
  | "FINANCING"
  | "PERSONAL";

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
      .replace(",", ".")
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
  if (type === "INCOME") return "bg-emerald-50 text-emerald-700 ring-emerald-100";
  if (type === "EXPENSE") return "bg-red-50 text-red-700 ring-red-100";
  if (type === "TRANSFER") return "bg-slate-100 text-slate-600 ring-slate-200";
  if (type === "FINANCING") return "bg-blue-50 text-blue-700 ring-blue-100";
  if (type === "PERSONAL") return "bg-orange-50 text-orange-700 ring-orange-100";
  return "bg-slate-50 text-slate-700 ring-slate-200";
}

function valueClassName(value: number) {
  if (value > 0) return "text-emerald-600";
  if (value < 0) return "text-red-600";
  return "text-slate-900";
}

function getSignedAmount(row: { operationType: string; amount: unknown }) {
  const amount = Number(row.amount ?? 0);

  if (row.operationType === "EXPENSE" || row.operationType === "PERSONAL") {
    return -amount;
  }

  if (row.operationType === "TRANSFER") {
    return 0;
  }

  return amount;
}

function getAmountDisplay(row: { operationType: string; amount: unknown }) {
  const amount = Number(row.amount ?? 0);

  if (row.operationType === "EXPENSE" || row.operationType === "PERSONAL") {
    return formatSignedMoney(-amount);
  }

  if (row.operationType === "TRANSFER") {
    return formatMoney(amount);
  }

  return formatSignedMoney(amount);
}

function shortText(value: string | null | undefined, fallback = "—") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

async function createFinanceTransaction(formData: FormData) {
  "use server";

  const companyName = String(formData.get("companyName") ?? "").trim();
  const operationType = String(formData.get("operationType") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim();
  const amount = toNumber(formData.get("amount"));
  const operationDate = toDate(formData.get("operationDate"));
  const obligationDate = toDate(formData.get("obligationDate"));

  if (
    !companyName ||
    !operationType ||
    !category ||
    !operationDate ||
    amount <= 0
  ) {
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
        operationType === "TRANSFER" ||
        formData.get("isInternalTransfer") === "on",
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

function KpiCard({
  title,
  value,
  helper,
  tone,
  icon,
}: {
  title: string;
  value: string;
  helper: string;
  tone: "emerald" | "red" | "blue" | "violet" | "orange" | "slate";
  icon: string;
}) {
  const toneClass =
    tone === "emerald"
      ? "bg-emerald-50 text-emerald-600 ring-emerald-100"
      : tone === "red"
        ? "bg-red-50 text-red-600 ring-red-100"
        : tone === "blue"
          ? "bg-blue-50 text-blue-600 ring-blue-100"
          : tone === "violet"
            ? "bg-violet-50 text-violet-600 ring-violet-100"
            : tone === "orange"
              ? "bg-orange-50 text-orange-600 ring-orange-100"
              : "bg-slate-100 text-slate-600 ring-slate-200";

  const valueColor =
    tone === "emerald"
      ? "text-emerald-600"
      : tone === "red"
        ? "text-red-600"
        : tone === "blue"
          ? "text-blue-600"
          : tone === "violet"
            ? "text-violet-600"
            : tone === "orange"
              ? "text-orange-600"
              : "text-slate-950";

  return (
    <div className="rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/50">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-black text-slate-500">{title}</div>
          <div className={`mt-3 text-2xl font-black tracking-tight ${valueColor}`}>
            {value}
          </div>
        </div>

        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-sm font-black ring-1 ${toneClass}`}
        >
          {icon}
        </div>
      </div>

      <div className="mt-3 text-xs font-semibold leading-5 text-slate-500">
        {helper}
      </div>
    </div>
  );
}

function TreatmentInfoCard({
  title,
  value,
  description,
  tone,
}: {
  title: string;
  value: string;
  description: string;
  tone: "cyan" | "blue" | "violet" | "slate";
}) {
  const className =
    tone === "cyan"
      ? "border-cyan-100 bg-cyan-50/80 text-cyan-800"
      : tone === "blue"
        ? "border-blue-100 bg-blue-50/80 text-blue-800"
        : tone === "violet"
          ? "border-violet-100 bg-violet-50/80 text-violet-800"
          : "border-slate-200 bg-slate-50 text-slate-700";

  return (
    <div className={`rounded-[26px] border p-5 ${className}`}>
      <div className="text-sm font-black">{title}</div>
      <div className="mt-2 text-2xl font-black">{value}</div>
      <p className="mt-2 text-sm font-semibold leading-5 opacity-80">
        {description}
      </p>
    </div>
  );
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

  if (next.search) query.set("search", next.search);

  return `/finance/operations?${query.toString()}`;
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

  const safeRowsLimit = ROWS_OPTIONS.includes(rowsLimit) ? rowsLimit : 50;
  const safeSortBy = SORTABLE_COLUMNS.includes(sortBy)
    ? sortBy
    : "operationDate";
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
      orderBy: [
        { categoryType: "asc" },
        { sortOrder: "asc" },
        { name: "asc" },
      ],
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
      orderBy: [
        {
          companyName: "asc",
        },
        {
          name: "asc",
        },
      ],
    }),
  ]);

  const transactionWhere = {
    ...(company !== "ALL" ? { companyName: company } : {}),
    ...(operationType !== "ALL" ? { operationType } : {}),
    ...(selectedCategory !== "ALL" ? { category: selectedCategory } : {}),
    ...(selectedBankAccount !== "ALL" ? { bankAccount: selectedBankAccount } : {}),
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
            ...(dateFrom
              ? {
                  gte: new Date(`${dateFrom}T00:00:00`),
                }
              : {}),
            ...(dateTo
              ? {
                  lte: new Date(`${dateTo}T23:59:59`),
                }
              : {}),
          },
        }
      : {}),
  };

  const [metricRows, rows, totalRowsCount] = await Promise.all([
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
  const bankAccounts = accounts.map((account) => ({
    name: account.name,
    companyName: account.companyName,
  }));

  const visibleAccounts =
    company === "ALL"
      ? bankAccounts
      : bankAccounts.filter((account) => account.companyName === company);

  return (
    <main className="page-shell">
      <div className="page-container">
        <section className="panel p-5 sm:p-6">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <div className="inline-flex rounded-full bg-violet-50 px-3 py-1 text-xs font-black uppercase tracking-[0.12em] text-violet-700 ring-1 ring-violet-100">
                Финансы
              </div>

              <h1 className="mt-3 text-3xl font-black tracking-tight text-slate-950 sm:text-4xl">
                Финансовые операции
              </h1>

              <p className="mt-3 max-w-4xl text-sm leading-6 text-slate-500">
                Поступления, расходы, оплаты, кредиты и внутренние переводы.
                Роль статьи определяет влияние на ДДС, чистую прибыль и вывод
                собственника.
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
                  <button
                    type="button"
                    disabled
                    className="flex w-full cursor-not-allowed items-start gap-3 rounded-2xl px-4 py-3 text-left opacity-60"
                    title="Сделаем следующим шагом: Excel-шаблон и загрузка файла"
                  >
                    <span className="mt-1 text-slate-400">⇩</span>
                    <span>
                      <span className="block text-sm font-black text-slate-800">
                        Скачать шаблон
                      </span>
                      <span className="mt-1 block text-xs font-semibold text-slate-500">
                        Excel-шаблон для загрузки операций
                      </span>
                    </span>
                  </button>

                  <button
                    type="button"
                    disabled
                    className="flex w-full cursor-not-allowed items-start gap-3 rounded-2xl px-4 py-3 text-left opacity-60"
                    title="Сделаем следующим шагом: route загрузки Excel"
                  >
                    <span className="mt-1 text-slate-400">⇧</span>
                    <span>
                      <span className="block text-sm font-black text-slate-800">
                        Загрузить файл
                      </span>
                      <span className="mt-1 block text-xs font-semibold text-slate-500">
                        Импорт операций из Excel
                      </span>
                    </span>
                  </button>
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
          </div>
        </section>

        <form className="panel grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1fr_1fr_130px_130px]">
          <input type="hidden" name="search" value={search} />
          <input type="hidden" name="rows" value={safeRowsLimit} />
          <input type="hidden" name="sortBy" value={safeSortBy} />
          <input type="hidden" name="sortDir" value={safeSortDir} />

          <label className="block">
            <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
              Период от
            </span>
            <input
              type="date"
              name="dateFrom"
              defaultValue={dateFrom}
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700 outline-none transition focus:border-violet-200 focus:bg-white focus:ring-4 focus:ring-violet-50"
            />
          </label>

          <label className="block">
            <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
              Период до
            </span>
            <input
              type="date"
              name="dateTo"
              defaultValue={dateTo}
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-700 outline-none transition focus:border-violet-200 focus:bg-white focus:ring-4 focus:ring-violet-50"
            />
          </label>

          <label className="block">
            <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
              Компания
            </span>
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
            <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
              Тип операции
            </span>
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
            <span className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
              Статья
            </span>
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

          <div className="flex items-end">
            <Link
              href="/finance/operations"
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-center text-sm font-black text-slate-700 transition hover:bg-slate-50"
            >
              Сбросить
            </Link>
          </div>

          <div className="flex items-end">
            <button className="w-full rounded-2xl bg-slate-950 px-4 py-3 text-sm font-black text-white shadow-lg shadow-slate-300 transition hover:bg-slate-800">
              Применить
            </button>
          </div>
        </form>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
          <KpiCard
            title="Поступления (ДДС)"
            value={formatMoney(metrics.cashIncome)}
            helper="Деньги, поступившие на счета"
            tone="emerald"
            icon="↙"
          />

          <KpiCard
            title="Выплаты (ДДС)"
            value={formatMoney(metrics.cashOutflow)}
            helper="Все денежные списания"
            tone="red"
            icon="↗"
          />

          <KpiCard
            title="Чистый ДДС"
            value={formatMoney(metrics.netCashFlow)}
            helper="Поступления минус выплаты"
            tone={metrics.netCashFlow >= 0 ? "emerald" : "red"}
            icon="⇅"
          />

          <KpiCard
            title="Влияние на чистую прибыль"
            value={formatMoney(metrics.netProfitImpact)}
            helper="Только операции, влияющие на P&L"
            tone={metrics.netProfitImpact >= 0 ? "emerald" : "violet"}
            icon="▣"
          />

          <KpiCard
            title="Вывод собственника"
            value={formatMoney(metrics.ownerWithdrawals)}
            helper="Деньги, выведенные из бизнеса"
            tone="orange"
            icon="₽"
          />

          <KpiCard
            title="Внутренние переводы"
            value={formatMoney(metrics.transferTotal)}
            helper="Между счетами и кассами"
            tone="slate"
            icon="⇄"
          />
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <TreatmentInfoCard
            title="Только ДДС"
            value={formatMoney(metrics.cashOnlyTotal)}
            description="Закуп, упаковка, фулфилмент и другие расходы, которые уже сидят в себестоимости."
            tone="cyan"
          />

          <TreatmentInfoCard
            title="Тело кредита"
            value={formatMoney(metrics.creditPrincipal)}
            description="Уменьшает деньги на счетах, но не уменьшает чистую прибыль повторно."
            tone="blue"
          />

          <TreatmentInfoCard
            title="Проценты кредита"
            value={formatMoney(metrics.creditInterest)}
            description="Уменьшает и ДДС, и чистую прибыль бизнеса."
            tone="violet"
          />

          <TreatmentInfoCard
            title="Не учитывается"
            value={formatMoney(metrics.ignoredTotal)}
            description="Внутренние и технические операции без влияния на ключевые показатели."
            tone="slate"
          />
        </section>

        <section id="quick-add" className="panel p-5 sm:p-6">
          <div>
            <h2 className="text-2xl font-black tracking-tight text-slate-950">
              Быстрое добавление операции
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              Добавь поступление, расход, кредит, вывод или перевод. Роль статьи
              автоматически попадёт в финансовую модель.
            </p>
          </div>

          <form
            action={createFinanceTransaction}
            className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-[155px_180px_170px_minmax(220px,1fr)_190px_150px_minmax(220px,1fr)_170px]"
          >
            <input
              type="date"
              name="operationDate"
              defaultValue={dateTo}
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
            />

            <select
              name="companyName"
              defaultValue={company !== "ALL" ? company : companies[0]?.name}
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
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
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
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
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
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
              defaultValue={
                selectedBankAccount !== "ALL" ? selectedBankAccount : ""
              }
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
            >
              <option value="">Счёт / касса</option>
              {visibleAccounts.map((account) => (
                <option
                  key={`${account.companyName}-${account.name}`}
                  value={account.name}
                >
                  {account.name}
                </option>
              ))}
            </select>

            <input
              name="amount"
              inputMode="decimal"
              placeholder="Сумма"
              required
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
            />

            <input
              name="comment"
              placeholder="Комментарий"
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 outline-none focus:border-violet-200 focus:ring-4 focus:ring-violet-50"
            />

            <button className="rounded-2xl bg-slate-950 px-4 py-3 text-sm font-black text-white shadow-lg shadow-slate-300 transition hover:bg-slate-800">
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

        <section className="panel overflow-hidden">
          <div className="border-b border-slate-200 p-5 sm:p-6">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <h2 className="text-2xl font-black tracking-tight text-slate-950">
                  Журнал операций
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-500">
                  Показано {rows.length} из {totalRowsCount} операций по выбранным
                  фильтрам.
                </p>
              </div>

              <form className="flex flex-col gap-3 xl:flex-row xl:items-center">
                <input type="hidden" name="company" value={company} />
                <input
                  type="hidden"
                  name="operationType"
                  value={operationType}
                />
                <input type="hidden" name="category" value={selectedCategory} />
                <input
                  type="hidden"
                  name="bankAccount"
                  value={selectedBankAccount}
                />
                <input type="hidden" name="dateFrom" value={dateFrom} />
                <input type="hidden" name="dateTo" value={dateTo} />
                <input type="hidden" name="sortBy" value={safeSortBy} />
                <input type="hidden" name="sortDir" value={safeSortDir} />

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
              </form>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              {OPERATION_TABS.map((tab) => {
                const isActive = operationType === tab.value;

                return (
                  <Link
                    key={tab.value}
                    href={buildHref(params, { operationType: tab.value })}
                    className={`rounded-2xl px-4 py-2 text-sm font-black transition ${
                      isActive
                        ? "bg-violet-50 text-violet-700 ring-1 ring-violet-100"
                        : "bg-slate-50 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
                    }`}
                  >
                    {tab.label}
                  </Link>
                );
              })}

              <div className="flex-1" />

              <button
                type="button"
                disabled
                title="Экспорт сделаем вместе с Excel-импортом"
                className="cursor-not-allowed rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-black text-slate-400"
              >
                Экспорт
              </button>
            </div>
          </div>

          <div className="divide-y divide-slate-100 lg:hidden">
            {rows.map((row) => {
              const treatment = getFinanceTransactionTreatment(
                row,
                categoryTreatmentIndex
              );
              const signedAmount = getSignedAmount(row);

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
                      className={`text-right text-lg font-black ${valueClassName(
                        signedAmount
                      )}`}
                    >
                      {getAmountDisplay(row)}
                    </div>
                  </div>

                  <div className="mt-3">
                    <div
                      className={`inline-flex rounded-full px-3 py-1 text-xs font-black ring-1 ${operationTypeClassName(
                        row.operationType
                      )}`}
                    >
                      {operationTypeLabel(row.operationType)}
                    </div>

                    <div className="mt-2 font-black text-slate-950">
                      {row.category}
                    </div>

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

          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[1380px] border-collapse text-sm">
              <thead className="bg-slate-50 text-left text-slate-500">
                <tr>
                  <th className="px-5 py-4">
                    <Link href={sortHref("operationDate")}>
                      Дата {sortIcon("operationDate")}
                    </Link>
                  </th>
                  <th className="px-5 py-4">
                    <Link href={sortHref("companyName")}>
                      Компания {sortIcon("companyName")}
                    </Link>
                  </th>
                  <th className="px-5 py-4">
                    <Link href={sortHref("operationType")}>
                      Тип {sortIcon("operationType")}
                    </Link>
                  </th>
                  <th className="px-5 py-4">
                    <Link href={sortHref("category")}>
                      Статья {sortIcon("category")}
                    </Link>
                  </th>
                  <th className="px-5 py-4">Счёт</th>
                  <th className="px-5 py-4 text-right">
                    <Link href={sortHref("amount")}>
                      Сумма {sortIcon("amount")}
                    </Link>
                  </th>
                  <th className="px-5 py-4">Роль в модели</th>
                  <th className="px-5 py-4">Комментарий</th>
                  <th className="px-5 py-4 text-center">Действия</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => {
                  const treatment = getFinanceTransactionTreatment(
                    row,
                    categoryTreatmentIndex
                  );
                  const signedAmount = getSignedAmount(row);

                  return (
                    <tr key={row.id} className="transition hover:bg-slate-50">
                      <td className="px-5 py-4 align-top">
                        <div className="font-black text-slate-800">
                          {formatDate(row.operationDate)}
                        </div>
                        {row.obligationDate ? (
                          <div className="mt-1 text-xs font-semibold text-slate-400">
                            Обязательство: {formatDate(row.obligationDate)}
                          </div>
                        ) : null}
                      </td>

                      <td className="px-5 py-4 align-top font-bold text-slate-700">
                        {row.companyName}
                      </td>

                      <td className="px-5 py-4 align-top">
                        <span
                          className={`inline-flex rounded-full px-3 py-1 text-xs font-black ring-1 ${operationTypeClassName(
                            row.operationType
                          )}`}
                        >
                          {operationTypeLabel(row.operationType)}
                        </span>
                      </td>

                      <td className="px-5 py-4 align-top">
                        <div className="font-black text-slate-950">
                          {row.category}
                        </div>
                        {row.subcategory ? (
                          <div className="mt-1 text-xs font-semibold text-slate-400">
                            {row.subcategory}
                          </div>
                        ) : null}
                      </td>

                      <td className="px-5 py-4 align-top">
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
                        className={`px-5 py-4 text-right align-top text-base font-black ${valueClassName(
                          signedAmount
                        )}`}
                      >
                        {getAmountDisplay(row)}
                      </td>

                      <td className="px-5 py-4 align-top">
                        <div
                          className={`inline-flex rounded-full px-3 py-1 text-xs font-black ring-1 ${treatment.className}`}
                          title={treatment.description}
                        >
                          {treatment.label}
                        </div>
                      </td>

                      <td className="max-w-[260px] px-5 py-4 align-top">
                        <div className="truncate font-semibold text-slate-600">
                          {shortText(row.comment)}
                        </div>
                        {row.project ? (
                          <div className="mt-1 text-xs font-semibold text-slate-400">
                            Проект: {row.project}
                          </div>
                        ) : null}
                      </td>

                      <td className="px-5 py-4 text-center align-top">
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
                    <td colSpan={9} className="p-10 text-center text-slate-500">
                      Операции пока не загружены.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
