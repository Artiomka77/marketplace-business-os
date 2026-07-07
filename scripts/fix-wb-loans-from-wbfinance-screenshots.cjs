const { Pool } = require('pg');

const APPLY = String(process.env.APPLY || '').toLowerCase() === 'true';

const TARGETS = [
  {
    loanId: 'loan_dfd0049677',
    bankName: 'Wb Кредит Петров 1,2 млн',
    companyName: 'ИП Петров',
    contractNumber: '2025072800345',
    startDate: '2025-07-28',
    currentDebt: 718905.26,
    monthlyPayment: 25863.00,
    endDate: '2027-02-01',
    paymentFrequency: 'WEEKLY',
    payments: [
      ['2026-07-13', 22355.53, 3507.47, 25863.00],
      ['2026-07-20', 22464.60, 3398.40, 25863.00],
      ['2026-07-27', 22574.20, 3288.80, 25863.00],
      ['2026-08-03', 22684.34, 3178.66, 25863.00],
      ['2026-08-10', 22795.02, 3067.98, 25863.00],
      ['2026-08-17', 22906.23, 2956.77, 25863.00],
      ['2026-08-24', 23017.99, 2845.01, 25863.00],
      ['2026-08-31', 23130.29, 2732.71, 25863.00],
      ['2026-09-07', 23243.14, 2619.86, 25863.00],
      ['2026-09-14', 23356.54, 2506.46, 25863.00],
      ['2026-09-21', 23470.50, 2392.50, 25863.00],
      ['2026-09-28', 23585.01, 2277.99, 25863.00],
      ['2026-10-05', 23700.08, 2162.92, 25863.00],
      ['2026-10-12', 23815.71, 2047.29, 25863.00],
      ['2026-10-19', 23931.90, 1931.10, 25863.00],
      ['2026-10-26', 24048.66, 1814.34, 25863.00],
      ['2026-11-02', 24165.99, 1697.01, 25863.00],
      ['2026-11-09', 24283.90, 1579.10, 25863.00],
      ['2026-11-16', 24402.38, 1460.62, 25863.00],
      ['2026-11-23', 24521.43, 1341.57, 25863.00],
      ['2026-11-30', 24641.07, 1221.93, 25863.00],
      ['2026-12-07', 24761.29, 1101.71, 25863.00],
      ['2026-12-14', 24882.10, 980.90, 25863.00],
      ['2026-12-21', 25003.50, 859.50, 25863.00],
      ['2026-12-28', 25125.49, 737.51, 25863.00],
      ['2027-01-11', 50496.14, 1229.86, 51726.00],
      ['2027-01-18', 25494.44, 368.56, 25863.00],
      ['2027-01-25', 25618.82, 244.18, 25863.00],
      ['2027-02-01', 24428.97, 119.19, 24548.16],
    ],
  },
  {
    loanId: 'loan_a476637be3',
    bankName: 'Wb Кредит Лебедева 1,4 млн',
    companyName: 'ИП Лебедева',
    contractNumber: '2025122500014',
    startDate: '2025-12-25',
    currentDebt: 1137241.13,
    monthlyPayment: 24869.10,
    endDate: '2027-06-28',
    paymentFrequency: 'WEEKLY',
    payments: [
      ['2026-07-13', 18023.22, 6845.88, 24869.10],
      ['2026-07-20', 20155.51, 4713.59, 24869.10],
      ['2026-07-27', 20240.39, 4628.71, 24869.10],
      ['2026-08-03', 20325.63, 4543.47, 24869.10],
      ['2026-08-10', 20411.24, 4457.86, 24869.10],
      ['2026-08-17', 20497.20, 4371.90, 24869.10],
      ['2026-08-24', 20583.52, 4285.58, 24869.10],
      ['2026-08-31', 20670.21, 4198.89, 24869.10],
      ['2026-09-07', 20757.26, 4111.84, 24869.10],
      ['2026-09-14', 20844.68, 4024.42, 24869.10],
      ['2026-09-21', 20932.47, 3936.63, 24869.10],
      ['2026-09-28', 21020.63, 3848.47, 24869.10],
      ['2026-10-05', 21109.15, 3759.95, 24869.10],
      ['2026-10-12', 21198.06, 3671.04, 24869.10],
      ['2026-10-19', 21287.33, 3581.77, 24869.10],
      ['2026-10-26', 21376.98, 3492.12, 24869.10],
      ['2026-11-02', 21467.01, 3402.09, 24869.10],
      ['2026-11-09', 21557.42, 3311.68, 24869.10],
      ['2026-11-16', 21648.21, 3220.89, 24869.10],
      ['2026-11-23', 21739.38, 3129.72, 24869.10],
      ['2026-11-30', 21830.94, 3038.16, 24869.10],
      ['2026-12-07', 21922.88, 2946.22, 24869.10],
      ['2026-12-14', 22015.21, 2853.89, 24869.10],
      ['2026-12-21', 22107.92, 2761.18, 24869.10],
      ['2026-12-28', 22201.03, 2668.07, 24869.10],
      ['2027-01-11', 44589.06, 5149.14, 49738.20],
      ['2027-01-18', 22482.32, 2386.78, 24869.10],
      ['2027-01-25', 22577.00, 2292.10, 24869.10],
      ['2027-02-01', 22672.09, 2197.01, 24869.10],
      ['2027-02-08', 22767.57, 2101.53, 24869.10],
      ['2027-02-15', 22863.46, 2005.64, 24869.10],
      ['2027-02-24', 22959.75, 1909.35, 24869.10],
      ['2027-03-01', 23028.81, 1840.29, 24869.10],
      ['2027-03-09', 23153.43, 1715.67, 24869.10],
      ['2027-03-15', 23237.01, 1632.09, 24869.10],
      ['2027-03-22', 23348.80, 1520.30, 24869.10],
      ['2027-03-29', 23447.13, 1421.97, 24869.10],
      ['2027-04-05', 23545.88, 1323.22, 24869.10],
      ['2027-04-12', 23645.05, 1224.05, 24869.10],
      ['2027-04-19', 23744.63, 1124.47, 24869.10],
      ['2027-04-26', 23844.63, 1024.47, 24869.10],
      ['2027-05-04', 23945.05, 924.05, 24869.10],
      ['2027-05-11', 24031.49, 837.61, 24869.10],
      ['2027-05-17', 24132.64, 736.46, 24869.10],
      ['2027-05-24', 24248.74, 620.36, 24869.10],
      ['2027-05-31', 24350.86, 518.24, 24869.10],
      ['2027-06-07', 24453.41, 415.69, 24869.10],
      ['2027-06-15', 24556.40, 312.70, 24869.10],
      ['2027-06-21', 24645.05, 224.05, 24869.10],
      ['2027-06-28', 25047.39, 105.49, 25152.88],
    ],
  },
];

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function sumPayments(payments, index) {
  return round2(payments.reduce((sum, row) => sum + Number(row[index]), 0));
}

function dateOnly(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function buildPaymentId(loanId, index) {
  return `loanpay_wbfinance_${loanId.replace(/^loan_/, '')}_${String(index + 1).padStart(3, '0')}`;
}

function buildFinanceTransactionId(paymentId, kind) {
  return `fintr_wbfinance_${paymentId}_${kind}`;
}

function loanTargetTotals(target) {
  return {
    paymentsCount: target.payments.length,
    principal: sumPayments(target.payments, 1),
    interest: sumPayments(target.payments, 2),
    total: sumPayments(target.payments, 3),
  };
}

async function getCurrentState(client) {
  const loanIds = TARGETS.map((target) => target.loanId);

  const loans = await client.query(
    `
      SELECT
        "id", "companyName", "bankName", "contractNumber", "creditLimit", "currentDebt",
        "monthlyPayment", "interestRate", "startDate", "endDate", "paymentFrequency"
      FROM "Loan"
      WHERE "id" = ANY($1)
      ORDER BY "companyName", "bankName"
    `,
    [loanIds]
  );

  const payments = await client.query(
    `
      SELECT
        p."id", p."loanId", p."paymentDate", p."principalAmount", p."interestAmount", p."totalAmount", p."paid",
        l."companyName", l."bankName"
      FROM "LoanPayment" p
      JOIN "Loan" l ON l."id" = p."loanId"
      WHERE p."loanId" = ANY($1)
      ORDER BY l."bankName", p."paymentDate"
    `,
    [loanIds]
  );

  const paymentIds = payments.rows.map((row) => row.id);

  const planTransactions = await client.query(
    `
      SELECT
        "id", "companyName", "operationDate", "operationType", "category", "subcategory",
        "counterparty", "amount", "comment", "project", "transactionStatus", "sourceType", "sourceId"
      FROM "FinanceTransaction"
      WHERE "transactionStatus" = 'PLAN'
        AND (
          "sourceId" = ANY($1)
          OR "sourceId" = ANY($2)
          OR lower(coalesce("counterparty", '')) = ANY($3)
          OR lower(coalesce("project", '')) = ANY($3)
          OR lower(coalesce("comment", '')) LIKE ANY($4)
        )
      ORDER BY "operationDate", "companyName", "counterparty", "category"
    `,
    [
      loanIds,
      paymentIds,
      TARGETS.map((target) => target.bankName.toLowerCase()),
      TARGETS.map((target) => `%${target.bankName.toLowerCase()}%`),
    ]
  );

  const protectedNonPlan = await client.query(
    `
      SELECT
        "id", "companyName", "operationDate", "operationType", "category", "subcategory",
        "counterparty", "amount", "comment", "project", "transactionStatus", "sourceType", "sourceId"
      FROM "FinanceTransaction"
      WHERE "transactionStatus" <> 'PLAN'
        AND (
          "sourceId" = ANY($1)
          OR "sourceId" = ANY($2)
          OR lower(coalesce("counterparty", '')) = ANY($3)
          OR lower(coalesce("project", '')) = ANY($3)
          OR lower(coalesce("comment", '')) LIKE ANY($4)
        )
      ORDER BY "operationDate", "companyName", "counterparty", "category"
    `,
    [
      loanIds,
      paymentIds,
      TARGETS.map((target) => target.bankName.toLowerCase()),
      TARGETS.map((target) => `%${target.bankName.toLowerCase()}%`),
    ]
  );

  return {
    loans: loans.rows,
    payments: payments.rows,
    planTransactions: planTransactions.rows,
    protectedNonPlanTransactions: protectedNonPlan.rows,
  };
}

function buildChanges(currentState) {
  const currentLoansById = new Map(currentState.loans.map((loan) => [loan.id, loan]));
  const currentPaymentsByLoan = new Map();

  for (const payment of currentState.payments) {
    const rows = currentPaymentsByLoan.get(payment.loanId) || [];
    rows.push(payment);
    currentPaymentsByLoan.set(payment.loanId, rows);
  }

  return TARGETS.map((target) => {
    const currentLoan = currentLoansById.get(target.loanId);
    const currentPayments = currentPaymentsByLoan.get(target.loanId) || [];
    const targetTotals = loanTargetTotals(target);
    const currentTotals = {
      paymentsCount: currentPayments.length,
      principal: round2(currentPayments.reduce((sum, row) => sum + Number(row.principalAmount || 0), 0)),
      interest: round2(currentPayments.reduce((sum, row) => sum + Number(row.interestAmount || 0), 0)),
      total: round2(currentPayments.reduce((sum, row) => sum + Number(row.totalAmount || 0), 0)),
    };

    return {
      loanId: target.loanId,
      bankName: target.bankName,
      companyName: target.companyName,
      current: currentLoan ? {
        contractNumber: currentLoan.contractNumber,
        creditLimit: currentLoan.creditLimit === null ? null : Number(currentLoan.creditLimit),
        currentDebt: currentLoan.currentDebt === null ? null : Number(currentLoan.currentDebt),
        monthlyPayment: currentLoan.monthlyPayment === null ? null : Number(currentLoan.monthlyPayment),
        interestRate: currentLoan.interestRate === null ? null : Number(currentLoan.interestRate),
        startDate: dateOnly(currentLoan.startDate),
        endDate: dateOnly(currentLoan.endDate),
        paymentFrequency: currentLoan.paymentFrequency,
        payments: currentTotals,
      } : null,
      next: {
        contractNumber: target.contractNumber,
        creditLimit: currentLoan && currentLoan.creditLimit !== null ? Number(currentLoan.creditLimit) : null,
        currentDebt: target.currentDebt,
        monthlyPayment: target.monthlyPayment,
        interestRate: currentLoan && currentLoan.interestRate !== null ? Number(currentLoan.interestRate) : null,
        startDate: target.startDate,
        endDate: target.endDate,
        paymentFrequency: target.paymentFrequency,
        payments: targetTotals,
      },
      delta: currentLoan ? {
        currentDebt: round2(target.currentDebt - Number(currentLoan.currentDebt || 0)),
        monthlyPayment: round2(target.monthlyPayment - Number(currentLoan.monthlyPayment || 0)),
        paymentsCount: target.payments.length - currentPayments.length,
        paymentsTotal: round2(targetTotals.total - currentTotals.total),
      } : null,
    };
  });
}

async function applyChanges(client, currentState) {
  const now = new Date();
  const loanIds = TARGETS.map((target) => target.loanId);
  const oldPaymentIds = currentState.payments.map((payment) => payment.id);

  await client.query('BEGIN');

  try {
    await client.query(
      `
        DELETE FROM "FinanceTransaction"
        WHERE "transactionStatus" = 'PLAN'
          AND (
            "sourceId" = ANY($1)
            OR "sourceId" = ANY($2)
            OR lower(coalesce("counterparty", '')) = ANY($3)
            OR lower(coalesce("project", '')) = ANY($3)
            OR lower(coalesce("comment", '')) LIKE ANY($4)
          )
      `,
      [
        loanIds,
        oldPaymentIds,
        TARGETS.map((target) => target.bankName.toLowerCase()),
        TARGETS.map((target) => `%${target.bankName.toLowerCase()}%`),
      ]
    );

    await client.query(`DELETE FROM "LoanPayment" WHERE "loanId" = ANY($1)`, [loanIds]);

    for (const target of TARGETS) {
      await client.query(
        `
          UPDATE "Loan"
          SET
            "contractNumber" = $2,
            "currentDebt" = $3,
            "monthlyPayment" = $4,
            "startDate" = $5::date,
            "endDate" = $6::date,
            "paymentFrequency" = $7
          WHERE "id" = $1
        `,
        [
          target.loanId,
          target.contractNumber,
          target.currentDebt,
          target.monthlyPayment,
          target.startDate,
          target.endDate,
          target.paymentFrequency,
        ]
      );

      for (let index = 0; index < target.payments.length; index += 1) {
        const [paymentDate, principalAmount, interestAmount, totalAmount] = target.payments[index];
        const paymentId = buildPaymentId(target.loanId, index);

        await client.query(
          `
            INSERT INTO "LoanPayment" (
              "id", "loanId", "paymentDate", "principalAmount", "interestAmount", "totalAmount", "paid", "createdAt"
            )
            VALUES ($1, $2, $3::date, $4, $5, $6, false, $7)
          `,
          [paymentId, target.loanId, paymentDate, principalAmount, interestAmount, totalAmount, now]
        );

        await client.query(
          `
            INSERT INTO "FinanceTransaction" (
              "id", "companyName", "operationDate", "obligationDate", "operationType", "category", "subcategory",
              "counterparty", "amount", "bankAccount", "comment", "project", "isInternalTransfer",
              "transactionStatus", "sourceType", "sourceId", "createdAt"
            )
            VALUES
              ($1, $2, $3::date, $3::date, 'FINANCING', 'Тело кредита', null,
               $4, $5, null, $6, $4, false, 'PLAN', 'LOAN_PAYMENT', $7, $8),
              ($9, $2, $3::date, $3::date, 'FINANCING', 'Проценты по кредиту', null,
               $4, $10, null, $11, $4, false, 'PLAN', 'LOAN_PAYMENT', $7, $8)
          `,
          [
            buildFinanceTransactionId(paymentId, 'principal'),
            target.companyName,
            paymentDate,
            target.bankName,
            principalAmount,
            `Тело кредитного платежа: ${target.bankName}. Итого платеж: ${totalAmount}, тело: ${principalAmount}, проценты: ${interestAmount}`,
            paymentId,
            now,
            buildFinanceTransactionId(paymentId, 'interest'),
            interestAmount,
            `Проценты по кредитному платежу: ${target.bankName}. Итого платеж: ${totalAmount}, тело: ${principalAmount}, проценты: ${interestAmount}`,
          ]
        );
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  const client = await pool.connect();
  try {
    const currentState = await getCurrentState(client);
    const changes = buildChanges(currentState);
    const missing = changes.filter((change) => !change.current);
    const mismatched = changes.filter((change) => change.current && change.current.bankName !== change.bankName);

    const targetTotals = TARGETS.reduce((acc, target) => {
      const totals = loanTargetTotals(target);
      acc.currentDebt = round2(acc.currentDebt + target.currentDebt);
      acc.monthlyPayment = round2(acc.monthlyPayment + target.monthlyPayment);
      acc.futurePrincipal = round2(acc.futurePrincipal + totals.principal);
      acc.futureInterest = round2(acc.futureInterest + totals.interest);
      acc.futurePayments = round2(acc.futurePayments + totals.total);
      acc.paymentsCount += totals.paymentsCount;
      return acc;
    }, {
      currentDebt: 0,
      monthlyPayment: 0,
      futurePrincipal: 0,
      futureInterest: 0,
      futurePayments: 0,
      paymentsCount: 0,
    });

    const baseResult = {
      mode: APPLY ? 'APPLY' : 'DRY_RUN',
      applied: false,
      ok: missing.length === 0 && mismatched.length === 0 && currentState.protectedNonPlanTransactions.length === 0,
      generatedAt: new Date().toISOString(),
      message: APPLY
        ? 'Применение корректировки WB-кредитов.'
        : 'Проверка прошла без изменения базы. Для применения запустите с APPLY=true.',
      targetTotals,
      currentPlanTransactionsToReplace: {
        count: currentState.planTransactions.length,
        absTotal: round2(currentState.planTransactions.reduce((sum, row) => sum + Math.abs(Number(row.amount || 0)), 0)),
      },
      protectedNonPlanTransactions: currentState.protectedNonPlanTransactions.length,
      missingLoans: missing.map((change) => change.loanId),
      mismatchedLoans: mismatched.map((change) => ({ loanId: change.loanId, expected: change.bankName, actual: change.current.bankName })),
      changes,
    };

    if (!baseResult.ok) {
      console.log(JSON.stringify(baseResult, null, 2));
      process.exitCode = 1;
      return;
    }

    if (APPLY) {
      await applyChanges(client, currentState);
      const afterState = await getCurrentState(client);
      const afterChanges = buildChanges(afterState);

      console.log(JSON.stringify({
        ...baseResult,
        applied: true,
        ok: true,
        message: 'WB-кредиты и плановые операции успешно обновлены.',
        after: {
          loans: afterChanges.map((change) => change.next),
          planTransactions: {
            count: afterState.planTransactions.length,
            absTotal: round2(afterState.planTransactions.reduce((sum, row) => sum + Math.abs(Number(row.amount || 0)), 0)),
          },
          protectedNonPlanTransactions: afterState.protectedNonPlanTransactions.length,
        },
      }, null, 2));
      return;
    }

    console.log(JSON.stringify(baseResult, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
