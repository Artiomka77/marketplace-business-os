import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type CompanyRow = {
  id: string;
  name: string;
};

function getString(formData: FormData, key: string) {
  const value = formData.get(key);

  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function getDefaultPeriod() {
  const dateTo = new Date();
  const dateFrom = new Date();

  dateFrom.setDate(dateFrom.getDate() - 35);

  return {
    dateFrom: formatDateOnly(dateFrom),
    dateTo: formatDateOnly(dateTo),
  };
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const companyId = getString(formData, "companyId");

  if (!companyId) {
    return NextResponse.json(
      {
        success: false,
        error: "companyId не передан",
      },
      { status: 400 }
    );
  }

  const companies = await prisma.$queryRaw<CompanyRow[]>`
    select "id", "name"
    from "Company"
    where "id" = ${companyId}
    limit 1
  `;

  const company = companies[0];

  if (!company) {
    return NextResponse.json(
      {
        success: false,
        error: "Компания не найдена",
        debug: {
          receivedCompanyId: companyId,
        },
      },
      { status: 404 }
    );
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
    return NextResponse.json(
      {
        success: false,
        error: "WB token не сохранён",
        companyName: company.name,
      },
      { status: 400 }
    );
  }

  const { dateFrom, dateTo } = getDefaultPeriod();

  const response = await fetch(
    "https://finance-api.wildberries.ru/api/finance/v1/sales-reports/list",
    {
      method: "POST",
      headers: {
        Authorization: connection.wbToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dateFrom,
        dateTo,
        limit: 10,
        offset: 0,
        period: "weekly",
      }),
      cache: "no-store",
    }
  );

  const rawText = await response.text();

  let parsedJson: unknown = null;

  try {
    parsedJson = rawText ? JSON.parse(rawText) : null;
  } catch {
    parsedJson = null;
  }

  return NextResponse.json({
    success: response.ok,
    companyName: company.name,
    request: {
      url: "https://finance-api.wildberries.ru/api/finance/v1/sales-reports/list",
      dateFrom,
      dateTo,
      limit: 10,
      offset: 0,
      period: "weekly",
    },
    response: {
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type"),
    },
    result: {
      isArray: Array.isArray(parsedJson),
      rowsCount: Array.isArray(parsedJson) ? parsedJson.length : null,
      sample: Array.isArray(parsedJson) ? parsedJson.slice(0, 3) : parsedJson,
      rawText: parsedJson ? null : rawText.slice(0, 3000),
    },
  });
}