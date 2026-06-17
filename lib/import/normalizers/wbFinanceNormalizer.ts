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

export async function normalizeWbFinance(
  rows: any[],
  importSessionId: string,
  companyName: string | null
) {
  const data = rows
    .map((row) => ({
      importSessionId,
      companyName,

      reportNumber: toStringOrNull(row["№ отчета"]),
      legalEntity: toStringOrNull(row["Юридическое лицо"]),

      dateFrom: toDate(row["Дата начала"]),
      dateTo: toDate(row["Дата конца"]),
      reportTypeName: toStringOrNull(row["Тип отчета"]),

      salesAmount: toNumber(row["Продажа"]),
      payoutAmount: toNumber(row["К перечислению за товар"]),
      logisticsCost: toNumber(row["Стоимость логистики"]),
      storageCost: toNumber(row["Стоимость хранения"]),
      acceptanceCost: toNumber(row["Стоимость операций на приемке"]),
      otherDeductions: toNumber(row["Прочие удержания/выплаты"]),
      penaltiesAmount: toNumber(row["Общая сумма штрафов"]),
      totalToPay: toNumber(row["Итого к оплате"]),
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