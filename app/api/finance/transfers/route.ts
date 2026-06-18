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

function normalizeText(value: FormDataEntryValue | null) {
  return String(value ?? "").trim();
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData();

    const companyName = normalizeText(formData.get("companyName"));
    const fromAccount = normalizeText(formData.get("fromAccount"));
    const toAccount = normalizeText(formData.get("toAccount"));
    const operationDate = toDate(formData.get("operationDate"));
    const amount = toNumber(formData.get("amount"));
    const comment = normalizeText(formData.get("comment"));

    if (
      !companyName ||
      !fromAccount ||
      !toAccount ||
      !operationDate ||
      amount <= 0
    ) {
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
          transactionStatus: "FACT",
          sourceType: "MANUAL_TRANSFER",
          sourceId: transferGroupId,
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
          transactionStatus: "FACT",
          sourceType: "MANUAL_TRANSFER",
          sourceId: transferGroupId,
        },
      }),
    ]);

    await recalculateAccountBalances();

    return NextResponse.redirect(new URL("/finance/operations", req.url));
  } catch (error) {
    console.error("CREATE_FINANCE_TRANSFER_ERROR", error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Ошибка создания внутреннего перевода",
      },
      { status: 500 }
    );
  }
}