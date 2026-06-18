import Link from "next/link";
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
    description: "Расход уменьшает ДДС и чистую прибыль бизнеса.",
  },
  {
    value: "CASH_ONLY",
    label: "Только ДДС",
    description:
      "Деньги ушли, но в прибыль не вычитаем повторно. Например: фулфилмент, закупка, упаковка.",
  },
  {
    value: "CREDIT_PRINCIPAL",
    label: "Тело кредита",
    description: "Учитывается в ДДС, но не уменьшает чистую прибыль.",
  },
  {
    value: "CREDIT_INTEREST",
    label: "Проценты по кредиту",
    description: "Учитывается в ДДС и уменьшает чистую прибыль.",
  },
  {
    value: "CREDIT_RECEIVED",
    label: "Получение кредита / займа",
    description: "Денежное поступление в ДДС, но не доход и не чистая прибыль.",
  },
  {
    value: "OWNER_WITHDRAWAL",
    label: "Вывод собственника",
    description:
      "Учитывается в ДДС и в показателе после вывода собственника.",
  },
  {
    value: "IGNORE",
    label: "Не учитывать",
    description: "Не участвует в расчётах прибыли и ДДС.",
  },
];

function typeLabel(type: string) {
  if (type === "INCOME") return "Доходы";
  if (type === "EXPENSE") return "Расходы";
  if (type === "TRANSFER") return "Переводы";
  if (type === "FINANCING") return "Финансирование";
  if (type === "PERSONAL") return "Личные";
  return type || "—";
}

function typeClassName(type: string) {
  if (type === "INCOME") return "text-emerald-600";
  if (type === "EXPENSE") return "text-red-600";
  if (type === "TRANSFER") return "text-slate-500";
  if (type === "FINANCING") return "text-blue-600";
  if (type === "PERSONAL") return "text-amber-600";
  return "text-slate-700";
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

function normalizeText(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

function toSortOrder(value: FormDataEntryValue | null) {
  const number = Number(String(value ?? "").trim());
  return Number.isFinite(number) ? number : 0;
}

function normalizeTreatment(value: FormDataEntryValue | null) {
  const text = normalizeText(value);
  const allowed = profitTreatmentOptions.some((option) => option.value === text);

  return allowed ? text : "AUTO";
}

async function createFinanceCategory(formData: FormData) {
  "use server";

  const name = normalizeText(formData.get("name"));
  const parentName = normalizeText(formData.get("parentName"));
  const categoryType = normalizeText(formData.get("categoryType"));
  const profitTreatment = normalizeTreatment(formData.get("profitTreatment"));
  const sortOrder = toSortOrder(formData.get("sortOrder"));
  const isActive = formData.get("isActive") === "on";

  if (!name || !categoryType) {
    return;
  }

  await prisma.financeCategory.create({
    data: {
      name,
      parentName: parentName || null,
      categoryType,
      profitTreatment,
      sortOrder,
      isActive,
    },
  });

  revalidatePath("/finance/categories");
}

async function updateFinanceCategory(formData: FormData) {
  "use server";

  const id = normalizeText(formData.get("id"));
  const name = normalizeText(formData.get("name"));
  const parentName = normalizeText(formData.get("parentName"));
  const categoryType = normalizeText(formData.get("categoryType"));
  const profitTreatment = normalizeTreatment(formData.get("profitTreatment"));
  const sortOrder = toSortOrder(formData.get("sortOrder"));
  const isActive = formData.get("isActive") === "on";

  if (!id || !name || !categoryType) {
    return;
  }

  await prisma.financeCategory.update({
    where: {
      id,
    },
    data: {
      name,
      parentName: parentName || null,
      categoryType,
      profitTreatment,
      sortOrder,
      isActive,
    },
  });

  revalidatePath("/finance/categories");
}

export default async function FinanceCategoriesPage() {
  const categories = await prisma.financeCategory.findMany({
    orderBy: [
      { categoryType: "asc" },
      { sortOrder: "asc" },
      { name: "asc" },
    ],
  });

  const grouped = categories.reduce<Record<string, typeof categories>>(
    (acc, category) => {
      acc[category.categoryType] = acc[category.categoryType] ?? [];
      acc[category.categoryType].push(category);
      return acc;
    },
    {}
  );

  const treatmentsCount = categories.reduce<Record<string, number>>(
    (acc, category) => {
      const value = category.profitTreatment || "AUTO";
      acc[value] = (acc[value] ?? 0) + 1;
      return acc;
    },
    {}
  );

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-4xl font-black tracking-tight text-slate-950">
              Справочник статей
            </h1>

            <p className="mt-3 max-w-4xl text-slate-500">
              Статьи доходов, расходов, переводов, личных расходов и
              финансирования. Здесь задаётся, как каждая статья влияет на ДДС,
              чистую прибыль и вывод собственника.
            </p>
          </div>

          <Link
            href="/finance/operations"
            className="rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white"
          >
            ← Операции
          </Link>
        </div>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Всего статей</div>
            <div className="mt-2 text-3xl font-black text-slate-950">
              {categories.length}
            </div>
          </div>

          {["INCOME", "EXPENSE", "TRANSFER", "FINANCING", "PERSONAL"].map(
            (type) => (
              <div key={type} className="rounded-2xl bg-white p-6 shadow-sm">
                <div className="text-sm text-slate-500">{typeLabel(type)}</div>
                <div
                  className={`mt-2 text-3xl font-black ${typeClassName(type)}`}
                >
                  {grouped[type]?.length ?? 0}
                </div>
              </div>
            )
          )}
        </section>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {profitTreatmentOptions.map((option) => (
            <div
              key={option.value}
              className={`rounded-2xl p-4 ring-1 ${treatmentClassName(
                option.value
              )}`}
            >
              <div className="text-2xl font-black">
                {treatmentsCount[option.value] ?? 0}
              </div>
              <div className="mt-1 text-sm font-black">{option.label}</div>
              <div className="mt-2 text-xs leading-5 opacity-80">
                {option.description}
              </div>
            </div>
          ))}
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <div className="mb-5">
            <h2 className="text-xl font-black text-slate-950">
              Добавить статью
            </h2>

            <p className="mt-2 text-slate-500">
              При добавлении новой статьи обязательно укажи её роль в финансовой
              модели. От этого зависит Dashboard.
            </p>
          </div>

          <form
            action={createFinanceCategory}
            className="grid gap-4 md:grid-cols-2 xl:grid-cols-[1.2fr_1fr_1fr_1.4fr_140px_130px]"
          >
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Название статьи
              </label>
              <input
                name="name"
                required
                placeholder="Например: Фулфилмент"
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Тип
              </label>
              <select
                name="categoryType"
                defaultValue="EXPENSE"
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              >
                <option value="INCOME">Доходы</option>
                <option value="EXPENSE">Расходы</option>
                <option value="TRANSFER">Переводы</option>
                <option value="FINANCING">Финансирование</option>
                <option value="PERSONAL">Личные</option>
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Группа
              </label>
              <input
                name="parentName"
                placeholder="Например: Себестоимость"
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Роль в финансовой модели
              </label>
              <select
                name="profitTreatment"
                defaultValue="AUTO"
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              >
                {profitTreatmentOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700">
                Сортировка
              </label>
              <input
                name="sortOrder"
                inputMode="numeric"
                defaultValue="0"
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              />
            </div>

            <label className="flex items-end gap-3 pb-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                name="isActive"
                defaultChecked
                className="h-4 w-4"
              />
              Активна
            </label>

            <div className="md:col-span-2 xl:col-span-6">
              <button className="rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white">
                Добавить статью
              </button>
            </div>
          </form>
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-black text-slate-950">
                Список статей
              </h2>

              <p className="mt-2 text-slate-500">
                Изменяй роль статьи аккуратно: это влияет на чистую прибыль,
                показатель после вывода собственника и ДДС.
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[1300px] border-collapse text-sm">
              <thead className="bg-slate-100 text-left text-slate-700">
                <tr>
                  <th className="p-3">Тип</th>
                  <th className="p-3">Статья</th>
                  <th className="p-3">Группа</th>
                  <th className="p-3">Роль в модели</th>
                  <th className="p-3 text-right">Сортировка</th>
                  <th className="p-3">Активна</th>
                  <th className="p-3 text-center">Действие</th>
                </tr>
              </thead>

              <tbody>
                {categories.map((category) => (
                  <tr
                    key={category.id}
                    className="border-t border-slate-100 hover:bg-slate-50"
                  >
                    <td className="p-3 align-top">
                      <form
                        id={`category-form-${category.id}`}
                        action={updateFinanceCategory}
                      >
                        <input type="hidden" name="id" value={category.id} />

                        <select
                          name="categoryType"
                          defaultValue={category.categoryType}
                          className={`w-full rounded-xl border border-slate-300 px-3 py-2 font-semibold ${typeClassName(
                            category.categoryType
                          )}`}
                        >
                          <option value="INCOME">Доходы</option>
                          <option value="EXPENSE">Расходы</option>
                          <option value="TRANSFER">Переводы</option>
                          <option value="FINANCING">Финансирование</option>
                          <option value="PERSONAL">Личные</option>
                        </select>
                      </form>
                    </td>

                    <td className="p-3 align-top">
                      <input
                        form={`category-form-${category.id}`}
                        name="name"
                        required
                        defaultValue={category.name}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 font-medium text-slate-900"
                      />
                    </td>

                    <td className="p-3 align-top">
                      <input
                        form={`category-form-${category.id}`}
                        name="parentName"
                        defaultValue={category.parentName ?? ""}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2"
                        placeholder="—"
                      />
                    </td>

                    <td className="p-3 align-top">
                      <select
                        form={`category-form-${category.id}`}
                        name="profitTreatment"
                        defaultValue={category.profitTreatment || "AUTO"}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2"
                      >
                        {profitTreatmentOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>

                      <div
                        className={`mt-2 rounded-xl px-3 py-2 text-xs leading-5 ring-1 ${treatmentClassName(
                          category.profitTreatment
                        )}`}
                      >
                        <div className="font-black">
                          {treatmentLabel(category.profitTreatment)}
                        </div>
                        <div className="mt-1">
                          {treatmentDescription(category.profitTreatment)}
                        </div>
                      </div>
                    </td>

                    <td className="p-3 align-top">
                      <input
                        form={`category-form-${category.id}`}
                        name="sortOrder"
                        inputMode="numeric"
                        defaultValue={String(category.sortOrder)}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-right"
                      />
                    </td>

                    <td className="p-3 align-top">
                      <label className="flex items-center gap-2 rounded-xl border border-slate-300 px-3 py-2">
                        <input
                          form={`category-form-${category.id}`}
                          type="checkbox"
                          name="isActive"
                          defaultChecked={category.isActive}
                          className="h-4 w-4"
                        />
                        Да
                      </label>
                    </td>

                    <td className="p-3 text-center align-top">
                      <button
                        form={`category-form-${category.id}`}
                        className="rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white"
                      >
                        Сохранить
                      </button>
                    </td>
                  </tr>
                ))}

                {categories.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-slate-500">
                      Справочник статей пока пустой.
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