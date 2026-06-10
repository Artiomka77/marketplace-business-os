import { prisma } from "@/lib/prisma";

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number") {
    return Number.isNaN(value) ? null : value;
  }

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const number = Number(normalized);

  return Number.isNaN(number) ? null : number;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "number") {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const date = new Date(excelEpoch.getTime() + value * 24 * 60 * 60 * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const text = String(value).trim();
  const ruDate = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);

  if (ruDate) {
    const [, day, month, year] = ruDate;

    return new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0)
    );
  }

  const date = new Date(text);

  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;

  const text = String(value).trim();

  return text || null;
}

function normalizeBankAccount(value: unknown): string | null {
  const text = cleanText(value);

  if (!text) return null;

  const normalized = text.toLowerCase().replaceAll("ё", "е").trim();

  if (
    normalized === "карта сбербанка" ||
    normalized === "сбербанк карта" ||
    normalized === "сбер карта" ||
    normalized === "карта сбер"
  ) {
    return "Сбербанк карта";
  }

  return text;
}

function getByIndex(row: Record<string, unknown>, index: number) {
  return Object.values(row)[index] ?? null;
}

function getValue(row: Record<string, unknown>, key: string, index: number) {
  return row[key] ?? getByIndex(row, index);
}

function detectOperationType(category: string | null, amount: number) {
  const text = String(category ?? "").toLowerCase();

  if (text.includes("перевод между счетами")) {
    return "TRANSFER";
  }

  if (text.startsWith("(+)")) {
    return "INCOME";
  }

  if (text.startsWith("(-)")) {
    return "EXPENSE";
  }

  if (amount >= 0) {
    return "INCOME";
  }

  return "EXPENSE";
}

function cleanCategory(category: string | null) {
  if (!category) return "Без статьи";

  return category
    .replace(/^\(\+\)\s*/g, "")
    .replace(/^\(-\)\s*/g, "")
    .trim();
}

export async function normalizeFinanceTransactions(
  rows: Record<string, unknown>[],
  importSessionId: string,
  companyName: string
) {
  const data = rows
    .map((row) => {
      const operationDate = toDate(getValue(row, "Дата платежа", 1));
      const obligationDate = toDate(
        getValue(row, "Дата выполнения обязательства", 2)
      );

      const rawCategory = cleanText(getValue(row, "Статья", 3));
      const amountRaw = toNumber(getValue(row, "Сумма", 4));
      const movementType = cleanText(getValue(row, "За что платим", 7));

      if (!operationDate || amountRaw === null) return null;

      const movementText = String(movementType ?? "").toLowerCase();

      const operationType =
        movementText.includes("поступ")
          ? "INCOME"
          : movementText.includes("выбыт")
            ? "EXPENSE"
            : detectOperationType(rawCategory, amountRaw);

      const amount = Math.abs(amountRaw);

      return {
        companyName,
        operationDate,
        obligationDate,
        operationType,
        category: cleanCategory(rawCategory),
        subcategory: null,
        counterparty: cleanText(getValue(row, "Кому платим", 6)),
        amount,
        bankAccount: normalizeBankAccount(getValue(row, "Счет/наличка", 5)),
        comment: cleanText(getValue(row, "Комментарий", 8)),
        project: null,
        isInternalTransfer:
          operationType === "TRANSFER" ||
          String(rawCategory ?? "")
            .toLowerCase()
            .includes("перевод между счетами"),
        sourceType: "GOOGLE_SHEETS_IMPORT",
        sourceId: importSessionId,
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));

  if (data.length === 0) {
    return {
      savedRows: 0,
    };
  }

  await prisma.financeTransaction.deleteMany({
    where: {
      companyName,
      sourceType: "GOOGLE_SHEETS_IMPORT",
    },
  });

  await prisma.financeTransaction.createMany({
    data,
  });

  return {
    savedRows: data.length,
  };
}