import assert from "node:assert/strict";
import test from "node:test";

import {
  EFFECTIVE_FACT_SOURCE_TYPE_INTEREST,
  getEffectiveFinanceTransactions,
  INTEREST_CATEGORY,
} from "@/lib/finance/effectiveFinanceTransactions";
import { calculateFinanceMetricsForRows } from "@/lib/finance/financeMetrics";

function makePrisma(opts: {
  loans: Array<Record<string, unknown>>;
  paymentsByLoan: Record<string, Array<Record<string, unknown>>>;
  factRows?: Array<Record<string, unknown>>;
}) {
  const factRows = opts.factRows ?? [];
  return {
    financeTransaction: {
      async findMany(args: { where?: Record<string, unknown> }) {
        const where = args.where ?? {};
        if (where.sourceType === "LOAN_EARLY_REPAYMENT") return [];
        // FACT period query
        return factRows.filter((r) => {
          if (where.transactionStatus && r.transactionStatus !== where.transactionStatus)
            return false;
          if (where.companyName && r.companyName !== where.companyName) return false;
          return true;
        });
      },
    },
    loan: {
      async findMany(args: {
        where?: Record<string, unknown>;
        include?: { payments?: { orderBy?: unknown } };
      }) {
        let loans = opts.loans;
        if (args.where?.companyName) {
          loans = loans.filter((l) => l.companyName === args.where!.companyName);
        }
        return loans.map((loan) => ({
          ...loan,
          payments: [...(opts.paymentsByLoan[String(loan.id)] ?? [])].sort(
            (a, b) =>
              new Date(String(a.paymentDate)).getTime() -
              new Date(String(b.paymentDate)).getTime(),
          ),
        }));
      },
    },
  };
}

const categories = [
  {
    name: INTEREST_CATEGORY,
    categoryType: "EXPENSE",
    parentName: null,
    profitTreatment: "CREDIT_INTEREST",
  },
  {
    name: "Тело кредита",
    categoryType: "EXPENSE",
    parentName: null,
    profitTreatment: "CREDIT_PRINCIPAL",
  },
];

test("due paid=false schedule without FACT synthesizes interest into net profit", async () => {
  const prisma = makePrisma({
    loans: [
      {
        id: "loan_dfd0049677",
        companyName: "ИП Петров",
        bankName: "Wb Кредит Петров 1,2 млн",
        currentDebt: 718905.26,
      },
    ],
    paymentsByLoan: {
      loan_dfd0049677: [
        {
          id: "loanpay_wbfinance_dfd0049677_015",
          loanId: "loan_dfd0049677",
          paymentDate: new Date("2026-10-19T00:00:00.000Z"),
          paid: false,
          principalAmount: 23931.9,
          interestAmount: 1931.1,
          totalAmount: 25863,
        },
      ],
    },
  });
  const rows = await getEffectiveFinanceTransactions({
    prisma,
    companyName: "ИП Петров",
    dateFrom: new Date("2026-10-19T00:00:00.000Z"),
    dateToExclusive: new Date("2026-10-26T00:00:00.000Z"),
    asOfDate: new Date("2026-10-25T00:00:00.000Z"),
  });
  const syntheticInterest = rows.filter(
    (r) =>
      r.__effectiveFactSynthetic &&
      r.sourceType === EFFECTIVE_FACT_SOURCE_TYPE_INTEREST,
  );
  assert.equal(syntheticInterest.length, 1);
  assert.ok(Math.abs(Number(syntheticInterest[0].amount) - 1931.1) < 0.02);
  const metrics = calculateFinanceMetricsForRows({
    transactions: rows as never,
    categories: categories as never,
  });
  assert.ok(Math.abs(metrics.netProfitImpact - -1931.1) < 0.02);
});

test("explicit FACT covering same LoanPayment prevents duplicate interest", async () => {
  const paymentId = "loanpay_wbfinance_dfd0049677_015";
  const prisma = makePrisma({
    loans: [
      {
        id: "loan_dfd0049677",
        companyName: "ИП Петров",
        bankName: "Wb Кредит",
        currentDebt: 718905.26,
      },
    ],
    paymentsByLoan: {
      loan_dfd0049677: [
        {
          id: paymentId,
          loanId: "loan_dfd0049677",
          paymentDate: new Date("2026-10-19T00:00:00.000Z"),
          paid: false,
          principalAmount: 23931.9,
          interestAmount: 1931.1,
          totalAmount: 25863,
        },
      ],
    },
    factRows: [
      {
        id: "fact_interest",
        companyName: "ИП Петров",
        transactionStatus: "FACT",
        sourceType: "LOAN_PAYMENT",
        sourceId: paymentId,
        category: INTEREST_CATEGORY,
        amount: 1931.1,
        operationDate: new Date("2026-10-19T00:00:00.000Z"),
        operationType: "FINANCING",
        isInternalTransfer: false,
      },
    ],
  });
  const rows = await getEffectiveFinanceTransactions({
    prisma,
    companyName: "ИП Петров",
    dateFrom: new Date("2026-10-19T00:00:00.000Z"),
    dateToExclusive: new Date("2026-10-26T00:00:00.000Z"),
    asOfDate: new Date("2026-10-25T00:00:00.000Z"),
  });
  const interestRows = rows.filter((r) => r.category === INTEREST_CATEGORY);
  assert.equal(interestRows.length, 1);
  assert.equal(interestRows[0].__effectiveFactSynthetic, undefined);
});

test("stale Alfa payment after proven endDate is excluded by runtime close (row kept in input)", async () => {
  // Real week row loanpay_bankfix_… on 2026-10-22 stays in the schedule array.
  // Loan endDate 2026-09-17 + currentDebt 0 → scheduleClose=endDate → post-close.
  const prisma = makePrisma({
    loans: [
      {
        id: "loan_cf6b9d061f",
        companyName: "ИП Петров",
        bankName: "Альфа кредит",
        currentDebt: 0,
        endDate: new Date("2026-09-17T00:00:00.000Z"),
      },
    ],
    paymentsByLoan: {
      loan_cf6b9d061f: [
        {
          id: "loanpay_bankfix_86d0916f84584e5c892b",
          loanId: "loan_cf6b9d061f",
          paymentDate: new Date("2026-10-22T00:00:00.000Z"),
          paid: true,
          principalAmount: 39085.59,
          interestAmount: 2914.41,
          totalAmount: 42000,
        },
      ],
    },
  });
  const rows = await getEffectiveFinanceTransactions({
    prisma,
    companyName: "ИП Петров",
    dateFrom: new Date("2026-10-19T00:00:00.000Z"),
    dateToExclusive: new Date("2026-10-26T00:00:00.000Z"),
    asOfDate: new Date("2026-10-25T00:00:00.000Z"),
  });
  assert.equal(rows.filter((r) => r.__effectiveFactSynthetic).length, 0);
  assert.equal(
    rows.filter((r) => String(r.sourceId).includes("loanpay_bankfix")).length,
    0,
  );
});

test("stale Sell Plus payment after endDate excluded the same way", async () => {
  const prisma = makePrisma({
    loans: [
      {
        id: "loan_7e9056bf74",
        companyName: "ИП Петров",
        bankName: "Sell Plus",
        currentDebt: 0,
        endDate: new Date("2026-07-03T00:00:00.000Z"),
      },
    ],
    paymentsByLoan: {
      loan_7e9056bf74: [
        {
          id: "cmq879zho005y20i5z8qwcst4",
          loanId: "loan_7e9056bf74",
          paymentDate: new Date("2026-10-23T09:00:00.000Z"),
          paid: true,
          principalAmount: 89254.62,
          interestAmount: 1413.81,
          totalAmount: 90668.43,
        },
      ],
    },
  });
  const rows = await getEffectiveFinanceTransactions({
    prisma,
    companyName: "ИП Петров",
    dateFrom: new Date("2026-10-19T00:00:00.000Z"),
    dateToExclusive: new Date("2026-10-26T00:00:00.000Z"),
    asOfDate: new Date("2026-10-25T00:00:00.000Z"),
  });
  assert.equal(rows.filter((r) => r.__effectiveFactSynthetic).length, 0);
});
