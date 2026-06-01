import { prisma } from "@/lib/prisma";

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

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

function normalizeDateOnly(date: Date): Date | null {
  if (Number.isNaN(date.getTime())) return null;

  const normalized = new Date(
    Date.UTC(
      date.getUTCHours() >= 12 ? date.getUTCFullYear() : date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() + (date.getUTCHours() >= 12 ? 1 : 0),
      12,
      0,
      0
    )
  );

  return Number.isNaN(normalized.getTime()) ? null : normalized;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;

  if (value instanceof Date) {
    return normalizeDateOnly(value);
  }

  if (typeof value === "number") {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const date = new Date(excelEpoch.getTime() + value * 24 * 60 * 60 * 1000);
    return normalizeDateOnly(date);
  }

  const text = String(value).trim();

  const ruDateMatch = text.match(
    /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );

  if (ruDateMatch) {
    const [, day, month, year] = ruDateMatch;

    return new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0)
    );
  }

  const isoDateMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (isoDateMatch) {
    const [, year, month, day] = isoDateMatch;

    return new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0)
    );
  }

  const date = new Date(text);

  return normalizeDateOnly(date);
}

function getByIndex(row: Record<string, unknown>, index: number) {
  return Object.values(row)[index] ?? null;
}

export async function normalizeOzonFinance(
  rows: Record<string, unknown>[],
  importSessionId: string
) {
  const data = rows
    .map((row) => ({
      importSessionId,

      accrualDate: toDate(getByIndex(row, 0)),

      operationType: getByIndex(row, 1) ? String(getByIndex(row, 1)) : null,

      sku: getByIndex(row, 5) ? String(getByIndex(row, 5)) : null,

      vendorCode: getByIndex(row, 6) ? String(getByIndex(row, 6)) : null,

      quantity: toNumber(getByIndex(row, 8)),

      salesAmount: toNumber(getByIndex(row, 9)),

      ozonCommission: toNumber(getByIndex(row, 11)),

      logisticsCost: toNumber(getByIndex(row, 20)),

      reverseLogisticsCost: toNumber(getByIndex(row, 23)),

      totalAmount: toNumber(getByIndex(row, 24)),
    }))
    .filter((row) => row.sku || row.vendorCode || row.totalAmount !== null);

  if (data.length === 0) {
    return {
      savedRows: 0,
    };
  }

  await prisma.ozonFinance.deleteMany({
    where: {
      importSessionId,
    },
  });

  await prisma.ozonFinance.createMany({
    data,
  });

  return {
    savedRows: data.length,
  };
}