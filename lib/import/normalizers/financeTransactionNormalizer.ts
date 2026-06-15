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

function makeSafeDate(year: number, monthIndex: number, day: number) {
  return new Date(Date.UTC(year, monthIndex, day, 12, 0, 0));
}

function toDate(value: unknown): Date | null {
  if (!value) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;

    return makeSafeDate(
      value.getFullYear(),
      value.getMonth(),
      value.getDate()
    );
  }

  if (typeof value === "number") {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const rawDate = new Date(excelEpoch.getTime() + value * 24 * 60 * 60 * 1000);

    if (Number.isNaN(rawDate.getTime())) return null;

    return makeSafeDate(
      rawDate.getUTCFullYear(),
      rawDate.getUTCMonth(),
      rawDate.getUTCDate()
    );
  }

  const text = String(value).trim();
  const ruDate = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);

  if (ruDate) {
    const [, day, month, year] = ruDate;

    return makeSafeDate(Number(year), Number(month) - 1, Number(day));
  }

  const isoDate = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);

  if (isoDate) {
    const [, year, month, day] = isoDate;

    return makeSafeDate(Number(year), Number(month) - 1, Number(day));
  }

  const date = new Date(text);

  if (Number.isNaN(date.getTime())) return null;

  return makeSafeDate(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0)
  );
}

function endOfDay(date: Date) {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      23,
      59,
      59,
      999
    )
  );
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

  const sortedDates = data
    .map((row) => row.operationDate)
    .sort((a, b) => a.getTime() - b.getTime());

  const dateFrom = startOfDay(sortedDates[0]);
  const dateTo = endOfDay(sortedDates[sortedDates.length - 1]);

  await prisma.financeTransaction.deleteMany({
    where: {
      companyName,
      sourceType: "GOOGLE_SHEETS_IMPORT",
      operationDate: {
        gte: dateFrom,
        lte: dateTo,
      },
    },
  });

  await prisma.financeTransaction.createMany({
    data,
  });

  return {
    savedRows: data.length,
  };
}