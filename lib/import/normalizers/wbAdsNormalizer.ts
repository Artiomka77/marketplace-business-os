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

export async function normalizeWbAds(
  rows: any[],
  importSessionId: string,
  dateFrom?: Date | null,
  dateTo?: Date | null
) {
  const data = rows
    .map((row) => ({
      importSessionId,
      dateFrom,
      dateTo,

      campaignId: row["ID кампании"] ? String(row["ID кампании"]) : null,

      campaignName: row["Кампания"] ? String(row["Кампания"]) : null,

      impressions: toNumber(row["Показы"]),
      clicks: toNumber(row["Клики"]),

      ctr: toNumber(row["CTR(%)"]),
      cpc: toNumber(row["CPC"]),

      spend:
        toNumber(row["Затраты"]) ??
        toNumber(row["Расход"]) ??
        toNumber(row["Сумма"]),
    }))
    .filter((row) => row.campaignId || row.campaignName || row.spend);

  if (data.length === 0) {
    return {
      savedRows: 0,
    };
  }

  if (dateFrom && dateTo) {
    await prisma.wbAds.deleteMany({
      where: {
        dateFrom,
        dateTo,
      },
    });
  }

  await prisma.wbAds.createMany({
    data,
  });

  return {
    savedRows: data.length,
  };
}