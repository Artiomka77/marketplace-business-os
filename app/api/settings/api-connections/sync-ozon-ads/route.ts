import { redirect } from "next/navigation";

import { prisma } from "@/lib/prisma";

type CompanyRow = {
  id: string;
  name: string;
};

type TokenResponse = {
  access_token?: string;
};

type CampaignItem = {
  id?: string;
  title?: string;
  state?: string;
  PaymentType?: string;
  advObjectType?: string;
  fromDate?: string;
  toDate?: string;
};

type StatsCreateResponse = {
  UUID?: string;
  uuid?: string;
  vendor?: boolean;
};

type ReportStatus = {
  UUID?: string;
  state?: string;
  link?: string;
};

type ReportRow = {
  date?: string;
  sku?: string;
  views?: string;
  clicks?: string;
  ctr?: string;
  avgBid?: string;
  moneySpent?: string;
  orders?: string;
};

type CampaignReport = {
  title?: string;
  report?: {
    rows?: ReportRow[];
  };
};

type ReportFile = Record<string, CampaignReport>;

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Неизвестная ошибка";
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getDefaultPeriod() {
  const dateTo = new Date();
  const dateFrom = new Date();

  dateFrom.setDate(dateFrom.getDate() - 14);

  return {
    dateFrom,
    dateTo,
    dateFromText: formatDateOnly(dateFrom),
    dateToText: formatDateOnly(dateTo),
  };
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isNaN(value) ? null : value;
  }

  const normalized = String(value)
    .replace(/\s/g, "")
    .replace(",", ".")
    .replace(/[^\d.-]/g, "");

  const number = Number(normalized);

  return Number.isNaN(number) ? null : number;
}

function toInt(value: unknown): number | null {
  const number = toNumber(value);
  return number === null ? null : Math.trunc(number);
}

function toDate(value: unknown): Date | null {
  const text = String(value ?? "").trim();

  const ruDateMatch = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);

  if (ruDateMatch) {
    const [, day, month, year] = ruDateMatch;

    return new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0)
    );
  }

  const isoDateMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (isoDateMatch) {
    const [, year, month, day] = isoDateMatch;

    return new Date(
      Date.UTC(Number(year), Number(month) - 1, Number(day), 12, 0, 0)
    );
  }

  return null;
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

async function getPerformanceToken(clientId: string, clientSecret: string) {
  const response = await fetch(
    "https://api-performance.ozon.ru/api/client/token",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials",
      }),
      cache: "no-store",
    }
  );

  const rawText = await response.text();
  const json = rawText ? (JSON.parse(rawText) as TokenResponse) : null;

  if (!response.ok || !json?.access_token) {
    throw new Error(
      `Ozon Performance Token API: ${response.status} ${rawText}`.trim()
    );
  }

  return json.access_token;
}

async function fetchCampaigns(accessToken: string) {
  const response = await fetch(
    "https://api-performance.ozon.ru/api/client/campaign",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    }
  );

  const rawText = await response.text();
  const json = rawText
    ? (JSON.parse(rawText) as { list?: CampaignItem[]; total?: string })
    : null;

  if (!response.ok) {
    throw new Error(
      `Ozon Performance Campaign API: ${response.status} ${rawText}`.trim()
    );
  }

  return json?.list ?? [];
}

function isCampaignRelevant(
  campaign: CampaignItem,
  dateFrom: string,
  dateTo: string
) {
  if (!campaign.id) return false;

  if (campaign.PaymentType === "CPO") return true;

  if (
    ![
      "CAMPAIGN_STATE_RUNNING",
      "CAMPAIGN_STATE_INACTIVE",
      "CAMPAIGN_STATE_FINISHED",
    ].includes(campaign.state ?? "")
  ) {
    return false;
  }

  const fromDate = campaign.fromDate || "1900-01-01";
  const toDate = campaign.toDate || "2999-12-31";

  return fromDate <= dateTo && toDate >= dateFrom;
}

async function createStatsReport(
  accessToken: string,
  campaignIds: string[],
  dateFrom: string,
  dateTo: string
) {
  const response = await fetch(
    "https://api-performance.ozon.ru/api/client/statistics/json",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        campaigns: campaignIds,
        dateFrom,
        dateTo,
        groupBy: "DATE",
      }),
      cache: "no-store",
    }
  );

  const rawText = await response.text();
  const json = rawText ? (JSON.parse(rawText) as StatsCreateResponse) : null;

  if (!response.ok || (!json?.UUID && !json?.uuid)) {
    throw new Error(
      `Ozon Performance Statistics Create API: ${response.status} ${rawText}`.trim()
    );
  }

  return json.UUID ?? json.uuid ?? "";
}

async function getReportStatus(accessToken: string, uuid: string) {
  const response = await fetch(
    `https://api-performance.ozon.ru/api/client/statistics/${encodeURIComponent(
      uuid
    )}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    }
  );

  const rawText = await response.text();
  const json = rawText ? (JSON.parse(rawText) as ReportStatus) : null;

  if (!response.ok) {
    throw new Error(
      `Ozon Performance Report Status API: ${response.status} ${rawText}`.trim()
    );
  }

  return json;
}

async function waitForReport(accessToken: string, uuid: string) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    if (attempt > 1) {
      await sleep(10000);
    }

    const status = await getReportStatus(accessToken, uuid);

    if (status?.state === "OK") {
      return status;
    }

    if (
      status?.state &&
      !["NOT_STARTED", "IN_PROGRESS", "PROCESSING"].includes(status.state)
    ) {
      throw new Error(`Ozon Performance report failed: ${status.state}`);
    }
  }

  throw new Error("Ozon Performance report не успел сформироваться за 2 минуты");
}

async function downloadReport(accessToken: string, uuid: string) {
  const response = await fetch(
    `https://api-performance.ozon.ru/api/client/statistics/report?UUID=${encodeURIComponent(
      uuid
    )}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      cache: "no-store",
    }
  );

  const rawText = await response.text();

  if (!response.ok) {
    throw new Error(
      `Ozon Performance Report Download API: ${response.status} ${rawText}`.trim()
    );
  }

  return rawText ? (JSON.parse(rawText) as ReportFile) : {};
}

function mapReportRows(report: ReportFile, importSessionId: string, companyName: string) {
  const rows = [];

  for (const campaign of Object.values(report)) {
    for (const row of campaign.report?.rows ?? []) {
      const reportDate = toDate(row.date);
      const sku = row.sku ? String(row.sku) : null;

      if (!reportDate || !sku) {
        continue;
      }

      const impressions = toInt(row.views);
      const clicks = toInt(row.clicks);
      const spend = toNumber(row.moneySpent);
      const ctr = toNumber(row.ctr);

      const calculatedCpc =
        spend !== null && clicks && clicks > 0 ? spend / clicks : toNumber(row.avgBid);

      rows.push({
        importSessionId,
        companyName,
        reportDate,
        sku,
        impressions,
        clicks,
        ctr,
        cpc: calculatedCpc,
        orders: toInt(row.orders),
        spend,
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
        marketplace: "OZON",
      },
    },
  });

  if (
    !connection?.ozonPerformanceClientId ||
    !connection?.ozonPerformanceClientSecret
  ) {
    await prisma.marketplaceApiConnection.update({
      where: {
        companyId_marketplace: {
          companyId,
          marketplace: "OZON",
        },
      },
      data: {
        status: "ERROR",
        lastError: "Ozon Performance Client-Id или Client Secret не сохранены",
      },
    });

    redirect("/settings/api-connections");
  }

  try {
    const { dateFrom, dateTo, dateFromText, dateToText } = getDefaultPeriod();

    const accessToken = await getPerformanceToken(
      connection.ozonPerformanceClientId,
      connection.ozonPerformanceClientSecret
    );

    const campaigns = await fetchCampaigns(accessToken);

    const campaignIds = campaigns
      .filter((campaign) => isCampaignRelevant(campaign, dateFromText, dateToText))
      .map((campaign) => campaign.id)
      .filter((id): id is string => Boolean(id));

    const uuid = await createStatsReport(
      accessToken,
      campaignIds,
      dateFromText,
      dateToText
    );

    await waitForReport(accessToken, uuid);

    const report = await downloadReport(accessToken, uuid);

    const importSession = await prisma.importSession.create({
      data: {
        fileName: `Ozon API Ads ${company.name} ${dateFromText} - ${dateToText}`,
        reportType: "OZON_ADS",
        marketplace: "OZON",
        companyName: company.name,
        rowsCount: 0,
        previewJson: [],
        sheetName: "Ozon Performance API",
        headerRow: 1,
        status: "SUCCESS",
      },
    });

    const rows = mapReportRows(report, importSession.id, company.name);

    await prisma.ozonAds.deleteMany({
      where: {
        companyName: company.name,
        reportDate: {
          gte: dateFrom,
          lte: dateTo,
        },
      },
    });

    if (rows.length > 0) {
      await prisma.ozonAds.createMany({
        data: rows,
      });
    }

    await prisma.importSession.update({
      where: {
        id: importSession.id,
      },
      data: {
        rowsCount: rows.length,
        previewJson: rows.slice(0, 10) as any,
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
          marketplace: "OZON",
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