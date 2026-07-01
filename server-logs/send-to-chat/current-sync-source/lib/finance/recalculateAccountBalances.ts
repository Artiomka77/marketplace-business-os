import { prisma } from "@/lib/prisma";
import {
  buildFinanceCategoryTreatmentIndex,
  getFinanceTransactionCashEffect,
} from "@/lib/finance/financeMetrics";

function getAmount(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function accountKey(companyName: string, bankAccount: string) {
  return `${companyName}|||${bankAccount}`;
}

export async function recalculateAccountBalances() {
  const [accounts, categories, operations] = await Promise.all([
    prisma.financeAccount.findMany({
      where: {
        isActive: true,
      },
    }),

    prisma.financeCategory.findMany({
      where: {
        isActive: true,
      },
      orderBy: [
        { categoryType: "asc" },
        { sortOrder: "asc" },
        { name: "asc" },
      ],
    }),

    prisma.financeTransaction.findMany({
      where: {
        bankAccount: {
          not: null,
        },

        // В текущий остаток счёта входят только фактические операции.
        // Плановые операции нужны для календаря и прогноза, но не должны
        // уменьшать currentBalance заранее.
        transactionStatus: {
          not: "PLAN",
        },
      },
    }),
  ]);

  const categoryTreatmentIndex = buildFinanceCategoryTreatmentIndex(categories);
  const movementByAccount = new Map<string, number>();

  for (const operation of operations) {
    const bankAccount = operation.bankAccount;

    if (!bankAccount) continue;

    const key = accountKey(operation.companyName, bankAccount);

    const effect = getFinanceTransactionCashEffect(
      operation,
      categoryTreatmentIndex
    );

    movementByAccount.set(key, (movementByAccount.get(key) ?? 0) + effect);
  }

  const updates = accounts.map((account) => {
    const key = accountKey(account.companyName, account.name);
    const movement = movementByAccount.get(key) ?? 0;
    const currentBalance = getAmount(account.openingBalance) + movement;

    return prisma.financeAccount.update({
      where: {
        id: account.id,
      },
      data: {
        currentBalance,
      },
    });
  });

  if (updates.length > 0) {
    await prisma.$transaction(updates);
  }
}