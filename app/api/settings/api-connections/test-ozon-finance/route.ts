import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type CompanyRow = {
  id: string;
  name: string;
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

  dateFrom.setDate(dateFrom.getDate() - 14);

  return {
    dateFrom: formatDateOnly(dateFrom),
    dateTo: formatDateOnly(dateTo),
  };
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

  if (!connection?.ozonClientId || !connection?.ozonApiKey) {
    return NextResponse.json(
      { success: false, error: "Ozon Client-Id или Api-Key не сохранены" },
      { status: 400 }
    );
  }

  const { dateFrom, dateTo } = getDefaultPeriod();

  const response = await fetch(
    "https://api-seller.ozon.ru/v3/finance/transaction/list",
    {
      method: "POST",
      headers: {
        "Client-Id": connection.ozonClientId,
        "Api-Key": connection.ozonApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          date: {
            from: `${dateFrom}T00:00:00.000Z`,
            to: `${dateTo}T23:59:59.999Z`,
          },
          operation_type: [],
          posting_number: "",
          transaction_type: "all",
        },
        page: 1,
        page_size: 10,
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
      url: "https://api-seller.ozon.ru/v3/finance/transaction/list",
      dateFrom,
      dateTo,
      page: 1,
      pageSize: 10,
    },
    response: {
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type"),
    },
    result: {
      sample: parsedJson,
      rawText: parsedJson ? null : rawText.slice(0, 3000),
    },
  });
}