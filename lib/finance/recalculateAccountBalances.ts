import { prisma } from "@/lib/prisma";

function getAmount(value: unknown) {
  return Number(value ?? 0);
}

function cashEffectForAccount(operation: {
  operationType: string;
  category: string;
  amount: unknown;
  isInternalTransfer: boolean;
  transferDirection?: string | null;
}) {
  const amount = getAmount(operation.amount);

  if (operation.isInternalTransfer) {
    if (operation.transferDirection === "TRANSFER_IN") return amount;
    if (operation.transferDirection === "TRANSFER_OUT") return -amount;
    return 0;
  }

  if (operation.operationType === "INCOME") return amount;
  if (operation.operationType === "EXPENSE") return -amount;
  if (operation.operationType === "PERSONAL") return -amount;

  if (operation.operationType === "FINANCING") {
    return operation.category === "Получение кредита" ? amount : -amount;
  }

  return 0;
}

export async function recalculateAccountBalances() {
  const accounts = await prisma.financeAccount.findMany({
    where: {
      isActive: true,
    },
  });

  for (const account of accounts) {
    const operations = await prisma.financeTransaction.findMany({
      where: {
        companyName: account.companyName,
        bankAccount: account.name,
      },
    });

    const movement = operations.reduce(
      (sum, operation) => sum + cashEffectForAccount(operation),
      0
    );

    const currentBalance = getAmount(account.openingBalance) + movement;

    await prisma.financeAccount.update({
      where: {
        id: account.id,
      },
      data: {
        currentBalance,
      },
    });
  }
}