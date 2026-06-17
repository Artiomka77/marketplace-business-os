import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

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
    return NextResponse.json(
      { success: false, error: "Компания не найдена" },
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
      { success: false, error: "WB token не сохранён" },
      { status: 400 }
    );
  }

  const response = await fetch(
    "https://advert-api.wildberries.ru/adv/v1/promotion/count",
    {
      method: "GET",
      headers: {
        Authorization: connection.wbToken,
      },
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
      url: "https://advert-api.wildberries.ru/adv/v1/promotion/count",
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