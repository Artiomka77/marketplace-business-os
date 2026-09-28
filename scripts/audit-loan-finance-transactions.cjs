const { Pool } = require("pg");

const TARGET_LOANS = [
  "loan_4a576e763f", // Авто кредит УралСиб
  "loan_cf6b9d061f", // Альфа кредит
  "loan_bfec61bbc7", // Сбер ИП - 5 млн
  "loan_b05af6c78b", // Сбер ИП - 600 тр
  "loan_60debb8fb1", // Сбер ООО - 5 млн
  "loan_ffd0c8aa4f", // Сбер ООО - 600 р
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

function text(value) {
  return String(value ?? "").toLowerCase();
}

function includesAny(value, parts) {
  const source = text(value);
  return parts.some((part) => source.includes(text(part)));
}

function bankTokens(bankName) {
  const clean = text(bankName);
  const tokens = [clean];

  if (clean.includes("уралсиб")) tokens.push("уралсиб", "авто");
  if (clean.includes("альфа")) tokens.push("альфа");
  if (clean.includes("сбер")) tokens.push("сбер");
  if (clean.includes("ип")) tokens.push("ип");
  if (clean.includes("ооо")) tokens.push("ооо");

  return [...new Set(tokens.filter(Boolean))];
}

function txText(tx) {
  return [
    tx.category,
    tx.subcategory,
    tx.counterparty,
    tx.comment,
    tx.project,
    tx.sourceType,
    tx.sourceId,
  ].map((v) => String(v ?? "")).join(" ").toLowerCase();
}

async function main() {
  const loansResult = await pool.query(
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
    [TARGET_LOANS]
  );

  const paymentsResult = await pool.query(
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
    [TARGET_LOANS]
  );

  const paymentIds = paymentsResult.rows.map((row) => row.id);
  const loanIds = loansResult.rows.map((row) => row.id);

  const minDate = paymentsResult.rows.length
    ? paymentsResult.rows.map((row) => dateOnly(row.paymentDate)).sort()[0]
    : "2026-01-01";

  const maxDate = paymentsResult.rows.length
    ? paymentsResult.rows.map((row) => dateOnly(row.paymentDate)).sort().slice(-1)[0]
    : "2031-12-31";

  const companies = [...new Set(loansResult.rows.map((row) => row.companyName))];

  const transactionsResult = await pool.query(
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
        "bankAccount",
        "comment",
        "project",
        "transactionStatus",
        "sourceType",
        "sourceId"
      FROM "FinanceTransaction"
      WHERE "companyName" = ANY($1)
        AND "operationDate" >= $2::date
        AND "operationDate" <= $3::date
        AND (
          "sourceId" = ANY($4)
          OR "sourceId" = ANY($5)
          OR lower(coalesce("category", '')) LIKE '%кредит%'
          OR lower(coalesce("subcategory", '')) LIKE '%кредит%'
          OR lower(coalesce("counterparty", '')) LIKE '%кредит%'
          OR lower(coalesce("comment", '')) LIKE '%кредит%'
          OR lower(coalesce("project", '')) LIKE '%кредит%'
          OR lower(coalesce("category", '')) LIKE '%процент%'
          OR lower(coalesce("subcategory", '')) LIKE '%процент%'
          OR lower(coalesce("comment", '')) LIKE '%процент%'
          OR lower(coalesce("counterparty", '')) LIKE '%уралсиб%'
          OR lower(coalesce("counterparty", '')) LIKE '%альфа%'
          OR lower(coalesce("counterparty", '')) LIKE '%сбер%'
          OR lower(coalesce("comment", '')) LIKE '%уралсиб%'
          OR lower(coalesce("comment", '')) LIKE '%альфа%'
          OR lower(coalesce("comment", '')) LIKE '%сбер%'
        )
      ORDER BY "operationDate", "companyName", "category", "subcategory"
    `,
    [companies, minDate, maxDate, paymentIds, loanIds]
  );

  const transactions = transactionsResult.rows.map((tx) => ({
    ...tx,
    operationDate: dateOnly(tx.operationDate),
    obligationDate: dateOnly(tx.obligationDate),
    amount: money(tx.amount),
    absAmount: Math.abs(money(tx.amount)),
  }));

  const loans = loansResult.rows.map((loan) => ({
    ...loan,
    creditLimit: money(loan.creditLimit),
    currentDebt: money(loan.currentDebt),
    monthlyPayment: money(loan.monthlyPayment),
    interestRate: loan.interestRate === null ? null : money(loan.interestRate),
    startDate: dateOnly(loan.startDate),
    endDate: dateOnly(loan.endDate),
  }));

  const payments = paymentsResult.rows.map((payment) => ({
    ...payment,
    paymentDate: dateOnly(payment.paymentDate),
    principalAmount: money(payment.principalAmount),
    interestAmount: money(payment.interestAmount),
    totalAmount: money(payment.totalAmount),
  }));

  const paymentById = new Map(payments.map((payment) => [payment.id, payment]));

  const loanReports = loans.map((loan) => {
    const loanPayments = payments.filter((payment) => payment.loanId === loan.id);
    const tokens = bankTokens(loan.bankName);

    const expectedTotal = round2(
      loanPayments.reduce((sum, payment) => sum + payment.totalAmount, 0)
    );
    const expectedPrincipal = round2(
      loanPayments.reduce((sum, payment) => sum + payment.principalAmount, 0)
    );
    const expectedInterest = round2(
      loanPayments.reduce((sum, payment) => sum + payment.interestAmount, 0)
    );

    const matchedPaymentRows = loanPayments.map((payment) => {
      const linkedTransactions = transactions.filter(
        (tx) => tx.sourceId === payment.id || tx.sourceId === loan.id
      );

      const dateCandidateTransactions = transactions.filter((tx) => {
        if (tx.companyName !== loan.companyName) return false;
        if (tx.operationDate !== payment.paymentDate) return false;

        const sourceMatch = tx.sourceId === payment.id || tx.sourceId === loan.id;
        const bankMatch = includesAny(txText(tx), tokens);
        const creditMatch =
          includesAny(tx.category, ["кредит", "процент"]) ||
          includesAny(tx.subcategory, ["кредит", "процент"]) ||
          includesAny(tx.comment, ["кредит", "процент"]);

        return sourceMatch || bankMatch || creditMatch;
      });

      const linkedTotal = round2(
        linkedTransactions.reduce((sum, tx) => sum + tx.absAmount, 0)
      );

      const candidateTotal = round2(
        dateCandidateTransactions.reduce((sum, tx) => sum + tx.absAmount, 0)
      );

      return {
        paymentId: payment.id,
        paymentDate: payment.paymentDate,
        expectedTotal: round2(payment.totalAmount),
        expectedPrincipal: round2(payment.principalAmount),
        expectedInterest: round2(payment.interestAmount),
        paid: payment.paid,
        linkedTransactionsCount: linkedTransactions.length,
        linkedTransactionsTotal: linkedTotal,
        candidateTransactionsCount: dateCandidateTransactions.length,
        candidateTransactionsTotal: candidateTotal,
        status:
          Math.abs(candidateTotal - payment.totalAmount) <= 0.01
            ? "MATCH_BY_DATE"
            : linkedTransactions.length > 0 && Math.abs(linkedTotal - payment.totalAmount) <= 0.01
              ? "MATCH_BY_SOURCE"
              : candidateTotal === 0
                ? "NO_OPERATION_FOUND"
                : "AMOUNT_MISMATCH",
        candidateTransactions: dateCandidateTransactions.map((tx) => ({
          id: tx.id,
          operationDate: tx.operationDate,
          operationType: tx.operationType,
          category: tx.category,
          subcategory: tx.subcategory,
          counterparty: tx.counterparty,
          amount: tx.amount,
          transactionStatus: tx.transactionStatus,
          sourceType: tx.sourceType,
          sourceId: tx.sourceId,
          comment: tx.comment,
        })),
      };
    });

    const loanTransactions = transactions.filter((tx) => {
      if (tx.companyName !== loan.companyName) return false;
      if (tx.sourceId === loan.id) return true;
      if (loanPayments.some((payment) => payment.id === tx.sourceId)) return true;
      return includesAny(txText(tx), tokens);
    });

    const operationsTotal = round2(
      loanTransactions.reduce((sum, tx) => sum + tx.absAmount, 0)
    );

    return {
      loanId: loan.id,
      companyName: loan.companyName,
      bankName: loan.bankName,
      contractNumber: loan.contractNumber,
      currentDebt: loan.currentDebt,
      monthlyPayment: loan.monthlyPayment,
      endDate: loan.endDate,
      paymentsCount: loanPayments.length,
      expected: {
        principal: expectedPrincipal,
        interest: expectedInterest,
        total: expectedTotal,
      },
      operations: {
        count: loanTransactions.length,
        absTotal: operationsTotal,
        diffVsExpectedTotal: round2(operationsTotal - expectedTotal),
      },
      paymentStatuses: {
        matchedByDate: matchedPaymentRows.filter((row) => row.status === "MATCH_BY_DATE").length,
        matchedBySource: matchedPaymentRows.filter((row) => row.status === "MATCH_BY_SOURCE").length,
        noOperationFound: matchedPaymentRows.filter((row) => row.status === "NO_OPERATION_FOUND").length,
        amountMismatch: matchedPaymentRows.filter((row) => row.status === "AMOUNT_MISMATCH").length,
      },
      problemPayments: matchedPaymentRows.filter((row) =>
        ["NO_OPERATION_FOUND", "AMOUNT_MISMATCH"].includes(row.status)
      ),
      sampleMatchedPayments: matchedPaymentRows
        .filter((row) => ["MATCH_BY_DATE", "MATCH_BY_SOURCE"].includes(row.status))
        .slice(0, 5),
    };
  });

  const sourceTypeTotals = {};
  const categoryTotals = {};

  for (const tx of transactions) {
    const sourceKey = tx.sourceType || "NO_SOURCE_TYPE";
    const categoryKey = [tx.operationType, tx.category, tx.subcategory].join(" / ");

    sourceTypeTotals[sourceKey] = round2((sourceTypeTotals[sourceKey] || 0) + tx.absAmount);
    categoryTotals[categoryKey] = round2((categoryTotals[categoryKey] || 0) + tx.absAmount);
  }

  const orphanTransactions = transactions.filter((tx) => {
    if (!tx.sourceId) return false;
    if (loanIds.includes(tx.sourceId)) return false;
    if (paymentById.has(tx.sourceId)) return false;

    const looksLoanRelated =
      includesAny(tx.sourceType, ["loan", "credit", "кредит"]) ||
      includesAny(tx.category, ["кредит", "процент"]) ||
      includesAny(tx.subcategory, ["кредит", "процент"]) ||
      includesAny(tx.comment, ["кредит", "процент"]);

    return looksLoanRelated;
  });

  const result = {
    mode: "AUDIT_ONLY",
    applied: false,
    ok: true,
    generatedAt: new Date().toISOString(),
    period: {
      dateFrom: minDate,
      dateTo: maxDate,
    },
    checkedLoans: loans.length,
    checkedPayments: payments.length,
    scannedTransactions: transactions.length,
    totals: {
      expectedLoanPaymentsTotal: round2(
        payments.reduce((sum, payment) => sum + payment.totalAmount, 0)
      ),
      expectedPrincipal: round2(
        payments.reduce((sum, payment) => sum + payment.principalAmount, 0)
      ),
      expectedInterest: round2(
        payments.reduce((sum, payment) => sum + payment.interestAmount, 0)
      ),
      scannedFinanceTransactionsAbsTotal: round2(
        transactions.reduce((sum, tx) => sum + tx.absAmount, 0)
      ),
    },
    sourceTypeTotals,
    categoryTotals,
    orphanTransactions: orphanTransactions.map((tx) => ({
      id: tx.id,
      operationDate: tx.operationDate,
      companyName: tx.companyName,
      operationType: tx.operationType,
      category: tx.category,
      subcategory: tx.subcategory,
      counterparty: tx.counterparty,
      amount: tx.amount,
      sourceType: tx.sourceType,
      sourceId: tx.sourceId,
      comment: tx.comment,
    })),
    loanReports,
    conclusion: {
      loansUsingLoanPaymentWillBeUpdated: true,
      pagesUsingFinanceTransactionNeedSyncIfProblemsFound: true,
    },
  };

  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
