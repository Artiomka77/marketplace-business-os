/* eslint-disable no-console */
/**
 * Safe audit for Sell Plus early repayment.
 * Uses pg directly instead of PrismaClient, so it works in the temporary Node container.
 * Does not change DB data.
 */

const { Client } = require('pg');

const LOAN_NAME = process.env.LOAN_NAME || 'Sell Plus';
const DATE_FROM = process.env.DATE_FROM || '2026-07-03';
const COMPANY_NAME = process.env.COMPANY_NAME || '';

function toNumber(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const number = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(number) ? number : 0;
}

function money(value) {
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(toNumber(value)) + ' ₽';
}

function dateOnly(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().slice(0, 10);
}

function jsonSafe(value) {
  return JSON.stringify(
    value,
    (key, val) => {
      if (val instanceof Date) return val.toISOString();
      return val;
    },
    2
  );
}

function mustGetDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is missing');
  return url;
}

async function query(client, text, params = []) {
  const result = await client.query(text, params);
  return result.rows;
}

async function main() {
  const start = `${DATE_FROM}T00:00:00.000Z`;

  const client = new Client({ connectionString: mustGetDatabaseUrl() });
  await client.connect();

  try {
    const loans = await query(
      client,
      `
        SELECT *
        FROM "Loan"
        WHERE "bankName" = $1
          AND ($2::text = '' OR "companyName" = $2::text)
        ORDER BY "companyName" ASC, "createdAt" DESC
        LIMIT 5
      `,
      [LOAN_NAME, COMPANY_NAME]
    );

    if (!loans.length) {
      console.log(jsonSafe({ ok: false, error: `Loan not found: ${LOAN_NAME}`, companyName: COMPANY_NAME || null }));
      return;
    }

    if (loans.length > 1) {
      console.log('WARNING: multiple loans matched. Audit uses the first row. Set COMPANY_NAME to narrow the match.');
    }

    const loan = loans[0];

    const payments = await query(
      client,
      `
        SELECT *
        FROM "LoanPayment"
        WHERE "loanId" = $1
          AND "paymentDate" >= $2::timestamp
        ORDER BY "paymentDate" ASC
        LIMIT 30
      `,
      [loan.id, start]
    );

    const operations = await query(
      client,
      `
        SELECT *
        FROM "FinanceTransaction"
        WHERE "operationDate" >= $2::timestamp
          AND "sourceType" IN (
            'LOAN_PAYMENT_PRINCIPAL',
            'LOAN_PAYMENT_INTEREST',
            'LOAN_EARLY_REPAYMENT'
          )
          AND (
            "sourceId" = $1
            OR "counterparty" = $3
            OR "bankAccount" = $3
            OR COALESCE("comment", '') ILIKE ('%' || $3 || '%')
          )
        ORDER BY "operationDate" ASC, "createdAt" ASC
      `,
      [loan.id, start, loan.bankName]
    );

    const regularRows = operations.filter((row) =>
      ['LOAN_PAYMENT_PRINCIPAL', 'LOAN_PAYMENT_INTEREST'].includes(row.sourceType)
    );
    const earlyRows = operations.filter((row) => row.sourceType === 'LOAN_EARLY_REPAYMENT');

    const result = {
      ok: true,
      mode: 'AUDIT_ONLY_NO_CHANGES',
      params: {
        loanName: LOAN_NAME,
        dateFrom: DATE_FROM,
        companyName: COMPANY_NAME || null,
      },
      loan: {
        id: loan.id,
        companyName: loan.companyName,
        bankName: loan.bankName,
        currentDebt: money(loan.currentDebt),
        monthlyPayment: money(loan.monthlyPayment),
        endDate: dateOnly(loan.endDate),
      },
      futurePayments: {
        count: payments.length,
        unpaidCount: payments.filter((payment) => !payment.paid).length,
        rows: payments.map((payment) => ({
          id: payment.id,
          paymentDate: dateOnly(payment.paymentDate),
          principalAmount: money(payment.principalAmount),
          interestAmount: money(payment.interestAmount),
          totalAmount: money(payment.totalAmount),
          paid: payment.paid,
        })),
      },
      financeOperations: {
        totalMatched: operations.length,
        regularLoanPaymentRows: regularRows.length,
        earlyRepaymentRows: earlyRows.length,
        rows: operations.map((row) => ({
          id: row.id,
          operationDate: dateOnly(row.operationDate),
          obligationDate: dateOnly(row.obligationDate),
          operationType: row.operationType,
          category: row.category,
          subcategory: row.subcategory,
          amount: money(row.amount),
          bankAccount: row.bankAccount,
          counterparty: row.counterparty,
          sourceType: row.sourceType,
          sourceId: row.sourceId,
          comment: row.comment,
        })),
      },
    };

    console.log(jsonSafe(result));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
