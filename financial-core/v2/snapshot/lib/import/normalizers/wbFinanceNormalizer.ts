import { prisma } from "@/lib/prisma";

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const number = Number(normalized);

  return Number.isNaN(number) ? null : number;
}

function toDate(value: unknown): Date | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === "number") {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const date = new Date(excelEpoch.getTime() + value * 86400000);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const raw = String(value).trim();
  const ddmmyyyy = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);

  if (ddmmyyyy) {
    const day = Number(ddmmyyyy[1]);
    const month = Number(ddmmyyyy[2]) - 1;
    const yearRaw = Number(ddmmyyyy[3]);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    const date = new Date(year, month, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(raw);

  return Number.isNaN(date.getTime()) ? null : date;
}

function toStringOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = toNumber(value);
    if (number !== null) return number;
  }

  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = toStringOrNull(value);
    if (text) return text;
  }

  return null;
}

function firstDate(...values: unknown[]): Date | null {
  for (const value of values) {
    const date = toDate(value);
    if (date) return date;
  }

  return null;
}

export async function normalizeWbFinance(
  rows: any[],
  importSessionId: string,
  companyName: string | null
) {
  const data = rows
    .map((row) => ({
      importSessionId,
      companyName,

      reportNumber: firstString(
        row["№ отчета"],
        row["№ отчёта"],
        row["Номер отчета"],
        row["Номер отчёта"]
      ),
      legalEntity: toStringOrNull(row["Юридическое лицо"]),

      dateFrom: firstDate(row["Дата начала"], row["Дата начала отчета"], row["Дата начала отчёта"]),
      dateTo: firstDate(row["Дата конца"], row["Дата окончания"], row["Дата конца отчета"], row["Дата конца отчёта"]),
      reportTypeName: firstString(row["Тип отчета"], row["Тип отчёта"]),

      salesAmount: firstNumber(row["Продажа"], row["Сумма продаж"], row["Продажи"]),
      payoutAmount: firstNumber(row["К перечислению за товар"], row["К перечислению продавцу"], row["К перечислению"]),
      logisticsCost: firstNumber(row["Стоимость логистики"], row["Логистика"]),
      storageCost: firstNumber(row["Стоимость хранения"], row["Хранение"]),
      acceptanceCost: firstNumber(row["Стоимость операций на приемке"], row["Стоимость операций на приёмке"], row["Платная приемка"], row["Платная приёмка"]),
      otherDeductions: firstNumber(row["Прочие удержания/выплаты"], row["Удержания"], row["Прочие удержания"]),
      penaltiesAmount: firstNumber(row["Общая сумма штрафов"], row["Штрафы"], row["Штраф"]),
      totalToPay: firstNumber(row["Итого к оплате"], row["Итого"]),
    }))
    .filter((row) => row.reportNumber || row.legalEntity);

  if (data.length === 0) {
    return {
      savedRows: 0,
    };
  }

  const reportNumbers = Array.from(
    new Set(
      data
        .map((row) => String(row.reportNumber ?? "").trim())
        .filter(Boolean)
    )
  );

  if (reportNumbers.length > 0) {
    await prisma.wbFinance.deleteMany({
      where: {
        companyName,
        reportNumber: {
          in: reportNumbers,
        },
      },
    });
  } else {
    await prisma.wbFinance.deleteMany({
      where: {
        importSessionId,
        companyName,
      },
    });
  }

  await prisma.wbFinance.createMany({
  data,
  skipDuplicates: true,
});

  return {
    savedRows: data.length,
  };
}