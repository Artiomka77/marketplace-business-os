import { prisma } from "@/lib/prisma";

type NormalizeWbAdsOptions = {
  replaceMode?: "PERIOD" | "CAMPAIGNS";
  campaignIds?: string[];
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = String(value).replace(/\s/g, "").replace(",", ".");

  const number = Number(normalized);

  return Number.isNaN(number) ? null : number;
}

function normalizeCampaignIds(campaignIds: string[] | undefined) {
  return Array.from(
    new Set(
      (campaignIds ?? [])
        .map((campaignId) => String(campaignId ?? "").trim())
        .filter(Boolean)
    )
  );
}

export async function normalizeWbAds(
  rows: any[],
  importSessionId: string,
  dateFrom?: Date | null,
  dateTo?: Date | null,
  companyName?: string | null,
  options: NormalizeWbAdsOptions = {}
) {
  const replaceMode = options.replaceMode ?? "PERIOD";
  const campaignIds = normalizeCampaignIds(options.campaignIds);

  const data = rows
    .map((row) => ({
      importSessionId,
      companyName: companyName ?? null,
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

  if (dateFrom && dateTo) {
    if (replaceMode === "CAMPAIGNS" && campaignIds.length > 0) {
      await prisma.wbAds.deleteMany({
        where: {
          dateFrom,
          dateTo,
          companyName: companyName ?? null,
          campaignId: {
            in: campaignIds,
          },
        },
      });
    } else {
      await prisma.wbAds.deleteMany({
        where: {
          dateFrom,
          dateTo,
          companyName: companyName ?? null,
        },
      });
    }
  } else {
    await prisma.wbAds.deleteMany({
      where: {
        importSessionId,
        companyName: companyName ?? null,
      },
    });
  }

  if (data.length === 0) {
    return {
      savedRows: 0,
    };
  }

  await prisma.wbAds.createMany({
    data,
  });

  return {
    savedRows: data.length,
  };
}