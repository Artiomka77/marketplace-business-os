import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

type CompanyRow = {
  id: string;
  name: string;
};

type OzonProductListItem = {
  product_id?: number;
  offer_id?: string;
  is_fbo_visible?: boolean;
  is_fbs_visible?: boolean;
  archived?: boolean;
};

type OzonProductListResponse = {
  result?: {
    items?: OzonProductListItem[];
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

  const response = await fetch("https://api-seller.ozon.ru/v3/product/list", {
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
      last_id: "",
      limit: 10,
    }),
    cache: "no-store",
  });

  const rawText = await response.text();

  let parsedJson: OzonProductListResponse | null = null;

  try {
    parsedJson = rawText ? (JSON.parse(rawText) as OzonProductListResponse) : null;
  } catch {
    parsedJson = null;
  }

  return NextResponse.json({
    success: response.ok,
    companyName: company.name,
    request: {
      url: "https://api-seller.ozon.ru/v3/product/list",
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