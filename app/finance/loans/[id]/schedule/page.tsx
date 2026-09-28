import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

function formatMoney(value: unknown) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));
}

function formatDate(value: Date | null) {
  if (!value) return "—";
  return value.toLocaleDateString("ru-RU");
}

function inputDate(value: Date | null) {
  if (!value) return "";

  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function frequencyLabel(value: string | null | undefined) {
  if (value === "MONTHLY") return "Ежемесячно";
  if (value === "WEEKLY") return "Еженедельно";
  if (value === "BIWEEKLY") return "Раз в 2 недели";
  if (value === "TWICE_MONTHLY_15_25") return "15 и 25 числа";
  if (value === "CUSTOM") return "Ручной график";
  return "Ежемесячно";
}

function getAmount(value: unknown) {
  return Number(value ?? 0);
}

function daysBetween(previousDate: Date | null, currentDate: Date) {
  if (!previousDate) return null;

  const diff = currentDate.getTime() - previousDate.getTime();
  return Math.round(diff / (24 * 60 * 60 * 1000));
}

function differenceLabel(value: number) {
  if (Math.abs(value) < 1) return "График сходится с долгом";
  if (value > 0) return `Не хватает тела: ${formatMoney(value)}`;
  return `Лишнее тело в графике: ${formatMoney(Math.abs(value))}`;
}

function differenceClassName(value: number) {
  if (Math.abs(value) < 1) return "border-emerald-200 bg-emerald-50 text-emerald-700";
  return "border-red-200 bg-red-50 text-red-700";
}

export default async function LoanSchedulePage({
  params,
}: {
  params: Promise<{
    id: string;
  }>;
}) {
  const { id } = await params;

  const loan = await prisma.loan.findUnique({
    where: {
      id,
    },
    include: {
      payments: {
        orderBy: {
          paymentDate: "asc",
        },
      },
    },
  });

  if (!loan) {
    notFound();
  }

  const totalPayments = loan.payments.reduce(
    (sum, payment) => sum + getAmount(payment.totalAmount),
    0
  );

  const totalPrincipal = loan.payments.reduce(
    (sum, payment) => sum + getAmount(payment.principalAmount),
    0
  );

  const totalInterest = loan.payments.reduce(
    (sum, payment) => sum + getAmount(payment.interestAmount),
    0
  );

  const currentDebt = getAmount(loan.currentDebt);
  const principalDifference = currentDebt - totalPrincipal;

  const redirectTo = `/finance/loans/${loan.id}/schedule`;

  const firstPayment = loan.payments[0] ?? null;

  return (
    <main className="min-h-screen bg-slate-100 p-8">
      <div className="mx-auto max-w-[1700px] space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <Link
              href="/finance/loans"
              className="text-sm font-semibold text-slate-500 hover:text-slate-900"
            >
              ← Назад к кредитам
            </Link>

            <h1 className="mt-3 text-4xl font-bold text-slate-900">
              График кредита 2.0
            </h1>

            <p className="mt-3 text-slate-500">
              Редактирование дат, сумм, периодичности и будущих платежей по кредиту.
            </p>
          </div>

          <div className="flex gap-3">
            <Link
              href="/finance/calendar"
              className="rounded-xl bg-slate-900 px-5 py-3 font-semibold text-white"
            >
              Платёжный календарь
            </Link>

            <Link
              href="/finance/forecast"
              className="rounded-xl border border-slate-300 px-5 py-3 font-semibold"
            >
              Прогноз ликвидности
            </Link>
          </div>
        </div>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <div>
              <div className="text-sm text-slate-500">Компания</div>
              <div className="mt-1 text-xl font-bold text-slate-900">
                {loan.companyName}
              </div>
            </div>

            <div>
              <div className="text-sm text-slate-500">Кредит</div>
              <div className="mt-1 text-xl font-bold text-slate-900">
                {loan.bankName}
              </div>
            </div>

            <div>
              <div className="text-sm text-slate-500">Текущий долг</div>
              <div className="mt-1 text-xl font-bold text-red-600">
                {formatMoney(loan.currentDebt)}
              </div>
            </div>

            <div>
              <div className="text-sm text-slate-500">Платёж</div>
              <div className="mt-1 text-xl font-bold text-amber-600">
                {formatMoney(loan.monthlyPayment)}
              </div>
            </div>

            <div>
              <div className="text-sm text-slate-500">Периодичность</div>
              <div className="mt-1 text-xl font-bold text-slate-900">
                {frequencyLabel(loan.paymentFrequency)}
              </div>
            </div>
          </div>
        </section>

        <section
          className={`rounded-2xl border p-6 shadow-sm ${differenceClassName(
            principalDifference
          )}`}
        >
          <div className="text-sm font-semibold uppercase">
            Контроль долга
          </div>

          <div className="mt-3 grid gap-4 md:grid-cols-3">
            <div>
              <div className="text-sm opacity-80">Текущий долг</div>
              <div className="mt-1 text-2xl font-bold">
                {formatMoney(currentDebt)}
              </div>
            </div>

            <div>
              <div className="text-sm opacity-80">Тело по графику</div>
              <div className="mt-1 text-2xl font-bold">
                {formatMoney(totalPrincipal)}
              </div>
            </div>

            <div>
              <div className="text-sm opacity-80">Разница</div>
              <div className="mt-1 text-2xl font-bold">
                {differenceLabel(principalDifference)}
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-4">
          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Платежей в графике</div>
            <div className="mt-2 text-3xl font-bold text-slate-900">
              {loan.payments.length}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Всего платежей</div>
            <div className="mt-2 text-3xl font-bold text-red-600">
              {formatMoney(totalPayments)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Тело</div>
            <div className="mt-2 text-3xl font-bold text-red-600">
              {formatMoney(totalPrincipal)}
            </div>
          </div>

          <div className="rounded-2xl bg-white p-6 shadow-sm">
            <div className="text-sm text-slate-500">Проценты</div>
            <div className="mt-2 text-3xl font-bold text-amber-600">
              {formatMoney(totalInterest)}
            </div>
          </div>
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-2xl font-bold text-slate-900">
            Перестроить график кредита
          </h2>

          <p className="mt-2 text-sm text-slate-500">
            Перестроение удалит текущие платежи этого кредита и создаст новый график.
            Финансовые плановые операции по старому графику также будут заменены.
          </p>

          <form
            action="/api/finance/loan-payments"
            method="POST"
            className="mt-6 grid gap-4 md:grid-cols-3 xl:grid-cols-7"
          >
            <input type="hidden" name="action" value="REBUILD" />
            <input type="hidden" name="loanId" value={loan.id} />
            <input type="hidden" name="redirectTo" value={redirectTo} />

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">
                Первый платеж
              </label>

              <input
                type="date"
                name="paymentDate"
                required
                defaultValue={inputDate(firstPayment?.paymentDate ?? null)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">
                Периодичность
              </label>

              <select
                name="paymentFrequency"
                defaultValue={loan.paymentFrequency ?? "MONTHLY"}
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              >
                <option value="MONTHLY">Ежемесячно</option>
                <option value="WEEKLY">Еженедельно</option>
                <option value="BIWEEKLY">Раз в 2 недели</option>
                <option value="TWICE_MONTHLY_15_25">15 и 25 числа</option>
                <option value="CUSTOM">Ручной график</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">
                Кол-во платежей
              </label>

              <input
                name="paymentsCount"
                defaultValue={String(loan.payments.length || 1)}
                inputMode="numeric"
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">
                Тело
              </label>

              <input
                name="principalAmount"
                defaultValue={String(Number(firstPayment?.principalAmount ?? 0))}
                inputMode="decimal"
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">
                Проценты
              </label>

              <input
                name="interestAmount"
                defaultValue={String(Number(firstPayment?.interestAmount ?? 0))}
                inputMode="decimal"
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-500">
                Итого
              </label>

              <input
                name="totalAmount"
                required
                defaultValue={String(Number(firstPayment?.totalAmount ?? loan.monthlyPayment ?? 0))}
                inputMode="decimal"
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              />
            </div>

            <div className="flex items-end">
              <button className="w-full rounded-xl bg-red-600 px-4 py-2 font-semibold text-white hover:bg-red-700">
                Перестроить
              </button>
            </div>
          </form>
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-2xl font-bold text-slate-900">
            Добавить платёж
          </h2>

          <form
            action="/api/finance/loan-payments"
            method="POST"
            className="mt-6 grid gap-4 md:grid-cols-5"
          >
            <input type="hidden" name="action" value="CREATE" />
            <input type="hidden" name="loanId" value={loan.id} />
            <input type="hidden" name="redirectTo" value={redirectTo} />

            <input
              type="date"
              name="paymentDate"
              required
              className="rounded-xl border border-slate-300 px-4 py-2"
            />

            <input
              name="principalAmount"
              placeholder="Тело"
              inputMode="decimal"
              className="rounded-xl border border-slate-300 px-4 py-2"
            />

            <input
              name="interestAmount"
              placeholder="Проценты"
              inputMode="decimal"
              className="rounded-xl border border-slate-300 px-4 py-2"
            />

            <input
              name="totalAmount"
              placeholder="Итого"
              inputMode="decimal"
              required
              className="rounded-xl border border-slate-300 px-4 py-2"
            />

            <button className="rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white">
              Добавить
            </button>
          </form>
        </section>

        <section className="rounded-2xl bg-white p-6 shadow-sm">
          <h2 className="text-2xl font-bold text-slate-900">
            Платежи по графику
          </h2>

          <div className="mt-6 space-y-4">
            {loan.payments.map((payment, index) => {
              const previousPayment = loan.payments[index - 1] ?? null;
              const intervalDays = daysBetween(
                previousPayment?.paymentDate ?? null,
                payment.paymentDate
              );

              return (
                <div
                  key={payment.id}
                  className="rounded-2xl border border-slate-200 p-4"
                >
                  <form
                    action="/api/finance/loan-payments"
                    method="POST"
                    className="grid gap-4 xl:grid-cols-[145px_110px_130px_130px_130px_180px_180px_120px_100px]"
                  >
                    <input type="hidden" name="action" value="UPDATE" />
                    <input type="hidden" name="paymentId" value={payment.id} />
                    <input type="hidden" name="redirectTo" value={redirectTo} />

                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-500">
                        Дата
                      </label>

                      <input
                        type="date"
                        name="paymentDate"
                        defaultValue={inputDate(payment.paymentDate)}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-500">
                        Интервал
                      </label>

                      <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-semibold text-slate-700">
                        {intervalDays === null ? "—" : `${intervalDays} дн.`}
                      </div>
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-500">
                        Тело
                      </label>

                      <input
                        name="principalAmount"
                        defaultValue={String(Number(payment.principalAmount ?? 0))}
                        inputMode="decimal"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-500">
                        Проценты
                      </label>

                      <input
                        name="interestAmount"
                        defaultValue={String(Number(payment.interestAmount ?? 0))}
                        inputMode="decimal"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-500">
                        Итого
                      </label>

                      <input
                        name="totalAmount"
                        defaultValue={String(Number(payment.totalAmount ?? 0))}
                        inputMode="decimal"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-500">
                        Периодичность
                      </label>

                      <select
                        name="paymentFrequency"
                        defaultValue={loan.paymentFrequency ?? "MONTHLY"}
                        className="w-full rounded-xl border border-slate-300 px-3 py-2"
                      >
                        <option value="MONTHLY">Ежемесячно</option>
                        <option value="WEEKLY">Еженедельно</option>
                        <option value="BIWEEKLY">Раз в 2 недели</option>
                        <option value="TWICE_MONTHLY_15_25">15 и 25 числа</option>
                        <option value="CUSTOM">Ручной график</option>
                      </select>
                    </div>

                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-500">
                        Применить
                      </label>

                      <select
                        name="applyScope"
                        defaultValue="ONE"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2"
                      >
                        <option value="ONE">Только этот</option>
                        <option value="FUTURE">Этот и будущие</option>
                      </select>
                    </div>

                    <div className="flex items-end">
                      <button className="w-full rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white">
                        Сохранить
                      </button>
                    </div>

                    <div className="flex items-end">
                      <button
                        form={`delete-payment-${payment.id}`}
                        className="w-full rounded-xl bg-red-50 px-4 py-2 font-semibold text-red-600"
                      >
                        Удалить
                      </button>
                    </div>
                  </form>

                  <form
                    id={`delete-payment-${payment.id}`}
                    action="/api/finance/loan-payments"
                    method="POST"
                  >
                    <input type="hidden" name="action" value="DELETE" />
                    <input type="hidden" name="paymentId" value={payment.id} />
                    <input type="hidden" name="redirectTo" value={redirectTo} />
                  </form>

                  <div className="mt-3 text-sm text-slate-500">
                    Дата: {formatDate(payment.paymentDate)} · Интервал:{" "}
                    {intervalDays === null ? "—" : `${intervalDays} дн.`} · Тело:{" "}
                    {formatMoney(payment.principalAmount)} · Проценты:{" "}
                    {formatMoney(payment.interestAmount)} · Итого:{" "}
                    {formatMoney(payment.totalAmount)}
                  </div>
                </div>
              );
            })}

            {loan.payments.length === 0 && (
              <div className="rounded-xl bg-slate-50 p-8 text-center text-slate-500">
                График платежей пока пустой.
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}