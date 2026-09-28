import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  WB_FINANCE_REPORT_DETAILS_BY_ID_URL,
  WbFinanceScopeError,
  formatWbFinanceBody,
  wbFinanceRequest,
} from "@/lib/wb/wbFinanceApi";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const companyId = getString(formData, "companyId");

  const companies = await prisma.$queryRaw<{ id: string; name: string }[]>`
    select "id", "name"
    from "Company"
    where "id" = ${companyId}
    limit 1
  `;

  const company = companies[0];

  if (!company) {
    return NextResponse.json({ success: false, error: "Компания не найдена" }, { status: 404 });
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
    return NextResponse.json({ success: false, error: "WB token не сохранён" }, { status: 400 });
  }

  const financeReports = await prisma.wbFinance.findMany({
    where: {
      companyName: company.name,
      reportNumber: {
        not: null,
      },
    },
    orderBy: {
      dateFrom: "desc",
    },
    take: 1,
  });

  const reportNumber = financeReports[0]?.reportNumber;

  if (!reportNumber) {
    return NextResponse.json({
      success: false,
      error: "Нет загруженных WB Finance отчётов для теста детализации",
    });
  }

  let status = 0;
  let ok = false;
  let parsedJson: unknown = null;
  let rawText: string | null = null;

  try {
    const result = await wbFinanceRequest({
      url: WB_FINANCE_REPORT_DETAILS_BY_ID_URL(reportNumber),
      token: connection.wbToken,
      body: {
        limit: 5,
        rrdId: 0,
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
    reportNumber,
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
