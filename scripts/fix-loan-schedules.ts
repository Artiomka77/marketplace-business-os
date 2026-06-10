import "dotenv/config";

import * as XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  ssl: {
    rejectUnauthorized: false,
  },
});

const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

type Frequency =
  | "NONE"
  | "MONTHLY_EXCEL"
  | "WEEKLY_FIXED_MONDAY"
  | "WEEKLY_FIXED_FRIDAY"
  | "TWICE_MONTHLY_FIXED";

type Rule = {
  match: string[];
  frequency: Frequency;
  dayOfMonth?: number;
  fixedTotal?: number;
  fixedPrincipal?: number;
  fixedInterest?: number;
};

type ExcelSchedule = {
  name: string;
  principal: number[];
  interest: number[];
  monthDates: Date[];
};

type PaymentData = {
  paymentDate: Date;
  principalAmount: number;
  interestAmount: number;
  totalAmount: number;
};

const EXCEL_FILE = process.argv[2] ?? "Кредиты.xlsx";
const SHOULD_APPLY = process.argv.includes("--apply");

function normalize(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[().]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return 0;

  const number = Number(
    String(value)
      .replace(/\s/g, "")
      .replace(",", ".")
      .replace(/[^\d.-]/g, "")
  );

  return Number.isFinite(number) ? number : 0;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function makeDate(year: number, month: number, day: number) {
  return new Date(year, month, day, 12, 0, 0, 0);
}

function excelDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return makeDate(value.getFullYear(), value.getMonth(), value.getDate());
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);

    if (!parsed) return null;

    return makeDate(parsed.y, parsed.m - 1, parsed.d);
  }

  const text = String(value ?? "").trim();

  if (!text) return null;

  const ruDate = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);

  if (ruDate) {
    return makeDate(
      Number(ruDate[3]),
      Number(ruDate[2]) - 1,
      Number(ruDate[1])
    );
  }

  return null;
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  result.setHours(12, 0, 0, 0);
  return result;
}

function correctMonthlyDate(monthDate: Date, dayOfMonth: number) {
  return makeDate(monthDate.getFullYear(), monthDate.getMonth(), dayOfMonth);
}

function weekdayDatesInMonth(monthDate: Date, weekday: number) {
  const result: Date[] = [];
  const current = makeDate(monthDate.getFullYear(), monthDate.getMonth(), 1);

  while (current.getMonth() === monthDate.getMonth()) {
    if (current.getDay() === weekday) {
      result.push(makeDate(current.getFullYear(), current.getMonth(), current.getDate()));
    }

    current.setDate(current.getDate() + 1);
  }

  return result;
}

function twiceMonthlyDates(monthDate: Date) {
  return [
    makeDate(monthDate.getFullYear(), monthDate.getMonth(), 15),
    makeDate(monthDate.getFullYear(), monthDate.getMonth(), 25),
  ];
}

const rules: Rule[] = [
  {
    match: ["сбер кредитка"],
    frequency: "NONE",
  },
  {
    match: ["альфа кредитка 4337"],
    frequency: "NONE",
  },
  {
    match: ["альфа кредитка 4761"],
    frequency: "NONE",
  },
  {
    match: ["альфа кредит"],
    frequency: "MONTHLY_EXCEL",
    dayOfMonth: 22,
  },
  {
    match: ["авто кредит уралсиб"],
    frequency: "MONTHLY_EXCEL",
    dayOfMonth: 12,
  },
  {
    match: ["сбер ип 5 млн", "сбер ип - 5 млн"],
    frequency: "MONTHLY_EXCEL",
    dayOfMonth: 9,
  },
  {
    match: ["сбер ип 600", "сбер ип - 600"],
    frequency: "MONTHLY_EXCEL",
    dayOfMonth: 30,
  },
  {
    match: ["сбер ооо 5 млн", "сбер ооо - 5 млн"],
    frequency: "MONTHLY_EXCEL",
    dayOfMonth: 27,
  },
  {
    match: ["сбер ооо 600", "сбер ооо - 600"],
    frequency: "MONTHLY_EXCEL",
    dayOfMonth: 7,
  },
  {
    match: ["wb кредит петров 1 2", "wb кредит петров 1,2"],
    frequency: "WEEKLY_FIXED_MONDAY",
    fixedTotal: 25863,
  },
  {
    match: ["wb кредит лебедева 1 4", "wb кредит лебедева 1,4", "wb кредит лебедева"],
    frequency: "WEEKLY_FIXED_MONDAY",
    fixedTotal: 24869.2,
  },
  {
    match: ["озон кредит 2 200"],
    frequency: "TWICE_MONTHLY_FIXED",
    fixedTotal: 215480,
    fixedPrincipal: 182610.43,
    fixedInterest: 32869.57,
  },
  {
    match: ["озон кредит 990"],
    frequency: "MONTHLY_EXCEL",
    dayOfMonth: 30,
    fixedTotal: 70840,
    fixedPrincipal: 55000,
    fixedInterest: 15840,
  },
  {
    match: ["sell plus"],
    frequency: "WEEKLY_FIXED_FRIDAY",
    fixedTotal: 90668.43,
  },
];

function findRule(name: string) {
  const text = normalize(name);

  return rules.find((rule) =>
    rule.match.some((pattern) => text.includes(normalize(pattern)))
  );
}

function prismaFrequency(rule: Rule) {
  if (rule.frequency === "NONE") return "CUSTOM";
  if (rule.frequency === "MONTHLY_EXCEL") return "MONTHLY";
  if (rule.frequency === "WEEKLY_FIXED_MONDAY") return "WEEKLY";
  if (rule.frequency === "WEEKLY_FIXED_FRIDAY") return "WEEKLY";
  if (rule.frequency === "TWICE_MONTHLY_FIXED") return "TWICE_MONTHLY_15_25";

  return "CUSTOM";
}

function isScheduleHeader(row: unknown[]) {
  if (!normalize(row[0]).includes("наименование")) return false;

  const dateCellsCount = row
    .slice(1, 40)
    .filter((cell) => excelDate(cell) !== null).length;

  return dateCellsCount >= 3;
}

function rowHasKnownLoanName(value: unknown) {
  const text = normalize(value);

  if (!text) return false;
  if (text === "%") return false;
  if (text.includes("итого")) return false;
  if (text.includes("всего")) return false;
  if (text.includes("налог")) return false;
  if (text.includes("поставщик")) return false;

  return Boolean(findRule(text));
}

function readExcelSchedules() {
  const workbook = XLSX.readFile(EXCEL_FILE, {
    cellDates: true,
  });

  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];

  const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    defval: null,
    blankrows: false,
  });

  const headerIndex = matrix.findIndex((row) => isScheduleHeader(row));

  if (headerIndex < 0) {
    throw new Error("Не найден блок графика платежей: строка 'Наименование' + месяцы.");
  }

  const headerRow = matrix[headerIndex];
  const monthDates = headerRow.map((cell) => excelDate(cell));

  const schedules: ExcelSchedule[] = [];

  for (let rowIndex = headerIndex + 1; rowIndex < matrix.length; rowIndex++) {
    const principalRow = matrix[rowIndex];

    if (!rowHasKnownLoanName(principalRow[0])) continue;

    const name = String(principalRow[0] ?? "").trim();
    const interestRow = matrix[rowIndex + 1] ?? [];

    const principal: number[] = [];
    const interest: number[] = [];
    const rowMonthDates: Date[] = [];

    for (let col = 1; col < principalRow.length; col++) {
      const monthDate = monthDates[col];

      if (!monthDate) continue;

      const principalAmount = toNumber(principalRow[col]);
      const interestAmount = toNumber(interestRow[col]);

      if (principalAmount <= 0 && interestAmount <= 0) continue;

      principal.push(roundMoney(principalAmount));
      interest.push(roundMoney(interestAmount));
      rowMonthDates.push(monthDate);
    }

    schedules.push({
      name,
      principal,
      interest,
      monthDates: rowMonthDates,
    });
  }

  return schedules;
}

function findScheduleForLoan(loanName: string, schedules: ExcelSchedule[]) {
  const rule = findRule(loanName);

  if (!rule) return null;

  return (
    schedules.find((schedule) => {
      const scheduleName = normalize(schedule.name);
      const loan = normalize(loanName);

      if (loan.includes(scheduleName) || scheduleName.includes(loan)) {
        return true;
      }

      return rule.match.some((pattern) =>
        scheduleName.includes(normalize(pattern))
      );
    }) ?? null
  );
}

function splitFixedTotalByExcelRatio(params: {
  fixedTotal: number;
  excelPrincipal: number;
  excelInterest: number;
}) {
  const { fixedTotal, excelPrincipal, excelInterest } = params;
  const excelTotal = excelPrincipal + excelInterest;

  if (excelTotal <= 0) {
    return {
      principalAmount: roundMoney(fixedTotal),
      interestAmount: 0,
      totalAmount: roundMoney(fixedTotal),
    };
  }

  const principalAmount = roundMoney((fixedTotal * excelPrincipal) / excelTotal);
  const interestAmount = roundMoney(fixedTotal - principalAmount);

  return {
    principalAmount,
    interestAmount,
    totalAmount: roundMoney(fixedTotal),
  };
}

function buildPaymentsFromSchedule(
  schedule: ExcelSchedule | null,
  rule: Rule
): PaymentData[] {
  const payments: PaymentData[] = [];

  if (rule.frequency === "NONE") {
    return payments;
  }

  if (!schedule || schedule.monthDates.length === 0) {
    return payments;
  }

  for (let index = 0; index < schedule.monthDates.length; index++) {
    const monthDate = schedule.monthDates[index];

    const excelPrincipal = roundMoney(schedule.principal[index] ?? 0);
    const excelInterest = roundMoney(schedule.interest[index] ?? 0);

    if (rule.frequency === "MONTHLY_EXCEL") {
      const paymentDate = correctMonthlyDate(
        monthDate,
        rule.dayOfMonth ?? monthDate.getDate()
      );

      if (
        rule.fixedTotal !== undefined &&
        rule.fixedPrincipal !== undefined &&
        rule.fixedInterest !== undefined
      ) {
        payments.push({
          paymentDate,
          principalAmount: roundMoney(rule.fixedPrincipal),
          interestAmount: roundMoney(rule.fixedInterest),
          totalAmount: roundMoney(rule.fixedTotal),
        });

        continue;
      }

      const principalAmount = excelPrincipal;
      const interestAmount = excelInterest;
      const totalAmount = roundMoney(principalAmount + interestAmount);

      if (totalAmount <= 0) continue;

      payments.push({
        paymentDate,
        principalAmount,
        interestAmount,
        totalAmount,
      });
    }

    if (rule.frequency === "WEEKLY_FIXED_MONDAY") {
      const fixedTotal = rule.fixedTotal ?? 0;
      const dates = weekdayDatesInMonth(monthDate, 1);

      if (fixedTotal <= 0 || dates.length === 0) continue;

      const amounts = splitFixedTotalByExcelRatio({
        fixedTotal,
        excelPrincipal,
        excelInterest,
      });

      for (const paymentDate of dates) {
        payments.push({
          paymentDate,
          ...amounts,
        });
      }
    }

    if (rule.frequency === "WEEKLY_FIXED_FRIDAY") {
      const fixedTotal = rule.fixedTotal ?? 0;
      const dates = weekdayDatesInMonth(monthDate, 5);

      if (fixedTotal <= 0 || dates.length === 0) continue;

      const amounts = splitFixedTotalByExcelRatio({
        fixedTotal,
        excelPrincipal,
        excelInterest,
      });

      for (const paymentDate of dates) {
        payments.push({
          paymentDate,
          ...amounts,
        });
      }
    }

    if (rule.frequency === "TWICE_MONTHLY_FIXED") {
      const dates = twiceMonthlyDates(monthDate);

      for (const paymentDate of dates) {
        payments.push({
          paymentDate,
          principalAmount: roundMoney(rule.fixedPrincipal ?? 0),
          interestAmount: roundMoney(rule.fixedInterest ?? 0),
          totalAmount: roundMoney(rule.fixedTotal ?? 0),
        });
      }
    }
  }

  return payments.sort((a, b) => a.paymentDate.getTime() - b.paymentDate.getTime());
}

function financeTransactionData(payment: {
  id: string;
  paymentDate: Date;
  totalAmount: number;
  principalAmount: number;
  interestAmount: number;
  loan: {
    companyName: string;
    bankName: string;
  };
}) {
  return {
    companyName: payment.loan.companyName,
    operationDate: payment.paymentDate,
    obligationDate: payment.paymentDate,
    operationType: "FINANCING",
    category: "Погашение кредита",
    subcategory: payment.loan.bankName,
    counterparty: payment.loan.bankName,
    amount: payment.totalAmount,
    bankAccount: null,
    project: "Кредиты",
    comment: `Кредитный платеж: ${payment.loan.bankName}. Тело: ${payment.principalAmount}, проценты: ${payment.interestAmount}`,
    isInternalTransfer: false,
    transactionStatus: "PLAN",
    sourceType: "LOAN_PAYMENT",
    sourceId: payment.id,
  };
}

async function clearLoanSchedule(loanId: string) {
  const oldPayments = await prisma.loanPayment.findMany({
    where: {
      loanId,
    },
    select: {
      id: true,
    },
  });

  const oldPaymentIds = oldPayments.map((payment) => payment.id);

  if (oldPaymentIds.length > 0) {
    await prisma.financeTransaction.deleteMany({
      where: {
        sourceType: "LOAN_PAYMENT",
        sourceId: {
          in: oldPaymentIds,
        },
      },
    });
  }

  await prisma.loanPayment.deleteMany({
    where: {
      loanId,
    },
  });
}

async function main() {
  console.log(`Excel file: ${EXCEL_FILE}`);
  console.log(SHOULD_APPLY ? "MODE: APPLY" : "MODE: DRY RUN");

  const schedules = readExcelSchedules();

  console.log(`Excel schedules found: ${schedules.length}`);

  const loans = await prisma.loan.findMany({
    orderBy: [{ companyName: "asc" }, { bankName: "asc" }],
  });

  console.log(`DB loans found: ${loans.length}`);

  for (const loan of loans) {
    const rule = findRule(loan.bankName);

    if (!rule) {
      console.log(`\nSKIP: no rule for "${loan.companyName} / ${loan.bankName}"`);
      continue;
    }

    const schedule = findScheduleForLoan(loan.bankName, schedules);

    if (rule.frequency !== "NONE" && !schedule) {
      console.log(`\nERROR: no Excel schedule for "${loan.companyName} / ${loan.bankName}"`);
      continue;
    }

    const payments = buildPaymentsFromSchedule(schedule, rule);

    const totalPrincipal = roundMoney(
      payments.reduce((sum, payment) => sum + payment.principalAmount, 0)
    );

    const totalInterest = roundMoney(
      payments.reduce((sum, payment) => sum + payment.interestAmount, 0)
    );

    const totalAmount = roundMoney(
      payments.reduce((sum, payment) => sum + payment.totalAmount, 0)
    );

    console.log(`\nLoan: ${loan.companyName} / ${loan.bankName}`);
    console.log(`  Rule: ${rule.frequency}`);
    console.log(`  Excel schedule: ${schedule?.name ?? "—"}`);
    console.log(`  Payments to create: ${payments.length}`);
    console.log(`  Principal: ${totalPrincipal}`);
    console.log(`  Interest: ${totalInterest}`);
    console.log(`  Total: ${totalAmount}`);

    if (payments.length > 0) {
      console.log(
        `  First: ${payments[0].paymentDate.toLocaleDateString("ru-RU")} ${payments[0].totalAmount}`
      );
      console.log(
        `  Last: ${payments[payments.length - 1].paymentDate.toLocaleDateString(
          "ru-RU"
        )} ${payments[payments.length - 1].totalAmount}`
      );
    }

    if (!SHOULD_APPLY) {
      continue;
    }

    await clearLoanSchedule(loan.id);

    await prisma.loan.update({
      where: {
        id: loan.id,
      },
      data: {
        paymentFrequency: prismaFrequency(rule),
        monthlyPayment: payments.length > 0 ? payments[0].totalAmount : 0,
      },
    });

    for (const paymentData of payments) {
      const payment = await prisma.loanPayment.create({
        data: {
          loanId: loan.id,
          paymentDate: paymentData.paymentDate,
          principalAmount: paymentData.principalAmount,
          interestAmount: paymentData.interestAmount,
          totalAmount: paymentData.totalAmount,
        },
      });

      await prisma.financeTransaction.create({
        data: financeTransactionData({
          id: payment.id,
          paymentDate: paymentData.paymentDate,
          principalAmount: paymentData.principalAmount,
          interestAmount: paymentData.interestAmount,
          totalAmount: paymentData.totalAmount,
          loan: {
            companyName: loan.companyName,
            bankName: loan.bankName,
          },
        }),
      });
    }

    console.log("  Applied.");
  }

  console.log("\nDone.");
}

main()
  .catch((error) => {
    console.error("SCRIPT_ERROR", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });