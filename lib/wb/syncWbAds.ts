import { prisma } from "@/lib/prisma";
import { normalizeWbAds } from "@/lib/import/normalizers/wbAdsNormalizer";

type CompanyRow = {
  id: string;
  name: string;
};

type AdvertListItem = {
  advertId?: number;
  changeTime?: string;
};

type AdvertGroup = {
  type?: number;
  status?: number;
  count?: number;
  advert_list?: AdvertListItem[];
};

type AdvertCountResponse = {
  adverts?: AdvertGroup[];
};

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

const WB_ADS_BATCH_SIZE = 10;
const WB_ADS_REQUEST_TIMEOUT_MS = 45_000;

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getDefaultPeriod() {
  const dateTo = new Date();
  const dateFrom = new Date();

  dateFrom.setDate(dateFrom.getDate() - 7);

  return {
    dateFrom,
    dateTo,
    dateFromText: formatDateOnly(dateFrom),
    dateToText: formatDateOnly(dateTo),
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  label: string
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    WB_ADS_REQUEST_TIMEOUT_MS
  );

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${label}: timeout after ${WB_ADS_REQUEST_TIMEOUT_MS}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function findCompany(companyId: string) {
  const companies = await prisma.$queryRaw<CompanyRow[]>`
    select "id", "name"
    from "Company"
    where "id" = ${companyId}
    limit 1
  `;

  return companies[0] ?? null;
}

async function getWbConnection(companyId: string) {
  const company = await findCompany(companyId);

  if (!company) {
    throw new Error("Компания не найдена");
  }

  const connection = await prisma.marketplaceApiConnection.findUnique({
    where: {
      companyId_marketplace: {
        companyId,
        marketplace: "WB",
      },
    },
  });

  if (!connection?.wbToken) {
    throw new Error("WB token не сохранён");
  }

  return { company, connection };
}

async function fetchAdvertIds(token: string) {
  const response = await fetchWithTimeout(
    "https://advert-api.wildberries.ru/adv/v1/promotion/count",
    {
      method: "GET",
      headers: {
        Authorization: token,
      },
      cache: "no-store",
    },
    "WB Ads Count API"
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`WB Ads Count API: ${response.status} ${text}`.trim());
  }

  const json = (await response.json()) as AdvertCountResponse;
  const groups = json.adverts ?? [];

  return Array.from(
    new Set(
      groups
        .filter((group) => group.status === 9 || group.status === 11)
        .flatMap((group) => group.advert_list ?? [])
        .map((advert) => advert.advertId)
        .filter((advertId): advertId is number => Boolean(advertId))
    )
  );
}

async function fetchFullStats(
  token: string,
  advertIds: number[],
  dateFromText: string,
  dateToText: string
) {
  if (advertIds.length === 0) {
    return [];
  }

  const url = new URL("https://advert-api.wildberries.ru/adv/v3/fullstats");

  url.searchParams.set("ids", advertIds.join(","));
  url.searchParams.set("beginDate", dateFromText);
  url.searchParams.set("endDate", dateToText);

  const response = await fetchWithTimeout(
    url.toString(),
    {
      method: "GET",
      headers: {
        Authorization: token,
      },
      cache: "no-store",
    },
    "WB Ads FullStats API"
  );

  if (response.status === 204) {
    return [];
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`WB Ads FullStats API: ${response.status} ${text}`.trim());
  }

  const json = await response.json().catch(() => null);

  if (!Array.isArray(json)) {
    return [];
  }

  return json as WbAdsFullStatsItem[];
}

function mapWbAdsRows(stats: WbAdsFullStatsItem[]) {
  const rows: Record<string, unknown>[] = [];

  for (const item of stats) {
    const advertId = item.advertId ? String(item.advertId) : "";

    for (const day of item.days ?? []) {
      rows.push({
        Дата: day.date ?? "",
        "ID кампании": advertId,
        Кампания: `WB Ads API ${advertId}`,
        Показы: day.views ?? item.views ?? 0,
        Клики: day.clicks ?? item.clicks ?? 0,
        "CTR(%)": day.ctr ?? item.ctr ?? 0,
        CPC: day.cpc ?? item.cpc ?? 0,
        Расход: day.sum ?? item.sum ?? 0,
      });
    }
  }

  return rows;
}

export async function syncWbAds(companyId: string) {
  const { company, connection } = await getWbConnection(companyId);
  const { dateFrom, dateTo, dateFromText, dateToText } = getDefaultPeriod();

  const wbToken = connection.wbToken;

  if (!wbToken) {
    throw new Error("WB token не сохранён");
  }

  const advertIds = await fetchAdvertIds(wbToken);
  const limitedAdvertIds = advertIds.slice(0, WB_ADS_BATCH_SIZE);

  const stats = await fetchFullStats(
    wbToken,
    limitedAdvertIds,
    dateFromText,
    dateToText
  );

  const rows = mapWbAdsRows(stats);

  const importSession = await prisma.importSession.create({
    data: {
      fileName: `WB API Ads ${company.name} ${dateFromText} - ${dateToText}`,
      reportType: "WB_ADS_STATS",
      marketplace: "WILDBERRIES",
      companyName: company.name,
      rowsCount: rows.length,
      previewJson: rows.slice(0, 10) as any,
      sheetName: "WB Ads API",
      headerRow: 1,
      status: "SUCCESS",
    },
  });

  const normalizeResult = await normalizeWbAds(
    rows,
    importSession.id,
    dateFrom,
    dateTo,
    company.name
  );

  await prisma.importSession.update({
    where: { id: importSession.id },
    data: { rowsCount: normalizeResult.savedRows },
  });

  return {
    name: "WB Ads",
    rows: normalizeResult.savedRows,
    totalCampaigns: advertIds.length,
    processedCampaigns: limitedAdvertIds.length,
    skippedCampaigns: Math.max(advertIds.length - limitedAdvertIds.length, 0),
  };
}