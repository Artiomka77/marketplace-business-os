import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  WB_FINANCE_REPORTS_LIST_URL,
  WbFinanceScopeError,
  formatWbFinanceBody,
  wbFinanceRequest,
} from "@/lib/wb/wbFinanceApi";

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

  let status = 0;
  let ok = false;
  let parsedJson: unknown = null;
  let rawText: string | null = null;

  try {
    const result = await wbFinanceRequest({
      url: WB_FINANCE_REPORTS_LIST_URL,
      token: connection.wbToken,
      body: {
        dateFrom,
        dateTo,
        limit: 10,
        offset: 0,
        period: "weekly",
      },
    });
    status = result.status;
    ok = result.ok;
    parsedJson = result.body;
    rawText = typeof result.body === "string" ? result.body : null;
  } catch (error) {
    if (error instanceof WbFinanceScopeError) {
      status = error.status;
      ok = false;
      rawText = error.message;
    } else {
      throw error;
    }
  }

  return NextResponse.json({
    success: ok,
    companyName: company.name,
    request: {
      url: WB_FINANCE_REPORTS_LIST_URL,
      dateFrom,
      dateTo,
      limit: 10,
      offset: 0,
      period: "weekly",
    },
    response: {
      status,
      ok,
      contentType: "application/json",
    },
    result: {
      isArray: Array.isArray(parsedJson),
      rowsCount: Array.isArray(parsedJson) ? parsedJson.length : null,
      sample: Array.isArray(parsedJson) ? parsedJson.slice(0, 3) : parsedJson,
      rawText: Array.isArray(parsedJson)
        ? null
        : (rawText ?? formatWbFinanceBody(parsedJson)).slice(0, 3000),
    },
  });
}
