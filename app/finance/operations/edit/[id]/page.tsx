import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

function toDateInput(value?: Date | null) {
  if (!value) return "";
  return value.toISOString().slice(0, 10);
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

async function updateFinanceTransaction(formData: FormData) {
  "use server";

  const id = String(formData.get("id") ?? "");
  const operationDate = toDate(formData.get("operationDate"));
  const amount = toNumber(formData.get("amount"));

  if (!id || !operationDate || amount <= 0) return;

  await prisma.financeTransaction.update({
    where: { id },
    data: {
      companyName: String(formData.get("companyName") ?? "").trim(),
      operationType: String(formData.get("operationType") ?? "").trim(),
      category: String(formData.get("category") ?? "").trim(),
      subcategory: String(formData.get("subcategory") ?? "").trim() || null,
      counterparty: String(formData.get("counterparty") ?? "").trim() || null,
      bankAccount: String(formData.get("bankAccount") ?? "").trim() || null,
      project: String(formData.get("project") ?? "").trim() || null,
      comment: String(formData.get("comment") ?? "").trim() || null,
      amount,
      operationDate,
      obligationDate: toDate(formData.get("obligationDate")),
      isInternalTransfer:
        String(formData.get("operationType") ?? "") === "TRANSFER" ||
        formData.get("isInternalTransfer") === "on",
    },
  });

  revalidatePath("/finance/operations");
  redirect("/finance/operations");
}

export default async function EditFinanceOperationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const operation = await prisma.financeTransaction.findUnique({
    where: { id },
  });

  if (!operation) {
    return (
      <main className="min-h-screen bg-slate-100 p-8">
        <div className="mx-auto max-w-3xl rounded-2xl bg-white p-8 shadow-sm">
          <h1 className="text-2xl font-bold text-slate-900">
            Операция не найдена
          </h1>

          <Link
            href="/finance/operations"
            className="mt-6 inline-block rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white"
          >
            Вернуться к операциям
          </Link>
        </div>
      </main>
    );
  }

  const companies = await prisma.$queryRaw<{ id: string; name: string }[]>`
    select "id", "name"
    from "Company"
    where "isActive" = true
    order by "name" asc
  `;

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

  const accounts = await prisma.financeAccount.findMany({
    where: {
      isActive: true,
    },
    orderBy: [{ companyName: "asc" }, { name: "asc" }],
  });

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900">
              Редактирование операции
            </h1>

            <p className="mt-3 text-slate-500">
              Измени данные операции и сохрани изменения.
            </p>
          </div>

          <Link
            href="/finance/operations"
            className="rounded-xl border border-slate-300 px-5 py-3 font-semibold"
          >
            ← Назад к операциям
          </Link>
        </div>

        <form
          action={updateFinanceTransaction}
          className="grid gap-5 rounded-2xl bg-white p-6 shadow-sm md:grid-cols-2"
        >
          <input type="hidden" name="id" value={operation.id} />

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">
              Дата платежа
            </label>
            <input
              type="date"
              name="operationDate"
              defaultValue={toDateInput(operation.operationDate)}
              className="w-full rounded-xl border border-slate-300 px-4 py-2"
              required
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">
              Дата обязательства
            </label>
            <input
              type="date"
              name="obligationDate"
              defaultValue={toDateInput(operation.obligationDate)}
              className="w-full rounded-xl border border-slate-300 px-4 py-2"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">
              Компания
            </label>
            <select
              name="companyName"
              defaultValue={operation.companyName}
              className="w-full rounded-xl border border-slate-300 px-4 py-2"
              required
            >
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
              defaultValue={operation.operationType}
              className="w-full rounded-xl border border-slate-300 px-4 py-2"
              required
            >
              <option value="INCOME">Поступление</option>
              <option value="EXPENSE">Расход</option>
              <option value="TRANSFER">Перевод</option>
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
              defaultValue={operation.category}
              className="w-full rounded-xl border border-slate-300 px-4 py-2"
              required
            >
              {categories.map((category) => (
                <option key={category.id} value={category.name}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">
              Подстатья
            </label>
            <input
              name="subcategory"
              defaultValue={operation.subcategory ?? ""}
              className="w-full rounded-xl border border-slate-300 px-4 py-2"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">
              Счёт / касса
            </label>
            <select
              name="bankAccount"
              defaultValue={operation.bankAccount ?? ""}
              className="w-full rounded-xl border border-slate-300 px-4 py-2"
            >
              <option value="">Не указан</option>
              {accounts.map((account) => (
                <option
                  key={account.id}
                  value={account.name}
                >
                  {account.companyName} — {account.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">
              Сумма
            </label>
            <input
              name="amount"
              defaultValue={String(operation.amount ?? "")}
              className="w-full rounded-xl border border-slate-300 px-4 py-2"
              required
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">
              Контрагент
            </label>
            <input
              name="counterparty"
              defaultValue={operation.counterparty ?? ""}
              className="w-full rounded-xl border border-slate-300 px-4 py-2"
            />
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">
              Проект
            </label>
            <input
              name="project"
              defaultValue={operation.project ?? ""}
              className="w-full rounded-xl border border-slate-300 px-4 py-2"
            />
          </div>

          <div className="md:col-span-2">
            <label className="mb-2 block text-sm font-medium text-slate-700">
              Комментарий
            </label>
            <textarea
              name="comment"
              defaultValue={operation.comment ?? ""}
              className="min-h-[100px] w-full rounded-xl border border-slate-300 px-4 py-2"
            />
          </div>

          <label className="flex items-center gap-3 md:col-span-2">
            <input
              type="checkbox"
              name="isInternalTransfer"
              defaultChecked={operation.isInternalTransfer}
              className="h-4 w-4"
            />
            <span className="text-sm text-slate-700">
              Внутренний перевод
            </span>
          </label>

          <div className="flex gap-3 md:col-span-2">
            <button className="rounded-xl bg-slate-900 px-6 py-3 font-semibold text-white">
              Сохранить изменения
            </button>

            <Link
              href="/finance/operations"
              className="rounded-xl border border-slate-300 px-6 py-3 font-semibold"
            >
              Отмена
            </Link>
          </div>
        </form>
      </div>
    </main>
  );
}