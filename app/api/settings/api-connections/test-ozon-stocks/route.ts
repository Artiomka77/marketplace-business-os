import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type CompanyRow = {
  id: string;
  name: string;
};

type OzonStockItem = {
  offer_id?: string;
  product_id?: number;
  sku?: number;
  present?: number;
  reserved?: number;
  warehouse_id?: number;
  warehouse_name?: string;
};

type OzonStocksResponse = {
  result?: {
    items?: OzonStockItem[];
    total?: number;
    last_id?: string;
  };
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

  const response = await fetch(
    "https://api-seller.ozon.ru/v4/product/info/stocks",
    {
      method: "POST",
      headers: {
        "Client-Id": connection.ozonClientId,
        "Api-Key": connection.ozonApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          visibility: "ALL",
        },
        limit: 10,
        last_id: "",
      }),
      cache: "no-store",
    }
  );

  const rawText = await response.text();

  let parsedJson: OzonStocksResponse | null = null;

  try {
    parsedJson = rawText ? (JSON.parse(rawText) as OzonStocksResponse) : null;
  } catch {
    parsedJson = null;
  }

  return NextResponse.json({
    success: response.ok,
    companyName: company.name,
    request: {
      url: "https://api-seller.ozon.ru/v4/product/info/stocks",
      limit: 10,
    },
    response: {
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type"),
    },
    result: {
      total: parsedJson?.result?.total ?? null,
      lastId: parsedJson?.result?.last_id ?? null,
      rowsCount: parsedJson?.result?.items?.length ?? null,
      sample: parsedJson?.result?.items?.slice(0, 5) ?? parsedJson,
      rawText: parsedJson ? null : rawText.slice(0, 3000),
    },
  });
}