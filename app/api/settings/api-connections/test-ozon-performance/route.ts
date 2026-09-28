import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type CompanyRow = {
  id: string;
  name: string;
};

type OzonPerformanceTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
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
  const response = await fetch("https://api-performance.ozon.ru/api/client/token", {
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
  });

  const rawText = await response.text();

  let json: OzonPerformanceTokenResponse | null = null;

  try {
    json = rawText ? (JSON.parse(rawText) as OzonPerformanceTokenResponse) : null;
  } catch {
    json = null;
  }

  if (!response.ok || !json?.access_token) {
    return {
      ok: false,
      status: response.status,
      contentType: response.headers.get("content-type"),
      rawText: rawText.slice(0, 3000),
      json,
      accessToken: null,
    };
  }

  return {
    ok: true,
    status: response.status,
    contentType: response.headers.get("content-type"),
    rawText: null,
    json,
    accessToken: json.access_token,
  };
}

async function fetchCampaigns(accessToken: string) {
  const response = await fetch("https://api-performance.ozon.ru/api/client/campaign", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
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

  return {
    ok: response.ok,
    status: response.status,
    contentType: response.headers.get("content-type"),
    json,
    rawText: json ? null : rawText.slice(0, 3000),
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
        error:
          "Ozon Performance Client-Id или Client Secret не сохранены",
      },
      { status: 400 }
    );
  }

  const tokenResult = await getPerformanceToken(
    connection.ozonPerformanceClientId,
    connection.ozonPerformanceClientSecret
  );

  if (!tokenResult.ok || !tokenResult.accessToken) {
    return NextResponse.json({
      success: false,
      companyName: company.name,
      step: "token",
      tokenResponse: {
        status: tokenResult.status,
        ok: tokenResult.ok,
        contentType: tokenResult.contentType,
      },
      result: {
        sample: tokenResult.json,
        rawText: tokenResult.rawText,
      },
    });
  }

  const campaignsResult = await fetchCampaigns(tokenResult.accessToken);

  return NextResponse.json({
    success: campaignsResult.ok,
    companyName: company.name,
    step: "campaigns",
    tokenResponse: {
      status: tokenResult.status,
      ok: tokenResult.ok,
      contentType: tokenResult.contentType,
      tokenType: tokenResult.json?.token_type ?? null,
      expiresIn: tokenResult.json?.expires_in ?? null,
    },
    campaignsResponse: {
      status: campaignsResult.status,
      ok: campaignsResult.ok,
      contentType: campaignsResult.contentType,
    },
    result: {
      sample: campaignsResult.json,
      rawText: campaignsResult.rawText,
    },
  });
}