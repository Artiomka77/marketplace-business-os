const { Pool } = require("pg");

const APPLY = String(process.env.APPLY ?? "").toLowerCase() === "true";

const SOURCE_TYPES = [
  "LOAN_PAYMENT_INTEREST",
  "LOAN_PAYMENT_PRINCIPAL",
];

const TARGETS = [
  {
    loanId: "loan_d335592b95",
    bankName: "Озон кредит 2 200 тыс",
    expectedCompanyName: "ИП Петров",
    contractNumber: "2541779-1195154",
    creditLimit: 4200000,
    currentDebt: 365180.97,
    monthlyPayment: 215480,
    interestRate: 1.5,
    startDate: "2025-07-30",
    endDate: "2026-07-24",
    paymentFrequency: "TWICE_MONTHLY_15_25",
    payments: [
      {
        paymentDate: "2026-07-15",
        principalAmount: 182610.43,
        interestAmount: 32869.57,
        totalAmount: 215480,
      },
      {
        paymentDate: "2026-07-24",
        principalAmount: 182570.54,
        interestAmount: 32869.46,
        totalAmount: 215440,
      },
    ],
  },
  {
    loanId: "loan_c6e408881b",
    bankName: "Озон кредит 990 тыс",
    expectedCompanyName: "ИП Петров",
    contractNumber: "2541779-2126950",
    creditLimit: 990000,
    currentDebt: 715000,
    monthlyPayment: 70840,
    interestRate: 1.6,
    startDate: "2026-01-28",
    endDate: "2027-07-28",
    paymentFrequency: "MONTHLY",
    payments: [
      "2026-07-28",
      "2026-08-28",
      "2026-09-28",
      "2026-10-28",
      "2026-11-30",
      "2026-12-28",
      "2027-01-28",
      "2027-03-02",
      "2027-03-29",
      "2027-04-28",
      "2027-05-28",
      "2027-06-28",
      "2027-07-28",
    ].map((paymentDate) => ({
      paymentDate,
      principalAmount: 55000,
      interestAmount: 15840,
      totalAmount: 70840,
    })),
  },
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

function money(value) {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function dateOnly(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function paymentIdFor(target, index, paymentDate) {
  const compactDate = String(paymentDate).replace(/-/g, "");
  const loanPart = target.loanId.replace(/^loan_/, "");
  return `loanpay_ozonfix_${loanPart}_${compactDate}_${String(index + 1).padStart(2, "0")}`;
}

function normalizePayment(target, payment, index, companyName) {
  const principalAmount = round2(payment.principalAmount);
  const interestAmount = round2(payment.interestAmount);
  const totalAmount = round2(payment.totalAmount);

  if (Math.abs(round2(principalAmount + interestAmount) - totalAmount) > 0.01) {
    throw new Error(
      `Некорректный платеж ${target.bankName} ${payment.paymentDate}: тело + проценты != итог`
    );
  }

  return {
    id: paymentIdFor(target, index, payment.paymentDate),
    loanId: target.loanId,
    companyName,
    bankName: target.bankName,
    paymentDate: payment.paymentDate,
    principalAmount,
    interestAmount,
    totalAmount,
    paid: false,
  };
}

function makePrincipalTransaction(payment) {
  return {
    id: `loan_principal_${payment.id}`,
    companyName: payment.companyName,
    operationDate: payment.paymentDate,
    obligationDate: payment.paymentDate,
    operationType: "FINANCING",
    category: "Тело кредита",
    subcategory: payment.bankName,
    counterparty: payment.bankName,
    amount: round2(payment.principalAmount),
    bankAccount: null,
    comment: `Тело кредитного платежа: ${payment.bankName}. Итого платеж: ${round2(payment.totalAmount)}, тело: ${round2(payment.principalAmount)}, проценты: ${round2(payment.interestAmount)}`,
    project: null,
    isInternalTransfer: false,
    transferGroupId: null,
    transferDirection: null,
    transactionStatus: "PLAN",
    sourceType: "LOAN_PAYMENT_PRINCIPAL",
    sourceId: payment.id,
  };
}

function makeInterestTransaction(payment) {
  return {
    id: `loan_interest_${payment.id}`,
    companyName: payment.companyName,
    operationDate: payment.paymentDate,
    obligationDate: payment.paymentDate,
    operationType: "EXPENSE",
    category: "Проценты по кредиту",
    subcategory: payment.bankName,
    counterparty: payment.bankName,
    amount: round2(payment.interestAmount),
    bankAccount: null,
    comment: `Проценты по кредитному платежу: ${payment.bankName}. Итого платеж: ${round2(payment.totalAmount)}, тело: ${round2(payment.principalAmount)}, проценты: ${round2(payment.interestAmount)}`,
    project: null,
    isInternalTransfer: false,
    transferGroupId: null,
    transferDirection: null,
    transactionStatus: "PLAN",
    sourceType: "LOAN_PAYMENT_INTEREST",
    sourceId: payment.id,
  };
}

function makeFinanceTransactions(payments) {
  const result = [];

  for (const payment of payments) {
    if (round2(payment.principalAmount) > 0) {
      result.push(makePrincipalTransaction(payment));
    }

    if (round2(payment.interestAmount) > 0) {
      result.push(makeInterestTransaction(payment));
    }
  }

  return result;
}

async function insertLoanPayment(client, payment) {
  await client.query(
    `
      INSERT INTO "LoanPayment" (
        "id",
        "loanId",
        "paymentDate",
        "principalAmount",
        "interestAmount",
        "totalAmount",
        "paid",
        "createdAt"
      )
      VALUES ($1, $2, $3::date, $4, $5, $6, $7, now())
    `,
    [
      payment.id,
      payment.loanId,
      payment.paymentDate,
      payment.principalAmount,
      payment.interestAmount,
      payment.totalAmount,
      payment.paid,
    ]
  );
}

async function insertFinanceTransaction(client, tx) {
  await client.query(
    `
      INSERT INTO "FinanceTransaction" (
        "id",
        "companyName",
        "operationDate",
        "obligationDate",
        "operationType",
        "category",
        "subcategory",
        "counterparty",
        "amount",
        "bankAccount",
        "comment",
        "project",
        "isInternalTransfer",
        "transferGroupId",
        "transferDirection",
        "transactionStatus",
        "sourceType",
        "sourceId",
        "createdAt"
      )
      VALUES (
        $1, $2, $3::date, $4::date, $5, $6, $7, $8, $9,
        $10, $11, $12, $13, $14, $15, $16, $17, $18, now()
      )
    `,
    [
      tx.id,
      tx.companyName,
      tx.operationDate,
      tx.obligationDate,
      tx.operationType,
      tx.category,
      tx.subcategory,
      tx.counterparty,
      tx.amount,
      tx.bankAccount,
      tx.comment,
      tx.project,
      tx.isInternalTransfer,
      tx.transferGroupId,
      tx.transferDirection,
      tx.transactionStatus,
      tx.sourceType,
      tx.sourceId,
    ]
  );
}

async function loadCurrent(client) {
  const loanIds = TARGETS.map((target) => target.loanId);
  const bankNames = TARGETS.map((target) => target.bankName);

  const loansResult = await client.query(
    `
      SELECT
        "id",
        "companyName",
        "bankName",
        "contractNumber",
        "creditLimit",
        "currentDebt",
        "monthlyPayment",
        "interestRate",
        "startDate",
        "endDate",
        "paymentFrequency"
      FROM "Loan"
      WHERE "id" = ANY($1)
      ORDER BY "bankName"
    `,
    [loanIds]
  );

  const loans = loansResult.rows.map((loan) => ({
    ...loan,
    creditLimit: money(loan.creditLimit),
    currentDebt: money(loan.currentDebt),
    monthlyPayment: money(loan.monthlyPayment),
    interestRate: loan.interestRate === null ? null : money(loan.interestRate),
    startDate: dateOnly(loan.startDate),
    endDate: dateOnly(loan.endDate),
  }));

  if (loans.length !== TARGETS.length) {
    const found = new Set(loans.map((loan) => loan.id));
    const missing = loanIds.filter((id) => !found.has(id));
    throw new Error(`Найдены не все целевые кредиты. Missing: ${missing.join(", ")}`);
  }

  for (const target of TARGETS) {
    const loan = loans.find((item) => item.id === target.loanId);
    if (!loan) {
      throw new Error(`Кредит не найден: ${target.loanId}`);
    }
    if (loan.bankName !== target.bankName) {
      throw new Error(
        `Остановлено: loanId ${target.loanId} имеет bankName "${loan.bankName}", ожидалось "${target.bankName}"`
      );
    }
    if (loan.companyName !== target.expectedCompanyName) {
      throw new Error(
        `Остановлено: loanId ${target.loanId} имеет companyName "${loan.companyName}", ожидалось "${target.expectedCompanyName}"`
      );
    }
  }

  const paymentsResult = await client.query(
    `
      SELECT
        p."id",
        p."loanId",
        p."paymentDate",
        p."principalAmount",
        p."interestAmount",
        p."totalAmount",
        p."paid",
        l."companyName",
        l."bankName"
      FROM "LoanPayment" p
      JOIN "Loan" l ON l."id" = p."loanId"
      WHERE p."loanId" = ANY($1)
      ORDER BY l."bankName", p."paymentDate"
    `,
    [loanIds]
  );

  const payments = paymentsResult.rows.map((payment) => ({
    ...payment,
    paymentDate: dateOnly(payment.paymentDate),
    principalAmount: money(payment.principalAmount),
    interestAmount: money(payment.interestAmount),
    totalAmount: money(payment.totalAmount),
  }));

  const planTransactionsResult = await client.query(
    `
      SELECT
        "id",
        "companyName",
        "operationDate",
        "obligationDate",
        "operationType",
        "category",
        "subcategory",
        "counterparty",
        "amount",
        "comment",
        "transactionStatus",
        "sourceType",
        "sourceId"
      FROM "FinanceTransaction"
      WHERE "sourceType" = ANY($1)
        AND "transactionStatus" = 'PLAN'
        AND (
          "subcategory" = ANY($2)
          OR "counterparty" = ANY($2)
        )
      ORDER BY "operationDate", "subcategory", "sourceType"
    `,
    [SOURCE_TYPES, bankNames]
  );

  const planTransactions = planTransactionsResult.rows.map((tx) => ({
    ...tx,
    operationDate: dateOnly(tx.operationDate),
    obligationDate: dateOnly(tx.obligationDate),
    amount: money(tx.amount),
  }));

  const protectedTransactionsResult = await client.query(
    `
      SELECT
        "id",
        "companyName",
        "operationDate",
        "operationType",
        "category",
        "subcategory",
        "counterparty",
        "amount",
        "transactionStatus",
        "sourceType",
        "sourceId"
      FROM "FinanceTransaction"
      WHERE "sourceType" = ANY($1)
        AND coalesce("transactionStatus", '') <> 'PLAN'
        AND (
          "subcategory" = ANY($2)
          OR "counterparty" = ANY($2)
        )
      ORDER BY "operationDate", "subcategory", "sourceType"
    `,
    [SOURCE_TYPES, bankNames]
  );

  const protectedTransactions = protectedTransactionsResult.rows.map((tx) => ({
    ...tx,
    operationDate: dateOnly(tx.operationDate),
    amount: money(tx.amount),
  }));

  const nextPayments = TARGETS.flatMap((target) => {
    const loan = loans.find((item) => item.id === target.loanId);
    return target.payments.map((payment, index) =>
      normalizePayment(target, payment, index, loan.companyName)
    );
  });

  const nextFinanceTransactions = makeFinanceTransactions(nextPayments);

  return {
    loans,
    payments,
    planTransactions,
    protectedTransactions,
    nextPayments,
    nextFinanceTransactions,
    bankNames,
  };
}

function sumAmounts(rows, key) {
  return round2(rows.reduce((sum, row) => sum + money(row[key]), 0));
}

function summarize(data) {
  const currentByLoan = data.loans.map((loan) => {
    const currentPayments = data.payments.filter((payment) => payment.loanId === loan.id);
    const nextPayments = data.nextPayments.filter((payment) => payment.loanId === loan.id);
    const currentPlanTransactions = data.planTransactions.filter(
      (tx) => tx.subcategory === loan.bankName || tx.counterparty === loan.bankName
    );
    const nextPlanTransactions = data.nextFinanceTransactions.filter(
      (tx) => tx.subcategory === loan.bankName || tx.counterparty === loan.bankName
    );
    const target = TARGETS.find((item) => item.loanId === loan.id);

    return {
      loanId: loan.id,
      companyName: loan.companyName,
      bankName: loan.bankName,
      before: {
        contractNumber: loan.contractNumber,
        creditLimit: loan.creditLimit,
        currentDebt: loan.currentDebt,
        monthlyPayment: loan.monthlyPayment,
        interestRate: loan.interestRate,
        startDate: loan.startDate,
        endDate: loan.endDate,
        paymentFrequency: loan.paymentFrequency,
        paymentsCount: currentPayments.length,
        paymentsPrincipal: sumAmounts(currentPayments, "principalAmount"),
        paymentsInterest: sumAmounts(currentPayments, "interestAmount"),
        paymentsTotal: sumAmounts(currentPayments, "totalAmount"),
        planFinanceTransactionsCount: currentPlanTransactions.length,
        planFinanceTransactionsTotal: round2(
          currentPlanTransactions.reduce((sum, tx) => sum + Math.abs(money(tx.amount)), 0)
        ),
      },
      next: {
        contractNumber: target.contractNumber,
        creditLimit: target.creditLimit,
        currentDebt: target.currentDebt,
        monthlyPayment: target.monthlyPayment,
        interestRate: target.interestRate,
        startDate: target.startDate,
        endDate: target.endDate,
        paymentFrequency: target.paymentFrequency,
        paymentsCount: nextPayments.length,
        paymentsPrincipal: sumAmounts(nextPayments, "principalAmount"),
        paymentsInterest: sumAmounts(nextPayments, "interestAmount"),
        paymentsTotal: sumAmounts(nextPayments, "totalAmount"),
        planFinanceTransactionsCount: nextPlanTransactions.length,
        planFinanceTransactionsTotal: round2(
          nextPlanTransactions.reduce((sum, tx) => sum + Math.abs(money(tx.amount)), 0)
        ),
      },
      delta: {
        currentDebt: round2(target.currentDebt - loan.currentDebt),
        monthlyPayment: round2(target.monthlyPayment - loan.monthlyPayment),
        paymentsCount: nextPayments.length - currentPayments.length,
      },
    };
  });

  return {
    targetLoans: data.loans.length,
    currentLoanPayments: data.payments.length,
    nextLoanPayments: data.nextPayments.length,
    currentPlanFinanceTransactions: data.planTransactions.length,
    nextPlanFinanceTransactions: data.nextFinanceTransactions.length,
    protectedNonPlanTransactions: data.protectedTransactions.length,
    currentTotals: {
      currentDebt: sumAmounts(data.loans, "currentDebt"),
      loanPaymentsPrincipal: sumAmounts(data.payments, "principalAmount"),
      loanPaymentsInterest: sumAmounts(data.payments, "interestAmount"),
      loanPaymentsTotal: sumAmounts(data.payments, "totalAmount"),
      planFinanceTransactionsTotal: round2(
        data.planTransactions.reduce((sum, tx) => sum + Math.abs(money(tx.amount)), 0)
      ),
    },
    nextTotals: {
      currentDebt: round2(TARGETS.reduce((sum, target) => sum + target.currentDebt, 0)),
      loanPaymentsPrincipal: sumAmounts(data.nextPayments, "principalAmount"),
      loanPaymentsInterest: sumAmounts(data.nextPayments, "interestAmount"),
      loanPaymentsTotal: sumAmounts(data.nextPayments, "totalAmount"),
      planFinanceTransactionsTotal: round2(
        data.nextFinanceTransactions.reduce((sum, tx) => sum + Math.abs(money(tx.amount)), 0)
      ),
    },
    byLoan: currentByLoan,
  };
}

async function applyChanges(client, beforeData) {
  await client.query("BEGIN");

  const loanIds = TARGETS.map((target) => target.loanId);

  const deletePlanTransactionsResult = await client.query(
    `
      DELETE FROM "FinanceTransaction"
      WHERE "sourceType" = ANY($1)
        AND "transactionStatus" = 'PLAN'
        AND (
          "subcategory" = ANY($2)
          OR "counterparty" = ANY($2)
        )
    `,
    [SOURCE_TYPES, beforeData.bankNames]
  );

  const deletePaymentsResult = await client.query(
    `DELETE FROM "LoanPayment" WHERE "loanId" = ANY($1)`,
    [loanIds]
  );

  for (const target of TARGETS) {
    await client.query(
      `
        UPDATE "Loan"
        SET
          "contractNumber" = $2,
          "creditLimit" = $3,
          "currentDebt" = $4,
          "monthlyPayment" = $5,
          "interestRate" = $6,
          "startDate" = $7::date,
          "endDate" = $8::date,
          "paymentFrequency" = $9
        WHERE "id" = $1
      `,
      [
        target.loanId,
        target.contractNumber,
        target.creditLimit,
        target.currentDebt,
        target.monthlyPayment,
        target.interestRate,
        target.startDate,
        target.endDate,
        target.paymentFrequency,
      ]
    );
  }

  for (const payment of beforeData.nextPayments) {
    await insertLoanPayment(client, payment);
  }

  for (const tx of beforeData.nextFinanceTransactions) {
    await insertFinanceTransaction(client, tx);
  }

  await client.query("COMMIT");

  return {
    updatedLoans: TARGETS.length,
    deletedLoanPayments: deletePaymentsResult.rowCount,
    insertedLoanPayments: beforeData.nextPayments.length,
    deletedPlanFinanceTransactions: deletePlanTransactionsResult.rowCount,
    insertedPlanFinanceTransactions: beforeData.nextFinanceTransactions.length,
  };
}

async function main() {
  const client = await pool.connect();

  try {
    const beforeData = await loadCurrent(client);
    const beforeSummary = summarize(beforeData);

    let apply = null;
    let after = null;

    if (APPLY) {
      apply = await applyChanges(client, beforeData);
      const afterData = await loadCurrent(client);
      after = summarize(afterData);
    }

    const result = {
      mode: APPLY ? "APPLY" : "DRY_RUN",
      applied: APPLY,
      ok: true,
      generatedAt: new Date().toISOString(),
      message: APPLY
        ? "Озон-кредиты и плановые финансовые операции синхронизированы."
        : "Проверка прошла. База не изменена. Для применения запустите с APPLY=true.",
      targets: TARGETS.map((target) => ({
        loanId: target.loanId,
        bankName: target.bankName,
        contractNumber: target.contractNumber,
        currentDebt: target.currentDebt,
        monthlyPayment: target.monthlyPayment,
        endDate: target.endDate,
        paymentsCount: target.payments.length,
      })),
      before: beforeSummary,
      protectedNonPlanTransactionsSample: beforeData.protectedTransactions.slice(0, 20),
      apply,
      after,
    };

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
