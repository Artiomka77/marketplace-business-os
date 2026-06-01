import { prisma } from "@/lib/prisma";

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".");

  const number = Number(normalized);

  return Number.isNaN(number) ? null : number;
}

function toDate(value: unknown): Date | null {
  if (!value) {
    return null;
  }

  const date = new Date(String(value));

  return Number.isNaN(date.getTime()) ? null : date;
}

export async function normalizeWbFinance(
  rows: any[],
  importSessionId: string
) {
  const data = rows
    .map((row) => ({
      importSessionId,

      reportNumber: row["№ отчета"] ? String(row["№ отчета"]) : null,
      legalEntity: row["Юридическое лицо"]
        ? String(row["Юридическое лицо"])
        : null,

      dateFrom: toDate(row["Дата начала"]),
      dateTo: toDate(row["Дата конца"]),
      reportTypeName: row["Тип отчета"] ? String(row["Тип отчета"]) : null,

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

  await prisma.wbFinance.createMany({
    data,
  });

  return {
    savedRows: data.length,
  };
}