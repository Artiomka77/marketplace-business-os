import { prisma } from "@/lib/prisma";

type OperationType =
  | "INCOME"
  | "EXPENSE"
  | "TRANSFER"
  | "FINANCING"
  | "PERSONAL";

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
    const rawDate = new Date(
      excelEpoch.getTime() + value * 24 * 60 * 60 * 1000
    );

    if (Number.isNaN(rawDate.getTime())) return null;

    return makeSafeDate(
      rawDate.getUTCFullYear(),
      rawDate.getUTCMonth(),
      rawDate.getUTCDate()
    );
  }

  const text = String(value).trim();
  const ruDate = text.match(/^(\d{1,2})[.\-_/](\d{1,2})[.\-_/](\d{4})$/);

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
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      0,
      0,
      0
    )
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

function normalize(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBankAccount(value: unknown): string | null {
  const text = cleanText(value);

  if (!text) return null;

  const normalized = normalize(text);

  if (
    normalized === "карта сбербанка" ||
    normalized === "сбербанк карта" ||
    normalized === "сбер карта" ||
    normalized === "карта сбер"
  ) {
    return "Сбербанк карта";
  }

  if (normalized === "расчетный счет" || normalized === "р/с") {
    return "Расчетный счет";
  }

  return text;
}

function getByIndex(row: Record<string, unknown>, index: number) {
  return Object.values(row)[index] ?? null;
}

function getFirstValue(
  row: Record<string, unknown>,
  keys: string[],
  fallbackIndex?: number
) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      return row[key];
    }

    const matchedKey = Object.keys(row).find(
      (rowKey) => normalize(rowKey) === normalize(key)
    );

    if (matchedKey && row[matchedKey] !== undefined && row[matchedKey] !== "") {
      return row[matchedKey];
    }
  }

  return fallbackIndex === undefined ? null : getByIndex(row, fallbackIndex);
}

function normalizeOperationType(value: unknown): OperationType | null {
  const text = normalize(value);

  if (!text) return null;

  if (
    text.includes("поступ") ||
    text.includes("доход") ||
    text === "income" ||
    text === "приход"
  ) {
    return "INCOME";
  }

  if (
    text.includes("расход") ||
    text.includes("выбыт") ||
    text === "expense" ||
    text === "списание"
  ) {
    return "EXPENSE";
  }

  if (
    text.includes("перевод") ||
    text === "transfer" ||
    text.includes("между счетами")
  ) {
    return "TRANSFER";
  }

  if (
    text.includes("финанс") ||
    text.includes("кредит") ||
    text.includes("заем") ||
    text.includes("займ")
  ) {
    return "FINANCING";
  }

  if (
    text.includes("личн") ||
    text.includes("собственник") ||
    text.includes("вывод")
  ) {
    return "PERSONAL";
  }

  return null;
}

function detectOperationType(params: {
  explicitType: unknown;
  category: string | null;
  movementType: string | null;
  amount: number;
}): OperationType {
  const explicitType = normalizeOperationType(params.explicitType);

  if (explicitType) return explicitType;

  const category = normalize(params.category);
  const movementType = normalize(params.movementType);

  if (category.includes("перевод между счетами")) return "TRANSFER";

  if (
    movementType.includes("поступ") ||
    movementType.includes("приход") ||
    movementType.includes("доход")
  ) {
    return "INCOME";
  }

  if (
    movementType.includes("выбыт") ||
    movementType.includes("расход") ||
    movementType.includes("списание")
  ) {
    return "EXPENSE";
  }

  if (category.startsWith("(+)")) return "INCOME";
  if (category.startsWith("(-)")) return "EXPENSE";

  if (category.includes("получение кредита") || category.includes("получение займа")) {
    return "FINANCING";
  }

  if (
    category.includes("тело кредита") ||
    category.includes("проценты кредита") ||
    category.includes("проценты по кредит")
  ) {
    return "FINANCING";
  }

  if (category.includes("вывод собственника")) return "PERSONAL";

  return params.amount >= 0 ? "INCOME" : "EXPENSE";
}

function cleanCategory(category: string | null) {
  if (!category) return "Без статьи";

  return category
    .replace(/^\(\+\)\s*/g, "")
    .replace(/^\(-\)\s*/g, "")
    .trim();
}

function isInternalTransfer(value: unknown, category: string | null, operationType: string) {
  const text = normalize(value);

  return (
    operationType === "TRANSFER" ||
    text === "да" ||
    text === "yes" ||
    text === "true" ||
    text === "1" ||
    normalize(category).includes("перевод между счетами")
  );
}

export async function normalizeFinanceTransactions(
  rows: Record<string, unknown>[],
  importSessionId: string,
  fallbackCompanyName: string
) {
  const parsedRows = rows
    .map((row) => {
      const rawOperationDate = getFirstValue(
        row,
        ["Дата", "Дата платежа", "Дата операции", "operationDate"],
        0
      );
      const rawObligationDate = getFirstValue(
        row,
        [
          "Дата обязательства",
          "Дата выполнения обязательства",
          "obligationDate",
        ],
        1
      );

      const operationDate = toDate(rawOperationDate);
      const obligationDate = toDate(rawObligationDate);

      const rawCompanyName =
        cleanText(getFirstValue(row, ["Компания", "companyName"], 2)) ??
        fallbackCompanyName;

      const rawOperationType = getFirstValue(
        row,
        ["Тип операции", "operationType"],
        3
      );
      const rawCategory = cleanText(getFirstValue(row, ["Статья", "category"], 4));
      const rawSubcategory = cleanText(
        getFirstValue(row, ["Подстатья", "subcategory"], 5)
      );
      const rawBankAccount = getFirstValue(
        row,
        ["Счет", "Счёт", "Счет/наличка", "Счёт/наличка", "bankAccount"],
        6
      );
      const amountRaw = toNumber(getFirstValue(row, ["Сумма", "amount"], 7));
      const rawCounterparty = cleanText(
        getFirstValue(row, ["Контрагент", "Кому платим", "counterparty"], 8)
      );
      const rawProject = cleanText(getFirstValue(row, ["Проект", "project"], 9));
      const rawComment = cleanText(
        getFirstValue(row, ["Комментарий", "comment"], 10)
      );
      const rawInternalTransfer = getFirstValue(
        row,
        ["Внутренний перевод", "isInternalTransfer"],
        11
      );
      const movementType = cleanText(
        getFirstValue(row, ["За что платим", "Движение"], undefined)
      );

      if (!operationDate || amountRaw === null) return null;

      const operationType = detectOperationType({
        explicitType: rawOperationType,
        category: rawCategory,
        movementType,
        amount: amountRaw,
      });

      const amount = Math.abs(amountRaw);

      return {
        companyName: rawCompanyName,
        operationDate,
        obligationDate,
        operationType,
        category: cleanCategory(rawCategory),
        subcategory: rawSubcategory,
        counterparty: rawCounterparty,
        amount,
        bankAccount: normalizeBankAccount(rawBankAccount),
        comment: rawComment,
        project: rawProject,
        isInternalTransfer: isInternalTransfer(
          rawInternalTransfer,
          rawCategory,
          operationType
        ),
        sourceType: "FINANCE_EXCEL_IMPORT",
        sourceId: importSessionId,
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));

  if (parsedRows.length === 0) {
    return {
      savedRows: 0,
    };
  }

  const sortedDates = parsedRows
    .map((row) => row.operationDate)
    .sort((a, b) => a.getTime() - b.getTime());

  const dateFrom = startOfDay(sortedDates[0]);
  const dateTo = endOfDay(sortedDates[sortedDates.length - 1]);

  const companyNames = Array.from(
    new Set(parsedRows.map((row) => row.companyName).filter(Boolean))
  );

  await prisma.financeTransaction.deleteMany({
    where: {
      companyName: {
        in: companyNames,
      },
      sourceType: {
        in: ["GOOGLE_SHEETS_IMPORT", "FINANCE_EXCEL_IMPORT"],
      },
      operationDate: {
        gte: dateFrom,
        lte: dateTo,
      },
    },
  });

  await prisma.financeTransaction.createMany({
    data: parsedRows,
  });

  return {
    savedRows: parsedRows.length,
  };
}
