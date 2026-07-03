import Link from "next/link";

import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function toNumber(value: unknown) {
  if (value === null || value === undefined) return 0;

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === "object" && "toNumber" in value) {
    const decimalValue = value as { toNumber: () => number };
    const number = decimalValue.toNumber();
    return Number.isFinite(number) ? number : 0;
  }

  const number = Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(number) ? number : 0;
}

function formatMoney(value: unknown) {
  const number = toNumber(value);

  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(number);
}

function formatPercent(value: unknown) {
  const number = toNumber(value);
  if (!number) return "—";

  return `${number.toFixed(1)}%`;
}

function formatDate(value: Date | null | undefined) {
  if (!value) return "—";
  return value.toLocaleDateString("ru-RU");
}

function formatMonthValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(date: Date) {
  return date.toLocaleDateString("ru-RU", {
    month: "long",
    year: "numeric",
  });
}

function formatShortMonthLabel(date: Date) {
  return date.toLocaleDateString("ru-RU", {
    month: "short",
    year: "numeric",
  });
}

function formatDay(value: Date) {
  return String(value.getDate()).padStart(2, "0");
}

function formatShortMonth(value: Date) {
  return value.toLocaleDateString("ru-RU", { month: "short" }).replace(".", "");
}

function frequencyLabel(value: string | null | undefined) {
  if (value === "MONTHLY") return "Ежемесячно";
  if (value === "WEEKLY") return "Еженедельно";
  if (value === "BIWEEKLY") return "Раз в 2 недели";
  if (value === "TWICE_MONTHLY_15_25") return "15 и 25 числа";
  if (value === "CUSTOM") return "Ручной график";
  return "Ежемесячно";
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

function endOfYear(date: Date) {
  return new Date(date.getFullYear(), 11, 31, 23, 59, 59, 999);
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function parseMonth(value: string | null | undefined, fallback: Date) {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) return startOfMonth(fallback);

  const [year, month] = value.split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) return startOfMonth(fallback);

  return new Date(year, month - 1, 1);
}

function monthsBetween(from: Date, to: Date | null | undefined) {
  if (!to) return null;

  const start = startOfMonth(from);
  const end = startOfMonth(to);

  const months =
    (end.getFullYear() - start.getFullYear()) * 12 +
    end.getMonth() -
    start.getMonth();

  return Math.max(0, months + 1);
}

function getPaymentTotal(payment: {
  totalAmount: unknown;
  principalAmount: unknown;
  interestAmount: unknown;
}) {
  return (
    toNumber(payment.totalAmount) ||
    toNumber(payment.principalAmount) + toNumber(payment.interestAmount)
  );
}

function getPaymentPrincipal(payment: { principalAmount: unknown; totalAmount: unknown }) {
  const principal = toNumber(payment.principalAmount);
  return principal || getPaymentTotal({ ...payment, interestAmount: 0 });
}

function getPaymentInterest(payment: { interestAmount: unknown }) {
  return toNumber(payment.interestAmount);
}

function getSafeRatio(numerator: number, denominator: number) {
  return denominator > 0 ? (numerator / denominator) * 100 : 0;
}

function buildFinanceHref(company: string | null, period: string) {
  const query = new URLSearchParams();

  query.set("company", company ?? "ALL");
  query.set("period", period);

  return `/finance/loans?${query.toString()}`;
}

function getLoanDisplayName(loan: { bankName: string; contractNumber: string | null }) {
  return loan.bankName || loan.contractNumber || "Кредит";
}

export default async function LoansPage({
  searchParams,
}: {
  searchParams?: Promise<{
    company?: string;
    period?: string;
  }>;
}) {
  const params = searchParams ? await searchParams : {};
  const now = new Date();
  const today = startOfDay(now);

  const selectedMonth = parseMonth(params.period, now);
  const selectedMonthValue = formatMonthValue(selectedMonth);
  const selectedMonthEnd = endOfMonth(selectedMonth);
  const yearEnd = endOfYear(selectedMonth);

  const companyName =
    params.company && params.company !== "ALL" ? params.company : null;

  const companies = await prisma.$queryRaw<{ id: string; name: string }[]>`
    select "id", "name"
    from "Company"
    where "isActive" = true
    order by "name" asc
  `;

  const loans = await prisma.loan.findMany({
    where: {
      ...(companyName ? { companyName } : {}),
    },
    include: {
      payments: {
        orderBy: {
          paymentDate: "asc",
        },
      },
    },
    orderBy: [{ companyName: "asc" }, { bankName: "asc" }],
  });

  const activeLoans = loans.filter((loan) => toNumber(loan.currentDebt) > 0);
  const activeLoanIds = activeLoans.map((loan) => loan.id);

  const paymentsUntilYearEnd = await prisma.loanPayment.findMany({
    where: {
      paymentDate: {
        gte: selectedMonth,
        lte: yearEnd,
      },
      ...(companyName
        ? {
            loan: {
              companyName,
            },
          }
        : {}),
    },
    include: {
      loan: true,
    },
    orderBy: {
      paymentDate: "asc",
    },
  });

  const allFuturePayments = await prisma.loanPayment.findMany({
    where: {
      paymentDate: {
        gte: today,
      },
      paid: false,
      ...(companyName
        ? {
            loan: {
              companyName,
            },
          }
        : {}),
    },
    include: {
      loan: true,
    },
    orderBy: {
      paymentDate: "asc",
    },
  });

  const overduePayments = await prisma.loanPayment.findMany({
    where: {
      paymentDate: {
        lt: today,
      },
      paid: false,
      ...(companyName
        ? {
            loan: {
              companyName,
            },
          }
        : {}),
    },
    include: {
      loan: true,
    },
    orderBy: {
      paymentDate: "asc",
    },
  });

  const currentMonthPayments = paymentsUntilYearEnd.filter(
    (payment) =>
      payment.paymentDate >= selectedMonth && payment.paymentDate <= selectedMonthEnd
  );

  const next7DaysEnd = addDays(today, 7);
  const next14DaysEnd = addDays(today, 14);

  const next7Payments = allFuturePayments.filter(
    (payment) => payment.paymentDate <= next7DaysEnd
  );

  const next14Payments = allFuturePayments.filter(
    (payment) => payment.paymentDate <= next14DaysEnd
  );

  const totalDebt = activeLoans.reduce(
    (sum, loan) => sum + toNumber(loan.currentDebt),
    0
  );

  const selectedMonthPayment = currentMonthPayments.reduce(
    (sum, payment) => sum + getPaymentTotal(payment),
    0
  );

  const currentMonthPrincipal = currentMonthPayments.reduce(
    (sum, payment) => sum + getPaymentPrincipal(payment),
    0
  );

  const currentMonthInterest = currentMonthPayments.reduce(
    (sum, payment) => sum + getPaymentInterest(payment),
    0
  );

  const monthlyPaymentFromLoans = activeLoans.reduce(
    (sum, loan) => sum + toNumber(loan.monthlyPayment),
    0
  );

  const paymentInMonth =
    selectedMonthPayment > 0 ? selectedMonthPayment : monthlyPaymentFromLoans;

  const next14Amount = next14Payments.reduce(
    (sum, payment) => sum + getPaymentTotal(payment),
    0
  );

  const overdueAmount = overduePayments.reduce(
    (sum, payment) => sum + getPaymentTotal(payment),
    0
  );

  const next7Amount = next7Payments.reduce(
    (sum, payment) => sum + getPaymentTotal(payment),
    0
  );

  const totalPrincipalUntilYearEnd = paymentsUntilYearEnd.reduce(
    (sum, payment) => sum + getPaymentPrincipal(payment),
    0
  );

  const totalInterestUntilYearEnd = paymentsUntilYearEnd.reduce(
    (sum, payment) => sum + getPaymentInterest(payment),
    0
  );

  const totalPaymentsUntilYearEnd =
    totalPrincipalUntilYearEnd + totalInterestUntilYearEnd;

  const weightedRate =
    totalDebt > 0
      ? activeLoans.reduce(
          (sum, loan) =>
            sum + toNumber(loan.interestRate) * toNumber(loan.currentDebt),
          0
        ) / totalDebt
      : 0;

  const loanRows = activeLoans.map((loan) => {
    const futurePayments = loan.payments.filter(
      (payment) => payment.paymentDate >= today && !payment.paid
    );

    const monthPayments = loan.payments.filter(
      (payment) =>
        payment.paymentDate >= selectedMonth &&
        payment.paymentDate <= selectedMonthEnd &&
        !payment.paid
    );

    const nextPayment = futurePayments[0] ?? null;

    const monthlyPaymentBySchedule = monthPayments.reduce(
      (sum, payment) => sum + getPaymentTotal(payment),
      0
    );

    const monthlyPayment =
      monthlyPaymentBySchedule > 0
        ? monthlyPaymentBySchedule
        : toNumber(loan.monthlyPayment);

    const principalUntilYearEnd = futurePayments
      .filter((payment) => payment.paymentDate <= yearEnd)
      .reduce((sum, payment) => sum + getPaymentPrincipal(payment), 0);

    const interestUntilYearEnd = futurePayments
      .filter((payment) => payment.paymentDate <= yearEnd)
      .reduce((sum, payment) => sum + getPaymentInterest(payment), 0);

    const nextPaymentPrincipal = nextPayment ? getPaymentPrincipal(nextPayment) : 0;
    const nextPaymentInterest = nextPayment ? getPaymentInterest(nextPayment) : 0;
    const nextPaymentTotal = nextPayment ? getPaymentTotal(nextPayment) : monthlyPayment;

    const remainingMonths = monthsBetween(today, loan.endDate);

    return {
      id: loan.id,
      companyName: loan.companyName,
      bankName: loan.bankName,
      contractNumber: loan.contractNumber,
      displayName: getLoanDisplayName(loan),
      currentDebt: toNumber(loan.currentDebt),
      monthlyPayment,
      interestRate: toNumber(loan.interestRate),
      creditLimit: toNumber(loan.creditLimit),
      endDate: loan.endDate,
      paymentFrequency: loan.paymentFrequency,
      paymentsCount: loan.payments.length,
      nextPayment,
      nextPaymentDate: nextPayment?.paymentDate ?? null,
      nextPaymentPrincipal,
      nextPaymentInterest,
      nextPaymentTotal,
      principalUntilYearEnd,
      interestUntilYearEnd,
      remainingMonths,
      burdenPercent: getSafeRatio(monthlyPayment, paymentInMonth),
    };
  });

  const loansByMonthlyBurden = [...loanRows].sort(
    (a, b) => b.monthlyPayment - a.monthlyPayment
  );

  const loansByRate = [...loanRows].sort(
    (a, b) =>
      b.interestRate - a.interestRate ||
      b.interestUntilYearEnd - a.interestUntilYearEnd
  );

  const loansBySmallDebt = [...loanRows].sort(
    (a, b) => a.currentDebt - b.currentDebt
  );

  const nextPayments = allFuturePayments.slice(0, 4);

  const nextPayment = allFuturePayments[0] ?? null;
  const topMonthlyBurdenLoan = loansByMonthlyBurden[0] ?? null;
  const mostExpensiveLoan = loansByRate[0] ?? null;

  const monthlyMap = new Map<
    string,
    {
      monthDate: Date;
      totalAmount: number;
      principalAmount: number;
      interestAmount: number;
      loansCount: Set<string>;
      paymentsCount: number;
    }
  >();

  for (const payment of paymentsUntilYearEnd) {
    const key = monthKey(payment.paymentDate);

    const current =
      monthlyMap.get(key) ??
      {
        monthDate: new Date(
          payment.paymentDate.getFullYear(),
          payment.paymentDate.getMonth(),
          1
        ),
        totalAmount: 0,
        principalAmount: 0,
        interestAmount: 0,
        loansCount: new Set<string>(),
        paymentsCount: 0,
      };

    current.totalAmount += getPaymentTotal(payment);
    current.principalAmount += getPaymentPrincipal(payment);
    current.interestAmount += getPaymentInterest(payment);
    current.loansCount.add(payment.loanId);
    current.paymentsCount += 1;

    monthlyMap.set(key, current);
  }

  const paymentSchedule = Array.from(monthlyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, row]) => ({
      ...row,
      loansCountNumber: row.loansCount.size,
    }));

  const peakMonth = paymentSchedule.reduce<
    | {
        monthDate: Date;
        totalAmount: number;
        principalAmount: number;
        interestAmount: number;
        loansCountNumber: number;
        paymentsCount: number;
      }
    | null
  >((current, row) => {
    if (!current || row.totalAmount > current.totalAmount) return row;
    return current;
  }, null);

  const activeLoanIdsCount = new Set(activeLoanIds).size;

  const monthlyRevenuePlaceholder = 0;
  const monthlyBurdenPercent = getSafeRatio(paymentInMonth, monthlyRevenuePlaceholder);

  return (
    <main className="min-h-screen bg-[#f5f7fb] px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <section className="rounded-[28px] border border-slate-200 bg-white/80 p-6 shadow-sm shadow-slate-200/70 backdrop-blur xl:p-8">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <h1 className="text-4xl font-black tracking-tight text-slate-950">
                Кредиты и займы
              </h1>

              <p className="mt-3 max-w-3xl text-sm font-medium leading-6 text-slate-500">
                Полная картина долговой нагрузки и оптимальные решения по
                кредитному портфелю: ближайшие платежи, проценты, риски и
                рекомендации по досрочному погашению.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/finance/cashflow"
                className="rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-black text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
              >
                ОДДС
              </Link>

              <Link
                href="/finance/calendar"
                className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-black text-white shadow-sm shadow-slate-300 transition hover:bg-slate-800"
              >
                Платёжный календарь
              </Link>

              <Link
                href="/finance/accounts"
                className="rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-black text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
              >
                Счета
              </Link>
            </div>
          </div>

          <form className="mt-7 flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div className="grid flex-1 gap-4 md:grid-cols-3">
              <label className="block">
                <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                  Компания
                </span>

                <select
                  name="company"
                  defaultValue={params.company ?? "ALL"}
                  className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 shadow-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
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
                <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                  Период
                </span>

                <input
                  type="month"
                  name="period"
                  defaultValue={selectedMonthValue}
                  className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 shadow-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                />
              </label>

              <div className="flex items-end">
                <div className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <div className="text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                    Обновлено
                  </div>
                  <div className="mt-1 text-sm font-black text-slate-900">
                    {formatDate(now)},{" "}
                    {now.toLocaleTimeString("ru-RU", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <button className="h-12 rounded-2xl bg-slate-950 px-6 text-sm font-black text-white shadow-sm shadow-slate-300 transition hover:bg-slate-800">
                Применить
              </button>

              <a
                href="#all-loans"
                className="inline-flex h-12 items-center justify-center rounded-2xl border border-slate-200 bg-white px-6 text-sm font-black text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                Все кредиты
              </a>
            </div>
          </form>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
          <MetricCard
            label="Общий долг"
            value={formatMoney(totalDebt)}
            hint={`${activeLoanIdsCount} активных кредитов`}
            accent="red"
            icon="₽"
          />

          <MetricCard
            label="Платежи 30 дней"
            value={formatMoney(next14Amount)}
            hint={`${next14Payments.length} платежей в ближайшие 14 дней`}
            accent="blue"
            icon="14"
          />

          <MetricCard
            label="Платёж в текущем месяце"
            value={formatMoney(paymentInMonth)}
            hint={`тело ${formatMoney(currentMonthPrincipal)} · проценты ${formatMoney(
              currentMonthInterest
            )}`}
            accent="orange"
            icon="↗"
          />

          <MetricCard
            label="Ближайший платёж"
            value={nextPayment ? formatMoney(getPaymentTotal(nextPayment)) : "—"}
            hint={
              nextPayment
                ? `${formatDate(nextPayment.paymentDate)} · ${getLoanDisplayName(
                    nextPayment.loan
                  )}`
                : "платежей нет"
            }
            accent="indigo"
            icon="⏱"
          />

          <MetricCard
            label="Проценты до конца года"
            value={formatMoney(totalInterestUntilYearEnd)}
            hint={`${getSafeRatio(totalInterestUntilYearEnd, totalPaymentsUntilYearEnd).toFixed(
              1
            )}% от выплат`}
            accent="amber"
            icon="%"
          />

          <MetricCard
            label="Кредитов активных"
            value={String(activeLoanIdsCount)}
            hint={companyName ?? "все компании"}
            accent="green"
            icon="✓"
          />
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/70">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-black text-slate-950">
                Что требует внимания
              </h2>
              <p className="mt-1 text-sm font-medium text-slate-500">
                Риски, ближайшие платежи и самые дорогие обязательства.
              </p>
            </div>

            <Link
              href="/finance/calendar"
              className="text-sm font-black text-indigo-600 hover:text-indigo-500"
            >
              Смотреть все
            </Link>
          </div>

          <div className="mt-5 grid gap-4 xl:grid-cols-4">
            <AttentionCard
              tone="red"
              title="Просроченные платежи"
              subtitle={`${overduePayments.length} платежей на сумму`}
              value={formatMoney(overdueAmount)}
              action="Перейти к платежам →"
              href="/finance/calendar"
            />

            <AttentionCard
              tone="orange"
              title="Платежи в ближайшие 7 дней"
              subtitle={`${next7Payments.length} платежей на сумму`}
              value={formatMoney(next7Amount)}
              action="Посмотреть календарь →"
              href="/finance/calendar"
            />

            <AttentionCard
              tone="amber"
              title="Высокая ежемесячная нагрузка"
              subtitle={topMonthlyBurdenLoan?.displayName ?? "нет данных"}
              value={
                topMonthlyBurdenLoan
                  ? `${formatMoney(topMonthlyBurdenLoan.monthlyPayment)} / мес.`
                  : "—"
              }
              action="Рекомендации →"
              href="#recommendations"
            />

            <AttentionCard
              tone="purple"
              title="Самые дорогие кредиты"
              subtitle={mostExpensiveLoan?.displayName ?? "нет данных"}
              value={
                mostExpensiveLoan
                  ? `${formatPercent(mostExpensiveLoan.interestRate)} годовых`
                  : "—"
              }
              action="Смотреть детали →"
              href="#all-loans"
            />
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
          <section
            id="recommendations"
            className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm shadow-slate-200/70"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-xl font-black text-slate-950">
                  Рекомендации по досрочному погашению
                </h2>
                <p className="mt-1 text-sm font-medium text-slate-500">
                  Три стратегии: снизить платёж, уменьшить проценты или быстро
                  закрыть мелкие кредиты.
                </p>
              </div>

              <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-black text-indigo-700 ring-1 ring-indigo-100">
                без изменения данных
              </span>
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-3">
              <RecommendationCard
                number="1"
                tone="green"
                title="Снизить ежемесячный платёж"
                description="Гасите кредиты с самым большим платежом в месяц."
                headers={["Кредит", "Платёж/мес", "Потенциал"]}
                rows={loansByMonthlyBurden.slice(0, 3).map((loan) => [
                  loan.displayName,
                  formatMoney(loan.monthlyPayment),
                  `−${formatMoney(loan.monthlyPayment)}`,
                ])}
                action="Показать варианты"
              />

              <RecommendationCard
                number="2"
                tone="blue"
                title="Снизить переплату по процентам"
                description="Начинайте с кредитов с высокой ставкой и процентами."
                headers={["Кредит", "Ставка", "Проценты"]}
                rows={loansByRate.slice(0, 3).map((loan) => [
                  loan.displayName,
                  formatPercent(loan.interestRate),
                  formatMoney(loan.interestUntilYearEnd),
                ])}
                action="Рассчитать погашение"
              />

              <RecommendationCard
                number="3"
                tone="purple"
                title="Быстро закрыть мелкие кредиты"
                description="Закрывайте небольшие долги, чтобы снизить число обязательств."
                headers={["Кредит", "Долг", "Платёж/мес"]}
                rows={loansBySmallDebt.slice(0, 3).map((loan) => [
                  loan.displayName,
                  formatMoney(loan.currentDebt),
                  formatMoney(loan.monthlyPayment),
                ])}
                action="Закрыть мелкие кредиты"
              />
            </div>
          </section>

          <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm shadow-slate-200/70">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-black text-slate-950">
                  Ближайшие платежи
                </h2>
                <p className="mt-1 text-sm font-medium text-slate-500">
                  Следующие списания по графику.
                </p>
              </div>

              <Link
                href="/finance/calendar"
                className="text-sm font-black text-indigo-600 hover:text-indigo-500"
              >
                Календарь
              </Link>
            </div>

            <div className="mt-5 divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-100">
              {nextPayments.map((payment) => (
                <div
                  key={payment.id}
                  className="grid grid-cols-[58px_1fr_auto] items-center gap-4 bg-white p-4"
                >
                  <div className="rounded-2xl bg-slate-50 px-2 py-2 text-center ring-1 ring-slate-100">
                    <div className="text-lg font-black text-slate-950">
                      {formatDay(payment.paymentDate)}
                    </div>
                    <div className="text-[10px] font-black uppercase tracking-[0.08em] text-slate-400">
                      {formatShortMonth(payment.paymentDate)}
                    </div>
                  </div>

                  <div className="min-w-0">
                    <div className="truncate text-sm font-black text-slate-950">
                      {getLoanDisplayName(payment.loan)}
                    </div>

                    <div className="mt-1 grid gap-1 text-xs font-bold text-slate-500 sm:grid-cols-2">
                      <span>
                        Тело{" "}
                        <b className="text-slate-900">
                          {formatMoney(getPaymentPrincipal(payment))}
                        </b>
                      </span>
                      <span>
                        Проценты{" "}
                        <b className="text-amber-600">
                          {formatMoney(getPaymentInterest(payment))}
                        </b>
                      </span>
                    </div>
                  </div>

                  <div className="text-right">
                    <div className="text-[10px] font-black uppercase tracking-[0.08em] text-slate-400">
                      Всего
                    </div>
                    <div className="mt-1 text-base font-black text-red-600">
                      {formatMoney(getPaymentTotal(payment))}
                    </div>
                  </div>
                </div>
              ))}

              {nextPayments.length === 0 && (
                <div className="bg-slate-50 p-8 text-center text-sm font-bold text-slate-500">
                  Ближайших платежей пока нет.
                </div>
              )}
            </div>

            <Link
              href="/finance/calendar"
              className="mt-4 inline-flex text-sm font-black text-indigo-600 hover:text-indigo-500"
            >
              Смотреть все платежи →
            </Link>
          </section>
        </section>

        <section className="grid gap-6 xl:grid-cols-[1fr_0.95fr]">
          <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm shadow-slate-200/70">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-black text-slate-950">
                  Карта долговой нагрузки
                </h2>
                <p className="mt-1 text-sm font-medium text-slate-500">
                  Топ кредитов по величине ежемесячного платежа.
                </p>
              </div>

              <span className="rounded-full bg-slate-50 px-3 py-1 text-xs font-black text-slate-500 ring-1 ring-slate-100">
                {activeLoanIdsCount} активных
              </span>
            </div>

            <div className="mt-6 space-y-5">
              {loansByMonthlyBurden.slice(0, 5).map((loan, index) => (
                <div key={loan.id}>
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-black text-slate-950">
                        {loan.displayName}
                      </div>
                      <div className="mt-1 text-xs font-bold text-slate-500">
                        Тело: {formatMoney(loan.currentDebt)} · Ставка:{" "}
                        {formatPercent(loan.interestRate)}
                      </div>
                    </div>

                    <div className="text-right">
                      <div
                        className={`text-sm font-black ${
                          index === 0
                            ? "text-red-600"
                            : index <= 2
                              ? "text-orange-600"
                              : "text-amber-600"
                        }`}
                      >
                        {formatMoney(loan.monthlyPayment)} / мес.
                      </div>
                      <div className="mt-1 text-xs font-black text-slate-500">
                        {loan.burdenPercent.toFixed(1)}%
                      </div>
                    </div>
                  </div>

                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full ${
                        index === 0
                          ? "bg-red-500"
                          : index <= 2
                            ? "bg-orange-400"
                            : "bg-amber-400"
                      }`}
                      style={{
                        width: `${Math.min(100, Math.max(6, loan.burdenPercent))}%`,
                      }}
                    />
                  </div>
                </div>
              ))}

              {loansByMonthlyBurden.length === 0 && (
                <div className="rounded-2xl bg-slate-50 p-8 text-center text-sm font-bold text-slate-500">
                  Активных кредитов пока нет.
                </div>
              )}
            </div>
          </section>

          <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm shadow-slate-200/70">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-black text-slate-950">
                  План платежей по месяцам
                </h2>
                <p className="mt-1 text-sm font-medium text-slate-500">
                  Плановые платежи по телу и процентам до конца года.
                </p>
              </div>

              <span className="rounded-full bg-slate-950 px-3 py-1 text-xs font-black text-white">
                Таблица
              </span>
            </div>

            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="bg-slate-50 text-left text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                    <th className="rounded-l-2xl px-4 py-3">Месяц</th>
                    <th className="px-4 py-3 text-right">Платёж всего</th>
                    <th className="px-4 py-3 text-right">Тело</th>
                    <th className="px-4 py-3 text-right">Проценты</th>
                    <th className="rounded-r-2xl px-4 py-3 text-right">
                      Кредиты
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {paymentSchedule.map((row) => {
                    const isPeak =
                      peakMonth &&
                      monthKey(peakMonth.monthDate) === monthKey(row.monthDate);

                    return (
                      <tr
                        key={row.monthDate.toISOString()}
                        className={`border-b border-slate-100 ${
                          isPeak ? "bg-indigo-50/50" : ""
                        }`}
                      >
                        <td className="px-4 py-3 font-black text-slate-950">
                          {formatShortMonthLabel(row.monthDate)}
                        </td>
                        <td className="px-4 py-3 text-right font-black text-red-600">
                          {formatMoney(row.totalAmount)}
                        </td>
                        <td className="px-4 py-3 text-right font-bold text-slate-900">
                          {formatMoney(row.principalAmount)}
                        </td>
                        <td className="px-4 py-3 text-right font-bold text-orange-600">
                          {formatMoney(row.interestAmount)}
                        </td>
                        <td className="px-4 py-3 text-right font-bold text-slate-700">
                          {row.loansCountNumber}
                        </td>
                      </tr>
                    );
                  })}

                  {paymentSchedule.length === 0 && (
                    <tr>
                      <td
                        colSpan={5}
                        className="px-4 py-8 text-center text-sm font-bold text-slate-500"
                      >
                        Платежей пока нет.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <Link
              href="/finance/calendar"
              className="mt-4 inline-flex text-sm font-black text-indigo-600 hover:text-indigo-500"
            >
              Перейти в платёжный календарь →
            </Link>
          </section>
        </section>

        <section
          id="all-loans"
          className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm shadow-slate-200/70"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-black text-slate-950">Все кредиты</h2>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-600">
                {activeLoanIdsCount}
              </span>
            </div>

            <div className="flex gap-2">
              <a
                href="#add-loan"
                className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                Добавить кредит
              </a>
              <Link
                href="/finance/calendar"
                className="rounded-2xl bg-slate-950 px-4 py-2 text-sm font-black text-white shadow-sm transition hover:bg-slate-800"
              >
                График платежей
              </Link>
            </div>
          </div>

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[1180px] text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                  <th className="rounded-l-2xl px-4 py-3">Кредит</th>
                  <th className="px-4 py-3">Компания</th>
                  <th className="px-4 py-3 text-right">Текущий долг</th>
                  <th className="px-4 py-3 text-right">Платёж в месяц</th>
                  <th className="px-4 py-3">Следующий платёж</th>
                  <th className="px-4 py-3 text-right">Остаток срока</th>
                  <th className="px-4 py-3 text-right">Ставка</th>
                  <th className="px-4 py-3">Статус</th>
                  <th className="rounded-r-2xl px-4 py-3 text-right">
                    Действия
                  </th>
                </tr>
              </thead>

              <tbody>
                {loanRows.map((loan) => (
                  <tr key={loan.id} className="border-b border-slate-100">
                    <td className="px-4 py-4">
                      <div className="font-black text-slate-950">
                        {loan.displayName}
                      </div>
                      <div className="mt-1 text-xs font-bold text-slate-400">
                        {loan.contractNumber || frequencyLabel(loan.paymentFrequency)}
                      </div>
                    </td>

                    <td className="px-4 py-4 font-bold text-slate-700">
                      {loan.companyName}
                    </td>

                    <td className="px-4 py-4 text-right font-black text-slate-950">
                      {formatMoney(loan.currentDebt)}
                    </td>

                    <td className="px-4 py-4 text-right font-black text-orange-600">
                      {formatMoney(loan.monthlyPayment)}
                    </td>

                    <td className="px-4 py-4">
                      <div className="font-bold text-slate-900">
                        {formatDate(loan.nextPaymentDate)}
                      </div>
                      <div className="mt-1 text-xs font-bold text-slate-500">
                        {loan.nextPaymentDate
                          ? `всего ${formatMoney(loan.nextPaymentTotal)}`
                          : "нет платежей"}
                      </div>
                    </td>

                    <td className="px-4 py-4 text-right font-bold text-slate-700">
                      {loan.remainingMonths === null
                        ? "—"
                        : `${loan.remainingMonths} мес.`}
                    </td>

                    <td className="px-4 py-4 text-right font-bold text-slate-700">
                      {formatPercent(loan.interestRate)}
                    </td>

                    <td className="px-4 py-4">
                      <span className="inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-black text-emerald-700 ring-1 ring-emerald-100">
                        ● Активен
                      </span>
                    </td>

                    <td className="px-4 py-4 text-right">
                      <div className="flex justify-end gap-2">
                        <a
                          href="#early-repayment"
                          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-700 transition hover:bg-slate-50"
                        >
                          Досрочно погасить
                        </a>
                        <Link
                          href={`/finance/loans/${loan.id}/schedule`}
                          className="rounded-xl bg-slate-950 px-3 py-2 text-xs font-black text-white transition hover:bg-slate-800"
                        >
                          График
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}

                {loanRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={9}
                      className="px-4 py-10 text-center text-sm font-bold text-slate-500"
                    >
                      Кредиты пока не заведены.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <details
          id="add-loan"
          className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm shadow-slate-200/70"
        >
          <summary className="cursor-pointer list-none text-xl font-black text-slate-950">
            Добавить кредит
          </summary>

          <form
            action="/api/finance/loans"
            method="POST"
            className="mt-6 grid gap-4 md:grid-cols-4"
          >
            <select
              name="companyName"
              className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900"
              defaultValue={companies[0]?.name ?? ""}
            >
              {companies.map((company) => (
                <option key={company.id} value={company.name}>
                  {company.name}
                </option>
              ))}
            </select>

            <input
              name="bankName"
              required
              placeholder="Название кредита / банка"
              className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900"
            />

            <input
              name="contractNumber"
              placeholder="Номер договора"
              className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900"
            />

            <select
              name="paymentFrequency"
              defaultValue="MONTHLY"
              className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900"
            >
              <option value="MONTHLY">Ежемесячно</option>
              <option value="WEEKLY">Еженедельно</option>
              <option value="BIWEEKLY">Раз в 2 недели</option>
              <option value="TWICE_MONTHLY_15_25">15 и 25 числа</option>
              <option value="CUSTOM">Ручной график</option>
            </select>

            <input
              name="interestRate"
              placeholder="Ставка %"
              className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900"
            />

            <input
              name="creditLimit"
              placeholder="Лимит кредита"
              className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900"
            />

            <input
              name="currentDebt"
              placeholder="Текущий долг"
              className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900"
            />

            <input
              name="monthlyPayment"
              placeholder="Платёж в месяц"
              className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900"
            />

            <input
              type="date"
              name="startDate"
              className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900"
            />

            <input
              type="date"
              name="endDate"
              className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900"
            />

            <button className="h-12 rounded-2xl bg-slate-950 px-4 text-sm font-black text-white">
              Добавить кредит
            </button>
          </form>

          <p className="mt-4 text-sm font-medium text-slate-500">
            Для досрочного погашения следующим этапом добавим отдельную форму:
            она будет создавать финансовую операцию, уменьшать остаток долга и
            пересчитывать будущий график платежей.
          </p>
        </details>
      </div>
    </main>
  );
}

function MetricCard({
  label,
  value,
  hint,
  accent,
  icon,
}: {
  label: string;
  value: string;
  hint: string;
  accent: "red" | "blue" | "orange" | "indigo" | "amber" | "green";
  icon: string;
}) {
  const accentClass = {
    red: "text-red-600 bg-red-50 ring-red-100",
    blue: "text-blue-600 bg-blue-50 ring-blue-100",
    orange: "text-orange-600 bg-orange-50 ring-orange-100",
    indigo: "text-indigo-600 bg-indigo-50 ring-indigo-100",
    amber: "text-amber-600 bg-amber-50 ring-amber-100",
    green: "text-emerald-600 bg-emerald-50 ring-emerald-100",
  }[accent];

  return (
    <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/70">
      <div className="flex items-start justify-between gap-3">
        <div className="text-xs font-black uppercase tracking-[0.08em] text-slate-400">
          {label}
        </div>
        <div
          className={`flex h-9 w-9 items-center justify-center rounded-2xl text-xs font-black ring-1 ${accentClass}`}
        >
          {icon}
        </div>
      </div>

      <div className={`mt-4 text-2xl font-black tracking-tight ${accentClass.split(" ")[0]}`}>
        {value}
      </div>

      <div className="mt-2 text-xs font-bold leading-5 text-slate-500">{hint}</div>
    </div>
  );
}

function AttentionCard({
  tone,
  title,
  subtitle,
  value,
  action,
  href,
}: {
  tone: "red" | "orange" | "amber" | "purple";
  title: string;
  subtitle: string;
  value: string;
  action: string;
  href: string;
}) {
  const classes = {
    red: "border-red-100 bg-red-50/60 text-red-600",
    orange: "border-orange-100 bg-orange-50/60 text-orange-600",
    amber: "border-amber-100 bg-amber-50/60 text-amber-600",
    purple: "border-purple-100 bg-purple-50/60 text-purple-600",
  }[tone];

  return (
    <Link
      href={href}
      className={`rounded-[22px] border p-5 transition hover:-translate-y-0.5 hover:shadow-md ${classes}`}
    >
      <div className="text-sm font-black text-slate-950">{title}</div>
      <div className="mt-3 text-xs font-bold text-slate-500">{subtitle}</div>
      <div className="mt-2 text-xl font-black">{value}</div>
      <div className="mt-4 text-xs font-black">{action}</div>
    </Link>
  );
}

function RecommendationCard({
  number,
  tone,
  title,
  description,
  headers,
  rows,
  action,
}: {
  number: string;
  tone: "green" | "blue" | "purple";
  title: string;
  description: string;
  headers: string[];
  rows: string[][];
  action: string;
}) {
  const color = {
    green: "text-emerald-700 bg-emerald-50 border-emerald-100",
    blue: "text-blue-700 bg-blue-50 border-blue-100",
    purple: "text-purple-700 bg-purple-50 border-purple-100",
  }[tone];

  return (
    <div className={`rounded-[22px] border p-4 ${color}`}>
      <div className="text-sm font-black">
        {number}. {title}
      </div>

      <p className="mt-2 min-h-[42px] text-xs font-semibold leading-5 text-slate-600">
        {description}
      </p>

      <div className="mt-4 overflow-hidden rounded-2xl bg-white/75 ring-1 ring-white">
        <div className="grid grid-cols-[1.2fr_0.85fr_0.9fr] gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-[0.08em] text-slate-400">
          {headers.map((header) => (
            <div key={header} className={header === headers[0] ? "" : "text-right"}>
              {header}
            </div>
          ))}
        </div>

        <div className="divide-y divide-slate-100">
          {rows.length > 0 ? (
            rows.map((row) => (
              <div
                key={row.join("-")}
                className="grid grid-cols-[1.2fr_0.85fr_0.9fr] gap-2 px-3 py-2 text-xs font-bold text-slate-700"
              >
                <div className="truncate text-slate-950">{row[0]}</div>
                <div className="text-right">{row[1]}</div>
                <div className="text-right text-emerald-600">{row[2]}</div>
              </div>
            ))
          ) : (
            <div className="px-3 py-4 text-xs font-bold text-slate-500">
              Недостаточно данных.
            </div>
          )}
        </div>
      </div>

      <button className="mt-4 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-700 transition hover:bg-slate-50">
        {action}
      </button>
    </div>
  );
}
