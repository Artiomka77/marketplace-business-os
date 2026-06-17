import { redirect } from "next/navigation";

import { prisma } from "@/lib/prisma";
import { normalizeWbAds } from "@/lib/import/normalizers/wbAdsNormalizer";
import { sleep } from "@/lib/sleep";

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

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

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

async function findCompany(companyId: string) {
  const companies = await prisma.$queryRaw<CompanyRow[]>`
    select "id", "name"
    from "Company"
    where "id" = ${companyId}
    limit 1
  `;

  return companies[0] ?? null;
}

async function fetchAdvertIds(token: string) {
  const response = await fetch(
    "https://advert-api.wildberries.ru/adv/v1/promotion/count",
    {
      method: "GET",
      headers: {
        Authorization: token,
      },
      cache: "no-store",
    }
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
  const result: WbAdsFullStatsItem[] = [];

  for (const advertId of advertIds) {
    const url = new URL("https://advert-api.wildberries.ru/adv/v3/fullstats");

    url.searchParams.set("ids", String(advertId));
    url.searchParams.set("beginDate", dateFromText);
    url.searchParams.set("endDate", dateToText);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: token,
      },
      cache: "no-store",
    });

    if (response.status === 204) {
      await sleep(3000);
      continue;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`WB Ads FullStats API: ${response.status} ${text}`.trim());
    }

    const json = (await response.json()) as WbAdsFullStatsItem[];

    result.push(...json);

    await sleep(3000);
  }

  return result;
}

function mapWbAdsRows(stats: WbAdsFullStatsItem[]) {
  const rows: Record<string, unknown>[] = [];

  for (const item of stats) {
    const advertId = item.advertId ? String(item.advertId) : "";

    for (const day of item.days ?? []) {
      rows.push({
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

export async function POST(request: Request) {
  const formData = await request.formData();
  const companyId = getString(formData, "companyId");

  if (!companyId) {
    redirect("/settings/api-connections");
  }

  const company = await findCompany(companyId);

  if (!company) {
    redirect("/settings/api-connections");
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
    await prisma.marketplaceApiConnection.upsert({
      where: {
        companyId_marketplace: {
          companyId,
          marketplace: "WB",
        },
      },
      create: {
        companyId,
        marketplace: "WB",
        status: "ERROR",
        lastError: "WB token не сохранён",
      },
      update: {
        status: "ERROR",
        lastError: "WB token не сохранён",
      },
    });

    redirect("/settings/api-connections");
  }

  try {
    const { dateFrom, dateTo, dateFromText, dateToText } = getDefaultPeriod();

    const advertIds = await fetchAdvertIds(connection.wbToken);
    const limitedAdvertIds = advertIds.slice(0, 1);

    const stats = await fetchFullStats(
      connection.wbToken,
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
      where: {
        id: importSession.id,
      },
      data: {
        rowsCount: normalizeResult.savedRows,
      },
    });

    await prisma.marketplaceApiConnection.update({
      where: {
        id: connection.id,
      },
      data: {
        status: "CONNECTED",
        lastSyncAt: new Date(),
        lastError: null,
      },
    });
  } catch (error) {
    await prisma.marketplaceApiConnection.update({
      where: {
        companyId_marketplace: {
          companyId,
          marketplace: "WB",
        },
      },
      data: {
        status: "ERROR",
        lastError: getErrorMessage(error).slice(0, 1000),
      },
    });
  }

  redirect("/settings/api-connections");
}