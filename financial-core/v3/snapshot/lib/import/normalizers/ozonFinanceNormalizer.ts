import { prisma } from "@/lib/prisma";

type NormalizeOzonFinanceOptions = {
  dateFrom?: Date;
  dateTo?: Date;
};

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

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function endOfUtcDay(date: Date) {
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

function normalizeDateOnly(date: Date): Date | null {
  if (Number.isNaN(date.getTime())) return null;

  const normalized = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
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

function getValue(
  row: Record<string, unknown>,
  keys: string[],
  fallbackIndex?: number
) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      return row[key];
    }
  }

  if (fallbackIndex !== undefined) {
    return getByIndex(row, fallbackIndex);
  }

  return null;
}

function fixMojibake(value: unknown): string | null {
  const text = String(value ?? "").trim();

  if (!text) return null;

  if (!/[ÐÑ]/.test(text)) {
    return text;
  }

  try {
    const fixed = Buffer.from(text, "latin1").toString("utf8").trim();
    return fixed || text;
  } catch {
    return text;
  }
}

async function deleteOzonFinancePeriod(
  companyName: string | null,
  dateFrom: Date,
  dateTo: Date
) {
  await prisma.ozonFinance.deleteMany({
    where: {
      companyName,
      accrualDate: {
        gte: startOfUtcDay(dateFrom),
        lte: endOfUtcDay(dateTo),
      },
    },
  });
}

export async function normalizeOzonFinance(
  rows: Record<string, unknown>[],
  importSessionId: string,
  companyName: string | null,
  options: NormalizeOzonFinanceOptions = {}
) {
  const data = rows
    .map((row) => ({
      importSessionId,
      companyName,

      accrualDate: toDate(
        getValue(row, ["Дата начисления", "Дата операции", "operation_date"], 0)
      ),

      operationType: fixMojibake(
        getValue(row, ["Тип операции", "operation_type_name", "operation_type"], 1)
      ),

      sku: getValue(row, ["SKU", "sku"], 2)
        ? String(getValue(row, ["SKU", "sku"], 2))
        : null,

      vendorCode: getValue(row, ["Артикул", "Артикул продавца", "vendorCode"], 3)
        ? String(getValue(row, ["Артикул", "Артикул продавца", "vendorCode"], 3))
        : null,

      quantity: toNumber(getValue(row, ["Количество", "quantity"], 4)),

      salesAmount: toNumber(
        getValue(row, ["Сумма продаж", "Начисления за продажу"], 5)
      ),

      ozonCommission: toNumber(
        getValue(row, ["Комиссия Ozon", "Комиссия"], 6)
      ),

      logisticsCost: toNumber(getValue(row, ["Логистика"], 7)),

      reverseLogisticsCost: toNumber(
        getValue(row, ["Обратная логистика"], 8)
      ),

      totalAmount: toNumber(getValue(row, ["Итого", "amount"], 9)),
    }))
    .filter((row) => row.sku || row.vendorCode || row.totalAmount !== null);

  if (options.dateFrom && options.dateTo) {
    await deleteOzonFinancePeriod(companyName, options.dateFrom, options.dateTo);
  } else if (data.length > 0) {
    const dates = data
      .map((row) => row.accrualDate)
      .filter((date): date is Date => Boolean(date));

    if (dates.length > 0) {
      const minDate = new Date(Math.min(...dates.map((date) => date.getTime())));
      const maxDate = new Date(Math.max(...dates.map((date) => date.getTime())));

      await deleteOzonFinancePeriod(companyName, minDate, maxDate);
    } else {
      await prisma.ozonFinance.deleteMany({
        where: {
          importSessionId,
          companyName,
        },
      });
    }
  }

  if (data.length === 0) {
    return {
      savedRows: 0,
    };
  }

  await prisma.ozonFinance.createMany({
    data,
  });

  return {
    savedRows: data.length,
  };
}