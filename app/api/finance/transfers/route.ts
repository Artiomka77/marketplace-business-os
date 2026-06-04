import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { recalculateAccountBalances } from "@/lib/finance/recalculateAccountBalances";

function toDate(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!text) return null;

  const date = new Date(`${text}T12:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toNumber(value: FormDataEntryValue | null) {
  const number = Number(
    String(value ?? "")
      .replace(/\s/g, "")
      .replace(",", ".")
  );

  return Number.isFinite(number) ? number : 0;
}

export async function POST(req: Request) {
  const formData = await req.formData();

  const companyName = String(formData.get("companyName") ?? "").trim();
  const fromAccount = String(formData.get("fromAccount") ?? "").trim();
  const toAccount = String(formData.get("toAccount") ?? "").trim();
  const operationDate = toDate(formData.get("operationDate"));
  const amount = toNumber(formData.get("amount"));
  const comment = String(formData.get("comment") ?? "").trim();

  if (!companyName || !fromAccount || !toAccount || !operationDate || amount <= 0) {
    return NextResponse.json(
      { error: "Заполните обязательные поля" },
      { status: 400 }
    );
  }

  if (fromAccount === toAccount) {
    return NextResponse.json(
      { error: "Счёт списания и счёт зачисления не должны совпадать" },
      { status: 400 }
    );
  }

  const transferGroupId = crypto.randomUUID();

  await prisma.$transaction([
    prisma.financeTransaction.create({
      data: {
        companyName,
        operationDate,
        obligationDate: null,
        operationType: "TRANSFER",
        category: "Внутренний перевод",
        subcategory: "Списание",
        counterparty: null,
        amount,
        bankAccount: fromAccount,
        comment: comment || `Перевод на ${toAccount}`,
        project: null,
        isInternalTransfer: true,
        transferGroupId,
        transferDirection: "TRANSFER_OUT",
      },
    }),

    prisma.financeTransaction.create({
      data: {
        companyName,
        operationDate,
        obligationDate: null,
        operationType: "TRANSFER",
        category: "Внутренний перевод",
        subcategory: "Зачисление",
        counterparty: null,
        amount,
        bankAccount: toAccount,
        comment: comment || `Перевод со счёта ${fromAccount}`,
        project: null,
        isInternalTransfer: true,
        transferGroupId,
        transferDirection: "TRANSFER_IN",
      },
    }),
  ]);

await recalculateAccountBalances();

  return NextResponse.redirect(new URL("/finance/operations", req.url));
}