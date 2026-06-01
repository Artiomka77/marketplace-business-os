import Link from "next/link";
import { prisma } from "@/lib/prisma";

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

function operationTypeLabel(type: string) {
  if (type === "INCOME") return "Поступление";
  if (type === "EXPENSE") return "Расход";
  if (type === "TRANSFER") return "Перевод";

  return type || "—";
}

function operationTypeClassName(type: string) {
  if (type === "INCOME") return "text-emerald-600";
  if (type === "EXPENSE") return "text-red-600";
  if (type === "TRANSFER") return "text-slate-500";

  return "text-slate-700";
}

export default async function FinanceOperationsPage({
  searchParams,
}: {
  searchParams?: Promise<{
    company?: string;
    operationType?: string;
  }>;
}) {
  const params = await searchParams;

  const company = params?.company ?? "ALL";
  const operationType = params?.operationType ?? "ALL";

  const rows = await prisma.financeTransaction.findMany({
    where: {
      ...(company !== "ALL" ? { companyName: company } : {}),
      ...(operationType !== "ALL" ? { operationType } : {}),
    },
    orderBy: {
      operationDate: "desc",
    },
    take: 500,
  });

  const incomeTotal = rows
    .filter((row) => row.operationType === "INCOME" && !row.isInternalTransfer)
    .reduce((sum, row) => sum + Number(row.amount ?? 0), 0);

  const expenseTotal = rows
    .filter((row) => row.operationType === "EXPENSE" && !row.isInternalTransfer)
    .reduce((sum, row) => sum + Number(row.amount ?? 0), 0);

  const transferTotal = rows
    .filter((row) => row.operationType === "TRANSFER" || row.isInternalTransfer)
    .reduce((sum, row) => sum + Number(row.amount ?? 0), 0);

  const netCashFlow = incomeTotal - expenseTotal;

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
            </p>
          </div>

          <Link
            href="/"
            className="rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white"
          >
            ← Dashboard
          </Link>
        </div>

        <form className="grid gap-4 rounded-2xl bg-white p-6 shadow-sm md:grid-cols-4">
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
              <option value="ИП Петров">ИП Петров</option>
              <option value="ИП Лебедева">ИП Лебедева</option>
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
            </select>
          </div>

          <div className="flex items-end">
            <button className="w-full rounded-xl bg-slate-900 px-4 py-2 font-medium text-white">
              Применить
            </button>
          </div>

          <div className="flex items-end">
            <button
              type="button"
              disabled
              className="w-full rounded-xl bg-slate-200 px-4 py-2 font-medium text-slate-500"
            >
              + Добавить операцию
            </button>
          </div>
        </form>

        <section className="grid gap-4 md:grid-cols-4">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Поступления</div>
            <div className="mt-2 text-2xl font-bold text-emerald-600">
              {formatMoney(incomeTotal)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Расходы</div>
            <div className="mt-2 text-2xl font-bold text-red-600">
              {formatMoney(expenseTotal)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Чистый ДДС</div>
            <div
              className={`mt-2 text-2xl font-bold ${
                netCashFlow >= 0 ? "text-emerald-600" : "text-red-600"
              }`}
            >
              {formatMoney(netCashFlow)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Внутренние переводы</div>
            <div className="mt-2 text-2xl font-bold text-slate-900">
              {formatMoney(transferTotal)}
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl bg-white shadow-sm">
          <div className="border-b border-slate-200 p-6">
            <h2 className="text-xl font-bold text-slate-900">
              Журнал операций
            </h2>

            <p className="mt-2 text-sm text-slate-500">
              Показано до 500 последних операций.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1500px] border-collapse text-sm">
              <thead className="bg-slate-100 text-left text-slate-700">
                <tr>
                  <th className="p-3">Дата платежа</th>
                  <th className="p-3">Дата обязательства</th>
                  <th className="p-3">Компания</th>
                  <th className="p-3">Тип операции</th>
                  <th className="p-3">Статья</th>
                  <th className="p-3">Подстатья</th>
                  <th className="p-3">Контрагент</th>
                  <th className="p-3">Счёт / касса</th>
                  <th className="p-3 text-right">Сумма</th>
                  <th className="p-3">Внутр. перевод</th>
                  <th className="p-3">Проект</th>
                  <th className="p-3">Комментарий</th>
                </tr>
              </thead>

              <tbody>
                {rows.map((row) => (
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
                  </tr>
                ))}

                {rows.length === 0 && (
                  <tr>
                    <td colSpan={12} className="p-8 text-center text-slate-500">
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