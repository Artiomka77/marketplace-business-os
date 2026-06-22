import { prisma } from "@/lib/prisma";
import { normalizeWbAds } from "@/lib/import/normalizers/wbAdsNormalizer";

type CompanyRow = {
  id: string;
  name: string;
};

type WbAdsSyncOptions = {
  dateFrom?: Date;
  dateTo?: Date;
  cursorOffset?: number | null;
  mode?: "FULL" | "CHUNK";
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
const WB_ADS_BATCH_DELAY_MS = 1_000;
const WB_ADS_MIN_AVAILABLE_DATE_TEXT = "2025-03-01";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getDefaultPeriod() {
  const dateTo = new Date();
  const dateFrom = new Date();

  dateFrom.setDate(dateFrom.getDate() - 7);

  return {
    dateFrom: startOfUtcDay(dateFrom),
    dateTo: startOfUtcDay(dateTo),
  };
}

function getWbAdsMinAvailableDate() {
  return startOfUtcDay(new Date(`${WB_ADS_MIN_AVAILABLE_DATE_TEXT}T00:00:00Z`));
}

function getAvailableWbAdsPeriod(dateFrom: Date, dateTo: Date) {
  const minAvailableDate = getWbAdsMinAvailableDate();

  if (dateTo.getTime() < minAvailableDate.getTime()) {
    return {
      skipped: true as const,
      dateFrom,
      dateTo,
      effectiveDateFrom: dateFrom,
      effectiveDateTo: dateTo,
      message: `WB Ads за период ${formatDateOnly(dateFrom)} — ${formatDateOnly(
        dateTo
      )} пропущены: рекламная статистика WB доступна с ${WB_ADS_MIN_AVAILABLE_DATE_TEXT}.`,
    };
  }

  const effectiveDateFrom =
    dateFrom.getTime() < minAvailableDate.getTime()
      ? minAvailableDate
      : dateFrom;

  return {
    skipped: false as const,
    dateFrom,
    dateTo,
    effectiveDateFrom,
    effectiveDateTo: dateTo,
    message:
      effectiveDateFrom.getTime() !== dateFrom.getTime()
        ? `dateFrom обрезан до ${WB_ADS_MIN_AVAILABLE_DATE_TEXT}, так как более ранняя рекламная статистика WB недоступна.`
        : null,
  };
}

function createSkippedWbAdsResult(params: {
  dateFrom: Date;
  dateTo: Date;
  message: string;
}) {
  return {
    name: "WB Ads",
    rows: 0,
    totalCampaigns: 0,
    processedCampaigns: 0,
    skippedCampaigns: 0,
    dateFrom: formatDateOnly(params.dateFrom),
    dateTo: formatDateOnly(params.dateTo),
    done: true,
    nextCursorOffset: null,
    skipped: true,
    message: params.message,
  };
}

function getSyncPeriod(options: WbAdsSyncOptions = {}) {
  if (!options.dateFrom && !options.dateTo) {
    return getDefaultPeriod();
  }

  if (!options.dateFrom || !options.dateTo) {
    throw new Error("Для WB Ads синхронизации нужны dateFrom и dateTo");
  }

  const dateFrom = startOfUtcDay(options.dateFrom);
  const dateTo = startOfUtcDay(options.dateTo);

  if (dateFrom.getTime() > dateTo.getTime()) {
    throw new Error("dateFrom не может быть позже dateTo");
  }

  return {
    dateFrom,
    dateTo,
  };
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function isWbRateLimitStatus(status: number) {
  return status === 429;
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

    if (isWbRateLimitStatus(response.status)) {
      throw new Error(
        `WB Ads FullStats API: 429 ${text || "rate limit"}`.trim()
      );
    }

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

function getBatch(advertIds: number[], offset: number) {
  return advertIds.slice(offset, offset + WB_ADS_BATCH_SIZE);
}

function getNextOffset(currentOffset: number, processedCampaigns: number) {
  return currentOffset + processedCampaigns;
}

async function fetchAllStatsInBatches(
  token: string,
  advertIds: number[],
  dateFromText: string,
  dateToText: string
) {
  const allStats: WbAdsFullStatsItem[] = [];

  for (let offset = 0; offset < advertIds.length; offset += WB_ADS_BATCH_SIZE) {
    const batch = getBatch(advertIds, offset);
    const stats = await fetchFullStats(token, batch, dateFromText, dateToText);

    allStats.push(...stats);

    if (offset + WB_ADS_BATCH_SIZE < advertIds.length) {
      await sleep(WB_ADS_BATCH_DELAY_MS);
    }
  }

  return allStats;
}

async function createImportSession(params: {
  companyName: string;
  dateFromText: string;
  dateToText: string;
  rows: Record<string, unknown>[];
  cursorOffset?: number | null;
}) {
  const cursorText =
    params.cursorOffset === null || params.cursorOffset === undefined
      ? ""
      : ` offset ${params.cursorOffset}`;

  return prisma.importSession.create({
    data: {
      fileName: `WB API Ads ${params.companyName} ${params.dateFromText} - ${params.dateToText}${cursorText}`,
      reportType: "WB_ADS_STATS",
      marketplace: "WILDBERRIES",
      companyName: params.companyName,
      rowsCount: params.rows.length,
      previewJson: params.rows.slice(0, 10) as any,
      sheetName: "WB Ads API",
      headerRow: 1,
      status: "SUCCESS",
    },
  });
}

async function syncWbAdsFull(companyId: string, options: WbAdsSyncOptions = {}) {
  const { company, connection } = await getWbConnection(companyId);
  const requestedPeriod = getSyncPeriod(options);
  const availablePeriod = getAvailableWbAdsPeriod(
    requestedPeriod.dateFrom,
    requestedPeriod.dateTo
  );

  if (availablePeriod.skipped) {
    return createSkippedWbAdsResult({
      dateFrom: requestedPeriod.dateFrom,
      dateTo: requestedPeriod.dateTo,
      message: availablePeriod.message,
    });
  }

  const { effectiveDateFrom: dateFrom, effectiveDateTo: dateTo } =
    availablePeriod;

  const dateFromText = formatDateOnly(dateFrom);
  const dateToText = formatDateOnly(dateTo);

  const wbToken = connection.wbToken;

  if (!wbToken) {
    throw new Error("WB token не сохранён");
  }

  const advertIds = await fetchAdvertIds(wbToken);

  if (advertIds.length === 0) {
    return createSkippedWbAdsResult({
      dateFrom,
      dateTo,
      message: `WB Ads за период ${dateFromText} — ${dateToText} пропущены: рекламные кампании WB не найдены.`,
    });
  }

  const stats = await fetchAllStatsInBatches(
    wbToken,
    advertIds,
    dateFromText,
    dateToText
  );

  const rows = mapWbAdsRows(stats);

  const importSession = await createImportSession({
    companyName: company.name,
    dateFromText,
    dateToText,
    rows,
  });

  const normalizeResult = await normalizeWbAds(
    rows,
    importSession.id,
    dateFrom,
    dateTo,
    company.name,
    {
      replaceMode: "PERIOD",
    }
  );

  await prisma.importSession.update({
    where: { id: importSession.id },
    data: { rowsCount: normalizeResult.savedRows },
  });

  return {
    name: "WB Ads",
    rows: normalizeResult.savedRows,
    totalCampaigns: advertIds.length,
    processedCampaigns: advertIds.length,
    skippedCampaigns: 0,
    dateFrom: dateFromText,
    dateTo: dateToText,
    done: true,
    nextCursorOffset: null,
    periodAdjusted: availablePeriod.message,
  };
}

async function syncWbAdsChunk(companyId: string, options: WbAdsSyncOptions = {}) {
  const { company, connection } = await getWbConnection(companyId);
  const requestedPeriod = getSyncPeriod(options);
  const availablePeriod = getAvailableWbAdsPeriod(
    requestedPeriod.dateFrom,
    requestedPeriod.dateTo
  );

  if (availablePeriod.skipped) {
    return createSkippedWbAdsResult({
      dateFrom: requestedPeriod.dateFrom,
      dateTo: requestedPeriod.dateTo,
      message: availablePeriod.message,
    });
  }

  const { effectiveDateFrom: dateFrom, effectiveDateTo: dateTo } =
    availablePeriod;

  const dateFromText = formatDateOnly(dateFrom);
  const dateToText = formatDateOnly(dateTo);

  const wbToken = connection.wbToken;

  if (!wbToken) {
    throw new Error("WB token не сохранён");
  }

  const advertIds = await fetchAdvertIds(wbToken);

  if (advertIds.length === 0) {
    return createSkippedWbAdsResult({
      dateFrom,
      dateTo,
      message: `WB Ads за период ${dateFromText} — ${dateToText} пропущены: рекламные кампании WB не найдены.`,
    });
  }

  const cursorOffset = Math.max(options.cursorOffset ?? 0, 0);
  const batch = getBatch(advertIds, cursorOffset);

  if (batch.length === 0) {
    return {
      name: "WB Ads",
      rows: 0,
      totalCampaigns: advertIds.length,
      processedCampaigns: 0,
      skippedCampaigns: 0,
      cursorOffset,
      nextCursorOffset: null,
      dateFrom: dateFromText,
      dateTo: dateToText,
      done: true,
      periodAdjusted: availablePeriod.message,
    };
  }

  const stats = await fetchFullStats(wbToken, batch, dateFromText, dateToText);
  const rows = mapWbAdsRows(stats);

  const importSession = await createImportSession({
    companyName: company.name,
    dateFromText,
    dateToText,
    rows,
    cursorOffset,
  });

  const normalizeResult = await normalizeWbAds(
    rows,
    importSession.id,
    dateFrom,
    dateTo,
    company.name,
    {
      replaceMode: "CAMPAIGNS",
      campaignIds: batch.map(String),
    }
  );

  await prisma.importSession.update({
    where: { id: importSession.id },
    data: { rowsCount: normalizeResult.savedRows },
  });

  const nextCursorOffset = getNextOffset(cursorOffset, batch.length);
  const done = nextCursorOffset >= advertIds.length || batch.length === 0;

  return {
    name: "WB Ads",
    rows: normalizeResult.savedRows,
    totalCampaigns: advertIds.length,
    processedCampaigns: batch.length,
    skippedCampaigns: Math.max(advertIds.length - nextCursorOffset, 0),
    cursorOffset,
    nextCursorOffset: done ? null : nextCursorOffset,
    dateFrom: dateFromText,
    dateTo: dateToText,
    done,
    periodAdjusted: availablePeriod.message,
  };
}

export async function syncWbAds(
  companyId: string,
  options: WbAdsSyncOptions = {}
) {
  if (options.mode === "CHUNK") {
    return syncWbAdsChunk(companyId, options);
  }

  return syncWbAdsFull(companyId, options);
}