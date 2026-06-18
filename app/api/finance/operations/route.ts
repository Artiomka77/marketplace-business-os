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
    const operationType = normalizeText(formData.get("operationType"));
    const category = normalizeText(formData.get("category"));
    const amount = toNumber(formData.get("amount"));
    const operationDate = toDate(formData.get("operationDate"));
    const obligationDate = toDate(formData.get("obligationDate"));

    const subcategory = normalizeText(formData.get("subcategory"));
    const counterparty = normalizeText(formData.get("counterparty"));
    const bankAccount = normalizeText(formData.get("bankAccount"));
    const project = normalizeText(formData.get("project"));
    const comment = normalizeText(formData.get("comment"));

    if (
      !companyName ||
      !operationType ||
      !category ||
      !operationDate ||
      amount <= 0
    ) {
      return NextResponse.json(
        { error: "Заполните обязательные поля" },
        { status: 400 }
      );
    }

    await prisma.financeTransaction.create({
      data: {
        companyName,
        operationType,
        category,
        operationDate,
        obligationDate,
        amount,
        subcategory: subcategory || null,
        counterparty: counterparty || null,
        bankAccount: bankAccount || null,
        project: project || null,
        comment: comment || null,
        isInternalTransfer:
          operationType === "TRANSFER" ||
          formData.get("isInternalTransfer") === "on",
        transactionStatus: "FACT",
        sourceType: "MANUAL",
        sourceId: null,
      },
    });

    await recalculateAccountBalances();

    return NextResponse.json({
      success: true,
    });
  } catch (error) {
    console.error("CREATE_FINANCE_TRANSACTION_ERROR", error);

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Ошибка сохранения операции",
      },
      { status: 500 }
    );
  }
}