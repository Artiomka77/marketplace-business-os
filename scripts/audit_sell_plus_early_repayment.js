const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const LOAN_NAME = process.env.LOAN_NAME || 'Sell Plus';
const DATE_FROM = process.env.DATE_FROM || '2026-07-03';
const COMPANY_NAME = process.env.COMPANY_NAME || '';

function money(value) {
  const number = Number(value ?? 0);
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number.isFinite(number) ? number : 0) + ' ₽';
}

async function main() {
  const start = new Date(`${DATE_FROM}T00:00:00.000Z`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const loan = await prisma.loan.findFirst({
    where: {
      bankName: LOAN_NAME,
      ...(COMPANY_NAME ? { companyName: COMPANY_NAME } : {}),
    },
    include: {
      payments: {
        where: { paymentDate: { gte: start } },
        orderBy: { paymentDate: 'asc' },
        take: 20,
      },
    },
  });

  if (!loan) {
    console.log(JSON.stringify({ ok: false, error: `Loan not found: ${LOAN_NAME}` }, null, 2));
    return;
  }

  const operations = await prisma.financeTransaction.findMany({
    where: {
      operationDate: { gte: start },
      OR: [
        { sourceId: loan.id },
        { counterparty: loan.bankName },
        { bankAccount: loan.bankName },
        { comment: { contains: loan.bankName, mode: 'insensitive' } },
      ],
      sourceType: {
        in: [
          'LOAN_PAYMENT_PRINCIPAL',
          'LOAN_PAYMENT_INTEREST',
          'LOAN_EARLY_REPAYMENT',
        ],
      },
    },
    orderBy: [{ operationDate: 'asc' }, { createdAt: 'asc' }],
  });

  console.log(JSON.stringify({
    ok: true,
    loan: {
      id: loan.id,
      companyName: loan.companyName,
      bankName: loan.bankName,
      currentDebt: money(loan.currentDebt),
      monthlyPayment: money(loan.monthlyPayment),
      endDate: loan.endDate,
      futurePaymentsCount: loan.payments.length,
      futureUnpaidPaymentsCount: loan.payments.filter((p) => !p.paid).length,
    },
    operations: operations.map((row) => ({
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
