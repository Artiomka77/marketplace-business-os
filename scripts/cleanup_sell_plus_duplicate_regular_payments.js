/* eslint-disable no-console */
/**
 * Cleanup duplicate planned loan-payment finance transactions after full early repayment.
 * Uses pg directly instead of PrismaClient.
 * Default mode is DRY RUN. Set APPLY=true to delete matched regular loan payment rows.
 */

const { Client } = require('pg');

const LOAN_NAME = process.env.LOAN_NAME || 'Sell Plus';
const DATE_FROM = process.env.DATE_FROM || '2026-07-03';
const COMPANY_NAME = process.env.COMPANY_NAME || '';
const APPLY = String(process.env.APPLY || 'false').toLowerCase() === 'true';

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
      console.log('WARNING: multiple loans matched. Cleanup uses the first row. Set COMPANY_NAME to narrow the match.');
    }

    const loan = loans[0];

    const paymentRows = await query(
      client,
      `
        SELECT "id"
        FROM "LoanPayment"
        WHERE "loanId" = $1
          AND "paymentDate" >= $2::timestamp
      `,
      [loan.id, start]
    );

    const paymentIds = paymentRows.map((row) => row.id);

    const matchedRows = await query(
      client,
      `
        SELECT *
        FROM "FinanceTransaction"
        WHERE "companyName" = $1
          AND "operationDate" >= $2::timestamp
          AND "sourceType" IN ('LOAN_PAYMENT_PRINCIPAL', 'LOAN_PAYMENT_INTEREST')
          AND (
            "sourceId" = $3
            OR "sourceId" = ANY($4::text[])
            OR "counterparty" = $5
            OR "bankAccount" = $5
            OR COALESCE("comment", '') ILIKE ('%' || $5 || '%')
          )
        ORDER BY "operationDate" ASC, "createdAt" ASC
      `,
      [loan.companyName, start, loan.id, paymentIds, loan.bankName]
    );

    if (APPLY && matchedRows.length > 0) {
      await query(
        client,
        `
          DELETE FROM "FinanceTransaction"
          WHERE "id" = ANY($1::text[])
        `,
        [matchedRows.map((row) => row.id)]
      );
    }

    const result = {
      ok: true,
      mode: APPLY ? 'APPLY_DELETE' : 'DRY_RUN_ONLY',
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
      },
      futureLoanPaymentIdsCount: paymentIds.length,
      regularLoanPaymentTransactionsMatched: matchedRows.length,
      deleted: APPLY ? matchedRows.length : 0,
      rows: matchedRows.map((row) => ({
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
