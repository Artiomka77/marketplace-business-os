const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const LOAN_NAME = process.env.LOAN_NAME || 'Sell Plus';
const DATE_FROM = process.env.DATE_FROM || '2026-07-03';
const COMPANY_NAME = process.env.COMPANY_NAME || '';
const APPLY = process.env.APPLY === 'true';

function money(value) {
  const number = Number(value ?? 0);
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number.isFinite(number) ? number : 0) + ' ₽';
}

async function main() {
  const start = new Date(`${DATE_FROM}T00:00:00.000Z`);

  const loan = await prisma.loan.findFirst({
    where: {
      bankName: LOAN_NAME,
      ...(COMPANY_NAME ? { companyName: COMPANY_NAME } : {}),
    },
    include: {
      payments: {
        where: { paymentDate: { gte: start } },
        select: { id: true, paymentDate: true, paid: true },
      },
    },
  });

  if (!loan) {
    console.log(JSON.stringify({ ok: false, error: `Loan not found: ${LOAN_NAME}` }, null, 2));
    return;
  }

  const paymentIds = loan.payments.map((payment) => payment.id);

  const where = {
    companyName: loan.companyName,
    operationDate: { gte: start },
    sourceType: { in: ['LOAN_PAYMENT_PRINCIPAL', 'LOAN_PAYMENT_INTEREST'] },
    OR: [
      ...(paymentIds.length > 0 ? [{ sourceId: { in: paymentIds } }] : []),
      { sourceId: loan.id },
      { counterparty: loan.bankName },
      { bankAccount: loan.bankName },
      { comment: { contains: loan.bankName, mode: 'insensitive' } },
    ],
  };

  const rows = await prisma.financeTransaction.findMany({
    where,
    orderBy: [{ operationDate: 'asc' }, { createdAt: 'asc' }],
  });

  if (APPLY && rows.length > 0) {
    await prisma.financeTransaction.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  }

  console.log(JSON.stringify({
    ok: true,
    mode: APPLY ? 'APPLY_DELETE' : 'DRY_RUN_ONLY',
    loan: {
      id: loan.id,
      companyName: loan.companyName,
      bankName: loan.bankName,
      currentDebt: money(loan.currentDebt),
    },
    regularLoanPaymentTransactionsMatched: rows.length,
    rows: rows.map((row) => ({
      id: row.id,
      operationDate: row.operationDate,
      category: row.category,
      subcategory: row.subcategory,
      amount: money(row.amount),
      bankAccount: row.bankAccount,
      counterparty: row.counterparty,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      comment: row.comment,
    })),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
