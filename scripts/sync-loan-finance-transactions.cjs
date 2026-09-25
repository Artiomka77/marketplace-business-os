const { Pool } = require("pg");

const APPLY = String(process.env.APPLY ?? "").toLowerCase() === "true";

const TARGET_LOAN_IDS = [
  "loan_4a576e763f", // Авто кредит УралСиб
  "loan_cf6b9d061f", // Альфа кредит
  "loan_bfec61bbc7", // Сбер ИП - 5 млн
  "loan_b05af6c78b", // Сбер ИП - 600 тр
  "loan_60debb8fb1", // Сбер ООО - 5 млн
  "loan_ffd0c8aa4f", // Сбер ООО - 600 р
];

const SOURCE_TYPES = [
  "LOAN_PAYMENT_INTEREST",
  "LOAN_PAYMENT_PRINCIPAL",
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

async function loadData(client) {
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
      ORDER BY "companyName", "bankName"
    `,
    [TARGET_LOAN_IDS]
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

  if (loans.length !== TARGET_LOAN_IDS.length) {
    const found = new Set(loans.map((loan) => loan.id));
    const missing = TARGET_LOAN_IDS.filter((id) => !found.has(id));
    throw new Error(`Найдены не все целевые кредиты. Missing: ${missing.join(", ")}`);
  }

  const bankNames = loans.map((loan) => loan.bankName);

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
    [TARGET_LOAN_IDS]
  );

  const payments = paymentsResult.rows.map((payment) => ({
    ...payment,
    paymentDate: dateOnly(payment.paymentDate),
    principalAmount: money(payment.principalAmount),
    interestAmount: money(payment.interestAmount),
    totalAmount: money(payment.totalAmount),
  }));

  const existingTransactionsResult = await client.query(
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

  const existingTransactions = existingTransactionsResult.rows.map((tx) => ({
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

  const newTransactions = [];

  for (const payment of payments) {
    if (round2(payment.principalAmount) > 0) {
      newTransactions.push(makePrincipalTransaction(payment));
    }

    if (round2(payment.interestAmount) > 0) {
      newTransactions.push(makeInterestTransaction(payment));
    }
  }

  const currentPaymentIds = new Set(payments.map((payment) => payment.id));
  const oldSourceRows = existingTransactions.filter((tx) => !currentPaymentIds.has(tx.sourceId));
  const alreadyCurrentRows = existingTransactions.filter((tx) => currentPaymentIds.has(tx.sourceId));

  return {
    loans,
    bankNames,
    payments,
    existingTransactions,
    protectedTransactions,
    newTransactions,
    oldSourceRows,
    alreadyCurrentRows,
  };
}

function summarize(data) {
  const existingTotal = round2(data.existingTransactions.reduce((sum, tx) => sum + Math.abs(tx.amount), 0));
  const newTotal = round2(data.newTransactions.reduce((sum, tx) => sum + Math.abs(tx.amount), 0));
  const expectedPrincipal = round2(data.payments.reduce((sum, p) => sum + p.principalAmount, 0));
  const expectedInterest = round2(data.payments.reduce((sum, p) => sum + p.interestAmount, 0));
  const expectedTotal = round2(data.payments.reduce((sum, p) => sum + p.totalAmount, 0));

  const byLoan = data.loans.map((loan) => {
    const payments = data.payments.filter((payment) => payment.loanId === loan.id);
    const existing = data.existingTransactions.filter((tx) => tx.subcategory === loan.bankName || tx.counterparty === loan.bankName);
    const next = data.newTransactions.filter((tx) => tx.subcategory === loan.bankName || tx.counterparty === loan.bankName);

    return {
      loanId: loan.id,
      companyName: loan.companyName,
      bankName: loan.bankName,
      paymentsCount: payments.length,
      currentDebt: round2(loan.currentDebt),
      expectedLoanPaymentTotal: round2(payments.reduce((sum, p) => sum + p.totalAmount, 0)),
      existingFinanceTransactions: {
        count: existing.length,
        total: round2(existing.reduce((sum, tx) => sum + Math.abs(tx.amount), 0)),
        oldSourceRows: existing.filter((tx) => !payments.some((p) => p.id === tx.sourceId)).length,
      },
      nextFinanceTransactions: {
        count: next.length,
        total: round2(next.reduce((sum, tx) => sum + Math.abs(tx.amount), 0)),
      },
    };
  });

  return {
    loans: data.loans.length,
    payments: data.payments.length,
    existingPlanFinanceTransactions: data.existingTransactions.length,
    existingPlanFinanceTransactionsTotal: existingTotal,
    existingOldSourceRows: data.oldSourceRows.length,
    existingAlreadyCurrentRows: data.alreadyCurrentRows.length,
    protectedNonPlanTransactions: data.protectedTransactions.length,
    nextFinanceTransactions: data.newTransactions.length,
    nextFinanceTransactionsTotal: newTotal,
    expectedPrincipal,
    expectedInterest,
    expectedTotal,
    diffNextVsExpectedTotal: round2(newTotal - expectedTotal),
    byLoan,
  };
}

async function main() {
  const client = await pool.connect();

  try {
    const beforeData = await loadData(client);
    const summaryBefore = summarize(beforeData);

    let appliedDetails = null;

    if (APPLY) {
      await client.query("BEGIN");

      const deleteResult = await client.query(
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

      for (const tx of beforeData.newTransactions) {
        await insertFinanceTransaction(client, tx);
      }

      await client.query("COMMIT");

      const afterData = await loadData(client);
      appliedDetails = {
        deletedPlanRows: deleteResult.rowCount,
        insertedPlanRows: beforeData.newTransactions.length,
        after: summarize(afterData),
      };
    }

    const result = {
      mode: APPLY ? "APPLY" : "DRY_RUN",
      applied: APPLY,
      ok: true,
      generatedAt: new Date().toISOString(),
      message: APPLY
        ? "Синхронизация плановых финансовых операций по 6 кредитам выполнена."
        : "Проверка прошла. База не изменена. Для применения запустите с APPLY=true.",
      before: summaryBefore,
      protectedNonPlanTransactionsSample: beforeData.protectedTransactions.slice(0, 20),
      apply: appliedDetails,
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
