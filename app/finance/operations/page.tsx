import Link from "next/link";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";
import {
  buildFinanceCategoryTreatmentIndex,
  calculateFinanceMetricsForRows,
  getFinanceTransactionTreatment,
} from "@/lib/finance/financeMetrics";

import FinanceOperationForm from "./FinanceOperationForm";
import FinanceTransferForm from "./FinanceTransferForm";

function formatMoney(value: unknown) {
  const number = Number(value ?? 0);

  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(number) ? number : 0);
}

function formatDate(value?: Date | null) {
  if (!value) return "—";
  return value.toLocaleDateString("ru-RU");
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
  if (type === "INCOME") return "text-emerald-600";
  if (type === "EXPENSE") return "text-red-600";
  if (type === "TRANSFER") return "text-slate-500";
  if (type === "FINANCING") return "text-blue-600";
  if (type === "PERSONAL") return "text-amber-600";
  return "text-slate-700";
}

function valueClassName(value: number) {
  return value >= 0 ? "text-emerald-600" : "text-red-600";
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
}

export default async function FinanceOperationsPage({
  searchParams,
}: {
  searchParams: Promise<{
    company?: string;
    operationType?: string;
    category?: string;
    search?: string;
    rows?: string;
    sortBy?: string;
    sortDir?: string;
    dateFrom?: string;
    dateTo?: string;
  }>;
}) {
  const params = await searchParams;

  const company = params?.company ?? "ALL";
  const operationType = params?.operationType ?? "ALL";
  const selectedCategory = params?.category ?? "ALL";
  const search = params?.search ?? "";
  const rowsLimit = Number(params?.rows ?? 50);
  const sortBy = params?.sortBy ?? "operationDate";
  const sortDir = params?.sortDir ?? "desc";
  const dateFrom = params?.dateFrom ?? "";
  const dateTo = params?.dateTo ?? "";

  const safeRowsLimit = [25, 50, 100, 250, 500].includes(rowsLimit)
    ? rowsLimit
    : 50;

  const safeSortBy = [
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
  ].includes(sortBy)
    ? sortBy
    : "operationDate";

  const safeSortDir = sortDir === "asc" ? "asc" : "desc";

  function sortHref(column: string) {
    const nextSortDir =
      safeSortBy === column && safeSortDir === "desc" ? "asc" : "desc";

    const query = new URLSearchParams();

    query.set("company", company);
    query.set("operationType", operationType);
    query.set("category", selectedCategory);
    query.set("search", search);
    query.set("dateFrom", dateFrom);
    query.set("dateTo", dateTo);
    query.set("rows", String(safeRowsLimit));
    query.set("sortBy", column);
    query.set("sortDir", nextSortDir);

    return `/finance/operations?${query.toString()}`;
  }

  function sortIcon(column: string) {
    if (safeSortBy !== column) return "↕";
    return safeSortDir === "desc" ? "↓" : "↑";
  }

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

  const rows = await prisma.financeTransaction.findMany({
    where: {
      ...(company !== "ALL" ? { companyName: company } : {}),
      ...(operationType !== "ALL" ? { operationType } : {}),
      ...(selectedCategory !== "ALL" ? { category: selectedCategory } : {}),
      ...(search
        ? {
            OR: [
              { category: { contains: search, mode: "insensitive" } },
              { subcategory: { contains: search, mode: "insensitive" } },
              { counterparty: { contains: search, mode: "insensitive" } },
              { bankAccount: { contains: search, mode: "insensitive" } },
              { project: { contains: search, mode: "insensitive" } },
              { comment: { contains: search, mode: "insensitive" } },
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
    },
    orderBy: {
      [safeSortBy]: safeSortDir,
    },
    take: safeRowsLimit,
  });

  const companies = await prisma.$queryRaw<{ id: string; name: string }[]>`
    select "id", "name"
    from "Company"
    where "isActive" = true
    order by "name" asc
  `;

  const accounts = await prisma.financeAccount.findMany({
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
  });

  const bankAccounts = accounts.map((account) => ({
    name: account.name,
    companyName: account.companyName,
  }));

  const metrics = calculateFinanceMetricsForRows({
    transactions: rows,
    categories,
  });

  const categoryTreatmentIndex = buildFinanceCategoryTreatmentIndex(categories);

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-[1700px] space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900">
              Финансовые операции
            </h1>

            <p className="mt-3 text-slate-500">
              Поступления, расходы, оплаты и внутренние переводы компании.
              Расчёты идут по роли статьи в финансовой модели.
            </p>
          </div>

          <Link
            href="/finance/categories"
            className="rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white"
          >
            Справочник статей
          </Link>
        </div>

        <form className="grid gap-4 rounded-2xl bg-white p-6 shadow-sm lg:grid-cols-[1fr_1fr_1.4fr_180px_160px]">
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">
              Компания
            </label>

            <select
              name="company"
              defaultValue={company}
              className="w-full rounded-xl border border-slate-300 px-4 py-2"
            >
              <option value="ALL">Все</option>
              {companies.map((company) => (
                <option key={company.id} value={company.name}>
                  {company.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">
              Тип операции
            </label>

            <select
              name="operationType"
              defaultValue={operationType}
              className="w-full rounded-xl border border-slate-300 px-4 py-2"
            >
              <option value="ALL">Все</option>
              <option value="INCOME">Поступления</option>
              <option value="EXPENSE">Расходы</option>
              <option value="TRANSFER">Переводы</option>
              <option value="FINANCING">Финансирование</option>
              <option value="PERSONAL">Личные</option>
            </select>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">
              Статья
            </label>

            <select
              name="category"
              defaultValue={selectedCategory}
              className="w-full rounded-xl border border-slate-300 px-4 py-2"
            >
              <option value="ALL">Все статьи</option>
              {categories.map((category) => (
                <option key={category.id} value={category.name}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end">
            <button className="w-full rounded-xl bg-slate-900 px-4 py-2 font-medium text-white">
              Применить
            </button>
          </div>

          <div className="flex items-end">
            <Link
              href="/finance/operations"
              className="w-full rounded-xl border border-slate-300 px-4 py-2 text-center font-medium hover:bg-slate-100"
            >
              Сброс
            </Link>
          </div>

          <input type="hidden" name="search" value={search} />
          <input type="hidden" name="rows" value={safeRowsLimit} />
          <input type="hidden" name="sortBy" value={safeSortBy} />
          <input type="hidden" name="sortDir" value={safeSortDir} />
        </form>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Поступления ДДС</div>
            <div className="mt-2 text-2xl font-bold text-emerald-600">
              {formatMoney(metrics.cashIncome)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Выплаты ДДС</div>
            <div className="mt-2 text-2xl font-bold text-red-600">
              {formatMoney(metrics.cashOutflow)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Чистый ДДС</div>
            <div
              className={`mt-2 text-2xl font-bold ${valueClassName(
                metrics.netCashFlow
              )}`}
            >
              {formatMoney(metrics.netCashFlow)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">
              Влияние на чистую прибыль
            </div>
            <div
              className={`mt-2 text-2xl font-bold ${valueClassName(
                metrics.netProfitImpact
              )}`}
            >
              {formatMoney(metrics.netProfitImpact)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Вывод собственника</div>
            <div className="mt-2 text-2xl font-bold text-amber-600">
              {formatMoney(metrics.ownerWithdrawals)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Внутренние переводы</div>
            <div className="mt-2 text-2xl font-bold text-slate-900">
              {formatMoney(metrics.transferTotal)}
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl bg-cyan-50 p-5 ring-1 ring-cyan-100">
            <div className="text-sm font-medium text-cyan-700">
              Только ДДС
            </div>
            <div className="mt-2 text-2xl font-black text-cyan-800">
              {formatMoney(metrics.cashOnlyTotal)}
            </div>
            <p className="mt-2 text-sm text-cyan-700">
              Фулфилмент, закупка, упаковка и другие расходы, уже сидящие в
              себестоимости.
            </p>
          </div>

          <div className="rounded-2xl bg-blue-50 p-5 ring-1 ring-blue-100">
            <div className="text-sm font-medium text-blue-700">
              Тело кредита
            </div>
            <div className="mt-2 text-2xl font-black text-blue-800">
              {formatMoney(metrics.creditPrincipal)}
            </div>
            <p className="mt-2 text-sm text-blue-700">
              Уменьшает деньги, но не чистую прибыль.
            </p>
          </div>

          <div className="rounded-2xl bg-violet-50 p-5 ring-1 ring-violet-100">
            <div className="text-sm font-medium text-violet-700">
              Проценты кредита
            </div>
            <div className="mt-2 text-2xl font-black text-violet-800">
              {formatMoney(metrics.creditInterest)}
            </div>
            <p className="mt-2 text-sm text-violet-700">
              Уменьшает и ДДС, и чистую прибыль.
            </p>
          </div>

          <div className="rounded-2xl bg-slate-50 p-5 ring-1 ring-slate-200">
            <div className="text-sm font-medium text-slate-600">
              Не учитывается
            </div>
            <div className="mt-2 text-2xl font-black text-slate-900">
              {formatMoney(metrics.ignoredTotal)}
            </div>
            <p className="mt-2 text-sm text-slate-500">
              Внутренние и технические операции без влияния на показатели.
            </p>
          </div>
        </section>

        <FinanceOperationForm
          categories={categories}
          companies={companies}
          bankAccounts={bankAccounts}
        />

        <FinanceTransferForm companies={companies} accounts={bankAccounts} />

        <section className="overflow-hidden rounded-2xl bg-white shadow-sm">
          <div className="border-b border-slate-200 p-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 className="text-xl font-bold text-slate-900">
                  Журнал операций
                </h2>

                <p className="mt-2 text-sm text-slate-500">
                  Найдено операций: {rows.length}
                </p>
              </div>

              <form className="flex flex-col gap-3 lg:flex-row">
                <input type="hidden" name="company" value={company} />
                <input
                  type="hidden"
                  name="operationType"
                  value={operationType}
                />
                <input type="hidden" name="category" value={selectedCategory} />
                <input type="hidden" name="sortBy" value={safeSortBy} />
                <input type="hidden" name="sortDir" value={safeSortDir} />

                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">
                    Дата от
                  </label>

                  <input
                    type="date"
                    name="dateFrom"
                    defaultValue={dateFrom}
                    className="w-[180px] rounded-xl border border-slate-300 px-4 py-2"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">
                    Дата до
                  </label>

                  <input
                    type="date"
                    name="dateTo"
                    defaultValue={dateTo}
                    className="w-[180px] rounded-xl border border-slate-300 px-4 py-2"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">
                    Поиск по журналу
                  </label>

                  <input
                    type="text"
                    name="search"
                    defaultValue={search}
                    placeholder="Кредит, поставщик, комментарий..."
                    className="w-[320px] rounded-xl border border-slate-300 px-4 py-2"
                  />
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">
                    Строк
                  </label>

                  <select
                    name="rows"
                    defaultValue={safeRowsLimit}
                    className="w-[120px] rounded-xl border border-slate-300 px-4 py-2"
                  >
                    <option value="25">25</option>
                    <option value="50">50</option>
                    <option value="100">100</option>
                    <option value="250">250</option>
                    <option value="500">500</option>
                  </select>
                </div>

                <div className="flex items-end">
                  <button className="rounded-xl bg-slate-900 px-5 py-2 font-medium text-white">
                    Найти
                  </button>
                </div>
              </form>
            </div>
          </div>

          <div className="divide-y divide-slate-100 lg:hidden">
            {rows.map((row) => {
              const treatment = getFinanceTransactionTreatment(
                row,
                categoryTreatmentIndex
              );

              return (
                <div key={row.id} className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-sm text-slate-500">
                        {formatDate(row.operationDate)}
                      </div>

                      <div className="mt-1 font-bold text-slate-900">
                        {row.companyName}
                      </div>
                    </div>

                    <div
                      className={`text-right text-lg font-bold ${operationTypeClassName(
                        row.operationType
                      )}`}
                    >
                      {formatMoney(row.amount)}
                    </div>
                  </div>

                  <div className="mt-3">
                    <div
                      className={`font-semibold ${operationTypeClassName(
                        row.operationType
                      )}`}
                    >
                      {operationTypeLabel(row.operationType)}
                    </div>

                    <div className="mt-1 font-medium text-slate-900">
                      {row.category}
                    </div>

                    <div
                      className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ${treatment.className}`}
                    >
                      {treatment.label}
                    </div>

                    {row.subcategory && (
                      <div className="mt-1 text-sm text-slate-500">
                        {row.subcategory}
                      </div>
                    )}
                  </div>

                  <div className="mt-3 grid gap-2 text-sm text-slate-600">
                    <div>
                      <span className="text-slate-400">Счёт: </span>
                      {row.bankAccount || "—"}
                    </div>

                    <div>
                      <span className="text-slate-400">Контрагент: </span>
                      {row.counterparty || "—"}
                    </div>

                    <div>
                      <span className="text-slate-400">Проект: </span>
                      {row.project || "—"}
                    </div>

                    <div>
                      <span className="text-slate-400">Комментарий: </span>
                      {row.comment || "—"}
                    </div>
                  </div>
                </div>
              );
            })}

            {rows.length === 0 && (
              <div className="p-8 text-center text-slate-500">
                Операции пока не загружены.
              </div>
            )}
          </div>

          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[1650px] border-collapse text-sm">
              <thead className="bg-slate-100 text-left text-slate-700">
                <tr>
                  <th className="p-3">
                    <Link href={sortHref("operationDate")}>
                      Дата платежа {sortIcon("operationDate")}
                    </Link>
                  </th>

                  <th className="p-3">
                    <Link href={sortHref("obligationDate")}>
                      Дата обязательства {sortIcon("obligationDate")}
                    </Link>
                  </th>

                  <th className="p-3">
                    <Link href={sortHref("companyName")}>
                      Компания {sortIcon("companyName")}
                    </Link>
                  </th>

                  <th className="p-3">
                    <Link href={sortHref("operationType")}>
                      Тип операции {sortIcon("operationType")}
                    </Link>
                  </th>

                  <th className="p-3">
                    <Link href={sortHref("category")}>
                      Статья {sortIcon("category")}
                    </Link>
                  </th>

                  <th className="p-3">Роль</th>

                  <th className="p-3">
                    <Link href={sortHref("subcategory")}>
                      Подстатья {sortIcon("subcategory")}
                    </Link>
                  </th>

                  <th className="p-3">
                    <Link href={sortHref("counterparty")}>
                      Контрагент {sortIcon("counterparty")}
                    </Link>
                  </th>

                  <th className="p-3">
                    <Link href={sortHref("bankAccount")}>
                      Счёт / касса {sortIcon("bankAccount")}
                    </Link>
                  </th>

                  <th className="p-3 text-right">
                    <Link href={sortHref("amount")}>
                      Сумма {sortIcon("amount")}
                    </Link>
                  </th>

                  <th className="p-3">Внутр. перевод</th>

                  <th className="p-3">
                    <Link href={sortHref("project")}>
                      Проект {sortIcon("project")}
                    </Link>
                  </th>

                  <th className="p-3">Комментарий</th>
                  <th className="p-3 text-center">Действия</th>
                </tr>
              </thead>

              <tbody>
                {rows.map((row) => {
                  const treatment = getFinanceTransactionTreatment(
                    row,
                    categoryTreatmentIndex
                  );

                  return (
                    <tr
                      key={row.id}
                      className="border-t border-slate-100 hover:bg-slate-50"
                    >
                      <td className="p-3">{formatDate(row.operationDate)}</td>
                      <td className="p-3">{formatDate(row.obligationDate)}</td>
                      <td className="p-3">{row.companyName}</td>
                      <td
                        className={`p-3 font-semibold ${operationTypeClassName(
                          row.operationType
                        )}`}
                      >
                        {operationTypeLabel(row.operationType)}
                      </td>
                      <td className="p-3 font-medium">{row.category}</td>
                      <td className="p-3">
                        <div
                          className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ${treatment.className}`}
                          title={treatment.description}
                        >
                          {treatment.label}
                        </div>
                      </td>
                      <td className="p-3">{row.subcategory || "—"}</td>
                      <td className="p-3">{row.counterparty || "—"}</td>
                      <td className="p-3">{row.bankAccount || "—"}</td>
                      <td
                        className={`p-3 text-right font-bold ${operationTypeClassName(
                          row.operationType
                        )}`}
                      >
                        {formatMoney(row.amount)}
                      </td>
                      <td className="p-3">
                        {row.isInternalTransfer ? "Да" : "Нет"}
                      </td>
                      <td className="p-3">{row.project || "—"}</td>
                      <td className="p-3">{row.comment || "—"}</td>
                      <td className="p-3 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <Link
                            href={`/finance/operations/edit/${row.id}`}
                            className="rounded-lg bg-slate-100 px-3 py-1 text-sm font-medium text-slate-700 hover:bg-slate-200"
                          >
                            Изменить
                          </Link>

                          <form action={deleteFinanceTransaction}>
                            <input type="hidden" name="id" value={row.id} />

                            <button
                              type="submit"
                              className="rounded-lg bg-red-50 px-3 py-1 text-sm font-medium text-red-600 hover:bg-red-100"
                            >
                              Удалить
                            </button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {rows.length === 0 && (
                  <tr>
                    <td colSpan={14} className="p-8 text-center text-slate-500">
                      Операции пока не загружены.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}