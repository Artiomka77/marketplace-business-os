import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/prisma";

const profitTreatmentOptions = [
  {
    value: "AUTO",
    label: "Авто / временно",
    description: "Пока система определяет роль по названию статьи.",
  },
  {
    value: "INCLUDE_IN_NET_PROFIT",
    label: "Учитывать в чистой прибыли",
    description: "Влияет на ДДС и чистую прибыль бизнеса.",
  },
  {
    value: "CASH_ONLY",
    label: "Только ДДС",
    description: "Деньги ушли/пришли, но в прибыль повторно не включается.",
  },
  {
    value: "CREDIT_PRINCIPAL",
    label: "Тело кредита",
    description: "Влияет на ДДС, но не уменьшает чистую прибыль.",
  },
  {
    value: "CREDIT_INTEREST",
    label: "Проценты по кредиту",
    description: "Влияет на ДДС и уменьшает чистую прибыль.",
  },
  {
    value: "CREDIT_RECEIVED",
    label: "Получение кредита / займа",
    description: "Денежное поступление в ДДС, но не доход бизнеса.",
  },
  {
    value: "OWNER_WITHDRAWAL",
    label: "Вывод собственника",
    description: "Влияет на ДДС и показатель после вывода собственника.",
  },
  {
    value: "IGNORE",
    label: "Не учитывать",
    description: "Не участвует в расчётах прибыли и ДДС.",
  },
];

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

function typeLabel(type: string) {
  if (type === "INCOME") return "Поступление";
  if (type === "EXPENSE") return "Расход";
  if (type === "TRANSFER") return "Перевод";
  if (type === "FINANCING") return "Финансирование";
  if (type === "PERSONAL") return "Личные";
  return type || "—";
}

function treatmentLabel(value?: string | null) {
  return (
    profitTreatmentOptions.find((option) => option.value === value)?.label ??
    "Авто / временно"
  );
}

function treatmentDescription(value?: string | null) {
  return (
    profitTreatmentOptions.find((option) => option.value === value)
      ?.description ?? "Пока система определяет роль по названию статьи."
  );
}

function treatmentClassName(value?: string | null) {
  if (value === "INCLUDE_IN_NET_PROFIT") {
    return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  }

  if (value === "CASH_ONLY") {
    return "bg-cyan-50 text-cyan-700 ring-cyan-200";
  }

  if (value === "CREDIT_PRINCIPAL") {
    return "bg-blue-50 text-blue-700 ring-blue-200";
  }

  if (value === "CREDIT_INTEREST") {
    return "bg-violet-50 text-violet-700 ring-violet-200";
  }

  if (value === "CREDIT_RECEIVED") {
    return "bg-indigo-50 text-indigo-700 ring-indigo-200";
  }

  if (value === "OWNER_WITHDRAWAL") {
    return "bg-amber-50 text-amber-700 ring-amber-200";
  }

  if (value === "IGNORE") {
    return "bg-slate-100 text-slate-500 ring-slate-200";
  }

  return "bg-slate-50 text-slate-700 ring-slate-200";
}

async function updateFinanceTransaction(formData: FormData) {
  "use server";

  const id = String(formData.get("id") ?? "");
  const operationDate = toDate(formData.get("operationDate"));
  const amount = toNumber(formData.get("amount"));
  const operationType = String(formData.get("operationType") ?? "").trim();

  if (!id || !operationDate || amount <= 0) return;

  await prisma.financeTransaction.update({
    where: { id },
    data: {
      companyName: String(formData.get("companyName") ?? "").trim(),
      operationType,
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
        operationType === "TRANSFER" || formData.get("isInternalTransfer") === "on",
    },
  });

  revalidatePath("/finance/operations");
  revalidatePath(`/finance/operations/edit/${id}`);
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

  const [companies, activeCategories, accounts] = await Promise.all([
    prisma.company.findMany({
      where: {
        isActive: true,
      },
      orderBy: {
        name: "asc",
      },
    }),

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

    prisma.financeAccount.findMany({
      where: {
        isActive: true,
      },
      orderBy: [{ companyName: "asc" }, { name: "asc" }],
    }),
  ]);

  const hasCurrentCategory = activeCategories.some(
    (category) => category.name === operation.category
  );

  const categories = hasCurrentCategory
    ? activeCategories
    : [
        {
          id: `current-${operation.id}`,
          name: operation.category,
          parentName: null,
          categoryType: operation.operationType,
          sortOrder: 0,
          isActive: true,
          profitTreatment: "AUTO",
          createdAt: new Date(),
        },
        ...activeCategories,
      ];

  const selectedCategory = categories.find(
    (category) => category.name === operation.category
  );

  const selectedTreatment = selectedCategory?.profitTreatment ?? "AUTO";

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900">
              Редактирование операции
            </h1>

            <p className="mt-3 text-slate-500">
              Измени данные операции и сохрани изменения. Техническая связь с
              импортом, API или графиком кредита при редактировании сохраняется.
            </p>
          </div>

          <Link
            href="/finance/operations"
            className="rounded-xl border border-slate-300 px-5 py-3 font-semibold"
          >
            ← Назад к операциям
          </Link>
        </div>

        <section className="grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <div className="text-sm text-slate-500">Статус операции</div>
            <div className="mt-2 text-xl font-bold text-slate-900">
              {operation.transactionStatus || "—"}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <div className="text-sm text-slate-500">Источник</div>
            <div className="mt-2 text-xl font-bold text-slate-900">
              {operation.sourceType || "Ручная операция"}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-5 shadow-sm">
            <div className="text-sm text-slate-500">Роль текущей статьи</div>
            <div
              className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-bold ring-1 ${treatmentClassName(
                selectedTreatment
              )}`}
            >
              {treatmentLabel(selectedTreatment)}
            </div>
          </div>
        </section>

        <section
          className={`rounded-2xl px-5 py-4 ring-1 ${treatmentClassName(
            selectedTreatment
          )}`}
        >
          <div className="font-bold">{treatmentLabel(selectedTreatment)}</div>
          <div className="mt-1 text-sm">{treatmentDescription(selectedTreatment)}</div>
          <div className="mt-2 text-xs opacity-80">
            Чтобы изменить роль статьи, открой “Справочник статей”. На этой
            странице меняется сама операция, а не финансовая модель статьи.
          </div>
        </section>

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
                  {category.name} · {typeLabel(category.categoryType)} ·{" "}
                  {treatmentLabel(category.profitTreatment)}
                </option>
              ))}
            </select>

            <div className="mt-2 text-xs text-slate-500">
              Роль статьи берётся из справочника. При смене статьи операция
              начнёт считаться по роли новой статьи.
            </div>
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
                <option key={account.id} value={account.name}>
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
            <span className="text-sm text-slate-700">Внутренний перевод</span>
          </label>

          <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600 md:col-span-2">
            <div className="font-bold text-slate-900">
              Что не меняется при сохранении
            </div>
            <div className="mt-1">
              `transactionStatus`, `sourceType`, `sourceId`, дата создания и
              системные связи остаются как были. Это важно для операций,
              созданных импортом, API или графиком кредитов.
            </div>
          </div>

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