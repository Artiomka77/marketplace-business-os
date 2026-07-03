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

function formatDateInput(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
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
  const month = date
    .toLocaleDateString("ru-RU", { month: "short" })
    .replace(".", "")
    .toUpperCase();

  return `${month} ${date.getFullYear()}`;
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


type LoanSchedulePaymentForRate = {
  paymentDate: Date;
  totalAmount: unknown;
  principalAmount: unknown;
  interestAmount: unknown;
  paid?: boolean | null;
};

function daysBetween(from: Date, to: Date) {
  const oneDay = 24 * 60 * 60 * 1000;
  return Math.max(1, Math.ceil((startOfDay(to).getTime() - startOfDay(from).getTime()) / oneDay));
}

function estimateAnnualRateFromSchedule(params: {
  currentDebt: number;
  payments: LoanSchedulePaymentForRate[];
  today: Date;
  explicitRate?: number;
}) {
  const sortedPayments = [...params.payments]
    .filter((payment) => !payment.paid && payment.paymentDate >= params.today)
    .sort((a, b) => a.paymentDate.getTime() - b.paymentDate.getTime());

  let debt = Math.max(0, params.currentDebt);
  let previousDate = params.today;
  let totalInterest = 0;
  let debtDays = 0;

  for (const payment of sortedPayments) {
    if (debt <= 0) break;

    const interest = getPaymentInterest(payment);
    const principal = getPaymentPrincipal(payment);
    const days = daysBetween(previousDate, payment.paymentDate);

    debtDays += debt * days;
    totalInterest += interest;
    debt = Math.max(0, debt - principal);
    previousDate = payment.paymentDate;
  }

  if (totalInterest > 0 && debtDays > 0) {
    const annualRate = (totalInterest * 365 * 100) / debtDays;

    if (Number.isFinite(annualRate) && annualRate > 0 && annualRate < 300) {
      return {
        rate: annualRate,
        source: "calculated" as const,
      };
    }
  }

  const nextPayment = sortedPayments.find((payment) => getPaymentInterest(payment) > 0);

  if (nextPayment && params.currentDebt > 0) {
    const monthlyRate = (getPaymentInterest(nextPayment) / params.currentDebt) * 12 * 100;

    if (Number.isFinite(monthlyRate) && monthlyRate > 0 && monthlyRate < 300) {
      return {
        rate: monthlyRate,
        source: "estimated" as const,
      };
    }
  }

  if (params.explicitRate && params.explicitRate > 0) {
    return {
      rate: params.explicitRate,
      source: "manual" as const,
    };
  }

  return {
    rate: 0,
    source: "missing" as const,
  };
}

function formatRateLabel(rateInfo: { rate: number; source: string }) {
  if (!rateInfo.rate) return "—";
  return `${formatPercent(rateInfo.rate)} годовых`;
}

function formatRateActionLabel(rateInfo: { rate: number; source: string }) {
  if (!rateInfo.rate) return "ставка не рассчитана →";
  if (rateInfo.source === "manual") return `ставка ${formatPercent(rateInfo.rate)} годовых →`;
  if (rateInfo.source === "estimated") return `оценочная ставка ${formatPercent(rateInfo.rate)} годовых →`;
  return `расчётная ставка ${formatPercent(rateInfo.rate)} годовых →`;
}

function buildFinanceHref(company: string | null, period: string) {
  const query = new URLSearchParams();

  query.set("company", company ?? "ALL");
  query.set("period", period);

  return `/finance/loans?${query.toString()}`;
}

function buildRepaymentHref(company: string | null, period: string, loanId: string) {
  const query = new URLSearchParams();

  query.set("company", company ?? "ALL");
  query.set("period", period);
  query.set("repay", loanId);

  return `/finance/loans?${query.toString()}#early-repayment`;
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
    repay?: string;
    repayment?: string;
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

  const accounts = await prisma.financeAccount.findMany({
    where: {
      isActive: true,
      ...(companyName ? { companyName } : {}),
    },
    orderBy: [{ companyName: "asc" }, { name: "asc" }],
  });

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
      loanId: {
        in: activeLoanIds,
      },
      paid: false,
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
      loanId: {
        in: activeLoanIds,
      },
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

  const recommendedReserve = Math.ceil((next14Amount * 1.1) / 1000) * 1000;


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
    const rateInfo = estimateAnnualRateFromSchedule({
      currentDebt: toNumber(loan.currentDebt),
      payments: futurePayments,
      today,
      explicitRate: toNumber(loan.interestRate),
    });

    return {
      id: loan.id,
      companyName: loan.companyName,
      bankName: loan.bankName,
      contractNumber: loan.contractNumber,
      displayName: getLoanDisplayName(loan),
      currentDebt: toNumber(loan.currentDebt),
      monthlyPayment,
      interestRate: toNumber(loan.interestRate),
      calculatedAnnualRate: rateInfo.rate,
      rateSource: rateInfo.source,
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

  const loansByRate = [...loanRows].sort((a, b) => {
    const aHasRate = a.calculatedAnnualRate > 0;
    const bHasRate = b.calculatedAnnualRate > 0;

    if (aHasRate !== bHasRate) return aHasRate ? -1 : 1;

    return (
      b.calculatedAnnualRate - a.calculatedAnnualRate ||
      b.interestUntilYearEnd - a.interestUntilYearEnd
    );
  });

  const loansBySmallDebt = [...loanRows].sort(
    (a, b) => a.currentDebt - b.currentDebt
  );

  const loansByFutureInterest = [...loanRows].sort(
    (a, b) =>
      b.interestUntilYearEnd - a.interestUntilYearEnd ||
      b.calculatedAnnualRate - a.calculatedAnnualRate ||
      b.currentDebt - a.currentDebt
  );

  const nextPayments = allFuturePayments.slice(0, 4);

  const nextPayment = allFuturePayments[0] ?? null;
  const topMonthlyBurdenLoan = loansByMonthlyBurden[0] ?? null;
  const mostExpensiveLoan = loansByFutureInterest[0] ?? null;
  const expensiveLoanPeriodLabel = `до 31.12.${selectedMonth.getFullYear()}`;

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

  const selectedRepaymentLoan = params.repay
    ? loanRows.find((loan) => loan.id === params.repay) ?? null
    : null;

  const selectedRepaymentPrincipal = selectedRepaymentLoan
    ? selectedRepaymentLoan.currentDebt
    : 0;
  const selectedRepaymentInterest = selectedRepaymentLoan
    ? selectedRepaymentLoan.nextPaymentInterest
    : 0;
  const selectedRepaymentTotal =
    selectedRepaymentPrincipal + selectedRepaymentInterest;
  const selectedRepaymentRate = selectedRepaymentLoan
    ? selectedRepaymentLoan.calculatedAnnualRate || selectedRepaymentLoan.interestRate
    : 0;
  const selectedRepaymentNextDateInput = selectedRepaymentLoan?.nextPaymentDate
    ? formatDateInput(selectedRepaymentLoan.nextPaymentDate)
    : formatDateInput(addDays(today, 1));
  const selectedRepaymentEndDateInput = selectedRepaymentLoan?.endDate
    ? formatDateInput(selectedRepaymentLoan.endDate)
    : selectedRepaymentNextDateInput;
  const selectedRepaymentRegularPayment = selectedRepaymentLoan
    ? selectedRepaymentLoan.nextPaymentTotal || selectedRepaymentLoan.monthlyPayment
    : 0;

  const debtLoadColors = [
    "#1d4ed8",
    "#6366f1",
    "#f59e0b",
    "#ef4444",
    "#a855f7",
    "#94a3b8",
  ];

  const debtLoadTopLoans = loansByMonthlyBurden.slice(0, 5);
  const debtLoadTopAmount = debtLoadTopLoans.reduce(
    (sum, loan) => sum + loan.monthlyPayment,
    0
  );
  const debtLoadOtherAmount = Math.max(0, paymentInMonth - debtLoadTopAmount);
  const debtLoadLegend = [
    ...debtLoadTopLoans.map((loan, index) => ({
      id: loan.id,
      label: loan.displayName,
      amount: loan.monthlyPayment,
      percent: getSafeRatio(loan.monthlyPayment, paymentInMonth),
      color: debtLoadColors[index] ?? "#94a3b8",
    })),
    ...(debtLoadOtherAmount > 0
      ? [
          {
            id: "other",
            label: `Другие кредиты (${Math.max(
              0,
              activeLoanIdsCount - debtLoadTopLoans.length
            )})`,
            amount: debtLoadOtherAmount,
            percent: getSafeRatio(debtLoadOtherAmount, paymentInMonth),
            color: debtLoadColors[5],
          },
        ]
      : []),
  ];

  const debtLoadRadius = 68;
  const debtLoadStrokeWidth = 26;
  const debtLoadCircumference = 2 * Math.PI * debtLoadRadius;

  let debtLoadCursor = 0;
  const debtLoadSvgSegments = debtLoadLegend.map((segment) => {
    const dashLength = Math.max(
      0,
      (segment.percent / 100) * debtLoadCircumference
    );
    const offset = debtLoadCursor;
    debtLoadCursor += dashLength;

    const middle = offset + dashLength / 2;
    const angle = (middle / debtLoadCircumference) * Math.PI * 2 - Math.PI / 2;
    const pointX = 90 + Math.cos(angle) * 76;
    const pointY = 90 + Math.sin(angle) * 76;
    const tooltipWidth = 168;
    const tooltipHeight = 74;
    const tooltipX = pointX >= 90 ? 194 : -182;
    const tooltipY = Math.min(108, Math.max(8, pointY - tooltipHeight / 2));

    return {
      ...segment,
      dashLength,
      dashGap: Math.max(0, debtLoadCircumference - dashLength),
      dashOffset: -offset,
      tooltipX,
      tooltipY,
      tooltipWidth,
      tooltipHeight,
    };
  });

  const monthlyMatrix = paymentSchedule.slice(0, 6);
  const monthlyMatrixPeakKey = monthlyMatrix.reduce<string | null>((currentKey, row) => {
    if (!currentKey) return monthKey(row.monthDate);

    const current = monthlyMatrix.find(
      (item) => monthKey(item.monthDate) === currentKey
    );

    return !current || row.totalAmount > current.totalAmount
      ? monthKey(row.monthDate)
      : currentKey;
  }, null);


  return (
    <main className="min-h-screen bg-[#f5f7fb] px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1600px] space-y-5">
        <section className="rounded-[24px] border border-slate-200 bg-white/90 p-4 shadow-sm shadow-slate-200/70 backdrop-blur">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <h1 className="text-2xl font-black tracking-tight text-slate-950">
                Кредиты и займы
              </h1>

              <p className="mt-1.5 max-w-3xl text-sm font-medium leading-5 text-slate-500">
                Полная картина долговой нагрузки: ближайшие платежи, проценты,
                риски и рекомендации по досрочному погашению.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/finance/cashflow"
                className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
              >
                ОДДС
              </Link>

              <Link
                href="/finance/calendar"
                className="rounded-2xl bg-slate-950 px-4 py-2 text-sm font-black text-white shadow-sm shadow-slate-300 transition hover:bg-slate-800"
              >
                Платёжный календарь
              </Link>

              <Link
                href="/finance/accounts"
                className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
              >
                Счета
              </Link>
            </div>
          </div>

          <form className="mt-4 flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
            <div className="grid flex-1 gap-3 md:grid-cols-3">
              <label className="block">
                <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                  Компания
                </span>

                <select
                  name="company"
                  defaultValue={params.company ?? "ALL"}
                  className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 shadow-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
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
                  className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 shadow-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                />
              </label>

              <div className="flex items-end">
                <div className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2.5">
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
              <button className="h-11 rounded-2xl bg-slate-950 px-6 text-sm font-black text-white shadow-sm shadow-slate-300 transition hover:bg-slate-800">
                Применить
              </button>

              <a
                href="#all-loans"
                className="inline-flex h-11 items-center justify-center rounded-2xl border border-slate-200 bg-white px-6 text-sm font-black text-slate-700 shadow-sm transition hover:bg-slate-50"
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
            label="Резерв 14 дней"
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

        <section className="grid gap-5 xl:grid-cols-[1.28fr_1fr]">
          <section
            id="recommendations"
            className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/70"
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

              <span className="shrink-0 rounded-full bg-indigo-50 px-3 py-1 text-xs font-black text-indigo-700 ring-1 ring-indigo-100">
                Рекомендуемый вариант
              </span>
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-3">
              <RecommendationCard
                number="1"
                tone="green"
                title="Снизить ежемесячный платёж"
                description="Гасите кредиты с самым большим платежом в месяц."
                headers={["Кредит", "Платёж в мес.", "Потенциал"]}
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
                  formatRateLabel({
                    rate: loan.calculatedAnnualRate,
                    source: loan.rateSource,
                  }),
                  formatMoney(loan.interestUntilYearEnd),
                ])}
                action="Рассчитать погашение"
              />

              <RecommendationCard
                number="3"
                tone="purple"
                title="Быстро закрыть мелкие кредиты"
                description="Закрывайте небольшие долги, чтобы снизить число обязательств."
                headers={["Кредит", "Долг", "Платёж в мес."]}
                rows={loansBySmallDebt.slice(0, 3).map((loan) => [
                  loan.displayName,
                  formatMoney(loan.currentDebt),
                  formatMoney(loan.monthlyPayment),
                ])}
                action="Закрыть мелкие кредиты"
              />
            </div>
          </section>

          <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/70">
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

            <div className="mt-4 overflow-hidden rounded-2xl border border-slate-100">
              <div className="hidden grid-cols-[64px_1fr_96px_90px_96px] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-black uppercase tracking-[0.08em] text-slate-400 lg:grid">
                <div>Дата</div>
                <div>Кредит</div>
                <div className="text-right">Тело</div>
                <div className="text-right">Проценты</div>
                <div className="text-right">Всего</div>
              </div>

              <div className="divide-y divide-slate-100">
                {nextPayments.map((payment) => (
                  <div
                    key={payment.id}
                    className="grid gap-3 bg-white px-4 py-3 lg:grid-cols-[64px_1fr_96px_90px_96px] lg:items-center"
                  >
                    <div className="flex items-center gap-3 lg:block">
                      <div className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-2xl bg-slate-50 ring-1 ring-slate-100">
                        <div className="text-base font-black text-slate-950">
                          {formatDay(payment.paymentDate)}
                        </div>
                        <div className="text-[10px] font-black uppercase tracking-[0.08em] text-slate-400">
                          {formatShortMonth(payment.paymentDate)}
                        </div>
                      </div>
                      <div className="min-w-0 lg:hidden">
                        <div className="truncate text-sm font-black text-slate-950">
                          {getLoanDisplayName(payment.loan)}
                        </div>
                        <div className="mt-1 text-xs font-bold text-slate-500">
                          Тело {formatMoney(getPaymentPrincipal(payment))} · проценты {formatMoney(getPaymentInterest(payment))}
                        </div>
                      </div>
                    </div>

                    <div className="hidden min-w-0 truncate text-sm font-black text-slate-950 lg:block">
                      {getLoanDisplayName(payment.loan)}
                    </div>

                    <div className="hidden text-right text-sm font-bold text-slate-900 lg:block">
                      {formatMoney(getPaymentPrincipal(payment))}
                    </div>

                    <div className="hidden text-right text-sm font-bold text-orange-600 lg:block">
                      {formatMoney(getPaymentInterest(payment))}
                    </div>

                    <div className="text-right text-base font-black text-red-600 lg:text-sm">
                      {formatMoney(getPaymentTotal(payment))}
                    </div>
                  </div>
                ))}

                {nextPayments.length === 0 && (
                  <div className="bg-slate-50 p-8 text-center text-sm font-bold text-slate-500">
                    Ближайших платежей пока нет.
                  </div>
                )}
              </div>
            </div>

            <Link
              href="/finance/calendar"
              className="mt-4 inline-flex text-sm font-black text-indigo-600 hover:text-indigo-500"
            >
              Смотреть все платежи →
            </Link>
          </section>
        </section>

        <section className="grid gap-5 xl:grid-cols-[0.72fr_1.28fr]">
          <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/70">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-black text-slate-950">
                  Карта долговой нагрузки
                </h2>
                <p className="mt-1 text-sm font-medium text-slate-500">
                  Доля кредитов в ежемесячном платеже.
                </p>
              </div>

              <span className="rounded-full bg-slate-50 px-3 py-1 text-xs font-black text-slate-500 ring-1 ring-slate-100">
                {activeLoanIdsCount} активных
              </span>
            </div>

            <div className="mt-5 grid gap-5 md:grid-cols-[190px_1fr] md:items-center xl:grid-cols-1 2xl:grid-cols-[190px_1fr]">
              <div className="relative mx-auto h-[180px] w-[180px]">
                <svg
                  viewBox="0 0 180 180"
                  className="relative z-20 h-full w-full overflow-visible"
                  role="img"
                  aria-label="Карта долговой нагрузки по кредитам"
                >
                  <circle
                    cx="90"
                    cy="90"
                    r={debtLoadRadius}
                    fill="none"
                    stroke="#e2e8f0"
                    strokeWidth={debtLoadStrokeWidth}
                  />

                  {debtLoadSvgSegments.map((segment) => (
                    <g key={segment.id} className="group outline-none">
                      <circle
                        cx="90"
                        cy="90"
                        r={debtLoadRadius}
                        fill="none"
                        stroke={segment.color}
                        strokeWidth={debtLoadStrokeWidth}
                        strokeDasharray={`${segment.dashLength} ${segment.dashGap}`}
                        strokeDashoffset={segment.dashOffset}
                        strokeLinecap="butt"
                        transform="rotate(-90 90 90)"
                        className="cursor-pointer opacity-95 transition-opacity duration-150 hover:opacity-80 focus:opacity-80"
                        tabIndex={0}
                      />

                      <foreignObject
                        x={segment.tooltipX}
                        y={segment.tooltipY}
                        width={segment.tooltipWidth}
                        height={segment.tooltipHeight}
                        className="pointer-events-none opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
                      >
                        <div className="h-full rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-left shadow-2xl shadow-slate-300/70 ring-1 ring-white">
                          <div className="flex items-center gap-2">
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: segment.color }}
                            />
                            <div className="min-w-0 truncate text-[11px] font-black text-slate-950">
                              {segment.label}
                            </div>
                          </div>
                          <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-1 text-[10px] font-bold text-slate-500">
                            <span>Платёж</span>
                            <span className="text-right text-slate-950">
                              {formatMoney(segment.amount)}
                            </span>
                            <span>Нагрузка</span>
                            <span className="text-right text-slate-950">
                              {segment.percent.toFixed(1)}%
                            </span>
                          </div>
                        </div>
                      </foreignObject>
                    </g>
                  ))}
                </svg>

                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                  <div className="flex h-[112px] w-[112px] flex-col items-center justify-center rounded-full bg-white text-center shadow-sm">
                    <div className="text-lg font-black text-slate-950">
                      {formatMoney(paymentInMonth)}
                    </div>
                    <div className="mt-1 text-[11px] font-black uppercase tracking-[0.08em] text-slate-400">
                      в месяц
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                {debtLoadLegend.map((segment) => (
                  <div
                    key={segment.id}
                    className="grid grid-cols-[1fr_auto_auto] items-center gap-3 text-sm"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: segment.color }}
                      />
                      <span className="truncate font-bold text-slate-700">
                        {segment.label}
                      </span>
                    </div>
                    <span className="font-black text-slate-950">
                      {segment.percent.toFixed(1)}%
                    </span>
                    <span className="w-[88px] text-right font-bold text-slate-600">
                      {formatMoney(segment.amount)}
                    </span>
                  </div>
                ))}

                {debtLoadLegend.length === 0 && (
                  <div className="rounded-2xl bg-slate-50 p-8 text-center text-sm font-bold text-slate-500">
                    Активных кредитов пока нет.
                  </div>
                )}
              </div>
            </div>

            <a
              href="#all-loans"
              className="mt-5 inline-flex text-sm font-black text-indigo-600 hover:text-indigo-500"
            >
              Подробнее о нагрузке →
            </a>
          </section>

          <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/70 ring-1 ring-slate-100">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-black text-slate-950">
                  План платежей по месяцам
                </h2>
                <p className="mt-1 text-sm font-medium text-slate-500">
                  Матрица тела, процентов и общей нагрузки.
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                {peakMonth ? (
                  <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-black text-orange-700 ring-1 ring-orange-100">
                    Пик: {formatShortMonthLabel(peakMonth.monthDate)} · {formatMoney(peakMonth.totalAmount)}
                  </span>
                ) : null}
                <span className="rounded-full bg-slate-950 px-3 py-1 text-xs font-black text-white">
                  Таблица
                </span>
              </div>
            </div>

            <div className="mt-5 overflow-x-auto rounded-[22px] border border-slate-100 bg-slate-50/70 p-2">
              <table className="w-full min-w-[760px] border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="text-left text-xs font-black uppercase tracking-[0.08em] text-slate-500">
                    <th className="rounded-l-2xl bg-white px-4 py-3 shadow-sm">Месяц</th>
                    {monthlyMatrix.map((row, index) => {
                      const isPeak = monthlyMatrixPeakKey === monthKey(row.monthDate);

                      return (
                        <th
                          key={row.monthDate.toISOString()}
                          className={`whitespace-nowrap px-4 py-3 text-right shadow-sm ${
                            isPeak
                              ? "bg-orange-50 text-orange-700 ring-1 ring-orange-100"
                              : "bg-white text-slate-500"
                          } ${
                            index === monthlyMatrix.length - 1 ? "rounded-r-2xl" : ""
                          }`}
                        >
                          {formatShortMonthLabel(row.monthDate)}
                        </th>
                      );
                    })}
                  </tr>
                </thead>

                <tbody>
                  <tr>
                    <td className="border-b border-slate-100 bg-white px-4 py-3 font-bold text-slate-600">Основной долг</td>
                    {monthlyMatrix.map((row) => {
                      const isPeak = monthlyMatrixPeakKey === monthKey(row.monthDate);

                      return (
                        <td
                          key={`principal-${row.monthDate.toISOString()}`}
                          className={`border-b border-slate-100 px-4 py-3 text-right font-black ${
                            isPeak ? "bg-orange-50/50 text-slate-950" : "bg-white text-slate-900"
                          }`}
                        >
                          {formatMoney(row.principalAmount)}
                        </td>
                      );
                    })}
                  </tr>

                  <tr>
                    <td className="border-b border-slate-100 bg-white px-4 py-3 font-bold text-slate-600">Проценты</td>
                    {monthlyMatrix.map((row) => {
                      const isPeak = monthlyMatrixPeakKey === monthKey(row.monthDate);

                      return (
                        <td
                          key={`interest-${row.monthDate.toISOString()}`}
                          className={`border-b border-slate-100 px-4 py-3 text-right font-black ${
                            isPeak ? "bg-orange-50/50 text-orange-700" : "bg-white text-orange-600"
                          }`}
                        >
                          {formatMoney(row.interestAmount)}
                        </td>
                      );
                    })}
                  </tr>

                  <tr>
                    <td className="rounded-l-2xl bg-slate-100 px-4 py-4 font-black text-slate-950">Всего платежей</td>
                    {monthlyMatrix.map((row, index) => {
                      const isPeak = monthlyMatrixPeakKey === monthKey(row.monthDate);

                      return (
                        <td
                          key={`total-${row.monthDate.toISOString()}`}
                          className={`px-4 py-4 text-right text-base font-black ${
                            isPeak
                              ? "bg-orange-100 text-orange-700 ring-1 ring-orange-200"
                              : "bg-slate-100 text-red-600"
                          } ${
                            index === monthlyMatrix.length - 1 ? "rounded-r-2xl" : ""
                          }`}
                        >
                          {formatMoney(row.totalAmount)}
                        </td>
                      );
                    })}
                  </tr>

                  {monthlyMatrix.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-4 py-8 text-center text-sm font-bold text-slate-500"
                      >
                        Платежей пока нет.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <Link
                href="/finance/calendar"
                className="inline-flex text-sm font-black text-indigo-600 hover:text-indigo-500"
              >
                Показать полный график →
              </Link>

              <div className="flex items-center gap-3 text-sm font-bold text-slate-600">
                <span>Показывать план до погашения</span>
                <span className="relative inline-flex h-6 w-11 items-center rounded-full bg-slate-950">
                  <span className="ml-auto mr-1 h-4 w-4 rounded-full bg-white" />
                </span>
              </div>
            </div>
          </section>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/70">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-black text-slate-950">
                Что требует внимания
              </h2>
              <p className="mt-1 text-sm font-medium text-slate-500">
                Резерв, ближайшие платежи и самые дорогие обязательства.
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
              tone="green"
              title="Резерв на ближайшие платежи"
              subtitle={`${next14Payments.length} платежей в ближайшие 14 дней`}
              value={formatMoney(recommendedReserve)}
              action="Держать на счетах →"
              href="/finance/accounts"
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
              title="Самый дорогой кредит"
              subtitle={
                mostExpensiveLoan
                  ? `${mostExpensiveLoan.displayName} · проценты ${expensiveLoanPeriodLabel}`
                  : "нет данных"
              }
              value={
                mostExpensiveLoan
                  ? mostExpensiveLoan.interestUntilYearEnd > 0
                    ? formatMoney(mostExpensiveLoan.interestUntilYearEnd)
                    : "проценты не рассчитаны"
                  : "—"
              }
              action={
                mostExpensiveLoan
                  ? formatRateActionLabel({
                      rate: mostExpensiveLoan.calculatedAnnualRate,
                      source: mostExpensiveLoan.rateSource,
                    })
                  : "ставка не рассчитана →"
              }
              href="#all-loans"
            />
          </div>
        </section>

        {selectedRepaymentLoan ? (
          <section
            id="early-repayment"
            className="rounded-[28px] border border-indigo-100 bg-white p-6 shadow-sm shadow-indigo-100/70 ring-1 ring-indigo-50"
          >
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <div className="inline-flex rounded-full bg-indigo-50 px-3 py-1 text-xs font-black uppercase tracking-[0.08em] text-indigo-700 ring-1 ring-indigo-100">
                  Досрочное погашение
                </div>

                <h2 className="mt-3 text-2xl font-black text-slate-950">
                  Погасить {selectedRepaymentLoan.displayName}
                </h2>

                <p className="mt-2 max-w-4xl text-sm font-medium leading-6 text-slate-500">
                  Система создаст финансовые операции: тело кредита отдельно от
                  процентов. Тело уменьшит долг и не испортит прибыль, проценты
                  попадут в финансовые расходы.
                </p>
              </div>

              <Link
                href={buildFinanceHref(companyName, selectedMonthValue)}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                Отменить
              </Link>
            </div>

            <div className="mt-5 grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
              <div className="rounded-[24px] border border-slate-100 bg-slate-50/70 p-5">
                <div className="text-sm font-black text-slate-950">
                  {selectedRepaymentLoan.companyName}
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-100">
                    <div className="text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                      Текущий долг
                    </div>
                    <div className="mt-2 text-xl font-black text-slate-950">
                      {formatMoney(selectedRepaymentLoan.currentDebt)}
                    </div>
                  </div>

                  <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-100">
                    <div className="text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                      Следующий платёж
                    </div>
                    <div className="mt-2 text-xl font-black text-indigo-600">
                      {formatMoney(selectedRepaymentLoan.nextPaymentTotal)}
                    </div>
                    <div className="mt-1 text-xs font-bold text-slate-500">
                      {formatDate(selectedRepaymentLoan.nextPaymentDate)}
                    </div>
                  </div>

                  <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-100">
                    <div className="text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                      Тело ближайшего платежа
                    </div>
                    <div className="mt-2 text-lg font-black text-slate-950">
                      {formatMoney(selectedRepaymentLoan.nextPaymentPrincipal)}
                    </div>
                  </div>

                  <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-100">
                    <div className="text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                      Проценты ближайшего платежа
                    </div>
                    <div className="mt-2 text-lg font-black text-orange-600">
                      {formatMoney(selectedRepaymentLoan.nextPaymentInterest)}
                    </div>
                  </div>
                </div>

                <div className="mt-4 space-y-3">
                  <div className="rounded-2xl bg-emerald-50 p-4 text-sm font-bold leading-6 text-emerald-800 ring-1 ring-emerald-100">
                    При полном погашении будущие платежи по этому кредиту будут
                    помечены как закрытые, будущие плановые операции будут удалены,
                    а текущий долг станет 0 ₽.
                  </div>

                  <div className="rounded-2xl bg-amber-50 p-4 text-sm font-bold leading-6 text-amber-900 ring-1 ring-amber-100">
                    При частичном погашении система закроет старый будущий график и
                    создаст новый: с новым телом, процентами, датами платежей и
                    новой долговой нагрузкой.
                  </div>
                </div>
              </div>

              <form
                action="/api/finance/loans/early-repayment"
                method="POST"
                className="rounded-[24px] border border-slate-100 bg-white p-5 shadow-sm"
              >
                <input type="hidden" name="loanId" value={selectedRepaymentLoan.id} />
                <input type="hidden" name="returnCompany" value={companyName ?? "ALL"} />
                <input type="hidden" name="returnPeriod" value={selectedMonthValue} />

                <div className="grid gap-4 md:grid-cols-2">
                  <label className="block">
                    <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                      Тип погашения
                    </span>
                    <select
                      name="repaymentMode"
                      defaultValue="FULL"
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                    >
                      <option value="FULL">Полное погашение</option>
                      <option value="PARTIAL">Частичное погашение</option>
                    </select>
                  </label>

                  <label className="block">
                    <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                      Дата операции
                    </span>
                    <input
                      type="date"
                      name="operationDate"
                      defaultValue={formatDateInput(today)}
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                      Тело кредита
                    </span>
                    <input
                      name="principalAmount"
                      inputMode="decimal"
                      defaultValue={Math.round(selectedRepaymentPrincipal)}
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                      Проценты
                    </span>
                    <input
                      name="interestAmount"
                      inputMode="decimal"
                      defaultValue={Math.round(selectedRepaymentInterest)}
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                    />
                  </label>

                  <div className="md:col-span-2 rounded-[22px] border border-indigo-100 bg-indigo-50/60 p-4 ring-1 ring-indigo-50">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="text-xs font-black uppercase tracking-[0.08em] text-indigo-700">
                          Новый график для частичного погашения
                        </div>
                        <p className="mt-1 text-sm font-bold leading-6 text-slate-600">
                          Заполняется только при выборе “Частичное погашение”.
                          Система закроет старые будущие платежи и создаст новый
                          график по этим настройкам.
                        </p>
                      </div>
                      <span className="rounded-full bg-white px-3 py-1 text-xs font-black text-indigo-700 ring-1 ring-indigo-100">
                        Пересчёт
                      </span>
                    </div>

                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                      <label className="block">
                        <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                          Как пересчитать
                        </span>
                        <select
                          name="scheduleStrategy"
                          defaultValue="REDUCE_PAYMENT"
                          className="h-11 w-full rounded-2xl border border-indigo-100 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                        >
                          <option value="REDUCE_PAYMENT">Уменьшить платёж, срок оставить</option>
                          <option value="SHORTEN_TERM">Платёж оставить, сократить срок</option>
                        </select>
                      </label>

                      <label className="block">
                        <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                          Первый платёж нового графика
                        </span>
                        <input
                          type="date"
                          name="firstNewPaymentDate"
                          defaultValue={selectedRepaymentNextDateInput}
                          className="h-11 w-full rounded-2xl border border-indigo-100 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                        />
                      </label>

                      <label className="block">
                        <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                          Ставка для пересчёта, % годовых
                        </span>
                        <input
                          name="scheduleAnnualRate"
                          inputMode="decimal"
                          defaultValue={
                            selectedRepaymentRate > 0
                              ? selectedRepaymentRate.toFixed(2)
                              : ""
                          }
                          placeholder="Например 24"
                          className="h-11 w-full rounded-2xl border border-indigo-100 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                        />
                      </label>

                      <label className="block">
                        <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                          Дата окончания при уменьшении платежа
                        </span>
                        <input
                          type="date"
                          name="scheduleEndDate"
                          defaultValue={selectedRepaymentEndDateInput}
                          className="h-11 w-full rounded-2xl border border-indigo-100 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                        />
                      </label>

                      <label className="block md:col-span-2">
                        <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                          Регулярный платёж при сокращении срока
                        </span>
                        <input
                          name="newRegularPayment"
                          inputMode="decimal"
                          defaultValue={Math.round(selectedRepaymentRegularPayment)}
                          placeholder="Сумма одного платежа"
                          className="h-11 w-full rounded-2xl border border-indigo-100 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                        />
                      </label>
                    </div>

                    <div className="mt-4 rounded-2xl bg-white p-4 text-sm font-bold leading-6 text-slate-600 ring-1 ring-indigo-100">
                      Для частичного погашения сумма в поле “Тело кредита” должна
                      быть меньше текущего долга. Если закрываешь кредит полностью —
                      выбирай “Полное погашение”.
                    </div>
                  </div>

                  <label className="block md:col-span-2">
                    <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                      Счёт списания
                    </span>
                    <select
                      name="bankAccount"
                      defaultValue=""
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                    >
                      <option value="">Не выбран</option>
                      {accounts.map((account) => (
                        <option key={account.id} value={account.name}>
                          {account.companyName} · {account.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block md:col-span-2">
                    <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                      Комментарий
                    </span>
                    <textarea
                      name="comment"
                      rows={3}
                      defaultValue={`Досрочное погашение ${selectedRepaymentLoan.displayName}`}
                      className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                    />
                  </label>
                </div>

                <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm font-bold text-slate-500">
                    Ориентир к списанию: {formatMoney(selectedRepaymentTotal)}
                  </div>
                  <button className="rounded-2xl bg-slate-950 px-6 py-3 text-sm font-black text-white shadow-sm transition hover:bg-slate-800">
                    Создать погашение
                  </button>
                </div>
              </form>
            </div>
          </section>
        ) : null}

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
                      {formatRateLabel({
                        rate: loan.calculatedAnnualRate,
                        source: loan.rateSource,
                      })}
                    </td>

                    <td className="px-4 py-4">
                      <span className="inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-black text-emerald-700 ring-1 ring-emerald-100">
                        ● Активен
                      </span>
                    </td>

                    <td className="px-4 py-4 text-right">
                      <div className="flex justify-end gap-2">
                        <Link
                          href={buildRepaymentHref(companyName, selectedMonthValue, loan.id)}
                          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-700 transition hover:bg-slate-50"
                        >
                          Досрочно погасить
                        </Link>
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
  tone: "red" | "orange" | "amber" | "purple" | "green";
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
    green: "border-emerald-100 bg-emerald-50/60 text-emerald-600",
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
    <div className={`rounded-[22px] border p-3.5 ${color}`}>
      <div className="text-sm font-black leading-5">
        {number}. {title}
      </div>

      <p className="mt-2 min-h-[38px] text-[11px] font-semibold leading-5 text-slate-600">
        {description}
      </p>

      <div className="mt-3 space-y-2">
        {rows.length > 0 ? (
          rows.map((row) => (
            <div
              key={row.join("-")}
              className="group rounded-2xl bg-white/85 px-3 py-2 text-xs font-bold text-slate-700 ring-1 ring-white/80 transition hover:bg-white"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 truncate text-sm font-black text-slate-950" title={row[0]}>
                  {row[0]}
                </div>
                <span className="shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500">›</span>
              </div>

              <div className="mt-1 text-[11px] leading-4 text-slate-500">
                <span className="font-bold text-slate-500">{headers[1]}: </span>
                <b className="text-slate-900">{row[1]}</b>
                <span className="mx-1.5 text-slate-300">·</span>
                <span className="font-bold text-slate-500">{headers[2]}: </span>
                <b className="text-emerald-600">{row[2]}</b>
              </div>
            </div>
          ))
        ) : (
          <div className="rounded-2xl bg-white/75 px-3 py-4 text-xs font-bold text-slate-500 ring-1 ring-white/80">
            Недостаточно данных.
          </div>
        )}
      </div>

      <button className="mt-3 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-700 transition hover:bg-slate-50">
        {action}
      </button>
    </div>
  );
}
