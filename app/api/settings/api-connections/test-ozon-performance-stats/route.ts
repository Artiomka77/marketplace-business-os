import { NextResponse } from "next/server";
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
  createdAt?: string;
  updatedAt?: string;
  request?: unknown;
  kind?: string;
  result?: unknown;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  return {
    uuid: json.UUID ?? json.uuid ?? "",
    response: {
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type"),
      sample: json,
    },
  };
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

  let json: ReportStatus | null = null;

  try {
    json = rawText ? (JSON.parse(rawText) as ReportStatus) : null;
  } catch {
    json = null;
  }

  return {
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type"),
    sample: json,
    rawText: json ? null : rawText.slice(0, 5000),
  };
}

async function downloadReportFile(accessToken: string, uuid: string) {
  const variants = [
    {
      variant: "statistics/report/{uuid}",
      url: `https://api-performance.ozon.ru/api/client/statistics/report/${encodeURIComponent(
        uuid
      )}`,
    },
    {
      variant: "statistics/report?UUID",
      url: `https://api-performance.ozon.ru/api/client/statistics/report?UUID=${encodeURIComponent(
        uuid
      )}`,
    },
    {
      variant: "statistics/report?uuid",
      url: `https://api-performance.ozon.ru/api/client/statistics/report?uuid=${encodeURIComponent(
        uuid
      )}`,
    },
  ];

  const attempts = [];

  for (const variant of variants) {
    const response = await fetch(variant.url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json,text/csv,text/plain,*/*",
      },
      cache: "no-store",
    });

    const rawText = await response.text();

    let json: unknown = null;

    try {
      json = rawText ? JSON.parse(rawText) : null;
    } catch {
      json = null;
    }

    const result = {
      variant: variant.variant,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type"),
      sample: json,
      rawText: json ? null : rawText.slice(0, 5000),
    };

    attempts.push(result);

    if (response.ok) {
      return {
        ok: true,
        finalVariant: variant.variant,
        finalResult: result,
        attempts,
      };
    }
  }

  return {
    ok: false,
    finalVariant: null,
    finalResult: attempts.at(-1) ?? null,
    attempts,
  };
}

async function waitForReport(accessToken: string, uuid: string) {
  const statusAttempts = [];

  for (let attempt = 1; attempt <= 12; attempt += 1) {
    if (attempt > 1) {
      await sleep(10000);
    }

    const statusResult = await getReportStatus(accessToken, uuid);
    const state = statusResult.sample?.state ?? null;

    statusAttempts.push({
      attempt,
      status: statusResult.status,
      ok: statusResult.ok,
      state,
      contentType: statusResult.contentType,
      sample: statusResult.sample,
      rawText: statusResult.rawText,
    });

    if (
      statusResult.ok &&
      state &&
      !["NOT_STARTED", "IN_PROGRESS", "PROCESSING"].includes(state)
    ) {
      return {
        ready: true,
        state,
        statusResult,
        statusAttempts,
      };
    }
  }

  return {
    ready: false,
    state: statusAttempts.at(-1)?.state ?? null,
    statusResult: statusAttempts.at(-1) ?? null,
    statusAttempts,
  };
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const companyId = getString(formData, "companyId");

  const company = await findCompany(companyId);

  if (!company) {
    return NextResponse.json(
      { success: false, error: "Компания не найдена" },
      { status: 404 }
    );
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
    return NextResponse.json(
      {
        success: false,
        error: "Ozon Performance Client-Id или Client Secret не сохранены",
      },
      { status: 400 }
    );
  }

  const dateFrom = "2026-06-08";
  const dateTo = "2026-06-14";

  const accessToken = await getPerformanceToken(
    connection.ozonPerformanceClientId,
    connection.ozonPerformanceClientSecret
  );

  const campaigns = await fetchCampaigns(accessToken);

  const selectedCampaigns = campaigns
    .filter((campaign) => isCampaignRelevant(campaign, dateFrom, dateTo))
    .slice(0, 10);

  const campaignIds = selectedCampaigns
    .map((campaign) => campaign.id)
    .filter((id): id is string => Boolean(id));

  const createResult = await createStatsReport(
    accessToken,
    campaignIds,
    dateFrom,
    dateTo
  );

  const waitResult = await waitForReport(accessToken, createResult.uuid);

  const fileResult = waitResult.ready
    ? await downloadReportFile(accessToken, createResult.uuid)
    : null;

  return NextResponse.json({
    success: Boolean(waitResult.ready),
    companyName: company.name,
    request: {
      dateFrom,
      dateTo,
      campaignIds,
      campaignsCount: campaignIds.length,
      uuid: createResult.uuid,
      finalState: waitResult.state,
      note:
        "Если finalState остается NOT_STARTED, отчёт Ozon формируется дольше 2 минут. Тогда нужно выносить загрузку в фон, а не держать HTTP-запрос.",
    },
    selectedCampaigns,
    createReportResponse: createResult.response,
    statusAttempts: waitResult.statusAttempts,
    reportStatus: waitResult.statusResult,
    downloadReport: fileResult,
    result: {
      sample:
        fileResult?.finalResult?.sample ??
        waitResult.statusResult?.sample ??
        null,
      rawText:
        fileResult?.finalResult?.rawText ??
        waitResult.statusResult?.rawText ??
        null,
    },
  });
}