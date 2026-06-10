import { prisma } from "@/lib/prisma";

function formatMoney(value: unknown) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
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

function monthName(month: number) {
  return months.find((item) => item.value === month)?.label ?? String(month);
}

export default async function BudgetPage() {
  const now = new Date();

  const companies = await prisma.company.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });

  const plans = await prisma.budgetPlan.findMany({
    orderBy: [
      { periodYear: "desc" },
      { periodMonth: "desc" },
      { companyName: "asc" },
    ],
  });

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-[1700px] space-y-6">
        <div>
          <h1 className="text-4xl font-bold text-slate-900">
            Планирование бюджета 2.0
          </h1>

          <p className="mt-3 text-slate-500">
            Создание, редактирование и удаление плановых бюджетов по компаниям и месяцам.
          </p>
        </div>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-2xl font-bold text-slate-900">
            Создать бюджет
          </h2>

          <form
            action="/api/finance/budget"
            method="POST"
            className="mt-6 grid gap-4 md:grid-cols-3 xl:grid-cols-5"
          >
            <input type="hidden" name="action" value="CREATE" />

            <div>
              <label className="mb-1 block text-sm text-slate-500">
                Компания
              </label>

              <select
                name="companyName"
                required
                defaultValue={companies[0]?.name ?? ""}
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              >
                {companies.map((company) => (
                  <option key={company.id} value={company.name}>
                    {company.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-sm text-slate-500">
                Год
              </label>

              <input
                name="periodYear"
                defaultValue={now.getFullYear()}
                required
                inputMode="numeric"
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              />
            </div>

            <div>
              <label className="mb-1 block text-sm text-slate-500">
                Месяц
              </label>

              <select
                name="periodMonth"
                defaultValue={now.getMonth() + 1}
                className="w-full rounded-xl border border-slate-300 px-4 py-2"
              >
                {months.map((month) => (
                  <option key={month.value} value={month.value}>
                    {month.label}
                  </option>
                ))}
              </select>
            </div>

            <input
              name="revenuePlan"
              placeholder="План выручки"
              inputMode="decimal"
              className="rounded-xl border border-slate-300 px-4 py-2"
            />

            <input
              name="profitPlan"
              placeholder="План прибыли"
              inputMode="decimal"
              className="rounded-xl border border-slate-300 px-4 py-2"
            />

            <input
              name="adsPlan"
              placeholder="План рекламы"
              inputMode="decimal"
              className="rounded-xl border border-slate-300 px-4 py-2"
            />

            <input
              name="logisticsPlan"
              placeholder="План логистики"
              inputMode="decimal"
              className="rounded-xl border border-slate-300 px-4 py-2"
            />

            <input
              name="taxPlan"
              placeholder="План налогов"
              inputMode="decimal"
              className="rounded-xl border border-slate-300 px-4 py-2"
            />

            <input
              name="salaryPlan"
              placeholder="План зарплаты"
              inputMode="decimal"
              className="rounded-xl border border-slate-300 px-4 py-2"
            />

            <input
              name="otherPlan"
              placeholder="Прочие расходы"
              inputMode="decimal"
              className="rounded-xl border border-slate-300 px-4 py-2"
            />

            <button className="rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white">
              Сохранить бюджет
            </button>
          </form>
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-2xl font-bold text-slate-900">
            Бюджеты
          </h2>

          <div className="mt-6 space-y-4">
            {plans.map((plan) => (
              <div
                key={plan.id}
                className="rounded-2xl border border-slate-200 p-4"
              >
                <form
                  action="/api/finance/budget"
                  method="POST"
                  className="grid gap-4 xl:grid-cols-[180px_90px_150px_repeat(7,120px)_110px_90px]"
                >
                  <input type="hidden" name="action" value="UPDATE" />
                  <input type="hidden" name="id" value={plan.id} />

                  <select
                    name="companyName"
                    defaultValue={plan.companyName}
                    className="rounded-xl border border-slate-300 px-3 py-2"
                  >
                    {companies.map((company) => (
                      <option key={company.id} value={company.name}>
                        {company.name}
                      </option>
                    ))}
                  </select>

                  <input
                    name="periodYear"
                    defaultValue={plan.periodYear}
                    inputMode="numeric"
                    className="rounded-xl border border-slate-300 px-3 py-2"
                  />

                  <select
                    name="periodMonth"
                    defaultValue={plan.periodMonth}
                    className="rounded-xl border border-slate-300 px-3 py-2"
                  >
                    {months.map((month) => (
                      <option key={month.value} value={month.value}>
                        {month.label}
                      </option>
                    ))}
                  </select>

                  <input
                    name="revenuePlan"
                    defaultValue={Number(plan.revenuePlan ?? 0)}
                    className="rounded-xl border border-slate-300 px-3 py-2"
                  />

                  <input
                    name="profitPlan"
                    defaultValue={Number(plan.profitPlan ?? 0)}
                    className="rounded-xl border border-slate-300 px-3 py-2"
                  />

                  <input
                    name="adsPlan"
                    defaultValue={Number(plan.adsPlan ?? 0)}
                    className="rounded-xl border border-slate-300 px-3 py-2"
                  />

                  <input
                    name="logisticsPlan"
                    defaultValue={Number(plan.logisticsPlan ?? 0)}
                    className="rounded-xl border border-slate-300 px-3 py-2"
                  />

                  <input
                    name="taxPlan"
                    defaultValue={Number(plan.taxPlan ?? 0)}
                    className="rounded-xl border border-slate-300 px-3 py-2"
                  />

                  <input
                    name="salaryPlan"
                    defaultValue={Number(plan.salaryPlan ?? 0)}
                    className="rounded-xl border border-slate-300 px-3 py-2"
                  />

                  <input
                    name="otherPlan"
                    defaultValue={Number(plan.otherPlan ?? 0)}
                    className="rounded-xl border border-slate-300 px-3 py-2"
                  />

                  <button className="rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white">
                    Сохранить
                  </button>

                  <button
                    form={`delete-budget-${plan.id}`}
                    className="rounded-xl bg-red-50 px-4 py-2 font-semibold text-red-600"
                  >
                    Удалить
                  </button>
                </form>

                <form
                  id={`delete-budget-${plan.id}`}
                  action="/api/finance/budget"
                  method="POST"
                >
                  <input type="hidden" name="action" value="DELETE" />
                  <input type="hidden" name="id" value={plan.id} />
                </form>

                <div className="mt-3 grid gap-3 text-sm text-slate-500 md:grid-cols-4">
                  <div>
                    Период:{" "}
                    <span className="font-semibold text-slate-900">
                      {monthName(plan.periodMonth)} {plan.periodYear}
                    </span>
                  </div>

                  <div>
                    Выручка:{" "}
                    <span className="font-semibold text-emerald-600">
                      {formatMoney(plan.revenuePlan)}
                    </span>
                  </div>

                  <div>
                    Прибыль:{" "}
                    <span className="font-semibold text-emerald-600">
                      {formatMoney(plan.profitPlan)}
                    </span>
                  </div>

                  <div>
                    Расходы:{" "}
                    <span className="font-semibold text-red-600">
                      {formatMoney(
                        Number(plan.adsPlan ?? 0) +
                          Number(plan.logisticsPlan ?? 0) +
                          Number(plan.taxPlan ?? 0) +
                          Number(plan.salaryPlan ?? 0) +
                          Number(plan.otherPlan ?? 0)
                      )}
                    </span>
                  </div>
                </div>
              </div>
            ))}

            {plans.length === 0 && (
              <div className="rounded-xl bg-slate-50 p-10 text-center text-slate-500">
                Бюджеты пока не созданы.
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}