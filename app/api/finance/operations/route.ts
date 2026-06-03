import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

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
  try {
    const formData = await req.formData();

    const companyName = String(formData.get("companyName") ?? "").trim();
    const operationType = String(formData.get("operationType") ?? "").trim();
    const category = String(formData.get("category") ?? "").trim();
    const amount = toNumber(formData.get("amount"));
    const operationDate = toDate(formData.get("operationDate"));

    if (!companyName || !operationType || !category || !operationDate || amount <= 0) {
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
        obligationDate: null,
        amount,
        subcategory: null,
        counterparty: null,
        bankAccount: String(formData.get("bankAccount") ?? "").trim() || null,
        project: null,
        comment: String(formData.get("comment") ?? "").trim() || null,
        isInternalTransfer:
          operationType === "TRANSFER" ||
          formData.get("isInternalTransfer") === "on",
      },
    });

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