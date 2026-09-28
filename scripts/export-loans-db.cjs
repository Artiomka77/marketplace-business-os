const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

function money(value) {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function dateOnly(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

async function main() {
  const loansResult = await pool.query(`
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
      "paymentFrequency",
      "createdAt"
    FROM "Loan"
    ORDER BY "companyName" ASC, "bankName" ASC, "createdAt" ASC
  `);

  const paymentsResult = await pool.query(`
    SELECT
      "id",
      "loanId",
      "paymentDate",
      "principalAmount",
      "interestAmount",
      "totalAmount",
      "paid"
    FROM "LoanPayment"
    ORDER BY "paymentDate" ASC
  `);

  const paymentsByLoan = new Map();

  for (const payment of paymentsResult.rows) {
    if (!paymentsByLoan.has(payment.loanId)) {
      paymentsByLoan.set(payment.loanId, []);
    }

    paymentsByLoan.get(payment.loanId).push({
      id: payment.id,
      paymentDate: dateOnly(payment.paymentDate),
      principalAmount: money(payment.principalAmount),
      interestAmount: money(payment.interestAmount),
      totalAmount: money(payment.totalAmount),
      paid: payment.paid,
    });
  }

  const result = loansResult.rows.map((loan) => ({
    id: loan.id,
    companyName: loan.companyName,
    bankName: loan.bankName,
    contractNumber: loan.contractNumber,
    creditLimit: money(loan.creditLimit),
    currentDebt: money(loan.currentDebt),
    monthlyPayment: money(loan.monthlyPayment),
    interestRate: money(loan.interestRate),
    startDate: dateOnly(loan.startDate),
    endDate: dateOnly(loan.endDate),
    paymentFrequency: loan.paymentFrequency,
    paymentsCount: (paymentsByLoan.get(loan.id) ?? []).length,
    payments: paymentsByLoan.get(loan.id) ?? [],
  }));

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
