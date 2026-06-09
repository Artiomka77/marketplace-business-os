import Link from "next/link";
import { prisma } from "@/lib/prisma";

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

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-[1400px] space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-4xl font-bold text-slate-900">
              Справочник статей
            </h1>

            <p className="mt-3 text-slate-500">
              Статьи доходов, расходов, переводов, личных расходов и
              финансирования.
            </p>
          </div>

          <Link
            href="/finance/operations"
            className="rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white"
          >
            ← Операции
          </Link>
        </div>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Всего статей</div>
            <div className="mt-2 text-3xl font-bold">
              {categories.length}
            </div>
          </div>

          {["INCOME", "EXPENSE", "TRANSFER", "FINANCING"].map((type) => (
            <div key={type} className="rounded-2xl bg-white p-6 shadow-sm">
              <div className="text-sm text-slate-500">{typeLabel(type)}</div>
              <div className={`mt-2 text-3xl font-bold ${typeClassName(type)}`}>
                {grouped[type]?.length ?? 0}
              </div>
            </div>
          ))}
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold text-slate-900">
                Список статей
              </h2>

              <p className="mt-2 text-slate-500">
                Сейчас справочник только просматривается. Добавление и
                редактирование подключим следующим шагом.
              </p>
            </div>

            <button
              disabled
              className="rounded-xl bg-slate-200 px-5 py-3 font-semibold text-slate-500"
            >
              + Добавить статью
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-sm">
              <thead className="bg-slate-100 text-left text-slate-700">
                <tr>
                  <th className="p-3">Тип</th>
                  <th className="p-3">Статья</th>
                  <th className="p-3">Группа</th>
                  <th className="p-3 text-right">Сортировка</th>
                  <th className="p-3">Активна</th>
                </tr>
              </thead>

              <tbody>
                {categories.map((category) => (
                  <tr
                    key={category.id}
                    className="border-t border-slate-100 hover:bg-slate-50"
                  >
                    <td
                      className={`p-3 font-semibold ${typeClassName(
                        category.categoryType
                      )}`}
                    >
                      {typeLabel(category.categoryType)}
                    </td>

                    <td className="p-3 font-medium">{category.name}</td>

                    <td className="p-3">
                      {category.parentName || "—"}
                    </td>

                    <td className="p-3 text-right">
                      {category.sortOrder}
                    </td>

                    <td className="p-3">
                      {category.isActive ? "Да" : "Нет"}
                    </td>
                  </tr>
                ))}

                {categories.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-slate-500">
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