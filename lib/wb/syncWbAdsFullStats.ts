/**
 * WB Ads FullStats (impressions/clicks/CTR/CPC) for exact calendar days.
 * Complements expense-history sync which does not persist counters.
 */
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { normalizeWbAds } from "@/lib/import/normalizers/wbAdsNormalizer";
import { sleep } from "@/lib/sleep";

type AdvertListItem = { advertId?: number };
type AdvertGroup = {
  status?: number;
  advert_list?: AdvertListItem[];
};
type AdvertCountResponse = { adverts?: AdvertGroup[] };

type WbAdsFullStatsItem = {
  advertId?: number;
  views?: number;
  clicks?: number;
  ctr?: number;
  cpc?: number;
  sum?: number;
  days?: {
    date?: string;
    views?: number;
    clicks?: number;
    ctr?: number;
    cpc?: number;
    sum?: number;
  }[];
};

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

async function fetchAdvertIds(token: string) {
  const response = await fetch(
    "https://advert-api.wildberries.ru/adv/v1/promotion/count",
    {
      method: "GET",
      headers: { Authorization: token },
      cache: "no-store",
    }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`WB Ads Count API: ${response.status} ${text}`.trim());
  }
  const json = (await response.json()) as AdvertCountResponse;
  return Array.from(
    new Set(
      (json.adverts ?? [])
        .filter((g) => g.status === 9 || g.status === 11)
        .flatMap((g) => g.advert_list ?? [])
        .map((a) => a.advertId)
        .filter((id): id is number => Boolean(id))
    )
  );
}

async function fetchFullStatsChunk(
  token: string,
  advertIds: number[],
  dateFromText: string,
  dateToText: string
) {
  const url = new URL("https://advert-api.wildberries.ru/adv/v3/fullstats");
  url.searchParams.set("ids", advertIds.join(","));
  url.searchParams.set("beginDate", dateFromText);
  url.searchParams.set("endDate", dateToText);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { Authorization: token },
    cache: "no-store",
  });

  if (response.status === 204) return [] as WbAdsFullStatsItem[];
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`WB Ads FullStats API: ${response.status} ${text}`.trim());
  }
  const json = (await response.json()) as WbAdsFullStatsItem[];
  return Array.isArray(json) ? json : [];
}

function mapFullStatsRows(stats: WbAdsFullStatsItem[]) {
  const rows: Record<string, unknown>[] = [];
  for (const item of stats) {
    const advertId = item.advertId ? String(item.advertId) : "";
    for (const day of item.days ?? []) {
      const dateText = String(day.date ?? "").slice(0, 10);
      rows.push({
        Дата: dateText,
        "ID кампании": advertId,
        Кампания: `WB Ads FullStats ${advertId}`,
        Показы: day.views ?? 0,
        Клики: day.clicks ?? 0,
        "CTR(%)": day.ctr ?? 0,
        CPC: day.cpc ?? 0,
        Расход: day.sum ?? 0,
      });
    }
  }
  return rows;
}

/**
 * Persist exact-day FullStats counters for a company/period.
 * Uses CAMPAIGNS replace for touched campaign ids so expense-only other
 * campaigns are not wiped when FullStats returns a subset.
 */
export async function syncWbAdsFullStats(
  companyId: string,
  options: { dateFrom?: Date; dateTo?: Date } = {}
) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error("Company not found");

  const connection = await prisma.marketplaceApiConnection.findUnique({
    where: {
      companyId_marketplace: { companyId, marketplace: "WB" },
    },
  });
  if (!connection?.wbToken) throw new Error("WB token не сохранён");

  const dateTo = startOfUtcDay(options.dateTo ?? new Date());
  const dateFrom = startOfUtcDay(
    options.dateFrom ??
      new Date(dateTo.getTime() - 2 * 24 * 60 * 60 * 1000)
  );
  const dateFromText = formatDateOnly(dateFrom);
  const dateToText = formatDateOnly(dateTo);

  const advertIds = await fetchAdvertIds(connection.wbToken);
  const stats: WbAdsFullStatsItem[] = [];
  const chunkSize = 50;
  for (let i = 0; i < advertIds.length; i += chunkSize) {
    const chunk = advertIds.slice(i, i + chunkSize);
    try {
      const part = await fetchFullStatsChunk(
        connection.wbToken,
        chunk,
        dateFromText,
        dateToText
      );
      stats.push(...part);
    } catch (error) {
      // Fall back to one-by-one if batch rejected
      for (const id of chunk) {
        const part = await fetchFullStatsChunk(
          connection.wbToken,
          [id],
          dateFromText,
          dateToText
        );
        stats.push(...part);
        await sleep(2500);
      }
    }
    if (i + chunkSize < advertIds.length) await sleep(2500);
  }

  const rows = mapFullStatsRows(stats);
  const campaignIds = Array.from(
    new Set(
      rows
        .map((r) => String(r["ID кампании"] ?? ""))
        .filter((id) => id.length > 0)
    )
  );

  const importSession = await prisma.importSession.create({
    data: {
      fileName: `WB API Ads FullStats ${company.name} ${dateFromText} - ${dateToText}`,
      reportType: "WB_ADS_FULLSTATS",
      marketplace: "WILDBERRIES",
      companyName: company.name,
      rowsCount: rows.length,
      previewJson: rows.slice(0, 10) as Prisma.InputJsonValue,
      sheetName: "WB Ads FullStats API",
      headerRow: 1,
      status: "SUCCESS",
    },
  });

  const normalizeResult = await normalizeWbAds(
    rows,
    importSession.id,
    dateFrom,
    dateTo,
    company.name,
    {
      replaceMode: campaignIds.length > 0 ? "CAMPAIGNS" : "PERIOD",
      campaignIds,
    }
  );

  await prisma.importSession.update({
    where: { id: importSession.id },
    data: { rowsCount: normalizeResult.savedRows },
  });

  return {
    name: "WB Ads FullStats",
    source: "WB Ads FullStats API",
    rows: normalizeResult.savedRows,
    totalCampaigns: advertIds.length,
    processedCampaigns: campaignIds.length,
    dateFrom: dateFromText,
    dateTo: dateToText,
    done: true,
  };
}
