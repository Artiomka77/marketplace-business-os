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

function parseDateFromFileName(fileName: string): Date | null {
  const fullDateMatch = fileName.match(/(\d{2})[.\-_](\d{2})[.\-_](\d{4})/);

  if (fullDateMatch) {
    const [, day, month, year] = fullDateMatch;

    const date = new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0)
    );

    return Number.isNaN(date.getTime()) ? null : date;
  }

  const dayOnlyMatch = fileName.match(/^(\d{1,2})(?:\.[a-zA-Z0-9]+)?$/);

  if (dayOnlyMatch) {
    const [, day] = dayOnlyMatch;

    const date = new Date(Date.UTC(2026, 4, Number(day), 12, 0, 0));

    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

export async function normalizeOzonAds(
  rows: any[],
  importSessionId: string,
  fileName: string,
  companyName: string | null
) {
  const reportDate = parseDateFromFileName(fileName);

  const data = rows
    .map((row) => ({
      importSessionId,
      companyName,
      reportDate,

      sku: row["SKU"] ? String(row["SKU"]) : null,

      impressions: toNumber(row["Показы"]),
      clicks: toNumber(row["Клики"]),

      ctr:
        toNumber(row["CTR"]) ??
        toNumber(row["CTR, %"]) ??
        toNumber(row["CTR, % "]),

      cpc:
        toNumber(row["Стоимость клика"]) ??
        toNumber(row["CPC"]) ??
        toNumber(row["CPC, ₽"]),

      orders:
        toNumber(row["Заказы"]) ??
        toNumber(row["Заказы, шт"]) ??
        toNumber(row["Заказы, шт."]),

      spend:
        toNumber(row["Расход"]) ??
        toNumber(row["Расход, ₽"]) ??
        toNumber(row["Расход ₽"]),
    }))
    .filter((row) => row.sku || row.spend || row.clicks || row.impressions);

  if (data.length === 0) {
    return {
      savedRows: 0,
    };
  }

  if (reportDate) {
    await prisma.ozonAds.deleteMany({
      where: {
        reportDate,
        companyName,
      },
    });
  } else {
    await prisma.ozonAds.deleteMany({
      where: {
        importSessionId,
        companyName,
      },
    });
  }

  await prisma.ozonAds.createMany({
    data,
  });

  return {
    savedRows: data.length,
  };
}