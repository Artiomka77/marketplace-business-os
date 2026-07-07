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
  if (!number) return "вЂ”";

  return `${number.toFixed(1)}%`;
}

function formatDate(value: Date | null | undefined) {
  if (!value) return "вЂ”";
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
  if (value === "MONTHLY") return "Р•Р¶РµРјРµСЃСЏС‡РЅРѕ";
  if (value === "WEEKLY") return "Р•Р¶РµРЅРµРґРµР»СЊРЅРѕ";
  if (value === "BIWEEKLY") return "Р Р°Р· РІ 2 РЅРµРґРµР»Рё";
  if (value === "TWICE_MONTHLY_15_25") return "15 Рё 25 С‡РёСЃР»Р°";
  if (value === "CUSTOM") return "Р СѓС‡РЅРѕР№ РіСЂР°С„РёРє";
  return "Р•Р¶РµРјРµСЃСЏС‡РЅРѕ";
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

function getPaymentPrincipal(payment: {
  principalAmount: unknown;
  totalAmount: unknown;
}) {
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
  return Math.max(
    1,
    Math.ceil((startOfDay(to).getTime() - startOfDay(from).getTime()) / oneDay),
  );
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

  const nextPayment = sortedPayments.find(
    (payment) => getPaymentInterest(payment) > 0,
  );

  if (nextPayment && params.currentDebt > 0) {
    const monthlyRate =
      (getPaymentInterest(nextPayment) / params.currentDebt) * 12 * 100;

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
  if (!rateInfo.rate) return "вЂ”";
  return `${formatPercent(rateInfo.rate)} РіРѕРґРѕРІС‹С…`;
}

function formatRateActionLabel(rateInfo: { rate: number; source: string }) {
  if (!rateInfo.rate) return "СЃС‚Р°РІРєР° РЅРµ СЂР°СЃСЃС‡РёС‚Р°РЅР° в†’";
  if (rateInfo.source === "manual")
    return `СЃС‚Р°РІРєР° ${formatPercent(rateInfo.rate)} РіРѕРґРѕРІС‹С… в†’`;
  if (rateInfo.source === "estimated")
    return `РѕС†РµРЅРѕС‡РЅР°СЏ СЃС‚Р°РІРєР° ${formatPercent(rateInfo.rate)} РіРѕРґРѕРІС‹С… в†’`;
  return `СЂР°СЃС‡С‘С‚РЅР°СЏ СЃС‚Р°РІРєР° ${formatPercent(rateInfo.rate)} РіРѕРґРѕРІС‹С… в†’`;
}

function buildFinanceHref(company: string | null, period: string) {
  const query = new URLSearchParams();

  query.set("company", company ?? "ALL");
  query.set("period", period);

  return `/finance/loans?${query.toString()}`;
}

function buildRepaymentHref(
  company: string | null,
  period: string,
  loanId: string,
) {
  const query = new URLSearchParams();

  query.set("company", company ?? "ALL");
  query.set("period", period);
  query.set("repay", loanId);

  return `/finance/loans?${query.toString()}#early-repayment`;
}

function buildCreditCardEditHref(
  company: string | null,
  period: string,
  loanId: string,
) {
  const query = new URLSearchParams();

  query.set("company", company ?? "ALL");
  query.set("period", period);
  query.set("card", loanId);

  return `/finance/loans?${query.toString()}#credit-card-editor`;
}

function getLoanDisplayName(loan: {
  bankName: string;
  contractNumber: string | null;
}) {
  return loan.bankName || loan.contractNumber || "РљСЂРµРґРёС‚";
}

type CreditCardRiskTone = "high" | "medium" | "low" | "missing";

type CreditCardView = {
  id: string;
  displayName: string;
  companyName: string;
  contractNumber: string | null;
  currentDebt: number;
  creditLimit: number;
  availableLimit: number;
  utilizationPercent: number;
  minimumPayment: number;
  minimumPaymentPercent: number;
  minimumPaymentDate: Date | null;
  gracePeriodDate: Date | null;
  graceDaysLeft: number | null;
  interestRate: number;
  riskTone: CreditCardRiskTone;
  riskLabel: string;
  riskHint: string;
};

function isCreditCardLoan(loan: {
  bankName: string;
  paymentFrequency?: string | null;
}) {
  const name = loan.bankName.toLowerCase();

  return name.includes("РєСЂРµРґРёС‚РєР°") || name.includes("РєСЂРµРґРёС‚РЅР°СЏ РєР°СЂС‚Р°");
}

function getDaysLeft(from: Date, to: Date | null | undefined) {
  if (!to) return null;

  return Math.ceil(
    (startOfDay(to).getTime() - startOfDay(from).getTime()) /
      (24 * 60 * 60 * 1000),
  );
}

function formatDaysLeft(value: number | null) {
  if (value === null) return "РЅРµ Р·Р°РґР°РЅРѕ";
  if (value < 0) return `РїСЂРѕСЃСЂРѕС‡РµРЅРѕ ${Math.abs(value)} РґРЅ.`;
  if (value === 0) return "СЃРµРіРѕРґРЅСЏ";

  return `${value} РґРЅ.`;
}

function getCreditCardRiskTone(params: {
  graceDaysLeft: number | null;
  utilizationPercent: number;
  minimumPayment: number;
  minimumPaymentPercent?: number | null;
  minimumPaymentDate: Date | null;
}) {
  if (
    params.minimumPayment <= 0 &&
    !params.minimumPaymentDate &&
    params.graceDaysLeft === null
  ) {
    return "missing" as const;
  }

  if (params.graceDaysLeft !== null && params.graceDaysLeft <= 7) {
    return "high" as const;
  }

  if (params.utilizationPercent >= 80) {
    return "high" as const;
  }

  if (params.graceDaysLeft !== null && params.graceDaysLeft <= 21) {
    return "medium" as const;
  }

  if (params.utilizationPercent >= 55) {
    return "medium" as const;
  }

  return "low" as const;
}

function getCreditCardRiskCopy(tone: CreditCardRiskTone) {
  if (tone === "high") {
    return {
      label: "Р’С‹СЃРѕРєРёР№ СЂРёСЃРє",
      hint: "Р»СЊРіРѕС‚РЅС‹Р№ РїРµСЂРёРѕРґ Р±Р»РёР·РєРѕ РёР»Рё Р»РёРјРёС‚ СЃРёР»СЊРЅРѕ РёСЃРїРѕР»СЊР·РѕРІР°РЅ",
    };
  }

  if (tone === "medium") {
    return {
      label: "РЎСЂРµРґРЅРёР№ СЂРёСЃРє",
      hint: "РґРµСЂР¶Р°С‚СЊ РїРѕРґ РєРѕРЅС‚СЂРѕР»РµРј РјРёРЅРёРјР°Р»СЊРЅС‹Р№ РїР»Р°С‚С‘Р¶ Рё Р»СЊРіРѕС‚РЅС‹Р№ РїРµСЂРёРѕРґ",
    };
  }

  if (tone === "missing") {
    return {
      label: "РќСѓР¶РЅС‹ РґР°РЅРЅС‹Рµ",
      hint: "СѓРєР°Р¶РёС‚Рµ РјРёРЅРёРјР°Р»СЊРЅС‹Р№ РїР»Р°С‚С‘Р¶ Рё СЃСЂРѕРє Р»СЊРіРѕС‚РЅРѕРіРѕ РїРµСЂРёРѕРґР°",
    };
  }

  return {
    label: "РќРёР·РєРёР№ СЂРёСЃРє",
    hint: "Р±Р°Р»Р°РЅСЃ Рё СЃСЂРѕРєРё РІС‹РіР»СЏРґСЏС‚ СЃРїРѕРєРѕР№РЅРѕ",
  };
}

export default async function LoansPage({
  searchParams,
}: {
  searchParams?: Promise<{
    company?: string;
    period?: string;
    repay?: string;
    repayment?: string;
    card?: string;
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
      payment.paymentDate >= selectedMonth &&
      payment.paymentDate <= selectedMonthEnd,
  );

  const next14DaysEnd = addDays(today, 14);

  const next14Payments = allFuturePayments.filter(
    (payment) => payment.paymentDate <= next14DaysEnd,
  );

  const totalDebt = activeLoans.reduce(
    (sum, loan) => sum + toNumber(loan.currentDebt),
    0,
  );

  const selectedMonthPayment = currentMonthPayments.reduce(
    (sum, payment) => sum + getPaymentTotal(payment),
    0,
  );

  const currentMonthPrincipal = currentMonthPayments.reduce(
    (sum, payment) => sum + getPaymentPrincipal(payment),
    0,
  );

  const currentMonthInterest = currentMonthPayments.reduce(
    (sum, payment) => sum + getPaymentInterest(payment),
    0,
  );

  const monthlyPaymentFromLoans = activeLoans.reduce(
    (sum, loan) => sum + toNumber(loan.monthlyPayment),
    0,
  );

  const paymentInMonth =
    selectedMonthPayment > 0 ? selectedMonthPayment : monthlyPaymentFromLoans;

  const next14Amount = next14Payments.reduce(
    (sum, payment) => sum + getPaymentTotal(payment),
    0,
  );

  const totalPrincipalUntilYearEnd = paymentsUntilYearEnd.reduce(
    (sum, payment) => sum + getPaymentPrincipal(payment),
    0,
  );

  const totalInterestUntilYearEnd = paymentsUntilYearEnd.reduce(
    (sum, payment) => sum + getPaymentInterest(payment),
    0,
  );

  const totalPaymentsUntilYearEnd =
    totalPrincipalUntilYearEnd + totalInterestUntilYearEnd;

  const loanRows = activeLoans.map((loan) => {
    const futurePayments = loan.payments.filter(
      (payment) => payment.paymentDate >= today && !payment.paid,
    );

    const monthPayments = loan.payments.filter(
      (payment) =>
        payment.paymentDate >= selectedMonth &&
        payment.paymentDate <= selectedMonthEnd &&
        !payment.paid,
    );

    const nextPayment = futurePayments[0] ?? null;

    const monthlyPaymentBySchedule = monthPayments.reduce(
      (sum, payment) => sum + getPaymentTotal(payment),
      0,
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

    const nextPaymentPrincipal = nextPayment
      ? getPaymentPrincipal(nextPayment)
      : 0;
    const nextPaymentInterest = nextPayment
      ? getPaymentInterest(nextPayment)
      : 0;
    const nextPaymentTotal = nextPayment
      ? getPaymentTotal(nextPayment)
      : monthlyPayment;

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

  const creditCardRows: CreditCardView[] = loanRows
    .filter((loan) => isCreditCardLoan(loan))
    .map((loan) => {
      const availableLimit = Math.max(0, loan.creditLimit - loan.currentDebt);
      const utilizationPercent = getSafeRatio(
        loan.currentDebt,
        loan.creditLimit,
      );
      const minimumPayment = loan.nextPaymentTotal || loan.monthlyPayment;
      const minimumPaymentPercent = getSafeRatio(
        minimumPayment,
        loan.currentDebt,
      );
      const minimumPaymentDate = loan.nextPaymentDate;
      const gracePeriodDate = loan.endDate ?? loan.nextPaymentDate ?? null;
      const graceDaysLeft = getDaysLeft(today, gracePeriodDate);
      const riskTone = getCreditCardRiskTone({
        graceDaysLeft,
        utilizationPercent,
        minimumPayment,
        minimumPaymentPercent,
        minimumPaymentDate,
      });
      const riskCopy = getCreditCardRiskCopy(riskTone);

      return {
        id: loan.id,
        displayName: loan.displayName,
        companyName: loan.companyName,
        contractNumber: loan.contractNumber,
        currentDebt: loan.currentDebt,
        creditLimit: loan.creditLimit,
        availableLimit,
        utilizationPercent,
        minimumPayment,
        minimumPaymentPercent,
        minimumPaymentDate,
        gracePeriodDate,
        graceDaysLeft,
        interestRate: loan.interestRate,
        riskTone,
        riskLabel: riskCopy.label,
        riskHint: riskCopy.hint,
      };
    })
    .sort((a, b) => {
      const riskOrder = { high: 0, medium: 1, missing: 2, low: 3 };
      return (
        riskOrder[a.riskTone] - riskOrder[b.riskTone] ||
        b.utilizationPercent - a.utilizationPercent ||
        b.currentDebt - a.currentDebt
      );
    });

  const creditCardsTotalDebt = creditCardRows.reduce(
    (sum, card) => sum + card.currentDebt,
    0,
  );
  const creditCardsMinimumPayment = creditCardRows.reduce(
    (sum, card) => sum + card.minimumPayment,
    0,
  );
  const creditCardsHighRiskCount = creditCardRows.filter(
    (card) => card.riskTone === "high",
  ).length;

  const loansByMonthlyBurden = [...loanRows].sort(
    (a, b) => b.monthlyPayment - a.monthlyPayment,
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
    (a, b) => a.currentDebt - b.currentDebt,
  );

  const nextPayments = allFuturePayments.slice(0, 4);

  const nextPayment = allFuturePayments[0] ?? null;
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

    const current = monthlyMap.get(key) ?? {
      monthDate: new Date(
        payment.paymentDate.getFullYear(),
        payment.paymentDate.getMonth(),
        1,
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

  const peakMonth = paymentSchedule.reduce<{
    monthDate: Date;
    totalAmount: number;
    principalAmount: number;
    interestAmount: number;
    loansCountNumber: number;
    paymentsCount: number;
  } | null>((current, row) => {
    if (!current || row.totalAmount > current.totalAmount) return row;
    return current;
  }, null);

  const activeLoanIdsCount = new Set(activeLoanIds).size;

  const selectedRepaymentLoan = params.repay
    ? (loanRows.find(
        (loan) => loan.id === params.repay && !isCreditCardLoan(loan),
      ) ?? null)
    : null;

  const selectedCreditCard = params.card
    ? (creditCardRows.find((card) => card.id === params.card) ?? null)
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
    ? selectedRepaymentLoan.calculatedAnnualRate ||
      selectedRepaymentLoan.interestRate
    : 0;
  const selectedRepaymentNextDateInput = selectedRepaymentLoan?.nextPaymentDate
    ? formatDateInput(selectedRepaymentLoan.nextPaymentDate)
    : formatDateInput(addDays(today, 1));
  const selectedRepaymentEndDateInput = selectedRepaymentLoan?.endDate
    ? formatDateInput(selectedRepaymentLoan.endDate)
    : selectedRepaymentNextDateInput;
  const selectedRepaymentRegularPayment = selectedRepaymentLoan
    ? selectedRepaymentLoan.nextPaymentTotal ||
      selectedRepaymentLoan.monthlyPayment
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
    0,
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
            label: `Р”СЂСѓРіРёРµ РєСЂРµРґРёС‚С‹ (${Math.max(
              0,
              activeLoanIdsCount - debtLoadTopLoans.length,
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
      (segment.percent / 100) * debtLoadCircumference,
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
  const monthlyMatrixPeakKey = monthlyMatrix.reduce<string | null>(
    (currentKey, row) => {
      if (!currentKey) return monthKey(row.monthDate);

      const current = monthlyMatrix.find(
        (item) => monthKey(item.monthDate) === currentKey,
      );

      return !current || row.totalAmount > current.totalAmount
        ? monthKey(row.monthDate)
        : currentKey;
    },
    null,
  );

  return (
    <main className="min-h-screen bg-[#f5f7fb] px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1600px] space-y-5">
        <section className="rounded-[24px] border border-slate-200 bg-white/90 p-4 shadow-sm shadow-slate-200/70 backdrop-blur">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <h1 className="text-2xl font-black tracking-tight text-slate-950">
                РљСЂРµРґРёС‚С‹ Рё Р·Р°Р№РјС‹
              </h1>

              <p className="mt-1.5 max-w-3xl text-sm font-medium leading-5 text-slate-500">
                РџРѕР»РЅР°СЏ РєР°СЂС‚РёРЅР° РґРѕР»РіРѕРІРѕР№ РЅР°РіСЂСѓР·РєРё: Р±Р»РёР¶Р°Р№С€РёРµ РїР»Р°С‚РµР¶Рё, РїСЂРѕС†РµРЅС‚С‹,
                СЂРёСЃРєРё Рё СЂРµРєРѕРјРµРЅРґР°С†РёРё РїРѕ РґРѕСЃСЂРѕС‡РЅРѕРјСѓ РїРѕРіР°С€РµРЅРёСЋ.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/finance/cashflow"
                className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
              >
                РћР”Р”РЎ
              </Link>

              <Link
                href="/finance/calendar"
                className="rounded-2xl bg-slate-950 px-4 py-2 text-sm font-black text-white shadow-sm shadow-slate-300 transition hover:bg-slate-800"
              >
                РџР»Р°С‚С‘Р¶РЅС‹Р№ РєР°Р»РµРЅРґР°СЂСЊ
              </Link>

              <Link
                href="/finance/accounts"
                className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50"
              >
                РЎС‡РµС‚Р°
              </Link>
            </div>
          </div>

          <form className="mt-4 flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
            <div className="grid flex-1 gap-3 md:grid-cols-3">
              <label className="block">
                <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                  РљРѕРјРїР°РЅРёСЏ
                </span>

                <select
                  name="company"
                  defaultValue={params.company ?? "ALL"}
                  className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 shadow-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                >
                  <option value="ALL">Р’СЃРµ РєРѕРјРїР°РЅРёРё</option>

                  {companies.map((company) => (
                    <option key={company.id} value={company.name}>
                      {company.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                  РџРµСЂРёРѕРґ
                </span>

                <input
                  type="month"
                  name="period"
                  defaultValue={selectedMonthValue}
                  className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 shadow-sm outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                />
              </label>

              <label className="block">
                <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                  РћР±РЅРѕРІР»РµРЅРѕ
                </span>

                <div className="flex h-11 w-full items-center rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm font-black text-slate-900 shadow-sm">
                  {formatDate(now)},{" "}
                  {now.toLocaleTimeString("ru-RU", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
              </label>
            </div>

            <div className="flex flex-wrap gap-3">
              <button className="h-11 rounded-2xl bg-slate-950 px-6 text-sm font-black text-white shadow-sm shadow-slate-300 transition hover:bg-slate-800">
                РџСЂРёРјРµРЅРёС‚СЊ
              </button>

              <a
                href="#all-loans"
                className="inline-flex h-11 items-center justify-center rounded-2xl border border-slate-200 bg-white px-6 text-sm font-black text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                Р’СЃРµ РєСЂРµРґРёС‚С‹
              </a>
            </div>
          </form>
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
          <MetricCard
            label="РћР±С‰РёР№ РґРѕР»Рі"
            value={formatMoney(totalDebt)}
            hint={`${activeLoanIdsCount} Р°РєС‚РёРІРЅС‹С… РєСЂРµРґРёС‚РѕРІ`}
            accent="red"
            icon="в‚Ѕ"
          />

          <MetricCard
            label="Р РµР·РµСЂРІ 14 РґРЅРµР№"
            value={formatMoney(next14Amount)}
            hint={`${next14Payments.length} РїР»Р°С‚РµР¶РµР№ РІ Р±Р»РёР¶Р°Р№С€РёРµ 14 РґРЅРµР№`}
            accent="blue"
            icon="14"
          />

          <MetricCard
            label="РџР»Р°С‚С‘Р¶ РІ С‚РµРєСѓС‰РµРј РјРµСЃСЏС†Рµ"
            value={formatMoney(paymentInMonth)}
            hint={`С‚РµР»Рѕ ${formatMoney(currentMonthPrincipal)} В· РїСЂРѕС†РµРЅС‚С‹ ${formatMoney(
              currentMonthInterest,
            )}`}
            accent="orange"
            icon="в†—"
          />

          <MetricCard
            label="Р‘Р»РёР¶Р°Р№С€РёР№ РїР»Р°С‚С‘Р¶"
            value={
              nextPayment ? formatMoney(getPaymentTotal(nextPayment)) : "вЂ”"
            }
            hint={
              nextPayment
                ? `${formatDate(nextPayment.paymentDate)} В· ${getLoanDisplayName(
                    nextPayment.loan,
                  )}`
                : "РїР»Р°С‚РµР¶РµР№ РЅРµС‚"
            }
            accent="indigo"
            icon="вЏ±"
          />

          <MetricCard
            label="РџСЂРѕС†РµРЅС‚С‹ РґРѕ РєРѕРЅС†Р° РіРѕРґР°"
            value={formatMoney(totalInterestUntilYearEnd)}
            hint={`${getSafeRatio(
              totalInterestUntilYearEnd,
              totalPaymentsUntilYearEnd,
            ).toFixed(1)}% РѕС‚ РІС‹РїР»Р°С‚`}
            accent="amber"
            icon="%"
          />

          <MetricCard
            label="РђРєС‚РёРІРЅС‹С… РѕР±СЏР·Р°С‚РµР»СЊСЃС‚РІ"
            value={String(activeLoanIdsCount)}
            hint={`${activeLoanIdsCount} РёР· ${activeLoanIdsCount} Р°РєС‚РёРІРЅС‹С…`}
            accent="green"
            icon="вњ“"
          />
        </section>

        <section className="grid gap-5 xl:grid-cols-[0.72fr_1.28fr]">
          <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/70">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-black text-slate-950">
                  РљР°СЂС‚Р° РґРѕР»РіРѕРІРѕР№ РЅР°РіСЂСѓР·РєРё
                </h2>
                <p className="mt-1 text-sm font-medium text-slate-500">
                  Р”РѕР»СЏ РєСЂРµРґРёС‚РѕРІ РІ РµР¶РµРјРµСЃСЏС‡РЅРѕРј РїР»Р°С‚РµР¶Рµ.
                </p>
              </div>

              <span className="rounded-full bg-slate-50 px-3 py-1 text-xs font-black text-slate-500 ring-1 ring-slate-100">
                {activeLoanIdsCount} Р°РєС‚РёРІРЅС‹С…
              </span>
            </div>

            <div className="mt-5 grid gap-5 md:grid-cols-[190px_1fr] md:items-center xl:grid-cols-1 2xl:grid-cols-[190px_1fr]">
              <div className="relative mx-auto h-[180px] w-[180px]">
                <svg
                  viewBox="0 0 180 180"
                  className="relative z-20 h-full w-full overflow-visible"
                  role="img"
                  aria-label="РљР°СЂС‚Р° РґРѕР»РіРѕРІРѕР№ РЅР°РіСЂСѓР·РєРё РїРѕ РєСЂРµРґРёС‚Р°Рј"
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
                            <span>РџР»Р°С‚С‘Р¶</span>
                            <span className="text-right text-slate-950">
                              {formatMoney(segment.amount)}
                            </span>
                            <span>РќР°РіСЂСѓР·РєР°</span>
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
                      РІ РјРµСЃСЏС†
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
                    РђРєС‚РёРІРЅС‹С… РєСЂРµРґРёС‚РѕРІ РїРѕРєР° РЅРµС‚.
                  </div>
                )}
              </div>
            </div>

            <a
              href="#all-loans"
              className="mt-5 inline-flex text-sm font-black text-indigo-600 hover:text-indigo-500"
            >
              РџРѕРґСЂРѕР±РЅРµРµ Рѕ РЅР°РіСЂСѓР·РєРµ в†’
            </a>
          </section>

          <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/70 ring-1 ring-slate-100">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-black text-slate-950">
                  РџР»Р°РЅ РїР»Р°С‚РµР¶РµР№ РїРѕ РјРµСЃСЏС†Р°Рј
                </h2>
                <p className="mt-1 text-sm font-medium text-slate-500">
                  РњР°С‚СЂРёС†Р° С‚РµР»Р°, РїСЂРѕС†РµРЅС‚РѕРІ Рё РѕР±С‰РµР№ РЅР°РіСЂСѓР·РєРё.
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                {peakMonth ? (
                  <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-black text-orange-700 ring-1 ring-orange-100">
                    РџРёРє: {formatShortMonthLabel(peakMonth.monthDate)} В·{" "}
                    {formatMoney(peakMonth.totalAmount)}
                  </span>
                ) : null}
                <span className="rounded-full bg-slate-950 px-3 py-1 text-xs font-black text-white">
                  РўР°Р±Р»РёС†Р°
                </span>
              </div>
            </div>

            <div className="mt-5 overflow-x-auto rounded-[22px] border border-slate-100 bg-slate-50/70 p-2">
              <table className="w-full min-w-[760px] border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="text-left text-xs font-black uppercase tracking-[0.08em] text-slate-500">
                    <th className="rounded-l-2xl bg-white px-4 py-3 shadow-sm">
                      РњРµСЃСЏС†
                    </th>
                    {monthlyMatrix.map((row, index) => {
                      const isPeak =
                        monthlyMatrixPeakKey === monthKey(row.monthDate);

                      return (
                        <th
                          key={row.monthDate.toISOString()}
                          className={`whitespace-nowrap px-4 py-3 text-right shadow-sm ${
                            isPeak
                              ? "bg-orange-50 text-orange-700 ring-1 ring-orange-100"
                              : "bg-white text-slate-500"
                          } ${
                            index === monthlyMatrix.length - 1
                              ? "rounded-r-2xl"
                              : ""
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
                    <td className="border-b border-slate-100 bg-white px-4 py-3 font-bold text-slate-600">
                      РћСЃРЅРѕРІРЅРѕР№ РґРѕР»Рі
                    </td>
                    {monthlyMatrix.map((row) => {
                      const isPeak =
                        monthlyMatrixPeakKey === monthKey(row.monthDate);

                      return (
                        <td
                          key={`principal-${row.monthDate.toISOString()}`}
                          className={`border-b border-slate-100 px-4 py-3 text-right font-black ${
                            isPeak
                              ? "bg-orange-50/50 text-slate-950"
                              : "bg-white text-slate-900"
                          }`}
                        >
                          {formatMoney(row.principalAmount)}
                        </td>
                      );
                    })}
                  </tr>

                  <tr>
                    <td className="border-b border-slate-100 bg-white px-4 py-3 font-bold text-slate-600">
                      РџСЂРѕС†РµРЅС‚С‹
                    </td>
                    {monthlyMatrix.map((row) => {
                      const isPeak =
                        monthlyMatrixPeakKey === monthKey(row.monthDate);

                      return (
                        <td
                          key={`interest-${row.monthDate.toISOString()}`}
                          className={`border-b border-slate-100 px-4 py-3 text-right font-black ${
                            isPeak
                              ? "bg-orange-50/50 text-orange-700"
                              : "bg-white text-orange-600"
                          }`}
                        >
                          {formatMoney(row.interestAmount)}
                        </td>
                      );
                    })}
                  </tr>

                  <tr>
                    <td className="rounded-l-2xl bg-slate-100 px-4 py-4 font-black text-slate-950">
                      Р’СЃРµРіРѕ РїР»Р°С‚РµР¶РµР№
                    </td>
                    {monthlyMatrix.map((row, index) => {
                      const isPeak =
                        monthlyMatrixPeakKey === monthKey(row.monthDate);

                      return (
                        <td
                          key={`total-${row.monthDate.toISOString()}`}
                          className={`px-4 py-4 text-right text-base font-black ${
                            isPeak
                              ? "bg-orange-100 text-orange-700 ring-1 ring-orange-200"
                              : "bg-slate-100 text-red-600"
                          } ${
                            index === monthlyMatrix.length - 1
                              ? "rounded-r-2xl"
                              : ""
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
                        РџР»Р°С‚РµР¶РµР№ РїРѕРєР° РЅРµС‚.
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
                РџРѕРєР°Р·Р°С‚СЊ РїРѕР»РЅС‹Р№ РіСЂР°С„РёРє в†’
              </Link>

              <div className="flex items-center gap-3 text-sm font-bold text-slate-600">
                <span>РџРѕРєР°Р·С‹РІР°С‚СЊ РїР»Р°РЅ РґРѕ РїРѕРіР°С€РµРЅРёСЏ</span>
                <span className="relative inline-flex h-6 w-11 items-center rounded-full bg-slate-950">
                  <span className="ml-auto mr-1 h-4 w-4 rounded-full bg-white" />
                </span>
              </div>
            </div>
          </section>
        </section>

        <section className="grid gap-5 xl:grid-cols-[1.28fr_1fr]">
          <section
            id="recommendations"
            className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/70"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-xl font-black text-slate-950">
                  Р РµРєРѕРјРµРЅРґР°С†РёРё РїРѕ РґРѕСЃСЂРѕС‡РЅРѕРјСѓ РїРѕРіР°С€РµРЅРёСЋ
                </h2>
                <p className="mt-1 text-sm font-medium text-slate-500">
                  РўСЂРё СЃС‚СЂР°С‚РµРіРёРё: СЃРЅРёР·РёС‚СЊ РїР»Р°С‚С‘Р¶, СѓРјРµРЅСЊС€РёС‚СЊ РїСЂРѕС†РµРЅС‚С‹ РёР»Рё Р±С‹СЃС‚СЂРѕ
                  Р·Р°РєСЂС‹С‚СЊ РјРµР»РєРёРµ РєСЂРµРґРёС‚С‹.
                </p>
              </div>

              <span className="shrink-0 rounded-full bg-indigo-50 px-3 py-1 text-xs font-black text-indigo-700 ring-1 ring-indigo-100">
                Р РµРєРѕРјРµРЅРґСѓРµРјС‹Р№ РІР°СЂРёР°РЅС‚
              </span>
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-3">
              <RecommendationCard
                number="1"
                tone="green"
                title="РЎРЅРёР·РёС‚СЊ РµР¶РµРјРµСЃСЏС‡РЅС‹Р№ РїР»Р°С‚С‘Р¶"
                description="Р“Р°СЃРёС‚Рµ РєСЂРµРґРёС‚С‹ СЃ СЃР°РјС‹Рј Р±РѕР»СЊС€РёРј РїР»Р°С‚РµР¶РѕРј РІ РјРµСЃСЏС†."
                headers={["РљСЂРµРґРёС‚", "РџР»Р°С‚С‘Р¶ РІ РјРµСЃ.", "РџРѕС‚РµРЅС†РёР°Р»"]}
                rows={loansByMonthlyBurden
                  .slice(0, 3)
                  .map((loan) => [
                    loan.displayName,
                    formatMoney(loan.monthlyPayment),
                    `в€’${formatMoney(loan.monthlyPayment)}`,
                  ])}
                action="РџРѕРєР°Р·Р°С‚СЊ РІР°СЂРёР°РЅС‚С‹"
              />

              <RecommendationCard
                number="2"
                tone="blue"
                title="РЎРЅРёР·РёС‚СЊ РїРµСЂРµРїР»Р°С‚Сѓ РїРѕ РїСЂРѕС†РµРЅС‚Р°Рј"
                description="РќР°С‡РёРЅР°Р№С‚Рµ СЃ РєСЂРµРґРёС‚РѕРІ СЃ РІС‹СЃРѕРєРѕР№ СЃС‚Р°РІРєРѕР№ Рё РїСЂРѕС†РµРЅС‚Р°РјРё."
                headers={["РљСЂРµРґРёС‚", "РЎС‚Р°РІРєР°", "РџСЂРѕС†РµРЅС‚С‹"]}
                rows={loansByRate.slice(0, 3).map((loan) => [
                  loan.displayName,
                  formatRateLabel({
                    rate: loan.calculatedAnnualRate,
                    source: loan.rateSource,
                  }),
                  formatMoney(loan.interestUntilYearEnd),
                ])}
                action="Р Р°СЃСЃС‡РёС‚Р°С‚СЊ РїРѕРіР°С€РµРЅРёРµ"
              />

              <RecommendationCard
                number="3"
                tone="purple"
                title="Р‘С‹СЃС‚СЂРѕ Р·Р°РєСЂС‹С‚СЊ РјРµР»РєРёРµ РєСЂРµРґРёС‚С‹"
                description="Р—Р°РєСЂС‹РІР°Р№С‚Рµ РЅРµР±РѕР»СЊС€РёРµ РґРѕР»РіРё, С‡С‚РѕР±С‹ СЃРЅРёР·РёС‚СЊ С‡РёСЃР»Рѕ РѕР±СЏР·Р°С‚РµР»СЊСЃС‚РІ."
                headers={["РљСЂРµРґРёС‚", "Р”РѕР»Рі", "РџР»Р°С‚С‘Р¶ РІ РјРµСЃ."]}
                rows={loansBySmallDebt
                  .slice(0, 3)
                  .map((loan) => [
                    loan.displayName,
                    formatMoney(loan.currentDebt),
                    formatMoney(loan.monthlyPayment),
                  ])}
                action="Р—Р°РєСЂС‹С‚СЊ РјРµР»РєРёРµ РєСЂРµРґРёС‚С‹"
              />
            </div>

            {creditCardRows.length > 0 ? (
              <div className="mt-4 rounded-[22px] border border-orange-100 bg-orange-50/70 p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className="text-sm font-black text-orange-900">
                      Р РёСЃРє РїРѕ РєСЂРµРґРёС‚РЅС‹Рј РєР°СЂС‚Р°Рј
                    </div>
                    <p className="mt-1 text-xs font-bold leading-5 text-orange-800/80">
                      РњРёРЅРёРјР°Р»СЊРЅС‹Рµ РїР»Р°С‚РµР¶Рё, Р»СЊРіРѕС‚РЅС‹Рµ РїРµСЂРёРѕРґС‹ Рё РёСЃРїРѕР»СЊР·РѕРІР°РЅРёРµ
                      Р»РёРјРёС‚Р° РєРѕРЅС‚СЂРѕР»РёСЂСѓРµРј РѕС‚РґРµР»СЊРЅРѕ РѕС‚ РѕР±С‹С‡РЅС‹С… РєСЂРµРґРёС‚РѕРІ.
                    </p>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-3 lg:min-w-[520px]">
                    <div className="rounded-2xl bg-white px-3 py-2 ring-1 ring-orange-100">
                      <div className="text-[10px] font-black uppercase tracking-[0.08em] text-slate-400">
                        Р”РѕР»Рі РїРѕ РєР°СЂС‚Р°Рј
                      </div>
                      <div className="mt-1 text-sm font-black text-slate-950">
                        {formatMoney(creditCardsTotalDebt)}
                      </div>
                    </div>

                    <div className="rounded-2xl bg-white px-3 py-2 ring-1 ring-orange-100">
                      <div className="text-[10px] font-black uppercase tracking-[0.08em] text-slate-400">
                        РњРёРЅ. РїР»Р°С‚РµР¶Рё
                      </div>
                      <div className="mt-1 text-sm font-black text-orange-700">
                        {formatMoney(creditCardsMinimumPayment)}
                      </div>
                    </div>

                    <div className="rounded-2xl bg-white px-3 py-2 ring-1 ring-orange-100">
                      <div className="text-[10px] font-black uppercase tracking-[0.08em] text-slate-400">
                        Р’С‹СЃРѕРєРёР№ СЂРёСЃРє
                      </div>
                      <div className="mt-1 text-sm font-black text-red-600">
                        {creditCardsHighRiskCount} РєР°СЂС‚
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </section>

          <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/70">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-black text-slate-950">
                  Р‘Р»РёР¶Р°Р№С€РёРµ РїР»Р°С‚РµР¶Рё
                </h2>
                <p className="mt-1 text-sm font-medium text-slate-500">
                  РЎР»РµРґСѓСЋС‰РёРµ СЃРїРёСЃР°РЅРёСЏ РїРѕ РіСЂР°С„РёРєСѓ.
                </p>
              </div>

              <Link
                href="/finance/calendar"
                className="text-sm font-black text-indigo-600 hover:text-indigo-500"
              >
                РљР°Р»РµРЅРґР°СЂСЊ
              </Link>
            </div>

            <div className="mt-4 overflow-hidden rounded-2xl border border-slate-100">
              <div className="hidden grid-cols-[64px_1fr_96px_90px_96px] gap-3 bg-slate-50 px-4 py-3 text-[11px] font-black uppercase tracking-[0.08em] text-slate-400 lg:grid">
                <div>Р”Р°С‚Р°</div>
                <div>РљСЂРµРґРёС‚</div>
                <div className="text-right">РўРµР»Рѕ</div>
                <div className="text-right">РџСЂРѕС†РµРЅС‚С‹</div>
                <div className="text-right">Р’СЃРµРіРѕ</div>
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
                          РўРµР»Рѕ {formatMoney(getPaymentPrincipal(payment))} В·
                          РїСЂРѕС†РµРЅС‚С‹ {formatMoney(getPaymentInterest(payment))}
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
                    Р‘Р»РёР¶Р°Р№С€РёС… РїР»Р°С‚РµР¶РµР№ РїРѕРєР° РЅРµС‚.
                  </div>
                )}
              </div>
            </div>

            <Link
              href="/finance/calendar"
              className="mt-4 inline-flex text-sm font-black text-indigo-600 hover:text-indigo-500"
            >
              РЎРјРѕС‚СЂРµС‚СЊ РІСЃРµ РїР»Р°С‚РµР¶Рё в†’
            </Link>
          </section>
        </section>

        {creditCardRows.length > 0 ? (
          <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/70">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex items-center gap-3">
                  <h2 className="text-xl font-black text-slate-950">
                    РљСЂРµРґРёС‚РЅС‹Рµ РєР°СЂС‚С‹
                  </h2>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-600">
                    {creditCardRows.length} РєР°СЂС‚
                  </span>
                </div>
                <p className="mt-1 text-sm font-medium text-slate-500">
                  Р›СЊРіРѕС‚РЅС‹Р№ РїРµСЂРёРѕРґ, РјРёРЅРёРјР°Р»СЊРЅС‹Р№ РїР»Р°С‚С‘Р¶, РёСЃРїРѕР»СЊР·РѕРІР°РЅРёРµ Р»РёРјРёС‚Р° Рё
                  СЂРёСЃРє РїРѕ РєР°Р¶РґРѕР№ РєР°СЂС‚Рµ.
                </p>
              </div>

              <a
                href="#all-loans"
                className="text-sm font-black text-indigo-600 hover:text-indigo-500"
              >
                Р’СЃРµ РєР°СЂС‚С‹ в†’
              </a>
            </div>

            <div className="mt-4 grid gap-4 xl:grid-cols-3">
              {creditCardRows.slice(0, 3).map((card) => (
                <CreditCardPanel
                  key={card.id}
                  card={card}
                  editHref={buildCreditCardEditHref(
                    companyName,
                    selectedMonthValue,
                    card.id,
                  )}
                />
              ))}
            </div>
          </section>
        ) : null}

        {selectedCreditCard ? (
          <CreditCardEditForm
            card={selectedCreditCard}
            companyName={companyName}
            selectedMonthValue={selectedMonthValue}
          />
        ) : null}

        {selectedRepaymentLoan ? (
          <section
            id="early-repayment"
            className="rounded-[28px] border border-indigo-100 bg-white p-6 shadow-sm shadow-indigo-100/70 ring-1 ring-indigo-50"
          >
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <div className="inline-flex rounded-full bg-indigo-50 px-3 py-1 text-xs font-black uppercase tracking-[0.08em] text-indigo-700 ring-1 ring-indigo-100">
                  Р”РѕСЃСЂРѕС‡РЅРѕРµ РїРѕРіР°С€РµРЅРёРµ
                </div>

                <h2 className="mt-3 text-2xl font-black text-slate-950">
                  РџРѕРіР°СЃРёС‚СЊ {selectedRepaymentLoan.displayName}
                </h2>

                <p className="mt-2 max-w-4xl text-sm font-medium leading-6 text-slate-500">
                  РЎРёСЃС‚РµРјР° СЃРѕР·РґР°СЃС‚ С„РёРЅР°РЅСЃРѕРІС‹Рµ РѕРїРµСЂР°С†РёРё: С‚РµР»Рѕ РєСЂРµРґРёС‚Р° РѕС‚РґРµР»СЊРЅРѕ РѕС‚
                  РїСЂРѕС†РµРЅС‚РѕРІ. РўРµР»Рѕ СѓРјРµРЅСЊС€РёС‚ РґРѕР»Рі Рё РЅРµ РёСЃРїРѕСЂС‚РёС‚ РїСЂРёР±С‹Р»СЊ, РїСЂРѕС†РµРЅС‚С‹
                  РїРѕРїР°РґСѓС‚ РІ С„РёРЅР°РЅСЃРѕРІС‹Рµ СЂР°СЃС…РѕРґС‹.
                </p>
              </div>

              <Link
                href={buildFinanceHref(companyName, selectedMonthValue)}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                РћС‚РјРµРЅРёС‚СЊ
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
                      РўРµРєСѓС‰РёР№ РґРѕР»Рі
                    </div>
                    <div className="mt-2 text-xl font-black text-slate-950">
                      {formatMoney(selectedRepaymentLoan.currentDebt)}
                    </div>
                  </div>

                  <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-100">
                    <div className="text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                      РЎР»РµРґСѓСЋС‰РёР№ РїР»Р°С‚С‘Р¶
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
                      РўРµР»Рѕ Р±Р»РёР¶Р°Р№С€РµРіРѕ РїР»Р°С‚РµР¶Р°
                    </div>
                    <div className="mt-2 text-lg font-black text-slate-950">
                      {formatMoney(selectedRepaymentLoan.nextPaymentPrincipal)}
                    </div>
                  </div>

                  <div className="rounded-2xl bg-white p-4 ring-1 ring-slate-100">
                    <div className="text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                      РџСЂРѕС†РµРЅС‚С‹ Р±Р»РёР¶Р°Р№С€РµРіРѕ РїР»Р°С‚РµР¶Р°
                    </div>
                    <div className="mt-2 text-lg font-black text-orange-600">
                      {formatMoney(selectedRepaymentLoan.nextPaymentInterest)}
                    </div>
                  </div>
                </div>

                <div className="mt-4 space-y-3">
                  <div className="rounded-2xl bg-emerald-50 p-4 text-sm font-bold leading-6 text-emerald-800 ring-1 ring-emerald-100">
                    РџСЂРё РїРѕР»РЅРѕРј РїРѕРіР°С€РµРЅРёРё Р±СѓРґСѓС‰РёРµ РїР»Р°С‚РµР¶Рё РїРѕ СЌС‚РѕРјСѓ РєСЂРµРґРёС‚Сѓ Р±СѓРґСѓС‚
                    РїРѕРјРµС‡РµРЅС‹ РєР°Рє Р·Р°РєСЂС‹С‚С‹Рµ, Р±СѓРґСѓС‰РёРµ РїР»Р°РЅРѕРІС‹Рµ РѕРїРµСЂР°С†РёРё Р±СѓРґСѓС‚
                    СѓРґР°Р»РµРЅС‹, Р° С‚РµРєСѓС‰РёР№ РґРѕР»Рі СЃС‚Р°РЅРµС‚ 0 в‚Ѕ.
                  </div>

                  <div className="rounded-2xl bg-amber-50 p-4 text-sm font-bold leading-6 text-amber-900 ring-1 ring-amber-100">
                    РџСЂРё С‡Р°СЃС‚РёС‡РЅРѕРј РїРѕРіР°С€РµРЅРёРё СЃРёСЃС‚РµРјР° Р·Р°РєСЂРѕРµС‚ СЃС‚Р°СЂС‹Р№ Р±СѓРґСѓС‰РёР№
                    РіСЂР°С„РёРє Рё СЃРѕР·РґР°СЃС‚ РЅРѕРІС‹Р№: СЃ РЅРѕРІС‹Рј С‚РµР»РѕРј, РїСЂРѕС†РµРЅС‚Р°РјРё, РґР°С‚Р°РјРё
                    РїР»Р°С‚РµР¶РµР№ Рё РЅРѕРІРѕР№ РґРѕР»РіРѕРІРѕР№ РЅР°РіСЂСѓР·РєРѕР№.
                  </div>
                </div>
              </div>

              <form
                action="/api/finance/loans/early-repayment"
                method="POST"
                className="rounded-[24px] border border-slate-100 bg-white p-5 shadow-sm"
              >
                <input
                  type="hidden"
                  name="loanId"
                  value={selectedRepaymentLoan.id}
                />
                <input
                  type="hidden"
                  name="returnCompany"
                  value={companyName ?? "ALL"}
                />
                <input
                  type="hidden"
                  name="returnPeriod"
                  value={selectedMonthValue}
                />

                <div className="grid gap-4 md:grid-cols-2">
                  <label className="block">
                    <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                      РўРёРї РїРѕРіР°С€РµРЅРёСЏ
                    </span>
                    <select
                      name="repaymentMode"
                      defaultValue="FULL"
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                    >
                      <option value="FULL">РџРѕР»РЅРѕРµ РїРѕРіР°С€РµРЅРёРµ</option>
                      <option value="PARTIAL">Р§Р°СЃС‚РёС‡РЅРѕРµ РїРѕРіР°С€РµРЅРёРµ</option>
                    </select>
                  </label>

                  <label className="block">
                    <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                      Р”Р°С‚Р° РѕРїРµСЂР°С†РёРё
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
                      РўРµР»Рѕ РєСЂРµРґРёС‚Р°
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
                      РџСЂРѕС†РµРЅС‚С‹
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
                          РќРѕРІС‹Р№ РіСЂР°С„РёРє РґР»СЏ С‡Р°СЃС‚РёС‡РЅРѕРіРѕ РїРѕРіР°С€РµРЅРёСЏ
                        </div>
                        <p className="mt-1 text-sm font-bold leading-6 text-slate-600">
                          Р—Р°РїРѕР»РЅСЏРµС‚СЃСЏ С‚РѕР»СЊРєРѕ РїСЂРё РІС‹Р±РѕСЂРµ вЂњР§Р°СЃС‚РёС‡РЅРѕРµ РїРѕРіР°С€РµРЅРёРµвЂќ.
                          РЎРёСЃС‚РµРјР° Р·Р°РєСЂРѕРµС‚ СЃС‚Р°СЂС‹Рµ Р±СѓРґСѓС‰РёРµ РїР»Р°С‚РµР¶Рё Рё СЃРѕР·РґР°СЃС‚ РЅРѕРІС‹Р№
                          РіСЂР°С„РёРє РїРѕ СЌС‚РёРј РЅР°СЃС‚СЂРѕР№РєР°Рј.
                        </p>
                      </div>
                      <span className="rounded-full bg-white px-3 py-1 text-xs font-black text-indigo-700 ring-1 ring-indigo-100">
                        РџРµСЂРµСЃС‡С‘С‚
                      </span>
                    </div>

                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                      <label className="block">
                        <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                          РљР°Рє РїРµСЂРµСЃС‡РёС‚Р°С‚СЊ
                        </span>
                        <select
                          name="scheduleStrategy"
                          defaultValue="REDUCE_PAYMENT"
                          className="h-11 w-full rounded-2xl border border-indigo-100 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                        >
                          <option value="REDUCE_PAYMENT">
                            РЈРјРµРЅСЊС€РёС‚СЊ РїР»Р°С‚С‘Р¶, СЃСЂРѕРє РѕСЃС‚Р°РІРёС‚СЊ
                          </option>
                          <option value="SHORTEN_TERM">
                            РџР»Р°С‚С‘Р¶ РѕСЃС‚Р°РІРёС‚СЊ, СЃРѕРєСЂР°С‚РёС‚СЊ СЃСЂРѕРє
                          </option>
                        </select>
                      </label>

                      <label className="block">
                        <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                          РџРµСЂРІС‹Р№ РїР»Р°С‚С‘Р¶ РЅРѕРІРѕРіРѕ РіСЂР°С„РёРєР°
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
                          РЎС‚Р°РІРєР° РґР»СЏ РїРµСЂРµСЃС‡С‘С‚Р°, % РіРѕРґРѕРІС‹С…
                        </span>
                        <input
                          name="scheduleAnnualRate"
                          inputMode="decimal"
                          defaultValue={
                            selectedRepaymentRate > 0
                              ? selectedRepaymentRate.toFixed(2)
                              : ""
                          }
                          placeholder="РќР°РїСЂРёРјРµСЂ 24"
                          className="h-11 w-full rounded-2xl border border-indigo-100 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                        />
                      </label>

                      <label className="block">
                        <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                          Р”Р°С‚Р° РѕРєРѕРЅС‡Р°РЅРёСЏ РїСЂРё СѓРјРµРЅСЊС€РµРЅРёРё РїР»Р°С‚РµР¶Р°
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
                          Р РµРіСѓР»СЏСЂРЅС‹Р№ РїР»Р°С‚С‘Р¶ РїСЂРё СЃРѕРєСЂР°С‰РµРЅРёРё СЃСЂРѕРєР°
                        </span>
                        <input
                          name="newRegularPayment"
                          inputMode="decimal"
                          defaultValue={Math.round(
                            selectedRepaymentRegularPayment,
                          )}
                          placeholder="РЎСѓРјРјР° РѕРґРЅРѕРіРѕ РїР»Р°С‚РµР¶Р°"
                          className="h-11 w-full rounded-2xl border border-indigo-100 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                        />
                      </label>
                    </div>

                    <div className="mt-4 rounded-2xl bg-white p-4 text-sm font-bold leading-6 text-slate-600 ring-1 ring-indigo-100">
                      Р”Р»СЏ С‡Р°СЃС‚РёС‡РЅРѕРіРѕ РїРѕРіР°С€РµРЅРёСЏ СЃСѓРјРјР° РІ РїРѕР»Рµ вЂњРўРµР»Рѕ РєСЂРµРґРёС‚Р°вЂќ
                      РґРѕР»Р¶РЅР° Р±С‹С‚СЊ РјРµРЅСЊС€Рµ С‚РµРєСѓС‰РµРіРѕ РґРѕР»РіР°. Р•СЃР»Рё Р·Р°РєСЂС‹РІР°РµС€СЊ РєСЂРµРґРёС‚
                      РїРѕР»РЅРѕСЃС‚СЊСЋ вЂ” РІС‹Р±РёСЂР°Р№ вЂњРџРѕР»РЅРѕРµ РїРѕРіР°С€РµРЅРёРµвЂќ.
                    </div>
                  </div>

                  <label className="block md:col-span-2">
                    <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                      РЎС‡С‘С‚ СЃРїРёСЃР°РЅРёСЏ
                    </span>
                    <select
                      name="bankAccount"
                      defaultValue=""
                      className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                    >
                      <option value="">РќРµ РІС‹Р±СЂР°РЅ</option>
                      {accounts.map((account) => (
                        <option key={account.id} value={account.name}>
                          {account.companyName} В· {account.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block md:col-span-2">
                    <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                      РљРѕРјРјРµРЅС‚Р°СЂРёР№
                    </span>
                    <textarea
                      name="comment"
                      rows={3}
                      defaultValue={`Р”РѕСЃСЂРѕС‡РЅРѕРµ РїРѕРіР°С€РµРЅРёРµ ${selectedRepaymentLoan.displayName}`}
                      className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
                    />
                  </label>
                </div>

                <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-sm font-bold text-slate-500">
                    РћСЂРёРµРЅС‚РёСЂ Рє СЃРїРёСЃР°РЅРёСЋ: {formatMoney(selectedRepaymentTotal)}
                  </div>
                  <button className="rounded-2xl bg-slate-950 px-6 py-3 text-sm font-black text-white shadow-sm transition hover:bg-slate-800">
                    РЎРѕР·РґР°С‚СЊ РїРѕРіР°С€РµРЅРёРµ
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
              <h2 className="text-xl font-black text-slate-950">Р’СЃРµ РєСЂРµРґРёС‚С‹</h2>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-600">
                {activeLoanIdsCount}
              </span>
            </div>

            <div className="flex gap-2">
              <a
                href="#add-loan"
                className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-700 shadow-sm transition hover:bg-slate-50"
              >
                Р”РѕР±Р°РІРёС‚СЊ РєСЂРµРґРёС‚
              </a>
              <Link
                href="/finance/calendar"
                className="rounded-2xl bg-slate-950 px-4 py-2 text-sm font-black text-white shadow-sm transition hover:bg-slate-800"
              >
                Р“СЂР°С„РёРє РїР»Р°С‚РµР¶РµР№
              </Link>
            </div>
          </div>

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[1180px] text-sm">
              <thead>
                <tr className="bg-slate-50 text-left text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                  <th className="rounded-l-2xl px-4 py-3">РљСЂРµРґРёС‚</th>
                  <th className="px-4 py-3">РљРѕРјРїР°РЅРёСЏ</th>
                  <th className="px-4 py-3 text-right">РўРµРєСѓС‰РёР№ РґРѕР»Рі</th>
                  <th className="px-4 py-3 text-right">РџР»Р°С‚С‘Р¶ РІ РјРµСЃСЏС†</th>
                  <th className="px-4 py-3">РЎР»РµРґСѓСЋС‰РёР№ РїР»Р°С‚С‘Р¶</th>
                  <th className="px-4 py-3 text-right">РћСЃС‚Р°С‚РѕРє СЃСЂРѕРєР°</th>
                  <th className="px-4 py-3 text-right">РЎС‚Р°РІРєР°</th>
                  <th className="px-4 py-3">РЎС‚Р°С‚СѓСЃ</th>
                  <th className="rounded-r-2xl px-4 py-3 text-right">
                    Р”РµР№СЃС‚РІРёСЏ
                  </th>
                </tr>
              </thead>

              <tbody>
                {loanRows.map((loan) => {
                  const creditCard =
                    creditCardRows.find((card) => card.id === loan.id) ?? null;

                  return (
                    <tr key={loan.id} className="border-b border-slate-100">
                      <td className="px-4 py-4">
                        <div className="font-black text-slate-950">
                          {loan.displayName}
                        </div>
                        <div className="mt-1 text-xs font-bold text-slate-400">
                          {loan.contractNumber ||
                            frequencyLabel(loan.paymentFrequency)}
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
                            ? `РІСЃРµРіРѕ ${formatMoney(loan.nextPaymentTotal)}`
                            : "РЅРµС‚ РїР»Р°С‚РµР¶РµР№"}
                        </div>
                      </td>

                      <td className="px-4 py-4 text-right font-bold text-slate-700">
                        {creditCard
                          ? creditCard.graceDaysLeft === null
                            ? "вЂ”"
                            : `${formatDaysLeft(creditCard.graceDaysLeft)} В· Р»СЊРіРѕС‚РЅС‹Р№ РїРµСЂРёРѕРґ`
                          : loan.remainingMonths === null
                            ? "вЂ”"
                            : `${loan.remainingMonths} РјРµСЃ.`}
                      </td>

                      <td className="px-4 py-4 text-right font-bold text-slate-700">
                        {creditCard
                          ? creditCard.gracePeriodDate
                            ? `0% РґРѕ ${formatDate(creditCard.gracePeriodDate)}`
                            : creditCard.interestRate > 0
                              ? `РїРѕСЃР»Рµ Р»СЊРіРѕС‚С‹ ${formatPercent(creditCard.interestRate)}`
                              : "вЂ”"
                          : formatRateLabel({
                              rate: loan.calculatedAnnualRate,
                              source: loan.rateSource,
                            })}
                      </td>

                      <td className="px-4 py-4">
                        {creditCard ? (
                          <Link
                            href={buildCreditCardEditHref(
                              companyName,
                              selectedMonthValue,
                              loan.id,
                            )}
                            className="inline-flex"
                          >
                            <CreditCardRiskBadge tone={creditCard.riskTone} />
                          </Link>
                        ) : (
                          <span className="inline-flex rounded-full bg-emerald-50 px-3 py-1 text-xs font-black text-emerald-700 ring-1 ring-emerald-100">
                            в—Џ РђРєС‚РёРІРµРЅ
                          </span>
                        )}
                      </td>

                      <td className="px-4 py-4 text-right">
                        <div className="flex justify-end gap-2">
                          {creditCard ? (
                            <>
                              <Link
                                href={buildCreditCardEditHref(
                                  companyName,
                                  selectedMonthValue,
                                  loan.id,
                                )}
                                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-700 transition hover:bg-slate-50"
                              >
                                РќР°СЃС‚СЂРѕРёС‚СЊ
                              </Link>
                              <Link
                                href={`/finance/loans/${loan.id}/schedule`}
                                className="rounded-xl bg-slate-950 px-3 py-2 text-xs font-black text-white transition hover:bg-slate-800"
                              >
                                РСЃС‚РѕСЂРёСЏ
                              </Link>
                            </>
                          ) : (
                            <>
                              <Link
                                href={buildRepaymentHref(
                                  companyName,
                                  selectedMonthValue,
                                  loan.id,
                                )}
                                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-700 transition hover:bg-slate-50"
                              >
                                Р”РѕСЃСЂРѕС‡РЅРѕ РїРѕРіР°СЃРёС‚СЊ
                              </Link>
                              <Link
                                href={`/finance/loans/${loan.id}/schedule`}
                                className="rounded-xl bg-slate-950 px-3 py-2 text-xs font-black text-white transition hover:bg-slate-800"
                              >
                                Р“СЂР°С„РёРє
                              </Link>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}

                {loanRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={9}
                      className="px-4 py-10 text-center text-sm font-bold text-slate-500"
                    >
                      РљСЂРµРґРёС‚С‹ РїРѕРєР° РЅРµ Р·Р°РІРµРґРµРЅС‹.
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
            Р”РѕР±Р°РІРёС‚СЊ РєСЂРµРґРёС‚
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
              placeholder="РќР°Р·РІР°РЅРёРµ РєСЂРµРґРёС‚Р° / Р±Р°РЅРєР°"
              className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900"
            />

            <input
              name="contractNumber"
              placeholder="РќРѕРјРµСЂ РґРѕРіРѕРІРѕСЂР°"
              className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900"
            />

            <select
              name="paymentFrequency"
              defaultValue="MONTHLY"
              className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900"
            >
              <option value="MONTHLY">Р•Р¶РµРјРµСЃСЏС‡РЅРѕ</option>
              <option value="WEEKLY">Р•Р¶РµРЅРµРґРµР»СЊРЅРѕ</option>
              <option value="BIWEEKLY">Р Р°Р· РІ 2 РЅРµРґРµР»Рё</option>
              <option value="TWICE_MONTHLY_15_25">15 Рё 25 С‡РёСЃР»Р°</option>
              <option value="CUSTOM">Р СѓС‡РЅРѕР№ РіСЂР°С„РёРє</option>
            </select>

            <input
              name="interestRate"
              placeholder="РЎС‚Р°РІРєР° %"
              className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900"
            />

            <input
              name="creditLimit"
              placeholder="Р›РёРјРёС‚ РєСЂРµРґРёС‚Р°"
              className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900"
            />

            <input
              name="currentDebt"
              placeholder="РўРµРєСѓС‰РёР№ РґРѕР»Рі"
              className="h-12 rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900"
            />

            <input
              name="monthlyPayment"
              placeholder="РџР»Р°С‚С‘Р¶ РІ РјРµСЃСЏС†"
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
              Р”РѕР±Р°РІРёС‚СЊ РєСЂРµРґРёС‚
            </button>
          </form>

          <p className="mt-4 text-sm font-medium text-slate-500">
            Р”Р»СЏ РґРѕСЃСЂРѕС‡РЅРѕРіРѕ РїРѕРіР°С€РµРЅРёСЏ СЃР»РµРґСѓСЋС‰РёРј СЌС‚Р°РїРѕРј РґРѕР±Р°РІРёРј РѕС‚РґРµР»СЊРЅСѓСЋ С„РѕСЂРјСѓ:
            РѕРЅР° Р±СѓРґРµС‚ СЃРѕР·РґР°РІР°С‚СЊ С„РёРЅР°РЅСЃРѕРІСѓСЋ РѕРїРµСЂР°С†РёСЋ, СѓРјРµРЅСЊС€Р°С‚СЊ РѕСЃС‚Р°С‚РѕРє РґРѕР»РіР° Рё
            РїРµСЂРµСЃС‡РёС‚С‹РІР°С‚СЊ Р±СѓРґСѓС‰РёР№ РіСЂР°С„РёРє РїР»Р°С‚РµР¶РµР№.
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

      <div
        className={`mt-4 text-2xl font-black tracking-tight ${accentClass.split(" ")[0]}`}
      >
        {value}
      </div>

      <div className="mt-2 text-xs font-bold leading-5 text-slate-500">
        {hint}
      </div>
    </div>
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
                <div
                  className="min-w-0 truncate text-sm font-black text-slate-950"
                  title={row[0]}
                >
                  {row[0]}
                </div>
                <span className="shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500">
                  вЂє
                </span>
              </div>

              <div className="mt-1 text-[11px] leading-4 text-slate-500">
                <span className="font-bold text-slate-500">{headers[1]}: </span>
                <b className="text-slate-900">{row[1]}</b>
                <span className="mx-1.5 text-slate-300">В·</span>
                <span className="font-bold text-slate-500">{headers[2]}: </span>
                <b className="text-emerald-600">{row[2]}</b>
              </div>
            </div>
          ))
        ) : (
          <div className="rounded-2xl bg-white/75 px-3 py-4 text-xs font-bold text-slate-500 ring-1 ring-white/80">
            РќРµРґРѕСЃС‚Р°С‚РѕС‡РЅРѕ РґР°РЅРЅС‹С….
          </div>
        )}
      </div>

      <button className="mt-3 w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-700 transition hover:bg-slate-50">
        {action}
      </button>
    </div>
  );
}

function CreditCardPanel({
  card,
  editHref,
}: {
  card: CreditCardView;
  editHref: string;
}) {
  const toneClass = {
    high: {
      badge: "bg-red-50 text-red-700 ring-red-100",
      bar: "bg-red-500",
      soft: "bg-red-50 border-red-100",
      text: "text-red-600",
    },
    medium: {
      badge: "bg-orange-50 text-orange-700 ring-orange-100",
      bar: "bg-orange-500",
      soft: "bg-orange-50 border-orange-100",
      text: "text-orange-600",
    },
    low: {
      badge: "bg-emerald-50 text-emerald-700 ring-emerald-100",
      bar: "bg-emerald-500",
      soft: "bg-emerald-50 border-emerald-100",
      text: "text-emerald-600",
    },
    missing: {
      badge: "bg-slate-50 text-slate-600 ring-slate-100",
      bar: "bg-slate-400",
      soft: "bg-slate-50 border-slate-100",
      text: "text-slate-600",
    },
  }[card.riskTone];

  return (
    <div className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm shadow-slate-100/70 transition hover:border-indigo-200 hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-base font-black text-slate-950">
            {card.displayName}
          </div>
          <div className="mt-1 text-xs font-bold text-slate-400">
            {card.contractNumber || card.companyName}
          </div>
        </div>

        <span
          className={`shrink-0 rounded-full px-3 py-1 text-[11px] font-black ring-1 ${toneClass.badge}`}
        >
          {card.riskLabel}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <div>
          <div className="text-[10px] font-black uppercase tracking-[0.08em] text-slate-400">
            Р”РѕР»Рі
          </div>
          <div className="mt-1 text-sm font-black text-slate-950">
            {formatMoney(card.currentDebt)}
          </div>
        </div>

        <div>
          <div className="text-[10px] font-black uppercase tracking-[0.08em] text-slate-400">
            Р›РёРјРёС‚
          </div>
          <div className="mt-1 text-sm font-black text-slate-950">
            {card.creditLimit > 0 ? formatMoney(card.creditLimit) : "вЂ”"}
          </div>
        </div>

        <div>
          <div className="text-[10px] font-black uppercase tracking-[0.08em] text-slate-400">
            Р”РѕСЃС‚СѓРїРЅРѕ
          </div>
          <div className="mt-1 text-sm font-black text-slate-950">
            {card.creditLimit > 0 ? formatMoney(card.availableLimit) : "вЂ”"}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between text-xs font-bold text-slate-500">
          <span>РСЃРїРѕР»СЊР·РѕРІР°РЅРёРµ Р»РёРјРёС‚Р°</span>
          <span>
            {card.creditLimit > 0
              ? `${card.utilizationPercent.toFixed(0)}%`
              : "РЅРµС‚ Р»РёРјРёС‚Р°"}
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full ${toneClass.bar}`}
            style={{
              width: `${Math.min(100, Math.max(0, card.utilizationPercent))}%`,
            }}
          />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-4">
        <div>
          <div className="text-[10px] font-black uppercase tracking-[0.08em] text-slate-400">
            РњРёРЅ. РїР»Р°С‚С‘Р¶
          </div>
          <div className="mt-1 text-sm font-black text-slate-950">
            {card.minimumPayment > 0
              ? formatMoney(card.minimumPayment)
              : "РЅРµ Р·Р°РґР°РЅ"}
          </div>
          <div className="mt-1 text-[11px] font-bold text-slate-500">
            РґРѕ {formatDate(card.minimumPaymentDate)}
          </div>
        </div>

        <div>
          <div className="text-[10px] font-black uppercase tracking-[0.08em] text-slate-400">
            Р›СЊРіРѕС‚РЅС‹Р№ РїРµСЂРёРѕРґ
          </div>
          <div className={`mt-1 text-sm font-black ${toneClass.text}`}>
            {formatDaysLeft(card.graceDaysLeft)}
          </div>
          <div className="mt-1 text-[11px] font-bold text-slate-500">
            РґРѕ {formatDate(card.gracePeriodDate)}
          </div>
        </div>
      </div>

      <div
        className={`mt-4 rounded-2xl border px-3 py-2 text-xs font-bold leading-5 ${toneClass.soft} ${toneClass.text}`}
      >
        {card.riskHint}
      </div>

      <Link
        href={editHref}
        className="mt-3 inline-flex w-full items-center justify-center rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-black text-slate-700 transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700"
      >
        РЈРєР°Р·Р°С‚СЊ РёР»Рё РёР·РјРµРЅРёС‚СЊ РґР°РЅРЅС‹Рµ РєР°СЂС‚С‹
      </Link>
    </div>
  );
}

function InfoBox({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "danger" | "warning";
}) {
  const toneClass = {
    default: "bg-white text-slate-950 ring-slate-100",
    danger: "bg-red-50 text-red-700 ring-red-100",
    warning: "bg-orange-50 text-orange-700 ring-orange-100",
  }[tone];

  return (
    <div className={`rounded-2xl p-4 ring-1 ${toneClass}`}>
      <div className="text-xs font-black uppercase tracking-[0.08em] text-slate-400">
        {label}
      </div>
      <div className="mt-2 text-lg font-black">{value}</div>
    </div>
  );
}

function CreditCardEditForm({
  card,
  companyName,
  selectedMonthValue,
}: {
  card: CreditCardView;
  companyName: string | null;
  selectedMonthValue: string;
}) {
  const minimumPaymentPercent =
    card.minimumPaymentPercent > 0 ? card.minimumPaymentPercent.toFixed(2) : "";

  return (
    <section
      id="credit-card-editor"
      className="rounded-[28px] border border-indigo-100 bg-white p-6 shadow-sm shadow-indigo-100/70 ring-1 ring-indigo-50"
    >
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="inline-flex rounded-full bg-indigo-50 px-3 py-1 text-xs font-black uppercase tracking-[0.08em] text-indigo-700 ring-1 ring-indigo-100">
            РќР°СЃС‚СЂРѕР№РєР° РєСЂРµРґРёС‚РЅРѕР№ РєР°СЂС‚С‹
          </div>

          <h2 className="mt-3 text-2xl font-black text-slate-950">
            {card.displayName}
          </h2>

          <p className="mt-2 max-w-4xl text-sm font-medium leading-6 text-slate-500">
            Р—РґРµСЃСЊ РѕР±РЅРѕРІР»СЏСЋС‚СЃСЏ РґРѕР»Рі, Р»РёРјРёС‚, РјРёРЅРёРјР°Р»СЊРЅС‹Р№ РїР»Р°С‚С‘Р¶ Рё Р»СЊРіРѕС‚РЅС‹Р№ РїРµСЂРёРѕРґ.
            Р­С‚Рё РґР°РЅРЅС‹Рµ РЅСѓР¶РЅС‹ РґР»СЏ Р±Р»РѕРєР° РєСЂРµРґРёС‚РѕРє, Р±Р»РёР¶Р°Р№С€РёС… РїР»Р°С‚РµР¶РµР№, РћР”Р”РЎ Рё
            РїР»Р°С‚С‘Р¶РЅРѕРіРѕ РєР°Р»РµРЅРґР°СЂСЏ.
          </p>
        </div>

        <Link
          href={buildFinanceHref(companyName, selectedMonthValue)}
          className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-black text-slate-700 shadow-sm transition hover:bg-slate-50"
        >
          Р—Р°РєСЂС‹С‚СЊ
        </Link>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[0.85fr_1.15fr]">
        <div className="rounded-[24px] border border-slate-100 bg-slate-50/70 p-5">
          <div className="text-sm font-black text-slate-950">
            {card.companyName}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <InfoBox
              label="РўРµРєСѓС‰РёР№ РґРѕР»Рі"
              value={formatMoney(card.currentDebt)}
            />
            <InfoBox
              label="РљСЂРµРґРёС‚РЅС‹Р№ Р»РёРјРёС‚"
              value={
                card.creditLimit > 0
                  ? formatMoney(card.creditLimit)
                  : "РЅРµ Р·Р°РґР°РЅ"
              }
            />
            <InfoBox
              label="РњРёРЅРёРјР°Р»СЊРЅС‹Р№ РїР»Р°С‚С‘Р¶"
              value={
                card.minimumPayment > 0
                  ? formatMoney(card.minimumPayment)
                  : "РЅРµ Р·Р°РґР°РЅ"
              }
            />
            <InfoBox
              label="Р›СЊРіРѕС‚РЅС‹Р№ РїРµСЂРёРѕРґ"
              value={formatDaysLeft(card.graceDaysLeft)}
              tone={
                card.riskTone === "high"
                  ? "danger"
                  : card.riskTone === "medium"
                    ? "warning"
                    : "default"
              }
            />
          </div>

          <div className="mt-4 rounded-2xl bg-blue-50 p-4 text-sm font-bold leading-6 text-blue-900 ring-1 ring-blue-100">
            Р”Р»СЏ РєСЂРµРґРёС‚РєРё РЅРµ СЃРѕР·РґР°С‘Рј С„РёРєСЃРёСЂРѕРІР°РЅРЅС‹Р№ РіСЂР°С„РёРє С‚РµР»Р° Рё РїСЂРѕС†РµРЅС‚РѕРІ. Р’
            РєР°Р»РµРЅРґР°СЂСЊ РїРѕРїР°РґР°РµС‚ С‚РѕР»СЊРєРѕ Р±Р»РёР¶Р°Р№С€РёР№ РјРёРЅРёРјР°Р»СЊРЅС‹Р№ РїР»Р°С‚С‘Р¶. Р›СЊРіРѕС‚РЅС‹Р№
            РїРµСЂРёРѕРґ РїРѕРєР°Р·С‹РІР°РµС‚СЃСЏ РѕС‚РґРµР»СЊРЅРѕ РєР°Рє СЂРёСЃРє Рё СЂРµРєРѕРјРµРЅРґР°С†РёСЏ.
          </div>

          <div className="mt-3 rounded-2xl bg-amber-50 p-4 text-sm font-bold leading-6 text-amber-900 ring-1 ring-amber-100">
            Р•СЃР»Рё Р·Р°РґР°РЅ РїСЂРѕС†РµРЅС‚ РјРёРЅРёРјР°Р»СЊРЅРѕРіРѕ РїР»Р°С‚РµР¶Р°, РЅРѕ СЃСѓРјРјР° РїСѓСЃС‚Р°СЏ, СЃРёСЃС‚РµРјР°
            СЂР°СЃСЃС‡РёС‚Р°РµС‚ РјРёРЅРёРјР°Р»СЊРЅС‹Р№ РїР»Р°С‚С‘Р¶ РѕС‚ С‚РµРєСѓС‰РµРіРѕ РґРѕР»РіР°.
          </div>
        </div>

        <form
          action="/api/finance/loans/credit-card"
          method="POST"
          className="rounded-[24px] border border-slate-100 bg-white p-5 shadow-sm"
        >
          <input type="hidden" name="loanId" value={card.id} />
          <input
            type="hidden"
            name="returnCompany"
            value={companyName ?? "ALL"}
          />
          <input type="hidden" name="returnPeriod" value={selectedMonthValue} />

          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                РўРµРєСѓС‰РёР№ РґРѕР»Рі
              </span>
              <input
                name="currentDebt"
                type="number"
                min="0"
                step="0.01"
                defaultValue={card.currentDebt || ""}
                className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                РљСЂРµРґРёС‚РЅС‹Р№ Р»РёРјРёС‚
              </span>
              <input
                name="creditLimit"
                type="number"
                min="0"
                step="0.01"
                defaultValue={card.creditLimit || ""}
                className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                РњРёРЅРёРјР°Р»СЊРЅС‹Р№ РїР»Р°С‚С‘Р¶, в‚Ѕ
              </span>
              <input
                name="minimumPayment"
                type="number"
                min="0"
                step="0.01"
                defaultValue={card.minimumPayment || ""}
                className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                РњРёРЅРёРјР°Р»СЊРЅС‹Р№ РїР»Р°С‚С‘Р¶, % РѕС‚ РґРѕР»РіР°
              </span>
              <input
                name="minimumPaymentPercent"
                type="number"
                min="0"
                step="0.01"
                defaultValue={minimumPaymentPercent}
                placeholder="РќР°РїСЂРёРјРµСЂ 5"
                className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                Р”Р°С‚Р° РјРёРЅРёРјР°Р»СЊРЅРѕРіРѕ РїР»Р°С‚РµР¶Р°
              </span>
              <input
                name="minimumPaymentDate"
                type="date"
                defaultValue={
                  card.minimumPaymentDate
                    ? formatDateInput(card.minimumPaymentDate)
                    : ""
                }
                className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                РљРѕРЅРµС† Р»СЊРіРѕС‚РЅРѕРіРѕ РїРµСЂРёРѕРґР°
              </span>
              <input
                name="gracePeriodDate"
                type="date"
                defaultValue={
                  card.gracePeriodDate
                    ? formatDateInput(card.gracePeriodDate)
                    : ""
                }
                className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                РЎС‚Р°РІРєР° РїРѕСЃР»Рµ Р»СЊРіРѕС‚РЅРѕРіРѕ РїРµСЂРёРѕРґР°, % РіРѕРґРѕРІС‹С…
              </span>
              <input
                name="interestRate"
                type="number"
                min="0"
                step="0.01"
                defaultValue={card.interestRate || ""}
                className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
              />
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-black uppercase tracking-[0.08em] text-slate-400">
                РџРµСЂРёРѕРґРёС‡РЅРѕСЃС‚СЊ РјРёРЅРёРјР°Р»СЊРЅРѕРіРѕ РїР»Р°С‚РµР¶Р°
              </span>
              <select
                name="paymentFrequency"
                defaultValue="MONTHLY"
                className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-4 text-sm font-bold text-slate-900 outline-none transition focus:border-indigo-300 focus:ring-4 focus:ring-indigo-100"
              >
                <option value="MONTHLY">Р•Р¶РµРјРµСЃСЏС‡РЅРѕ</option>
                <option value="CUSTOM">Р СѓС‡РЅРѕР№ РєРѕРЅС‚СЂРѕР»СЊ</option>
              </select>
            </label>
          </div>

          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs font-bold leading-5 text-slate-500">
              РЎРѕС…СЂР°РЅРµРЅРёРµ РѕР±РЅРѕРІРёС‚ РєР°СЂС‚РѕС‡РєСѓ, Р±Р»РёР¶Р°Р№С€РёР№ РјРёРЅРёРјР°Р»СЊРЅС‹Р№ РїР»Р°С‚С‘Р¶ Рё
              РїР»Р°РЅРѕРІСѓСЋ РѕРїРµСЂР°С†РёСЋ РІ С„РёРЅР°РЅСЃРѕРІРѕРј РєР°Р»РµРЅРґР°СЂРµ.
            </p>

            <button className="rounded-2xl bg-slate-950 px-6 py-3 text-sm font-black text-white shadow-sm transition hover:bg-slate-800">
              РЎРѕС…СЂР°РЅРёС‚СЊ РґР°РЅРЅС‹Рµ РєР°СЂС‚С‹
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

function CreditCardRiskBadge({ tone }: { tone: CreditCardRiskTone }) {
  const classes = {
    high: "bg-red-50 text-red-700 ring-red-100",
    medium: "bg-orange-50 text-orange-700 ring-orange-100",
    low: "bg-emerald-50 text-emerald-700 ring-emerald-100",
    missing: "bg-slate-50 text-slate-600 ring-slate-100",
  }[tone];

  const label = {
    high: "в—Џ Р’С‹СЃРѕРєРёР№ СЂРёСЃРє",
    medium: "в—Џ РЎСЂРµРґРЅРёР№ СЂРёСЃРє",
    low: "в—Џ РќРёР·РєРёР№ СЂРёСЃРє",
    missing: "в—Џ РќСѓР¶РЅС‹ РґР°РЅРЅС‹Рµ",
  }[tone];

  return (
    <span
      className={`inline-flex rounded-full px-3 py-1 text-xs font-black ring-1 ${classes}`}
    >
      {label}
    </span>
  );
}

